/** Logging for Edge traffic — routes to the bus (TUI) and optionally stdout. */

import { bus } from "./bus.js";

const MAX = 8_000;

let mirrorStdout = true;

/** When the TUI owns the terminal, disable stdout mirroring to avoid fighting the screen. */
export function setLogMirrorStdout(enabled: boolean): void {
  mirrorStdout = enabled;
}

export function ts(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

export function truncate(text: string, max = MAX): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [${text.length - max} more chars]`;
}

export function summarize(value: unknown, max = MAX): string {
  try {
    return truncate(JSON.stringify(value, redactReplacer, 2), max);
  } catch {
    return truncate(String(value), max);
  }
}

function redactReplacer(key: string, value: unknown): unknown {
  const k = key.toLowerCase();
  if (
    k === "authorization" ||
    k === "token" ||
    k === "RAKAZO_PC_EDGE_TOKEN".toLowerCase() ||
    k.endsWith("token") ||
    k.endsWith("secret") ||
    k.endsWith("password") ||
    k.endsWith("apikey") ||
    k === "api_key"
  ) {
    return typeof value === "string" && value.length ? "[redacted]" : value;
  }
  return value;
}

function publishGlobal(text: string): void {
  const at = ts();
  const line = text.endsWith("\n") ? text.slice(0, -1) : text;
  bus.emit("global:line", { at, text: line });
  if (mirrorStdout) console.log(`[${at}] ${line}`);
}

export function log(...parts: unknown[]): void {
  const text = parts
    .map((p) => (typeof p === "string" ? p : summarize(p)))
    .join(" ");
  publishGlobal(text);
}

export function logBlock(title: string, body: string): void {
  const line = "─".repeat(Math.min(60, Math.max(8, title.length + 4)));
  const block = `${title}\n${line}\n${body.endsWith("\n") ? body.slice(0, -1) : body}\n${line}`;
  publishGlobal(block);
}

/** Stream session PTY/stdout into the bus (and optionally plain stdout). */
export function createSessionPrinter(sessionId: string, label: string) {
  let pending = "";
  const prefix = `[session:${label}] `;
  return {
    write(chunk: string) {
      bus.emit("session:output", { sessionId, label, chunk });
      if (!mirrorStdout) return;
      pending += chunk;
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";
      for (const line of parts) {
        console.log(`${prefix}${line}`);
      }
    },
    flush() {
      if (!mirrorStdout) return;
      if (pending) {
        console.log(`${prefix}${pending}`);
        pending = "";
      }
    },
  };
}

/** Strip common ANSI CSI / OSC sequences for TUI log panes. */
export function stripAnsi(input: string): string {
  return input
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[()][0-9A-Za-z]/g, "")
    .replace(/\r/g, "");
}
