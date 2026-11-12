"""Tunnel Switcher desktop shell.

One window, saved SSH key, saved tunnels. Closing the window stops every tunnel
this app started.
"""

from __future__ import annotations

import atexit
import ctypes
import json
import os
import re
import subprocess
import sys
import threading
from ctypes import wintypes
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import keyring
import webview

CREATE_NO_WINDOW = 0x08000000
ERROR_ALREADY_EXISTS = 183
MUTEX_NAME = "Local\\TunnelSwitcher.SingleInstance"
WINDOW_TITLE = "Tunnel Switcher"
KEYRING_SERVICE = "tunnel-switcher"
KEYRING_USER = "ssh-key-passphrase"

HOST_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,252})$")
USER_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,80}$")
BIND_MARKERS = ("address already in use", "cannot listen to port")
AUTH_MARKERS = ("permission denied", "authentication failed", "too many authentication")

_mutex_handle = None
_job_handle = None


def app_config_path() -> Path:
    root = Path(os.environ.get("APPDATA") or Path.home()) / "Tunnel Switcher"
    root.mkdir(parents=True, exist_ok=True)
    return root / "config.json"


def resource_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parent.parent


def dist_dir() -> Path:
    root = resource_root()
    bundled = root / "dist"
    if bundled.exists():
        return bundled
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent / "dist"
    return root / "dist"


def app_icon_path() -> Path | None:
    for candidate in (
        resource_root() / "assets" / "logo.ico",
        Path(sys.executable).with_name("logo.ico") if getattr(sys, "frozen", False) else None,
        Path(__file__).resolve().parent.parent / "assets" / "logo.ico",
    ):
        if candidate and candidate.exists():
            return candidate
    return None


def default_config() -> dict:
    return {
        "sshKey": r"C:\Users\gelo\.ssh\gelo",
        "rememberPassphrase": False,
        "tunnels": [
            {
                "id": "mcdo-db",
                "name": "McDo DB",
                "user": "root",
                "host": "72.60.42.106",
                "sshPort": 2222,
                "forwards": [{"localPort": 5433, "remoteHost": "127.0.0.1", "remotePort": 5432}],
                "autoReconnect": True,
            },
            {
                "id": "caret-uat",
                "name": "Caret UAT",
                "user": "root",
                "host": "72.62.73.8",
                "sshPort": 22,
                "forwards": [{"localPort": 5434, "remoteHost": "127.0.0.1", "remotePort": 5432}],
                "autoReconnect": True,
            },
            {
                "id": "tunnel-1",
                "name": "Tunnel 1",
                "user": "root",
                "host": "46.202.164.246",
                "sshPort": 2222,
                "forwards": [{"localPort": 5433, "remoteHost": "127.0.0.1", "remotePort": 5432}],
                "autoReconnect": False,
            },
        ],
    }


def _port(value) -> int:
    try:
        port = int(value)
    except (TypeError, ValueError):
        raise ValueError("Ports must be numbers from 1 to 65535.") from None
    if port < 1 or port > 65535:
        raise ValueError("Ports must be numbers from 1 to 65535.")
    return port


def _name(value) -> str:
    name = " ".join(str(value or "").split())
    if not name or len(name) > 80 or any(ord(ch) < 32 for ch in name):
        raise ValueError("Give the connection a name.")
    return name


def _host(value, label: str) -> str:
    host = str(value or "").strip()
    if not HOST_RE.fullmatch(host):
        raise ValueError(f"{label} must be a hostname or IP address.")
    return host


def normalize_tunnel(raw) -> dict:
    if not isinstance(raw, dict):
        raise ValueError("A connection is missing its details.")
    tunnel_id = str(raw.get("id") or "").strip()
    if not ID_RE.fullmatch(tunnel_id):
        raise ValueError("A connection has an invalid id.")
    forwards_raw = raw.get("forwards")
    if not isinstance(forwards_raw, list) or not forwards_raw or len(forwards_raw) > 8:
        raise ValueError("Each connection needs between 1 and 8 forwards.")
    forwards = []
    seen = set()
    for item in forwards_raw:
        if not isinstance(item, dict):
            raise ValueError("A forward is missing its ports.")
        local_port = _port(item.get("localPort"))
        if local_port in seen:
            raise ValueError(f"Local port {local_port} is listed twice.")
        seen.add(local_port)
        forwards.append(
            {
                "localPort": local_port,
                "remoteHost": _host(item.get("remoteHost"), "Remote host"),
                "remotePort": _port(item.get("remotePort")),
            }
        )
    user = str(raw.get("user") or "").strip()
    if not USER_RE.fullmatch(user):
        raise ValueError("Enter an SSH user, such as root.")
    return {
        "id": tunnel_id,
        "name": _name(raw.get("name")),
        "user": user,
        "host": _host(raw.get("host"), "Host"),
        "sshPort": _port(raw.get("sshPort")),
        "forwards": forwards,
        "autoReconnect": bool(raw.get("autoReconnect")),
    }


