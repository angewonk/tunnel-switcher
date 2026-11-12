import type { Tunnel } from "./types.ts";

function setLine(name: string, value: string): string {
  if (/[\s&|<>^%]/.test(value)) return `set "${name}=${value.replace(/"/g, "")}"`;
  return `set ${name}=${value}`;
}

export function batFilename(name: string): string {
  const clean = name.replace(/[<>:"/\\|?*]/g, "").trim() || "tunnel";
  return /\.bat$/i.test(clean) ? clean : `${clean}.bat`;
}

export function sshCommand(tunnel: Tunnel, key: string): string {
  const forwards = tunnel.forwards
    .map((forward) => `-L ${forward.localPort}:${forward.remoteHost}:${forward.remotePort}`)
    .join(" ");
  const identity = key ? `-i "${key}" ` : "";
  return `ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=accept-new -o ExitOnForwardFailure=yes -o ConnectTimeout=15 -o BatchMode=yes -o IdentitiesOnly=yes ${identity}${forwards} -p ${tunnel.sshPort} -N -v -- ${tunnel.user}@${tunnel.host}`;
}

/** Windows batch file in the same shape as mcdo-db-loop.bat. */
export function toBat(tunnel: Tunnel, key: string): string {
  const first = tunnel.forwards[0];
  const extra = tunnel.forwards
    .slice(1)
    .map((forward) => ` -L ${forward.localPort}:${forward.remoteHost}:${forward.remotePort}`)
    .join("");
  const title = tunnel.name.replace(/[&|<>^]/g, " ").trim() || "SSH tunnel";
  const header = [
    "@echo off",
    setLine("SSH_USER", tunnel.user),
    setLine("SSH_HOST", tunnel.host),
    setLine("SSH_PORT", String(tunnel.sshPort)),
    setLine("PRIVATE_KEY", key),
    "",
    setLine("LOCAL_PORT", String(first.localPort)),
    setLine("REMOTE_HOST", first.remoteHost),
    setLine("REMOTE_PORT", String(first.remotePort)),
    "",
    'if not exist "%PRIVATE_KEY%" (',
    "    echo Error: Private key not found at %PRIVATE_KEY%",
    "    pause",
    "    exit /b 1",
    ")",
    "",
  ];
  const keepalive = tunnel.autoReconnect ? "-o ServerAliveInterval=30 -o ServerAliveCountMax=3 " : "";
  const ssh = `ssh ${keepalive}-i "%PRIVATE_KEY%" -L %LOCAL_PORT%:%REMOTE_HOST%:%REMOTE_PORT%${extra} -p %SSH_PORT% %SSH_USER%@%SSH_HOST% -N -v`;

  const body = tunnel.autoReconnect
    ? [
        ":tunnel_loop",
        "cls",
        "echo ===================================================",
        `echo Creating SSH Tunnel for ${title}...`,
        "echo Local Port: %LOCAL_PORT% ^-> Remote: %REMOTE_HOST%:%REMOTE_PORT%",
        "echo Press Ctrl+C in this window to stop auto-reconnecting.",
        "echo ===================================================",
        "",
        ssh,
        "",
        "echo.",
        "echo Tunnel dropped or closed. Reconnecting in 3 seconds...",
        "timeout /t 3 /nobreak >nul",
        "goto tunnel_loop",
        "",
      ]
    : [
        `echo Creating SSH Tunnel for ${title}`,
        "echo Local Port: %LOCAL_PORT% ^-> Remote: %REMOTE_HOST%:%REMOTE_PORT%",
        "",
        ssh,
        "",
        "echo Tunnel closed.",
        "pause",
        "",
      ];

  return [...header, ...body].join("\r\n");
}
