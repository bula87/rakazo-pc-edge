/**
 * Pretty-print OpenCode `--format json` NDJSON events for Edge session panes / exports.
 */

export interface FormatResult {
  /** Human-readable line(s), may be empty to skip noisy events. */
  text: string | null;
  /** OpenCode session id if present on the event. */
  sessionId?: string;
}

function trunc(s: string, max = 240): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

function toolName(part: Record<string, unknown> | undefined): string {
  if (!part) return "tool";
  if (typeof part.tool === "string") return part.tool;
  if (typeof part.title === "string") return part.title;
  return "tool";
}

function toolInputSummary(part: Record<string, unknown> | undefined): string {
  const state = part?.state as Record<string, unknown> | undefined;
  const input = (state?.input ?? part?.input) as Record<string, unknown> | undefined;
  if (!input || typeof input !== "object") return "";
  if (typeof input.path === "string") return input.path;
  if (typeof input.command === "string") return trunc(String(input.command), 120);
  if (typeof input.pattern === "string") return String(input.pattern);
  if (typeof input.content === "string") {
    return trunc(input.content.replace(/\n/g, "\\n"), 80);
  }
  try {
    return trunc(JSON.stringify(input), 120);
  } catch {
    return "";
  }
}

function toolOutputSummary(part: Record<string, unknown> | undefined): string {
  const state = part?.state as Record<string, unknown> | undefined;
  if (typeof state?.output === "string") return trunc(state.output, 200);
  if (typeof part?.output === "string") return trunc(String(part.output), 200);
  return "";
}

/**
 * Format one NDJSON line from `opencode run --format json`.
 * Returns null text for events we intentionally hide (step_start noise).
 */
export function formatOpencodeJsonLine(line: string): FormatResult {
  const trimmed = line.trim();
  if (!trimmed) return { text: null };
  if (!trimmed.startsWith("{")) {
    return { text: trimmed };
  }

  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return { text: trimmed };
  }

  const type = typeof ev.type === "string" ? ev.type : "event";
  const sessionId =
    typeof ev.sessionID === "string"
      ? ev.sessionID
      : typeof ev.sessionId === "string"
        ? ev.sessionId
        : undefined;
  const part = ev.part as Record<string, unknown> | undefined;

  switch (type) {
    case "step_start":
      return { text: null, sessionId };

    case "step_finish": {
      const reason = typeof part?.reason === "string" ? part.reason : "";
      if (reason === "stop") return { text: "── step done ──", sessionId };
      return { text: null, sessionId };
    }

    case "text": {
      const text = typeof part?.text === "string" ? part.text : "";
      if (!text.trim()) return { text: null, sessionId };
      return { text: `assistant: ${text.trim()}`, sessionId };
    }

    case "tool_use": {
      const name = toolName(part);
      const input = toolInputSummary(part);
      const out = toolOutputSummary(part);
      const state = part?.state as Record<string, unknown> | undefined;
      const status = typeof state?.status === "string" ? state.status : "";
      const head = input ? `tool ${name}(${input})` : `tool ${name}`;
      if (status === "completed" && out) {
        return { text: `${head}\n  → ${out}`, sessionId };
      }
      if (status === "completed") return { text: `${head} ✓`, sessionId };
      return { text: `${head}…`, sessionId };
    }

    case "retry": {
      const attempt = ev.attempt ?? "?";
      const err = ev.error as Record<string, unknown> | undefined;
      const msg =
        typeof err?.message === "string"
          ? err.message
          : typeof ev.message === "string"
            ? ev.message
            : "retry";
      return { text: `retry #${attempt}: ${trunc(msg, 160)}`, sessionId };
    }

    case "error": {
      const msg =
        typeof ev.message === "string"
          ? ev.message
          : trunc(JSON.stringify(ev), 200);
      return { text: `error: ${msg}`, sessionId };
    }

    default:
      return { text: `${type}`, sessionId };
  }
}

/** Line-oriented buffer that turns NDJSON chunks into pretty text. */
export class OpencodeJsonPretty {
  private pending = "";
  private sessionId: string | undefined;

  get opencodeSessionId(): string | undefined {
    return this.sessionId;
  }

  /** Feed raw stdout chunk; returns pretty text to show (may be empty). */
  push(chunk: string): string {
    this.pending += chunk;
    const parts = this.pending.split("\n");
    this.pending = parts.pop() ?? "";
    const out: string[] = [];
    for (const line of parts) {
      const r = formatOpencodeJsonLine(line);
      if (r.sessionId) this.sessionId = r.sessionId;
      if (r.text) out.push(r.text);
    }
    return out.length ? `${out.join("\n")}\n` : "";
  }

  flush(): string {
    if (!this.pending.trim()) return "";
    const r = formatOpencodeJsonLine(this.pending);
    this.pending = "";
    if (r.sessionId) this.sessionId = r.sessionId;
    return r.text ? `${r.text}\n` : "";
  }
}