def normalize_config(raw, allow_empty_key: bool = True) -> dict:
    if not isinstance(raw, dict):
        raise ValueError("Settings are unreadable.")
    key = str(raw.get("sshKey") or "").strip()
    if len(key) > 320 or any(ch in key for ch in "\r\n"):
        raise ValueError("SSH key path is invalid.")
    if not allow_empty_key and not key:
        raise ValueError("Set the SSH key path.")
    tunnels_raw = raw.get("tunnels")
    if not isinstance(tunnels_raw, list) or len(tunnels_raw) > 100:
        raise ValueError("The connection list is invalid.")
    tunnels = [normalize_tunnel(item) for item in tunnels_raw]
    ids = [item["id"] for item in tunnels]
    if len(ids) != len(set(ids)):
        raise ValueError("Two connections share an id.")
    return {
        "sshKey": key,
        "rememberPassphrase": bool(raw.get("rememberPassphrase")),
        "tunnels": tunnels,
    }


def askpass_helper() -> Path:
    path = Path(os.environ.get("TEMP") or ".") / "tunnel-switcher-askpass.cmd"
    path.write_text("@echo off\r\necho %SSH_PASSPHRASE%\r\n", encoding="utf-8")
    return path


def keyring_load() -> str:
    try:
        value = keyring.get_password(KEYRING_SERVICE, KEYRING_USER)
        return value or ""
    except Exception as exc:
        raise ValueError(f"Could not read OS keyring: {exc}") from exc


def keyring_store(passphrase: str | None) -> None:
    try:
        if passphrase:
            keyring.set_password(KEYRING_SERVICE, KEYRING_USER, passphrase)
        else:
            try:
                keyring.delete_password(KEYRING_SERVICE, KEYRING_USER)
            except keyring.errors.PasswordDeleteError:
                pass
    except Exception as exc:
        raise ValueError(f"Could not write OS keyring: {exc}") from exc


def load_config() -> dict:
    path = app_config_path()
    if not path.exists():
        config = default_config()
        save_config(config)
        return config
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return normalize_config(raw)
    except (OSError, json.JSONDecodeError, ValueError):
        backup = path.with_suffix(".json.bak")
        try:
            path.replace(backup)
        except OSError:
            pass
        config = default_config()
        save_config(config)
        return config


def save_config(config: dict) -> None:
    path = app_config_path()
    payload = json.dumps(config, indent=2)
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(payload, encoding="utf-8", newline="\n")
    temporary.replace(path)


def build_ssh_args(tunnel: dict, key: str, passphrase: str = "") -> list[str]:
    if not os.path.isfile(key):
        raise ValueError(f"Private key not found at {key}")
    command = [
        "ssh",
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ConnectTimeout=15",
        "-o",
        "IdentitiesOnly=yes",
    ]
    if passphrase:
        command.extend(["-o", "NumberOfPasswordPrompts=1"])
    else:
        command.extend(["-o", "BatchMode=yes"])
    command.extend(["-i", key])
    for forward in tunnel["forwards"]:
        command.extend(
            [
                "-L",
                f"{forward['localPort']}:{forward['remoteHost']}:{forward['remotePort']}",
            ]
        )
    command.extend(
        [
            "-p",
            str(tunnel["sshPort"]),
            "-N",
            "-v",
            "--",
            f"{tunnel['user']}@{tunnel['host']}",
        ]
    )
    return command


