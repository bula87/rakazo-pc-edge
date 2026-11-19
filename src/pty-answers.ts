/**
 * Answer terminal device queries that fullscreen TUIs (OpenCode) send over the PTY.
 * Without replies, apps may stall or behave oddly while waiting for cursor/color/DA.
 */

const CSI_CPR = /\x1b\[6n/g;
const CSI_DA = /\x1b\[0?c/g;
const CSI_DA_SECONDARY = /\x1b\[>0?c/g;
const OSC_FG = /\x1b\]10;\x07|\x1b\]10;\?\x07/g;
const OSC_BG = /\x1b\]11;\x07|\x1b\]11;\?\x07/g;
// Also BEL-terminated variants already covered; some use ST (\x1b\\)
const OSC_FG_ST = /\x1b\]10;\?\x1b\\/g;
const OSC_BG_ST = /\x1b\]11;\?\x1b\\/g;

export function collectPtyAnswers(
  chunk: string,
  cursor: { row: number; col: number },
): string {
  let out = "";
  if (CSI_CPR.test(chunk)) {
    out += `\x1b[${cursor.row};${cursor.col}R`;
  }
  // Reset lastIndex — global regexes retain state.
  CSI_CPR.lastIndex = 0;

  if (CSI_DA.test(chunk)) {
    out += "\x1b[?1;2c";
  }
  CSI_DA.lastIndex = 0;

  if (CSI_DA_SECONDARY.test(chunk)) {
    out += "\x1b[>0;276;0c";
  }
  CSI_DA_SECONDARY.lastIndex = 0;

  if (OSC_FG.test(chunk) || OSC_FG_ST.test(chunk)) {
    out += "\x1b]10;rgb:eeee/eeee/eeee\x07";
  }
  OSC_FG.lastIndex = 0;
  OSC_FG_ST.lastIndex = 0;

  if (OSC_BG.test(chunk) || OSC_BG_ST.test(chunk)) {
    out += "\x1b]11;rgb:0a0a/0a0a/0a0a\x07";
  }
  OSC_BG.lastIndex = 0;
  OSC_BG_ST.lastIndex = 0;

  return out;
}

/** OpenCode (opentui) reports app state via OSC 7501. */
export type UiBusyState = "idle" | "busy" | "unknown";

export function parseOpenTuiState(chunk: string): UiBusyState | null {
  // Examples (BEL or ST-terminated): ]7501;state=idle:app=opencode
  // Note: many OpenCode builds only emit idle once and never busy — use inferBusyFromScreen.
  const m = /\]7501;state=(idle|busy|clear)(?::[^\x07\x1b]*)?/i.exec(chunk);
  if (!m?.[1]) return null;
  const v = m[1].toLowerCase();
  if (v === "busy") return "busy";
  if (v === "idle") return "idle";
  return null; // clear → ignore
}

/** Braille spinners OpenCode/opentui show in the title while the agent works. */
const SPINNER_RE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
const ACTIVITY_RE =
  /\b(Thought|Thinking|Generating|Working|Running tool|Compacting|Building|Streaming)\b/i;

/**
 * Infer busy from a decoded screen / recent chunk when OSC never sends state=busy
 * (observed with current OpenCode: only one idle OSC at startup).
 */
export function inferBusyFromScreen(text: string): boolean {
  if (!text) return false;
  return SPINNER_RE.test(text) || ACTIVITY_RE.test(text);
}
