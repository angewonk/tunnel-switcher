import { sshCommand } from "@/lib/bat";
import { cloneConfig, DEFAULT_CONFIG, type Config, type StartResult, type Tunnel, type TunnelEvent } from "@/lib/types";

const STORAGE_KEY = "tunnel-switcher-config";
const PASS_KEY = "tunnel-switcher-passphrase";
const previewTimers = new Map<string, number>();

export function isDesktop(): boolean {
  return Boolean(window.pywebview?.api);
}

function browserConfig(): Config {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return cloneConfig(DEFAULT_CONFIG);
    const parsed = JSON.parse(raw) as Config;
    if (!parsed || !Array.isArray(parsed.tunnels)) return cloneConfig(DEFAULT_CONFIG);
    return parsed;
  } catch {
    return cloneConfig(DEFAULT_CONFIG);
  }
}

function emit(events: TunnelEvent[]) {
  window.__tunnelEvents?.(events);
}

export const api = {
  async loadConfig(): Promise<Config> {
    if (isDesktop()) return window.pywebview!.api.load_config();
    return browserConfig();
  },
  async saveConfig(config: Config): Promise<void> {
    if (isDesktop()) {
      await window.pywebview!.api.save_config(config);
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  },
  async loadPassphrase(): Promise<string> {
    if (isDesktop()) return window.pywebview!.api.load_passphrase();
    try {
      return localStorage.getItem(PASS_KEY) || "";
    } catch {
      return "";
    }
  },
  async storePassphrase(passphrase: string | null): Promise<void> {
    if (isDesktop()) {
      await window.pywebview!.api.store_passphrase(passphrase);
      return;
    }
    try {
      if (passphrase) localStorage.setItem(PASS_KEY, passphrase);
      else localStorage.removeItem(PASS_KEY);
    } catch {
      /* ignore */
    }
  },
  async keyExists(path: string): Promise<boolean> {
    if (isDesktop()) return window.pywebview!.api.key_exists(path);
    return path.trim().length > 0;
  },
  async browseKey(initial: string): Promise<string | null> {
    if (isDesktop()) return window.pywebview!.api.browse_key(initial);
    return null;
  },
  async readBat(): Promise<string | null> {
    if (isDesktop()) return window.pywebview!.api.read_bat();
    return null;
  },
  async exportBat(filename: string, contents: string): Promise<boolean> {
    if (isDesktop()) return window.pywebview!.api.export_bat(filename, contents);
    const blob = new Blob([contents], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
    return true;
  },
  async startTunnel(tunnel: Tunnel, sshKey: string, passphrase = ""): Promise<StartResult> {
    if (isDesktop()) return window.pywebview!.api.start_tunnel(tunnel, sshKey, passphrase);
    for (const [id, timer] of previewTimers) {
      if (id === tunnel.id) continue;
      window.clearInterval(timer);
      previewTimers.delete(id);
      emit([
        { type: "log", id, line: `Stopping so ${tunnel.name} can start...` },
        { type: "status", id, status: "stopped" },
      ]);
    }
    window.clearInterval(previewTimers.get(tunnel.id));
    const lines = [
      "Preview only. Open Tunnel Switcher to start a real SSH session.",
      `Creating SSH tunnel for ${tunnel.name}...`,
      sshCommand(tunnel, sshKey),
      `debug1: Local forwarding listening on 127.0.0.1 port ${tunnel.forwards[0]?.localPort ?? ""}`,
    ];
    emit([{ type: "status", id: tunnel.id, status: "starting" }]);
    let index = 0;
    const timer = window.setInterval(() => {
      if (index < lines.length) {
        emit([{ type: "log", id: tunnel.id, line: lines[index] }]);
        index += 1;
        return;
      }
      emit([{ type: "status", id: tunnel.id, status: "running" }]);
      window.clearInterval(timer);
      previewTimers.delete(tunnel.id);
    }, 180);
    previewTimers.set(tunnel.id, timer);
    return { ok: true };
  },
  async stopTunnel(id: string): Promise<void> {
    if (isDesktop()) {
      await window.pywebview!.api.stop_tunnel(id);
      return;
    }
    window.clearInterval(previewTimers.get(id));
    previewTimers.delete(id);
    emit([
      { type: "log", id, line: "Tunnel connection stopped." },
      { type: "status", id, status: "stopped" },
    ]);
  },
  async stopAll(): Promise<void> {
    if (isDesktop()) {
      await window.pywebview!.api.stop_all();
      return;
    }
    for (const id of [...previewTimers.keys()]) await this.stopTunnel(id);
  },
  async pollEvents(): Promise<TunnelEvent[]> {
    if (!isDesktop()) return [];
    return window.pywebview!.api.poll_events();
  },
};