def ssh_env(passphrase: str = "") -> dict[str, str]:
    env = os.environ.copy()
    if passphrase:
        env["SSH_ASKPASS"] = str(askpass_helper())
        env["SSH_ASKPASS_REQUIRE"] = "force"
        env["SSH_PASSPHRASE"] = passphrase
        env.setdefault("DISPLAY", "1")
    return env


def _kernel32():
    return ctypes.WinDLL("kernel32", use_last_error=True)


def create_kill_on_close_job():
    class IO_COUNTERS(ctypes.Structure):
        _fields_ = [
            ("ReadOperationCount", ctypes.c_ulonglong),
            ("WriteOperationCount", ctypes.c_ulonglong),
            ("OtherOperationCount", ctypes.c_ulonglong),
            ("ReadTransferCount", ctypes.c_ulonglong),
            ("WriteTransferCount", ctypes.c_ulonglong),
            ("OtherTransferCount", ctypes.c_ulonglong),
        ]

    class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_int64),
            ("PerJobUserTimeLimit", ctypes.c_int64),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
            ("IoInfo", IO_COUNTERS),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    kernel = _kernel32()
    kernel.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD]
    kernel.SetInformationJobObject.restype = wintypes.BOOL
    job = kernel.CreateJobObjectW(None, None)
    if not job:
        return None
    info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
    info.BasicLimitInformation.LimitFlags = 0x2000
    if not kernel.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)):
        kernel.CloseHandle(job)
        return None
    return job


def assign_to_job(proc: subprocess.Popen) -> bool:
    if not _job_handle or proc.pid is None:
        return False
    kernel = _kernel32()
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    handle = kernel.OpenProcess(0x0100 | 0x0001, False, proc.pid)
    if not handle:
        return False
    try:
        return bool(kernel.AssignProcessToJobObject(_job_handle, handle))
    finally:
        kernel.CloseHandle(handle)


def kill_process(proc: subprocess.Popen | None) -> None:
    if proc is None or proc.poll() is not None:
        return
    subprocess.run(
        ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=CREATE_NO_WINDOW,
        check=False,
    )


def acquire_single_instance() -> bool:
    global _mutex_handle
    kernel = _kernel32()
    kernel.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
    kernel.CreateMutexW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    ctypes.set_last_error(0)
    handle = kernel.CreateMutexW(None, False, MUTEX_NAME)
    if ctypes.get_last_error() == ERROR_ALREADY_EXISTS:
        if handle:
            kernel.CloseHandle(handle)
        return False
    _mutex_handle = handle
    return True


def focus_existing() -> None:
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel = _kernel32()
    user32.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
    user32.FindWindowW.restype = wintypes.HWND
    hwnd = user32.FindWindowW(None, WINDOW_TITLE)
    if not hwnd:
        user32.MessageBoxW(None, "Tunnel Switcher is already running.", WINDOW_TITLE, 0x40)
        return
    current = kernel.GetCurrentThreadId()
    foreground = user32.GetForegroundWindow()
    foreground_thread = user32.GetWindowThreadProcessId(foreground, None)
    target_thread = user32.GetWindowThreadProcessId(hwnd, None)
    user32.AttachThreadInput(foreground_thread, current, True)
    user32.AttachThreadInput(target_thread, current, True)
    user32.ShowWindow(hwnd, 9)
    user32.SetForegroundWindow(hwnd)
    user32.AttachThreadInput(foreground_thread, current, False)
    user32.AttachThreadInput(target_thread, current, False)


