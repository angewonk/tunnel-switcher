import { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { toBat } from "@/lib/bat";
import { HOST_PATTERN, parseTunnelPaste, USER_PATTERN, type ParsedPaste } from "@/lib/parse";
import type { Tunnel } from "@/lib/types";
import { Button, Field, Input, TextArea } from "@/components/ui";

interface DraftForward {
  localPort: string;
  remoteHost: string;
  remotePort: string;
}

interface Draft {
  name: string;
  user: string;
  host: string;
  sshPort: string;
  forwards: DraftForward[];
  autoReconnect: boolean;
}

function draftFrom(tunnel: Tunnel | null): Draft {
  if (!tunnel) {
    return {
      name: "",
      user: "root",
      host: "",
      sshPort: "2222",
      forwards: [{ localPort: "5433", remoteHost: "127.0.0.1", remotePort: "5432" }],
      autoReconnect: true,
    };
  }
  return {
    name: tunnel.name,
    user: tunnel.user,
    host: tunnel.host,
    sshPort: String(tunnel.sshPort),
    forwards: tunnel.forwards.map((forward) => ({
      localPort: String(forward.localPort),
      remoteHost: forward.remoteHost,
      remotePort: String(forward.remotePort),
    })),
    autoReconnect: tunnel.autoReconnect,
  };
}

export function AddTunnelDialog({
  initial,
  currentKey,
  onClose,
  onSave,
  onBrowseBat,
}: {
  initial: Tunnel | null;
  currentKey: string;
  onClose: () => void;
  onSave: (tunnel: Tunnel, keyPath?: string) => void;
  onBrowseBat: () => Promise<string | null>;
}) {
  const [form, setForm] = useState<Draft>(() => draftFrom(initial));
  const [paste, setPaste] = useState(() => (initial ? toBat(initial, currentKey) : ""));
  const [parsed, setParsed] = useState<ParsedPaste | null>(null);
  const [useParsedKey, setUseParsedKey] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!paste.trim()) {
      setParsed(null);
      return;
    }
    const next = parseTunnelPaste(paste);
    setParsed(next);
    if (next.error) return;
    setForm((current) => ({
      ...current,
      name: current.name.trim() ? current.name : next.name || current.name,
      user: next.user || current.user,
      host: next.host || "",
      sshPort: String(next.sshPort || current.sshPort),
      forwards: next.forwards.map((forward) => ({
        localPort: String(forward.localPort),
        remoteHost: forward.remoteHost,
        remotePort: String(forward.remotePort),
      })),
      autoReconnect: next.autoReconnect,
    }));
  }, [paste]);

  function updateForward(index: number, patch: Partial<DraftForward>) {
    setForm((current) => ({
      ...current,
      forwards: current.forwards.map((forward, i) => (i === index ? { ...forward, ...patch } : forward)),
    }));
  }

  function save() {
    const name = form.name.trim();
    if (!name) {
      setError("Give the connection a name.");
      return;
    }
    if (!USER_PATTERN.test(form.user.trim())) {
      setError("Enter an SSH user, such as root.");
      return;
    }
    if (!HOST_PATTERN.test(form.host.trim())) {
      setError("Enter a hostname or IP address.");
      return;
    }
    const sshPort = Number(form.sshPort);
    if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) {
      setError("SSH port must be between 1 and 65535.");
      return;
    }
    const locals = new Set<number>();
    const forwards = [];
    for (const row of form.forwards) {
      const localPort = Number(row.localPort);
      const remotePort = Number(row.remotePort);
      const remoteHost = row.remoteHost.trim();
      if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
        setError("Each local port must be between 1 and 65535.");
        return;
      }
      if (!HOST_PATTERN.test(remoteHost)) {
        setError("Each forward needs a remote host, usually 127.0.0.1.");
        return;
      }
      if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
        setError("Each remote port must be between 1 and 65535.");
        return;
      }
      if (locals.has(localPort)) {
        setError(`Local port ${localPort} is listed twice.`);
        return;
      }
      locals.add(localPort);
      forwards.push({ localPort, remoteHost, remotePort });
    }
    if (forwards.length === 0) {
      setError("Add at least one port forward.");
      return;
    }
    const keyPath = useParsedKey && parsed?.keyPath && parsed.keyPath !== currentKey ? parsed.keyPath : undefined;
    onSave(
      {
        id: initial?.id ?? crypto.randomUUID(),
        name,
        user: form.user.trim(),
        host: form.host.trim(),
        sshPort,
        forwards,
        autoReconnect: form.autoReconnect,
      },
      keyPath,
    );
  }

  const showKey = Boolean(parsed?.keyPath && parsed.keyPath !== currentKey);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-lg"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">{initial ? "Edit connection" : "Add connection"}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Paste an SSH command or a tunnel .bat file, then name it. The fields fill in from the paste.
        </p>

        <div className="mt-4 grid gap-4">
          <Field label="Name">
            <Input
              autoFocus
              value={form.name}
              placeholder="McDo DB"
              spellCheck={false}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
            />
          </Field>

          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Paste tunnel</span>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  const text = await onBrowseBat();
                  if (text) setPaste(text);
                }}
              >
                <FolderOpen /> Open .bat
              </Button>
            </div>
            <TextArea
              value={paste}
              spellCheck={false}
              placeholder={"ssh -i C:\\Users\\gelo\\.ssh\\gelo -L 5433:127.0.0.1:5432 -p 2222 root@72.60.42.106 -N\n\nor the contents of mcdo-db-loop.bat"}
              onChange={(event) => setPaste(event.target.value)}
            />
            {parsed?.error && <p className="text-xs text-destructive">{parsed.error}</p>}
            {showKey && (
              <label className="flex items-center gap-2 text-sm font-normal">
                <input type="checkbox" checked={useParsedKey} onChange={(event) => setUseParsedKey(event.target.checked)} />
                <span className="min-w-0 truncate">Save SSH key from this paste: {parsed?.keyPath}</span>
              </label>
            )}
          </div>

          <div className="grid grid-cols-[1fr_7rem] gap-3">
            <Field label="Host">
              <Input value={form.host} spellCheck={false} onChange={(event) => setForm((current) => ({ ...current, host: event.target.value }))} />
            </Field>
            <Field label="SSH port">
              <Input value={form.sshPort} inputMode="numeric" onChange={(event) => setForm((current) => ({ ...current, sshPort: event.target.value }))} />
            </Field>
          </div>
          <Field label="User">
            <Input value={form.user} spellCheck={false} onChange={(event) => setForm((current) => ({ ...current, user: event.target.value }))} />
          </Field>

          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Forwards</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setForm((current) => ({
                    ...current,
                    forwards: [...current.forwards, { localPort: "", remoteHost: "127.0.0.1", remotePort: "5432" }],
                  }))
                }
              >
                Add forward
              </Button>
            </div>
            {form.forwards.map((forward, index) => (
              <div key={index} className="grid grid-cols-[6rem_1fr_6rem_auto] gap-2">
                <Input
                  aria-label="Local port"
                  value={forward.localPort}
                  placeholder="5433"
                  inputMode="numeric"
                  onChange={(event) => updateForward(index, { localPort: event.target.value })}
                />
                <Input
                  aria-label="Remote host"
                  value={forward.remoteHost}
                  placeholder="127.0.0.1"
                  spellCheck={false}
                  onChange={(event) => updateForward(index, { remoteHost: event.target.value })}
                />
                <Input
                  aria-label="Remote port"
                  value={forward.remotePort}
                  placeholder="5432"
                  inputMode="numeric"
                  onChange={(event) => updateForward(index, { remotePort: event.target.value })}
                />
                <Button
                  variant="ghost"
                  disabled={form.forwards.length === 1}
                  onClick={() =>
                    setForm((current) => ({
                      ...current,
                      forwards: current.forwards.filter((_, i) => i !== index),
                    }))
                  }
                >
                  Remove
                </Button>
              </div>
            ))}
            <p className="text-xs text-muted-foreground">Local port on this PC, then the host and port on the server. Database tunnels are usually 5433 to 127.0.0.1:5432.</p>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <button
              type="button"
              role="switch"
              aria-checked={form.autoReconnect}
              onClick={() => setForm((current) => ({ ...current, autoReconnect: !current.autoReconnect }))}
              className={`inline-flex shrink-0 items-center rounded-full p-0.5 transition-colors ${form.autoReconnect ? "bg-emerald-500" : "bg-foreground/25"}`}
              style={{ width: 44, height: 24 }}
            >
              <span
                className="block rounded-full bg-white shadow-sm transition-transform"
                style={{ width: 20, height: 20, transform: form.autoReconnect ? "translateX(20px)" : "translateX(0px)" }}
              />
            </button>
            Reconnect when the tunnel drops
          </label>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save}>{initial ? "Save" : "Add connection"}</Button>
        </div>
      </div>
    </div>
  );
}
