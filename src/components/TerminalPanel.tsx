import { useEffect, useRef } from "react";
import { Trash2 } from "lucide-react";
import { Ansi } from "@/components/Ansi";
import { Button } from "@/components/ui";
import type { TunnelStatus } from "@/lib/types";

const statusLabel: Record<TunnelStatus, string> = {
  stopped: "stopped",
  starting: "starting",
  running: "running",
  reconnecting: "reconnecting",
};

export function TerminalPanel({
  title,
  command,
  status,
  text,
  onClear,
}: {
  title: string;
  command: string;
  status: TunnelStatus;
  text: string;
  onClear: () => void;
}) {
  const scroller = useRef<HTMLPreElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = scroller.current;
    if (!el || !stick.current) return;
    el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <section className="terminal flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-white/10 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs text-[#d4d8de]">{title}</div>
          <div className="truncate text-[11px] text-[#8b93a7]" title={command}>
            {command || "ssh"}
          </div>
        </div>
        <span className="text-[11px] tracking-wide text-[#8b93a7] uppercase">{statusLabel[status]}</span>
        <Button variant="ghost" size="sm" className="text-[#d4d8de] hover:bg-white/10 hover:text-white" onClick={onClear}>
          <Trash2 /> Clear
        </Button>
      </div>
      <pre
        ref={scroller}
        onScroll={(event) => {
          const el = event.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        className="m-0 min-h-0 flex-1 overflow-auto p-3 text-xs leading-5 whitespace-pre-wrap"
      >
        {text ? <Ansi text={text} /> : <span className="text-[#8b93a7]">Waiting for a tunnel. Start one and the SSH session prints here.</span>}
      </pre>
    </section>
  );
}
