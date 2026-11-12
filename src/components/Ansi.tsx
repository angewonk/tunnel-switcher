import { type CSSProperties, type ReactNode } from "react";

const BASE = ["#2e3436", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#d4d8de"];
const BRIGHT = ["#6b7280", "#ff7b86", "#b5e890", "#f5d68b", "#7ec4ff", "#dc8cf0", "#6fd3e0", "#ffffff"];

function color256(n: number): string {
  if (n < 8) return BASE[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const c = [0, 95, 135, 175, 215, 255];
  return `rgb(${c[Math.floor(i / 36)]},${c[Math.floor(i / 6) % 6]},${c[i % 6]})`;
}

interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  underline?: boolean;
  italic?: boolean;
  inverse?: boolean;
}

function apply(st: Style, codes: number[]): Style {
  const style = { ...st };
  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i];
    if (code === 0) return {};
    if (code === 1) style.bold = true;
    else if (code === 2) style.dim = true;
    else if (code === 3) style.italic = true;
    else if (code === 4) style.underline = true;
    else if (code === 7) style.inverse = true;
    else if (code === 22) {
      style.bold = false;
      style.dim = false;
    } else if (code === 23) style.italic = false;
    else if (code === 24) style.underline = false;
    else if (code === 27) style.inverse = false;
    else if (code >= 30 && code <= 37) style.fg = BASE[code - 30];
    else if (code >= 90 && code <= 97) style.fg = BRIGHT[code - 90];
    else if (code >= 40 && code <= 47) style.bg = BASE[code - 40];
    else if (code >= 100 && code <= 107) style.bg = BRIGHT[code - 100];
    else if (code === 39) style.fg = undefined;
    else if (code === 49) style.bg = undefined;
    else if (code === 38 || code === 48) {
      const key = code === 38 ? "fg" : "bg";
      if (codes[i + 1] === 5) {
        style[key] = color256(codes[i + 2] ?? 0);
        i += 2;
      } else if (codes[i + 1] === 2) {
        style[key] = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`;
        i += 4;
      }
    }
  }
  return style;
}

/** Renders text containing ANSI SGR colour codes. Other escape sequences are dropped. */
export function Ansi({ text }: { text: string }) {
  // eslint-disable-next-line no-control-regex
  const parts = text.replace(/\r/g, "").split(/(\x1b\[[0-9;?]*[ -/]*[@-~])/);
  let style: Style = {};
  const out: ReactNode[] = [];
  parts.forEach((part, index) => {
    // eslint-disable-next-line no-control-regex
    const match = /^\x1b\[([0-9;?]*)[ -/]*([@-~])$/.exec(part);
    if (match) {
      if (match[2] === "m") {
        style = apply(style, match[1] === "" ? [0] : match[1].split(";").map((n) => parseInt(n, 10) || 0));
      }
      return;
    }
    if (!part) return;
    const fg = style.inverse ? style.bg ?? "#0b0d10" : style.fg;
    const bg = style.inverse ? style.fg ?? "#d4d8de" : style.bg;
    const css: CSSProperties = {
      color: fg,
      backgroundColor: bg,
      fontWeight: style.bold ? 700 : undefined,
      opacity: style.dim ? 0.6 : undefined,
      textDecoration: style.underline ? "underline" : undefined,
      fontStyle: style.italic ? "italic" : undefined,
    };
    out.push(
      <span key={index} style={css}>
        {part}
      </span>,
    );
  });
  return <>{out}</>;
}

export function paintLine(line: string): string {
  const reset = "\x1b[0m";
  if (/error|failed|denied|refused|unreachable|could not|no such/i.test(line)) return `\x1b[91m${line}${reset}`;
  if (/authenticated|forwarding listening|entering interactive|tunnel is up/i.test(line)) {
    return `\x1b[92m${line}${reset}`;
  }
  if (/reconnecting|dropped|closed/i.test(line)) return `\x1b[93m${line}${reset}`;
  if (/^debug1:/i.test(line)) return `\x1b[2m${line}${reset}`;
  return line;
}
