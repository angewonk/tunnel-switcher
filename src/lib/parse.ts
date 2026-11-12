import type { Forward } from "./types.ts";

export const HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,252})$/;
export const USER_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export interface ParsedPaste {
  name?: string;
  user?: string;
  host?: string;
  sshPort?: number;
  forwards: Forward[];
  autoReconnect: boolean;
  keyPath?: string;
  error?: string;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readSets(text: string): Record<string, string> {
  const sets: Record<string, string> = {};
  for (const match of text.matchAll(/^\s*set\s+"?([A-Za-z_][A-Za-z0-9_]*)=(.*?)"?\s*$/gim)) {
    sets[match[1].toUpperCase()] = unquote(match[2]);
  }
  const resolve = (value: string) => {
    let current = value;
    for (let i = 0; i < 6; i += 1) {
      const next = current.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_, name: string) => {
        return sets[name.toUpperCase()] ?? `%${name}%`;
      });
      if (next === current) break;
      current = next;
    }
    return current;
  };
  for (const key of Object.keys(sets)) sets[key] = resolve(sets[key]);
  return sets;
}

function asPort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) return undefined;
  const port = Number(value);
  if (port < 1 || port > 65535) return undefined;
  return port;
}

export function parseTunnelPaste(text: string): ParsedPaste {
  const raw = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!raw) {
    return { forwards: [], autoReconnect: true, error: "Paste a tunnel command or a .bat file." };
  }

  const sets = readSets(raw);
  const forwards: Forward[] = [];
  const seen = new Set<string>();
  const add = (localPort: number | undefined, remoteHost: string | undefined, remotePort: number | undefined) => {
    if (!localPort || !remotePort || !remoteHost || !HOST_PATTERN.test(remoteHost)) return;
    const key = `${localPort}:${remoteHost}:${remotePort}`;
    if (seen.has(key)) return;
    seen.add(key);
    forwards.push({ localPort, remoteHost, remotePort });
  };

  add(asPort(sets.LOCAL_PORT), sets.REMOTE_HOST, asPort(sets.REMOTE_PORT));
  for (const match of raw.matchAll(/(?:^|[\s"])-L\s+["']?(\d+)\s*:\s*([^:\s"']+)\s*:\s*(\d+)/g)) {
    add(asPort(match[1]), match[2], asPort(match[3]));
  }

  let user = sets.SSH_USER;
  let host = sets.SSH_HOST;
  const destination = raw.match(/(?:^|[\s"'])([A-Za-z0-9._-]{1,64})@([A-Za-z0-9][A-Za-z0-9._-]*)/);
  if (destination) {
    user = user || destination[1];
    host = host || destination[2];
  }

  const flaggedPort = raw.match(/(?:^|[\s"])-p\s+(\d+)/);
  const sshPort = asPort(sets.SSH_PORT) ?? asPort(flaggedPort?.[1]) ?? (host ? 22 : undefined);

  let keyPath: string | undefined = sets.PRIVATE_KEY;
  const quotedKey = raw.match(/(?:^|[\s"])-i\s+"([^"]+)"/);
  const plainKey = raw.match(/(?:^|[\s"])-i\s+(\S+)/);
  if (!keyPath && quotedKey) keyPath = quotedKey[1];
  else if (!keyPath && plainKey) keyPath = plainKey[1].replace(/^["']|["']$/g, "");
  if (keyPath && (keyPath.includes("%") || keyPath.startsWith("-"))) keyPath = undefined;

  const title = raw.match(/Creating SSH [Tt]unnel(?:\s+\d+)?\s+for\s+(.+?)(?:\.{2,}|\r|\n|$)/);
  const autoReconnect = /:tunnel_loop|ServerAliveInterval|goto\s+tunnel_loop/i.test(raw);

  let error: string | undefined;
  if (!host || !HOST_PATTERN.test(host)) error = "No SSH host found. Include user@host or set SSH_HOST.";
  else if (!user || !USER_PATTERN.test(user)) error = "No SSH user found. Include user@host or set SSH_USER.";
  else if (forwards.length === 0) {
    error = "No local forward found. Include -L localPort:remoteHost:remotePort, or set LOCAL_PORT, REMOTE_HOST, and REMOTE_PORT.";
  }

  return {
    name: title?.[1]?.trim() || undefined,
    user: user && USER_PATTERN.test(user) ? user : undefined,
    host: host && HOST_PATTERN.test(host) ? host : undefined,
    sshPort,
    forwards,
    autoReconnect,
    keyPath,
    error,
  };
}