class TunnelService:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._events: list[dict] = []
        self._runs: dict[str, dict] = {}
        self._closed = False

    def emit(self, event: dict) -> None:
        with self._lock:
            self._events.append(event)
            if len(self._events) > 4000:
                del self._events[:1000]

    def poll(self) -> list[dict]:
        with self._lock:
            batch = self._events
            self._events = []
        return batch

    def _busy_ports(self, except_id: str) -> set[int]:
        ports: set[int] = set()
        with self._lock:
            for tunnel_id, run in self._runs.items():
                if tunnel_id == except_id or run["stop"].is_set():
                    continue
                if run["proc"] is None and not run["thread"].is_alive():
                    continue
                for forward in run["spec"]["forwards"]:
                    ports.add(int(forward["localPort"]))
        return ports

    def start(self, tunnel: dict, key: str, passphrase: str = "") -> dict:
        if self._closed:
            return {"ok": False, "error": "Tunnel Switcher is closing."}
        try:
            spec = normalize_tunnel(tunnel)
            if not os.path.isfile(key):
                return {"ok": False, "error": f"Private key not found at {key}"}
            command = build_ssh_args(spec, key, passphrase)
            env = ssh_env(passphrase)
        except ValueError as exc:
            return {"ok": False, "error": str(exc)}

        # One tunnel at a time: stop whatever is running, then start the new one.
        with self._lock:
            previous = [
                (tunnel_id, self._runs[tunnel_id]["spec"].get("name", tunnel_id))
                for tunnel_id in self._runs
                if tunnel_id != spec["id"]
            ]
        for tunnel_id, name in previous:
            self.emit(
                {
                    "type": "log",
                    "id": tunnel_id,
                    "line": f"Stopping {name} so {spec['name']} can start...",
                }
            )
            self.stop(tunnel_id)
        for tunnel_id, _name in previous:
            self._join(tunnel_id)

        self.stop(spec["id"])
        self._join(spec["id"])
        conflict = sorted(set(forward["localPort"] for forward in spec["forwards"]) & self._busy_ports(spec["id"]))
        if conflict:
            listed = ", ".join(str(port) for port in conflict)
            return {"ok": False, "error": f"Local port {listed} is already used by another running tunnel."}
        stop = threading.Event()
        run = {"stop": stop, "proc": None, "thread": None, "spec": spec}
        thread = threading.Thread(
            target=self._loop,
            args=(spec, command, env, stop, run),
            name=f"tunnel-{spec['id']}",
            daemon=True,
        )
        run["thread"] = thread
        with self._lock:
            self._runs[spec["id"]] = run
        thread.start()
        return {"ok": True}

    def stop(self, tunnel_id: str) -> None:
        with self._lock:
            run = self._runs.get(str(tunnel_id))
        if not run:
            return
        run["stop"].set()
        kill_process(run.get("proc"))

    def stop_all(self) -> None:
        with self._lock:
            runs = list(self._runs.values())
        for run in runs:
            run["stop"].set()
            kill_process(run.get("proc"))

    def shutdown(self) -> None:
        if self._closed:
            return
        self._closed = True
        self.stop_all()
        with self._lock:
            runs = list(self._runs.values())
        for run in runs:
            thread = run.get("thread")
            if thread and thread.is_alive():
                thread.join(timeout=1.5)

    def _join(self, tunnel_id: str) -> None:
        with self._lock:
            run = self._runs.get(tunnel_id)
        thread = run.get("thread") if run else None
        if thread and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=2)

    def _loop(self, spec: dict, command: list[str], env: dict[str, str], stop: threading.Event, run: dict) -> None:
        tunnel_id = spec["id"]
        first = True
        while not stop.is_set() and not self._closed:
            self.emit({"type": "status", "id": tunnel_id, "status": "starting" if first else "reconnecting"})
            if first:
                self.emit({"type": "log", "id": tunnel_id, "line": "==================================================="})
                self.emit({"type": "log", "id": tunnel_id, "line": f"Creating SSH tunnel for {spec['name']}..."})
                for forward in spec["forwards"]:
                    self.emit(
                        {
                            "type": "log",
                            "id": tunnel_id,
                            "line": f"Local port {forward['localPort']} -> {forward['remoteHost']}:{forward['remotePort']}",
                        }
                    )
                if spec["autoReconnect"]:
                    self.emit(
                        {
                            "type": "log",
                            "id": tunnel_id,
                            "line": "This tunnel reconnects if it drops. Stop it here to close it.",
                        }
                    )
                self.emit({"type": "log", "id": tunnel_id, "line": "==================================================="})
            else:
                self.emit({"type": "log", "id": tunnel_id, "line": "Reconnecting..."})
            self.emit({"type": "log", "id": tunnel_id, "line": subprocess.list2cmdline(command)})
            fatal = False
            announced = False
            try:
                proc = subprocess.Popen(
                    command,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    stdin=subprocess.DEVNULL,
                    env=env,
                    creationflags=CREATE_NO_WINDOW,
                )
            except FileNotFoundError:
                self.emit({"type": "log", "id": tunnel_id, "line": "ssh was not found. Install the Windows OpenSSH Client and try again."})
                self.emit({"type": "status", "id": tunnel_id, "status": "stopped"})
                return
            assign_to_job(proc)
            with self._lock:
                run["proc"] = proc
            if stop.is_set() or self._closed:
                kill_process(proc)
            assert proc.stdout is not None
            for raw in iter(proc.stdout.readline, b""):
                line = raw.decode("utf-8", "replace").replace("\x00", "").rstrip("\r\n")
                if not line:
                    continue
                lowered = line.lower()
                if any(marker in lowered for marker in BIND_MARKERS + AUTH_MARKERS):
                    fatal = True
                if not announced and ("local forwarding listening" in lowered or "entering interactive session" in lowered):
                    announced = True
                    self.emit({"type": "status", "id": tunnel_id, "status": "running"})
                self.emit({"type": "log", "id": tunnel_id, "line": line})
            code = proc.wait()
            with self._lock:
                run["proc"] = None
            if stop.is_set() or self._closed:
                self.emit({"type": "log", "id": tunnel_id, "line": "Tunnel connection stopped."})
                self.emit({"type": "status", "id": tunnel_id, "status": "stopped"})
                return
            if fatal or not spec["autoReconnect"]:
                reason = "The tunnel stopped." if not fatal else "The tunnel stopped because SSH rejected the connection or the local port is in use."
                self.emit({"type": "log", "id": tunnel_id, "line": f"{reason} Exit code {code}."})
                self.emit({"type": "status", "id": tunnel_id, "status": "stopped"})
                return
            self.emit({"type": "status", "id": tunnel_id, "status": "reconnecting"})
            self.emit({"type": "log", "id": tunnel_id, "line": "Tunnel dropped or closed. Reconnecting in 3 seconds..."})
            first = False
            if stop.wait(3):
                self.emit({"type": "status", "id": tunnel_id, "status": "stopped"})
                return


