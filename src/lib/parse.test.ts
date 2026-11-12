import { readFileSync } from "node:fs";
import { toBat } from "./bat.ts";
import { parseTunnelPaste } from "./parse.ts";
import type { Tunnel } from "./types.ts";

const bat = readFileSync("e:/caret/mcdo-db-loop.bat", "utf8");
const parsed = parseTunnelPaste(bat);
if (parsed.error) throw new Error(parsed.error);
if (parsed.user !== "root") throw new Error(`user ${parsed.user}`);
if (parsed.host !== "72.60.42.106") throw new Error(`host ${parsed.host}`);
if (parsed.sshPort !== 2222) throw new Error(`port ${parsed.sshPort}`);
if (parsed.keyPath !== "C:\\Users\\gelo\\.ssh\\gelo") throw new Error(`key ${parsed.keyPath}`);
if (!parsed.autoReconnect) throw new Error("expected reconnect");
if (parsed.name !== "McDo DBs") throw new Error(`name ${parsed.name}`);
if (parsed.forwards.length !== 1) throw new Error("expected one forward");
const forward = parsed.forwards[0];
if (forward.localPort !== 5433 || forward.remoteHost !== "127.0.0.1" || forward.remotePort !== 5432) {
  throw new Error(JSON.stringify(forward));
}

const command = parseTunnelPaste(
  'ssh -o ServerAliveInterval=30 -i "C:\\Users\\gelo\\.ssh\\gelo" -L 5434:127.0.0.1:5432 -p 22 root@72.62.73.8 -N -v',
);
if (command.error) throw new Error(command.error);
if (command.host !== "72.62.73.8" || command.sshPort !== 22 || !command.autoReconnect) {
  throw new Error(JSON.stringify(command));
}
if (command.forwards[0]?.localPort !== 5434) throw new Error("local port");

const oneshot = parseTunnelPaste("ssh -i C:\\Users\\gelo\\.ssh\\gelo -L 5433:127.0.0.1:5432 -p 2222 root@46.202.164.246 -N");
if (oneshot.autoReconnect) throw new Error("one-shot should not reconnect");
if (oneshot.host !== "46.202.164.246") throw new Error("one-shot host");

const missing = parseTunnelPaste("ssh root@10.0.0.5");
if (!missing.error) throw new Error("expected an error when there is no forward");

const tunnel: Tunnel = {
  id: "mcdo-db",
  name: "McDo DB",
  user: "root",
  host: "72.60.42.106",
  sshPort: 2222,
  forwards: [{ localPort: 5433, remoteHost: "127.0.0.1", remotePort: 5432 }],
  autoReconnect: true,
};
const exported = toBat(tunnel, "C:\\Users\\gelo\\.ssh\\gelo");
for (const line of [
  "set SSH_HOST=72.60.42.106",
  "set LOCAL_PORT=5433",
  "set PRIVATE_KEY=C:\\Users\\gelo\\.ssh\\gelo",
  ":tunnel_loop",
  "goto tunnel_loop",
]) {
  if (!exported.includes(line)) throw new Error(`missing ${line}`);
}

console.log("parse tests ok");
