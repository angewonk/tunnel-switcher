/// <reference types="vite/client" />

import type { Config, StartResult, Tunnel, TunnelEvent } from "@/lib/types";

declare global {
  interface Window {
    pywebview?: {
      api: {
        load_config(): Promise<Config>;
        save_config(config: Config): Promise<void>;
        load_passphrase(): Promise<string>;
        store_passphrase(passphrase: string | null): Promise<void>;
        key_exists(path: string): Promise<boolean>;
        browse_key(initial: string): Promise<string | null>;
        read_bat(): Promise<string | null>;
        export_bat(filename: string, contents: string): Promise<boolean>;
        start_tunnel(tunnel: Tunnel, sshKey: string, passphrase?: string): Promise<StartResult>;
        stop_tunnel(id: string): Promise<void>;
        stop_all(): Promise<void>;
        poll_events(): Promise<TunnelEvent[]>;
      };
    };
    __tunnelEvents?: (events: TunnelEvent[]) => void;
  }
}

export {};
