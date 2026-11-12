export interface Forward {
  localPort: number;
  remoteHost: string;
  remotePort: number;
}

export interface Tunnel {
  id: string;
  name: string;
  user: string;
  host: string;
  sshPort: number;
  forwards: Forward[];
  autoReconnect: boolean;
}

export interface Config {
  sshKey: string;
  /** Keep the passphrase in the OS keyring. The passphrase itself is never written to config.json. */
  rememberPassphrase?: boolean;
  tunnels: Tunnel[];
}

export type TunnelStatus = "stopped" | "starting" | "running" | "reconnecting";

export interface TunnelEvent {
  type: "log" | "status";
  id: string;
  line?: string;
  status?: TunnelStatus;
}

export interface StartResult {
  ok: boolean;
  error?: string;
}

export const DEFAULT_SSH_KEY = "C:\\Users\\gelo\\.ssh\\gelo";

export const DEFAULT_CONFIG: Config = {
  sshKey: DEFAULT_SSH_KEY,
  rememberPassphrase: false,
  tunnels: [
    {
      id: "mcdo-db",
      name: "McDo DB",
      user: "root",
      host: "72.60.42.106",
      sshPort: 2222,
      forwards: [{ localPort: 5433, remoteHost: "127.0.0.1", remotePort: 5432 }],
      autoReconnect: true,
    },
    {
      id: "caret-uat",
      name: "Caret UAT",
      user: "root",
      host: "72.62.73.8",
      sshPort: 22,
      forwards: [{ localPort: 5434, remoteHost: "127.0.0.1", remotePort: 5432 }],
      autoReconnect: true,
    },
    {
      id: "tunnel-1",
      name: "Tunnel 1",
      user: "root",
      host: "46.202.164.246",
      sshPort: 2222,
      forwards: [{ localPort: 5433, remoteHost: "127.0.0.1", remotePort: 5432 }],
      autoReconnect: false,
    },
  ],
};

export function cloneConfig(config: Config): Config {
  return structuredClone(config);
}