class Api:
    def __init__(self, service: TunnelService) -> None:
        self._service = service
        self._window = None

    def bind(self, window) -> None:
        self._window = window

    def load_config(self) -> dict:
        return load_config()

    def save_config(self, config: dict) -> None:
        save_config(normalize_config(config))

    def load_passphrase(self) -> str:
        return keyring_load()

    def store_passphrase(self, passphrase: str | None = None) -> None:
        value = None if passphrase is None else str(passphrase)
        keyring_store(value if value else None)

    def key_exists(self, path: str) -> bool:
        return bool(path) and os.path.isfile(str(path))

    def poll_events(self) -> list[dict]:
        return self._service.poll()

    def start_tunnel(self, tunnel: dict, ssh_key: str, passphrase: str = "") -> dict:
        return self._service.start(tunnel, str(ssh_key or ""), str(passphrase or ""))

    def stop_tunnel(self, tunnel_id: str) -> None:
        self._service.stop(str(tunnel_id))

    def stop_all(self) -> None:
        self._service.stop_all()

    def browse_key(self, initial: str = "") -> str | None:
        directory = ""
        if initial:
            parent = str(Path(str(initial)).expanduser().parent)
            if os.path.isdir(parent):
                directory = parent
        picked = self._dialog(webview.FileDialog.OPEN, directory, "", ("All files (*.*)",))
        return picked

    def read_bat(self) -> str | None:
        picked = self._dialog(webview.FileDialog.OPEN, "", "", ("Batch files (*.bat;*.cmd)", "All files (*.*)"))
        if not picked:
            return None
        path = Path(picked)
        if path.stat().st_size > 1_000_000:
            raise ValueError("That file is too large to be a tunnel script.")
        return path.read_text(encoding="utf-8", errors="replace")

    def export_bat(self, filename: str, contents: str) -> bool:
        safe_name = Path(str(filename or "tunnel.bat")).name or "tunnel.bat"
        if not safe_name.lower().endswith(".bat"):
            safe_name += ".bat"
        if len(contents) > 1_000_000:
            raise ValueError("The .bat file is unexpectedly large.")
        picked = self._dialog(webview.FileDialog.SAVE, "", safe_name, ("Batch files (*.bat)",))
        if not picked:
            return False
        destination = Path(picked)
        if destination.suffix.lower() != ".bat":
            destination = destination.with_suffix(".bat")
        destination.write_text(str(contents), encoding="utf-8", newline="")
        return True

    def _dialog(self, kind: int, directory: str, save_filename: str, file_types: tuple[str, ...]) -> str | None:
        window = self._window
        if window is None:
            return None

        def open_dialog():
            return window.create_file_dialog(
                dialog_type=kind,
                directory=directory,
                allow_multiple=False,
                save_filename=save_filename,
                file_types=file_types,
            )

        result = None
        form = None
        try:
            from webview.platforms.winforms import BrowserView

            form = BrowserView.instances.get(window.uid)
        except Exception:
            form = None
        if form is not None and form.InvokeRequired:
            from System import Func, Type

            holder: dict = {}

            def invoke():
                holder["value"] = open_dialog()

            form.Invoke(Func[Type](invoke))
            result = holder.get("value")
        else:
            result = open_dialog()
        if not result:
            return None
        return result[0]


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):  # noqa: A003
        return


