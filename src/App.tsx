import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, FileDown, FolderOpen, Moon, Pencil, Play, Plus, Square, Sun, Trash2 } from "lucide-react";
import { toast, Toaster } from "sonner";
import { AddTunnelDialog } from "@/components/AddTunnelDialog";
import { paintLine } from "@/components/Ansi";
import { TerminalPanel } from "@/components/TerminalPanel";
import { Button } from "@/components/ui";
import { api, isDesktop } from "@/lib/api";
import { batFilename, sshCommand, toBat } from "@/lib/bat";
import { cn } from "@/lib/cn";
import { useTheme } from "@/lib/theme";
import { cloneConfig, type Config, type Tunnel, type TunnelEvent, type TunnelStatus } from "@/lib/types";

interface ConfirmState {
  title: string;
  body: string;
  confirm: string;
  action: () => Promise<void> | void;
}

function appendLog(current: string, line: string): string {
  const painted = paintLine(line);
  const next = current ? `${current}\n${painted}` : painted;
  if (next.length < 120_000) return next;
  return next.slice(next.length - 100_000);
}

export default function App() {
  const { theme, toggle } = useTheme();
  const [config, setConfig] = useState<Config | null>(null);
  const configRef = useRef(config);
  configRef.current = config;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Record<string, TunnelStatus>>({});
  const [keyOk, setKeyOk] = useState(true);
  const [passphrase, setPassphrase] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [editing, setEditing] = useState<Tunnel | null | undefined>(undefined);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const saveChain = useRef(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const boot = async () => {
      try {
        const loaded = cloneConfig(await api.loadConfig());
        if (cancelled) return;
        setConfig(loaded);
        setSelectedId((current) => current ?? loaded.tunnels[0]?.id ?? null);
        setKeyOk(await api.keyExists(loaded.sshKey));
        if (loaded.rememberPassphrase) {
          try {
            setPassphrase(await api.loadPassphrase());
          } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error));
          }
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    };
    const onReady = () => {
      window.clearTimeout(timer);
      void boot();
    };
    if (window.pywebview?.api) {
      void boot();
    } else {
      window.addEventListener("pywebviewready", onReady);
      timer = window.setTimeout(() => {
        if (!cancelled) void boot();
      }, 500);
    }
    return () => {
      cancelled = true;
      window.removeEventListener("pywebviewready", onReady);
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    const apply = (events: TunnelEvent[]) => {
      if (events.length === 0) return;
      setLogs((current) => {
        const next = { ...current };
        for (const event of events) {
          if (event.type === "log" && event.line) next[event.id] = appendLog(next[event.id] ?? "", event.line);
        }
        return next;
      });
      setStatus((current) => {
        const next = { ...current };
        for (const event of events) {
          if (event.type === "status" && event.status) next[event.id] = event.status;
        }
        return next;
      });
    };
    window.__tunnelEvents = apply;
    const timer = window.setInterval(() => {
      if (!isDesktop()) return;
      void api.pollEvents().then(apply).catch(() => undefined);
    }, 120);
    return () => {
      window.clearInterval(timer);
      if (window.__tunnelEvents === apply) delete window.__tunnelEvents;
    };
  }, []);

  function persist(next: Config) {
    setConfig(next);
    saveChain.current = saveChain.current.then(() => api.saveConfig(next)).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : String(error));
    });
    return saveChain.current;
  }

  if (!config) {
    return <main className="h-full bg-background" />;
  }

  const selected = config.tunnels.find((tunnel) => tunnel.id === selectedId) ?? null;
  const selectedStatus: TunnelStatus = selected ? status[selected.id] ?? "stopped" : "stopped";
  const activeCount = config.tunnels.filter((tunnel) => {
    const value = status[tunnel.id];
    return value === "running" || value === "starting" || value === "reconnecting";
  }).length;

  const updateKey = (sshKey: string) => {
    const current = configRef.current;
    if (!current) return;
    const next = { ...current, sshKey };
    configRef.current = next;
    void persist(next);
  };

  const refreshKey = async (sshKey: string) => {
    setKeyOk(await api.keyExists(sshKey));
  }

  const browseKey = async () => {
    const picked = await api.browseKey(config.sshKey);
    if (picked) {
      await persist({ ...config, sshKey: picked });
      await refreshKey(picked);
    }
  }

  const rememberPassphrase = async (remember: boolean, value = passphrase) => {
    const current = configRef.current;
    if (!current) return;
    const next = { ...current, rememberPassphrase: remember };
    configRef.current = next;
    await persist(next);
    try {
      await api.storePassphrase(remember ? value || null : null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const start = async (tunnel: Tunnel) => {
    const exists = await api.keyExists(config.sshKey);
    setKeyOk(exists);
    if (!exists) {
      toast.error("Choose an SSH key file before starting a tunnel.");
      return;
    }
    if (config.rememberPassphrase) {
      try {
        await api.storePassphrase(passphrase || null);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    setSelectedId(tunnel.id);
    setLogs((current) => ({ ...current, [tunnel.id]: "" }));
    const result = await api.startTunnel(tunnel, config.sshKey, passphrase);
    if (!result.ok) toast.error(result.error || "Could not start the tunnel.");
  }

  const saveTunnel = async (tunnel: Tunnel, keyPath?: string) => {
    const exists = config.tunnels.some((item) => item.id === tunnel.id);
    const tunnels = exists ? config.tunnels.map((item) => (item.id === tunnel.id ? tunnel : item)) : [...config.tunnels, tunnel];
    const sshKey = keyPath || config.sshKey;
    try {
      await persist({ ...config, sshKey, tunnels });
      if (keyPath) await refreshKey(keyPath);
      setSelectedId(tunnel.id);
      setEditing(undefined);
      const running = status[tunnel.id] && status[tunnel.id] !== "stopped";
      toast.success(exists ? (running ? "Saved. Stop and start the tunnel to use the new settings." : "Connection updated.") : "Connection saved.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  const askRemove = (tunnel: Tunnel) => {
    setConfirm({
      title: `Delete ${tunnel.name}?`,
      body: "This removes the saved connection. If the tunnel is running, it stops.",
      confirm: "Delete",
      action: async () => {
        await api.stopTunnel(tunnel.id);
        const tunnels = config.tunnels.filter((item) => item.id !== tunnel.id);
        await persist({ ...config, tunnels });
        setSelectedId(tunnels[0]?.id ?? null);
        setConfirm(null);
      },
    });
  }

  const askRemoveAll = () => {
    setConfirm({
      title: "Delete all connections?",
      body: "Every saved tunnel is removed and any that are running will stop. The SSH key path stays.",
      confirm: "Delete all",
      action: async () => {
        await api.stopAll();
        await persist({ ...config, tunnels: [] });
        setSelectedId(null);
        setStatus({});
        setConfirm(null);
      },
    });
  }

  const exportSelected = async () => {
    if (!selected) return;
    if (!config.sshKey.trim()) {
      toast.error("Set the SSH key path before saving a .bat file.");
      return;
    }
    const saved = await api.exportBat(batFilename(selected.name), toBat(selected, config.sshKey));
    if (saved) toast.success("Saved the .bat file.");
  }

  return (
    <main className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-3">
          <img src="/logo.png" alt="" className="size-10 rounded-lg" draggable={false} />
          <div>
            <h1 className="text-xl font-semibold">Tunnel Switcher</h1>
            <p className="text-xs text-muted-foreground">
              {activeCount === 0 ? "No tunnels running" : activeCount === 1 ? "1 tunnel running" : `${activeCount} tunnels running`}
            </p>
          </div>
        </div>
        <Button variant="outline" size="icon" onClick={toggle} title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}>
          {theme === "dark" ? <Sun /> : <Moon />}
        </Button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[22rem_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col border-r">
          <div className="grid gap-2 border-b p-4">
            <label className="grid gap-1.5 text-sm font-medium" htmlFor="ssh-key">
              SSH key
              <div className="flex gap-2">
                <input
                  id="ssh-key"
                  value={config.sshKey}
                  spellCheck={false}
                  onChange={(event) => updateKey(event.target.value)}
                  onBlur={() => void refreshKey(config.sshKey)}
                  className={cn(
                    "h-8 min-w-0 flex-1 rounded-lg border bg-transparent px-2.5 font-mono text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30",
                    keyOk ? "border-input" : "border-destructive",
                  )}
                />
                <Button variant="outline" onClick={() => void browseKey()}>
                  <FolderOpen /> Browse
                </Button>
              </div>
            </label>
            <p className={cn("text-xs", keyOk ? "text-muted-foreground" : "text-destructive")}>
              {keyOk ? "Saved on this PC and used for every tunnel." : "That key file was not found."}
            </p>
            <label className="grid gap-1.5 text-sm font-medium" htmlFor="ssh-passphrase">
              Key passphrase
              <div className="flex gap-2">
                <input
                  id="ssh-passphrase"
                  type={showPass ? "text" : "password"}
                  autoComplete="off"
                  value={passphrase}
                  placeholder="Leave empty if the key has no passphrase"
                  onChange={(event) => setPassphrase(event.target.value)}
                  onBlur={() => {
                    if (!config.rememberPassphrase) return;
                    void api.storePassphrase(passphrase || null).catch((error: unknown) => {
                      toast.error(error instanceof Error ? error.message : String(error));
                    });
                  }}
                  className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
                />
                <Button
                  variant="outline"
                  size="icon"
                  title={showPass ? "Hide passphrase" : "Show passphrase"}
                  onClick={() => setShowPass((value) => !value)}
                >
                  {showPass ? <EyeOff /> : <Eye />}
                </Button>
              </div>
            </label>
            <label className="flex items-center gap-2 text-sm font-normal">
              <button
                type="button"
                role="switch"
                aria-checked={Boolean(config.rememberPassphrase)}
                onClick={() => void rememberPassphrase(!config.rememberPassphrase)}
                className={`inline-flex shrink-0 items-center rounded-full p-0.5 transition-colors ${config.rememberPassphrase ? "bg-emerald-500" : "bg-foreground/25"}`}
                style={{ width: 44, height: 24 }}
              >
                <span
                  className="block rounded-full bg-white shadow-sm transition-transform"
                  style={{ width: 20, height: 20, transform: config.rememberPassphrase ? "translateX(20px)" : "translateX(0px)" }}
                />
              </button>
              Keep passphrase (stored in the OS keyring)
            </label>
          </div>

          <div className="flex items-center justify-between px-4 py-3">
            <h2 className="text-sm font-medium">Connections</h2>
            <div className="flex gap-1.5">
              <Button size="sm" onClick={() => setEditing(null)}>
                <Plus /> Add
              </Button>
              <Button size="sm" variant="destructive" disabled={config.tunnels.length === 0} onClick={askRemoveAll}>
                Delete all
              </Button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
            {config.tunnels.length === 0 && (
              <p className="px-2 text-sm text-muted-foreground">No connections yet. Add one by pasting a tunnel command or a .bat file.</p>
            )}
            {config.tunnels.map((tunnel) => {
              const itemStatus = status[tunnel.id] ?? "stopped";
              const dot =
                itemStatus === "running"
                  ? "bg-emerald-400"
                  : itemStatus === "stopped"
                    ? "bg-muted-foreground/40"
                    : "animate-pulse bg-amber-400";
              return (
                <button
                  key={tunnel.id}
                  type="button"
                  onClick={() => setSelectedId(tunnel.id)}
                  className={cn(
                    "mb-1 flex w-full items-start gap-2 rounded-lg border px-2.5 py-2 text-left",
                    tunnel.id === selectedId ? "border-ring bg-muted" : "border-transparent hover:bg-muted/70",
                  )}
                >
                  <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", dot)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{tunnel.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {tunnel.user}@{tunnel.host}:{tunnel.sshPort}
                      {" · "}
                      {tunnel.forwards.map((forward) => forward.localPort).join(", ")}
                      {tunnel.autoReconnect ? " · reconnects" : ""}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="grid grid-cols-2 gap-2 border-t p-3">
            <Button disabled={!selected || selectedStatus !== "stopped"} onClick={() => selected && void start(selected)}>
              <Play /> Start
            </Button>
            <Button variant="outline" disabled={!selected || selectedStatus === "stopped"} onClick={() => selected && void api.stopTunnel(selected.id)}>
              <Square /> Stop
            </Button>
            <Button variant="outline" disabled={!selected} onClick={() => selected && setEditing(selected)}>
              <Pencil /> Edit
            </Button>
            <Button variant="outline" disabled={!selected} onClick={() => void exportSelected()}>
              <FileDown /> Save .bat
            </Button>
            <Button variant="destructive" className="col-span-2" disabled={!selected} onClick={() => selected && askRemove(selected)}>
              <Trash2 /> Delete
            </Button>
          </div>
        </aside>

        <div className="flex min-h-0 flex-col gap-3 p-4">
          <TerminalPanel
            title={selected ? selected.name : "Terminal"}
            command={selected ? sshCommand(selected, config.sshKey) : ""}
            status={selected ? selectedStatus : "stopped"}
            text={selected ? logs[selected.id] ?? "" : ""}
            onClear={() => {
              if (!selected) return;
              setLogs((current) => ({ ...current, [selected.id]: "" }));
            }}
          />
        </div>
      </div>

      {editing !== undefined && (
        <AddTunnelDialog
          key={editing ? editing.id : "new"}
          initial={editing}
          currentKey={config.sshKey}
          onClose={() => setEditing(undefined)}
          onSave={(tunnel, keyPath) => void saveTunnel(tunnel, keyPath)}
          onBrowseBat={() => api.readBat()}
        />
      )}

      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-xl border border-border bg-popover p-5 shadow-lg">
            <h2 className="text-lg font-semibold">{confirm.title}</h2>
            <p className="mt-2 text-sm text-muted-foreground">{confirm.body}</p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={() => void confirm.action()}>
                {confirm.confirm}
              </Button>
            </div>
          </div>
        </div>
      )}

      <Toaster theme={theme} />
    </main>
  );
}
