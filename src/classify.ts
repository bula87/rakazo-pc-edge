/** Heuristic classification of agent terminal output for Rakazo relay. */

export type SessionEventKind =
  | "progress"
  | "question"
  | "permission"
  | "done"
  | "error"
  | "idle"
  | "busy";

const QUESTION_RE =
  /\?[\s]*$|please (confirm|choose|select|answer|provide)|what (would you|do you|should i)|which (one|option)|enter (a |the )?(y\/n|yes\/no|path|name)|waiting for (your |user )?input|need (your |more )?clarification/im;

const PERMISSION_RE =
  /\b(allow|permission|authorize|grant access|run this command|execute this|sudo|overwrite|delete (these|the) files|y\/n|\[y\/N\]|\(y\/n\))\b/im;

const ERROR_RE =
  /\b(fatal error|unhandled exception|traceback \(most recent call last\)|command not found|permission denied|EACCES|ENOENT)\b/im;

/**
 * Classify a chunk. Prefer uiState (OpenCode OSC idle/busy) when provided.
 * Process exit → done/error. Do not treat redraw spam as meaningful completion.
 */
export function classifyOutput(
  chunk: string,
  exited: boolean,
  exitCode: number | null,
  uiState?: "idle" | "busy" | "unknown",
): SessionEventKind {
  if (exited) {
    if (exitCode !== null && exitCode !== 0) return "error";
    return "done";
  }
  if (uiState === "busy") return "busy";
  if (uiState === "idle") return "idle";

  const text = chunk.slice(-4000);
  if (PERMISSION_RE.test(text)) return "permission";
  if (QUESTION_RE.test(text)) return "question";
  if (ERROR_RE.test(text)) return "error";
  return "progress";
}

/** Kinds that should wake wait_event when already present in buffer (not progress). */
export function isStickyKind(kind: SessionEventKind): boolean {
  return (
    kind === "question" ||
    kind === "permission" ||
    kind === "done" ||
    kind === "error" ||
    kind === "idle" ||
    kind === "busy"
  );
}