def serve_dist() -> str:
    folder = dist_dir()
    if not folder.exists():
        raise FileNotFoundError(f"The app interface is missing at {folder}. Run npm run build first.")
    handler = partial(QuietHandler, directory=str(folder))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, name="tunnel-ui", daemon=True).start()
    return f"http://127.0.0.1:{server.server_address[1]}/"


def message(text: str) -> None:
    ctypes.windll.user32.MessageBoxW(None, text, WINDOW_TITLE, 0x10)


def self_test() -> None:
    spec = normalize_tunnel(default_config()["tunnels"][0])
    key_file = Path(os.environ.get("TEMP") or ".") / "tunnel-switcher-self-test-key"
    key_file.write_text("not-a-real-key\n", encoding="utf-8")
    try:
        build_ssh_args(spec, r"C:\missing\key")
    except ValueError:
        pass
    else:
        raise SystemExit("missing key should fail")
    command = build_ssh_args(spec, str(key_file))
    assert command[0] == "ssh"
    assert "5433:127.0.0.1:5432" in command
    assert f"{spec['user']}@{spec['host']}" in command
    key_file.unlink(missing_ok=True)
    try:
        bad = dict(spec)
        bad["host"] = "-oProxyCommand"
        normalize_tunnel(bad)
    except ValueError:
        pass
    else:
        raise SystemExit("unsafe host was accepted")
    proc = subprocess.Popen(
        ["ping", "127.0.0.1", "-n", "30"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=CREATE_NO_WINDOW,
    )
    assigned = assign_to_job(proc)
    kill_process(proc)
    proc.wait(timeout=5)
    if proc.poll() is None:
        raise SystemExit("ping was still running after taskkill")
    if not assigned:
        raise SystemExit("could not assign the child process to the job")
    print("self-test ok")


def main() -> None:
    global _job_handle
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        ctypes.windll.user32.SetProcessDPIAware()
    ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("Caret.TunnelSwitcher")
    if not acquire_single_instance():
        focus_existing()
        return
    _job_handle = create_kill_on_close_job()
    dev = "--dev" in sys.argv
    url = "http://127.0.0.1:1420" if dev else serve_dist()
    service = TunnelService()
    api = Api(service)
    icon = app_icon_path()
    window = webview.create_window(
        WINDOW_TITLE,
        url,
        js_api=api,
        width=1680,
        height=1000,
        min_size=(1100, 720),
        background_color="#1c1c1c",
        text_select=True,
    )
    api.bind(window)
    window.events.closing += lambda: service.shutdown()
    atexit.register(service.shutdown)

    def apply_windows_icon():
        path = app_icon_path()
        if not path:
            return
        try:
            from webview.platforms.winforms import BrowserView
            from System.Drawing import Icon as WinIcon

            form = BrowserView.instances.get(window.uid)
            if form is None:
                return
            icon_obj = WinIcon(str(path))

            def set_icon():
                form.Icon = icon_obj

            if form.InvokeRequired:
                from System import Func, Type

                form.Invoke(Func[Type](set_icon))
            else:
                set_icon()
        except Exception:
            return

    window.events.shown += apply_windows_icon
    webview.start(debug=dev, icon=str(icon) if icon else None)


if __name__ == "__main__":
    try:
        if "--self-test" in sys.argv:
            _job_handle = create_kill_on_close_job()
            self_test()
        else:
            main()
    except Exception as exc:
        message(str(exc))
        raise
