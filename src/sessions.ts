/// <reference path="./node-pty.d.ts" />
import { randomUUID } from "node:crypto";
import { spawn as cpSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { bus } from "./bus.js";
import { classifyOutput, isStickyKind, type SessionEventKind } from "./classify.js";
import { createSessionPrinter, log, summarize, stripAnsi } from "./log.js";
import {
  collectPtyAnswers,
  inferBusyFromScreen,
  parseOpenTuiState,
  type UiBusyState,
} from "./pty-answers.js";
import { OpencodeJsonPretty } from "./opencode-format.js";
import type { AccessScope } from "./scope.js";
import { resolveInScope } from "./scope.js";
import { TermScreen } from "./term-screen.js";

export interface SessionSpawnOptions {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  pty?: boolean;
  label?: string;
  /** Pretty-print OpenCode `--format json` NDJSON in the session pane / export. */
  pretty?: "opencode-json";
  /** Known OpenCode session id when continuing a prior run. */
  opencodeSessionId?: string;
}

export interface SessionInfo {
  id: string;
  label: string;
  cmd: string;
  args: string[];
  cwd: string;
  pty: boolean;
  startedAt: string;
  exited: boolean;
  exitCode: number | null;
  bytesBuffered: number;
  lastKind: SessionEventKind;
  /** OpenCode/opentui OSC state when known. */
  uiState: UiBusyState;
  /** OpenCode ses_… id when this Edge session is an opencode run. */
  opencodeSessionId?: string;
  pretty?: "opencode-json";
}

export interface SessionEvent {
  sessionId: string;
  kind: SessionEventKind;
  at: string;
  chunk?: string;
  exitCode?: number | null;
  uiState?: UiBusyState;
  plain?: string;
}

interface LiveSession {
  info: SessionInfo;
  buffer: string;
  cursor: number;
  printer: { write(chunk: string): void; flush(): void };
  /** VT mirror for interactive PTY UIs (OpenCode). Absent for plain pipe sessions. */
  screen?: TermScreen;
  /** Frozen last frame after exit — kept until Edge restarts. */
  finalFrame?: string;
  /** Scrollback of stripped lines for non-PTY / fallback display. */
  plainLines: string[];
  plainPending: string;
  child?: ChildProcessWithoutNullStreams;
  ptyProcess?: {
    write(data: string): void;
    kill(signal?: string): void;
    resize?(cols: number, rows: number): void;
    onData(cb: (data: string) => void): void;
    onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  };
  waiters: Array<{
    kinds: Set<SessionEventKind> | null;
    /** When waiting for idle, require a busy period first (typical after submit). */
    afterBusy: boolean;
    seenBusy: boolean;
    resolve: (event: SessionEvent) => void;
    timer: ReturnType<typeof setTimeout>;
  }>;
  /** Debounce: OpenCode often never re-emits OSC idle; settle after spinner disappears. */
  idleCheckTimer?: ReturnType<typeof setTimeout>;
  /** True after a submit until we observe real screen activity or settle to idle. */
  expectBusy?: boolean;
  /** Formats OpenCode JSON NDJSON into readable session pane lines. */
  pretty?: OpencodeJsonPretty;
}

const DEFAULT_MAX_SESSIONS = 16;
const DEFAULT_BUFFER_CHARS = 512 * 1024;

export class SessionManager {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly maxSessions: number;
  private readonly bufferChars: number;
  private readonly mirrorOutput: boolean;
  private ptyAvailable: boolean | null = null;

  constructor(
    private readonly scope: AccessScope,
    opts?: { maxSessions?: number; bufferChars?: number; mirrorOutput?: boolean },
  ) {
    this.maxSessions = opts?.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.bufferChars = opts?.bufferChars ?? DEFAULT_BUFFER_CHARS;
    this.mirrorOutput = opts?.mirrorOutput !== false;
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => ({
      ...s.info,
      bytesBuffered: Buffer.byteLength(s.buffer),
    }));
  }

  get(id: string): LiveSession {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`Unknown session: ${id}`);
    return s;
  }

  status(id: string): SessionInfo {
    const s = this.get(id);
    return { ...s.info, bytesBuffered: Buffer.byteLength(s.buffer) };
  }

  async spawn(opts: SessionSpawnOptions): Promise<SessionInfo> {
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(`Session limit reached (${this.maxSessions})`);
    }
    const cwd = resolveInScope(this.scope, opts.cwd ?? ".");
    const wantPty = opts.pty !== false;
    const id = randomUUID();
    const info: SessionInfo = {
      id,
      label: opts.label ?? opts.cmd,
      cmd: opts.cmd,
      args: opts.args ?? [],
      cwd,
      pty: wantPty,
      startedAt: new Date().toISOString(),
      exited: false,
      exitCode: null,
      bytesBuffered: 0,
      lastKind: "progress",
      uiState: "unknown",
      pretty: opts.pretty,
      opencodeSessionId: opts.opencodeSessionId,
    };
    const short = id.slice(0, 8);
    const tag = `${info.label}:${short}`;
    const live: LiveSession = {
      info,
      buffer: "",
      cursor: 0,
      printer: createSessionPrinter(id, tag),
      plainLines: [],
      plainPending: "",
      waiters: [],
      pretty: opts.pretty === "opencode-json" ? new OpencodeJsonPretty() : undefined,
    };
    this.sessions.set(id, live);

    const env = { ...process.env, ...(opts.env ?? {}) };
    log(
      `session SPAWN id=${id} label=${info.label} pty=${wantPty} cwd=${cwd} cmd=${opts.cmd} args=${summarize(opts.args ?? [])}`,
    );

    if (wantPty && (await this.canUsePty())) {
      await this.spawnPty(live, opts.cmd, opts.args ?? [], cwd, env);
    } else {
      info.pty = false;
      this.spawnPipes(live, opts.cmd, opts.args ?? [], cwd, env);
    }
    const status = this.status(id);
    bus.emit("session:spawn", status);
    bus.emit("session:updated", status);
    return status;
  }

  /** Full raw output buffer for tooling. */
  getBuffer(id: string): string {
    return this.get(id).buffer;
  }

  /**
   * Frame suitable for the TUI main pane: VT viewport for PTY sessions,
   * or stripped scrollback for pipe sessions.
   * After exit, returns the frozen frame so logs survive until Edge restarts.
   */
  async getDisplayFrame(id: string): Promise<string> {
    const s = this.get(id);
    if (s.info.exited && s.finalFrame !== undefined) {
      return s.finalFrame;
    }
    if (s.screen) return s.screen.snapshot();
    return this.plainFrame(s);
  }

  /** Resize PTY + VT mirror to match the TUI pane (cols/rows). No-op after exit. */
  resize(id: string, cols: number, rows: number): void {
    const s = this.get(id);
    if (s.info.exited) return;
    s.screen?.resize(cols, rows);
    try {
      s.ptyProcess?.resize?.(cols, rows);
    } catch {
      /* ignore */
    }
  }

  /**
   * Write session metadata + raw PTY/stdout log (and frozen display frame if any) to a file.
   * Path must stay under the access root unless scope is global.
   */
  async exportSessionLog(id: string, filePath: string): Promise<string> {
    const s = this.get(id);
    const abs = resolveInScope(this.scope, filePath);
    await mkdir(path.dirname(abs), { recursive: true });
    const display = s.finalFrame ?? (s.screen ? s.screen.snapshotSync() : this.plainFrame(s));
    const header = [
      "# rakazo-pc-edge session export",
      `# exportedAt=${new Date().toISOString()}`,
      `# id=${s.info.id}`,
      `# label=${s.info.label}`,
      `# cmd=${s.info.cmd} ${s.info.args.join(" ")}`.trimEnd(),
      `# cwd=${s.info.cwd}`,
      `# pty=${s.info.pty}`,
      s.info.opencodeSessionId ? `# opencodeSessionId=${s.info.opencodeSessionId}` : null,
      s.info.pretty ? `# pretty=${s.info.pretty}` : null,
      `# startedAt=${s.info.startedAt}`,
      `# exited=${s.info.exited}`,
      `# exitCode=${s.info.exitCode ?? ""}`,
      `# lastKind=${s.info.lastKind}`,
      "#",
      "# --- display frame (pretty/VT) ---",
      display,
      "#",
      "# --- raw output buffer ---",
      s.buffer,
      "",
    ]
      .filter((line) => line !== null)
      .join("\n");
    await writeFile(abs, header, "utf8");
    log(`session EXPORT id=${id} path=${abs} bytes=${Buffer.byteLength(header)}`);
    return abs;
  }

  /** Default export path under the access root (or cwd when global). */
  defaultExportPath(id: string): string {
    const s = this.get(id);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safe = s.info.label.replace(/[^\w.-]+/g, "_").slice(0, 40) || "session";
    const base = this.scope.root ?? process.cwd();
    return path.join(base, "edge-logs", `${safe}-${s.info.id.slice(0, 8)}-${stamp}.log`);
  }

  read(
    id: string,
    since = 0,
  ): {
    text: string;
    next: number;
    exited: boolean;
    kind: SessionEventKind;
    uiState: UiBusyState;
  } {
    const s = this.get(id);
    const start = Math.max(0, Math.min(since, s.buffer.length));
    const text = s.buffer.slice(start);
    return {
      text,
      next: s.buffer.length,
      exited: s.info.exited,
      kind: s.info.lastKind,
      uiState: s.info.uiState,
    };
  }

  /**
   * Human-readable screen for Rakazo (VT-decoded), plus uiState.
   * Prefer this over edge_session_read raw ANSI when monitoring OpenCode.
   */
  async snapshot(id: string): Promise<{
    plain: string;
    uiState: UiBusyState;
    exited: boolean;
    exitCode: number | null;
    lastKind: SessionEventKind;
    cwd: string;
  }> {
    const s = this.get(id);
    const plain =
      s.info.exited && s.finalFrame !== undefined
        ? s.finalFrame
        : s.screen
          ? await s.screen.snapshot()
          : this.plainFrame(s);
    return {
      plain,
      uiState: s.info.uiState,
      exited: s.info.exited,
      exitCode: s.info.exitCode,
      lastKind: s.info.lastKind,
      cwd: s.info.cwd,
    };
  }

  /**
   * Write to session stdin/PTY.
   * - raw: send data unchanged
   * - submit: after data, send Enter (`\r` on PTY, `\n` on pipes) — needed for OpenCode/TUIs
   * - default (neither): append a line ending; PTY gets `\r`, pipes get `\n`
   */
  stdin(id: string, data: string, opts?: { raw?: boolean; submit?: boolean }): void {
    const s = this.get(id);
    if (s.info.exited) throw new Error(`Session already exited: ${id}`);
    const usePty = Boolean(s.ptyProcess);
    const enter = usePty ? "\r" : "\n";

    let payload: string;
    if (opts?.raw) {
      payload = data;
    } else if (opts?.submit) {
      // Type the text (without forcing a trailing newline), then Enter.
      payload = data.replace(/\r?\n$/, "") + enter;
    } else if (usePty) {
      // Fullscreen TUIs (OpenCode) treat Enter as CR, not LF.
      if (data.endsWith("\r")) payload = data;
      else if (data.endsWith("\n")) payload = `${data.slice(0, -1)}\r`;
      else payload = `${data}\r`;
    } else {
      payload = data.endsWith("\n") ? data : `${data}\n`;
    }

    log(`session STDIN id=${id} label=${s.info.label} pty=${usePty} data=${summarize(payload)}`);
    bus.emit("session:stdin", { sessionId: id, label: s.info.label, data: payload });
    if (s.ptyProcess) {
      s.ptyProcess.write(payload);
    } else if (s.child?.stdin.writable) {
      s.child.stdin.write(payload);
    } else {
      throw new Error("Session has no writable stdin");
    }

    // OpenCode rarely emits OSC busy — mark busy on submit so afterBusy waiters can arm.
    if (opts?.submit) {
      s.expectBusy = true;
      this.setUiState(s, "busy", "submit");
      this.armIdleSettle(s, 8_000);
    }
  }

  /**
   * Send a chat prompt into an OpenCode-style TUI: Esc (leave shell/panels) then type+Enter.
   * Prefer this over bare edge_session_stdin for follow-up messages on a live TUI.
   */
  prompt(id: string, text: string): void {
    const s = this.get(id);
    if (s.info.exited) throw new Error(`Session already exited: ${id}`);
    // Esc twice: dismiss overlays / leave embedded shell focus, then type the prompt.
    const focus = `${keyToSequence("esc")}${keyToSequence("esc")}`;
    const body = text.replace(/\r?\n$/, "");
    const enter = s.ptyProcess ? "\r" : "\n";
    const payload = `${focus}${body}${enter}`;
    log(`session PROMPT id=${id} label=${s.info.label} data=${summarize(body)}`);
    bus.emit("session:stdin", { sessionId: id, label: s.info.label, data: payload });
    if (s.ptyProcess) {
      s.ptyProcess.write(payload);
    } else if (s.child?.stdin.writable) {
      s.child.stdin.write(payload);
    } else {
      throw new Error("Session has no writable stdin");
    }
    s.expectBusy = true;
    this.setUiState(s, "busy", "prompt");
    this.armIdleSettle(s, 8_000);
  }

  /** Send named keys / control sequences to a PTY session (OpenCode navigation, submit, etc.). */
  sendKeys(id: string, keys: string[]): void {
    const s = this.get(id);
    if (s.info.exited) throw new Error(`Session already exited: ${id}`);
    const seq = keys.map(keyToSequence).join("");
    if (!seq) throw new Error("No keys to send");
    log(`session KEYS id=${id} label=${s.info.label} keys=${summarize(keys)}`);
    bus.emit("session:stdin", { sessionId: id, label: s.info.label, data: seq });
    if (s.ptyProcess) {
      s.ptyProcess.write(seq);
      return;
    }
    if (s.child?.stdin.writable) {
      s.child.stdin.write(seq);
      return;
    }
    throw new Error("Session has no writable stdin");
  }

  kill(id: string, signal: NodeJS.Signals = "SIGTERM"): void {
    const s = this.get(id);
    if (s.info.exited) return;
    log(`session KILL id=${id} label=${s.info.label} signal=${signal}`);
    if (s.ptyProcess) {
      s.ptyProcess.kill(signal);
      return;
    }
    s.child?.kill(signal);
  }

  /** Drop an exited session from the list (active sessions must be killed first). */
  remove(id: string): void {
    const s = this.get(id);
    if (!s.info.exited) {
      throw new Error(`Session still active — call edge_session_kill first: ${id}`);
    }
    if (s.idleCheckTimer) clearTimeout(s.idleCheckTimer);
    this.sessions.delete(id);
    log(`session REMOVE id=${id} label=${s.info.label}`);
    bus.emit("session:updated", {
      id,
      label: s.info.label,
      cmd: s.info.cmd,
      args: s.info.args,
      cwd: s.info.cwd,
      pty: s.info.pty,
      startedAt: s.info.startedAt,
      exited: true,
      exitCode: s.info.exitCode,
      bytesBuffered: 0,
      lastKind: s.info.lastKind,
      uiState: s.info.uiState,
    });
  }

  waitEvent(
    id: string,
    kinds: SessionEventKind[] | undefined,
    timeoutMs: number,
    opts?: { afterBusy?: boolean },
  ): Promise<SessionEvent> {
    const s = this.get(id);
    const kindSet = kinds?.length ? new Set(kinds) : null;
    const afterBusy = Boolean(opts?.afterBusy);

    if (s.info.exited) {
      const kind = classifyOutput("", true, s.info.exitCode, s.info.uiState);
      if (!kindSet || kindSet.has(kind)) {
        return Promise.resolve({
          sessionId: id,
          kind,
          at: new Date().toISOString(),
          exitCode: s.info.exitCode,
          uiState: s.info.uiState,
        });
      }
    }

    const nowKind = classifyOutput("", false, null, s.info.uiState);
    // Immediate resolve for sticky states (not progress redraw spam).
    if (
      kindSet &&
      kindSet.has(nowKind) &&
      isStickyKind(nowKind) &&
      !(afterBusy && nowKind === "idle")
    ) {
      return Promise.resolve({
        sessionId: id,
        kind: nowKind,
        at: new Date().toISOString(),
        exitCode: s.info.exitCode,
        uiState: s.info.uiState,
      });
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = s.waiters.findIndex((w) => w.resolve === resolveWrapped);
        if (idx >= 0) s.waiters.splice(idx, 1);
        reject(
          new Error(
            `session_wait_event timed out after ${timeoutMs}ms (uiState=${s.info.uiState}, lastKind=${s.info.lastKind})`,
          ),
        );
      }, timeoutMs);
      timer.unref?.();

      const resolveWrapped = (event: SessionEvent) => {
        clearTimeout(timer);
        resolve(event);
      };
      s.waiters.push({
        kinds: kindSet,
        afterBusy,
        seenBusy: s.info.uiState === "busy",
        resolve: resolveWrapped,
        timer,
      });
    });
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) {
      try {
        this.kill(id, "SIGTERM");
      } catch {
        /* ignore */
      }
    }
  }

  private append(s: LiveSession, chunk: string): void {
    s.buffer += chunk;
    if (s.buffer.length > this.bufferChars) {
      const drop = s.buffer.length - this.bufferChars;
      s.buffer = s.buffer.slice(drop);
      s.cursor = Math.max(0, s.cursor - drop);
    }

    // OpenCode JSON runs: show pretty lines in the pane; keep raw JSON in buffer/export.
    let displayChunk = chunk;
    if (s.pretty) {
      displayChunk = s.pretty.push(chunk);
      if (s.pretty.opencodeSessionId && s.info.opencodeSessionId !== s.pretty.opencodeSessionId) {
        s.info.opencodeSessionId = s.pretty.opencodeSessionId;
        bus.emit("session:updated", this.status(s.info.id));
      }
    }

    if (s.screen) {
      s.screen.write(chunk);
    } else if (displayChunk) {
      this.appendPlain(s, displayChunk);
    }
    if (this.mirrorOutput && displayChunk) s.printer.write(displayChunk);

    // Answer terminal queries (cursor position, colors, DA) so OpenCode does not stall.
    if (s.ptyProcess) {
      const size = s.screen?.size ?? { cols: 120, rows: 40 };
      const answers = collectPtyAnswers(chunk, { row: size.rows, col: 1 });
      if (answers) {
        try {
          s.ptyProcess.write(answers);
        } catch {
          /* ignore */
        }
      }
    }

    const parsed = parseOpenTuiState(chunk);
    if (parsed) {
      this.setUiState(s, parsed, "osc");
    } else {
      // OpenCode often never emits OSC busy — infer from spinner / "Thought" on the VT frame.
      const frame = s.screen ? s.screen.snapshotSync() : stripAnsi(chunk);
      if (inferBusyFromScreen(frame) || inferBusyFromScreen(stripAnsi(chunk))) {
        s.expectBusy = false;
        this.setUiState(s, "busy", "screen");
        this.armIdleSettle(s, 2_500);
      } else if (s.info.uiState === "busy") {
        this.armIdleSettle(s, 2_500);
      }
    }

    const kind = classifyOutput(
      s.buffer.slice(-4000),
      s.info.exited,
      s.info.exitCode,
      s.info.uiState,
    );
    s.info.lastKind = kind;
    this.notifyWaiters(s, {
      sessionId: s.info.id,
      kind,
      at: new Date().toISOString(),
      chunk,
      exitCode: s.info.exitCode,
      uiState: s.info.uiState,
    });
  }

  private setUiState(s: LiveSession, next: UiBusyState, reason: string): void {
    if (s.info.uiState === next) return;
    s.info.uiState = next;
    log(`session UI id=${s.info.id} label=${s.info.label} uiState=${next} via=${reason}`);
    bus.emit("session:updated", this.status(s.info.id));
    const kind = classifyOutput("", false, null, next);
    s.info.lastKind = kind;
    this.notifyWaiters(s, {
      sessionId: s.info.id,
      kind,
      at: new Date().toISOString(),
      exitCode: s.info.exitCode,
      uiState: next,
    });
  }

  /** After activity stops, settle to idle (OpenCode rarely re-emits OSC idle). */
  private armIdleSettle(s: LiveSession, delayMs: number): void {
    if (s.idleCheckTimer) clearTimeout(s.idleCheckTimer);
    s.idleCheckTimer = setTimeout(() => {
      s.idleCheckTimer = undefined;
      if (s.info.exited) return;
      const frame = s.screen ? s.screen.snapshotSync() : s.buffer.slice(-2000);
      if (inferBusyFromScreen(frame)) {
        this.armIdleSettle(s, delayMs);
        return;
      }
      // If we marked busy on submit but never saw real activity, still go idle
      // so waiters unblock (prompt may have missed the composer).
      s.expectBusy = false;
      this.setUiState(s, "idle", "settle");
    }, delayMs);
    s.idleCheckTimer.unref?.();
  }

  private appendPlain(s: LiveSession, chunk: string): void {
    s.plainPending += stripAnsi(chunk);
    const parts = s.plainPending.split("\n");
    s.plainPending = parts.pop() ?? "";
    for (const line of parts) {
      s.plainLines.push(line);
    }
    const maxLines = 2_000;
    if (s.plainLines.length > maxLines) {
      s.plainLines.splice(0, s.plainLines.length - maxLines);
    }
  }

  private markExit(s: LiveSession, exitCode: number | null): void {
    s.info.exited = true;
    s.info.exitCode = exitCode;
    if (s.pretty) {
      const tail = s.pretty.flush();
      if (tail) this.appendPlain(s, tail);
      if (s.pretty.opencodeSessionId) {
        s.info.opencodeSessionId = s.pretty.opencodeSessionId;
      }
    }
    if (this.mirrorOutput) s.printer.flush();
    // Freeze display so the session stays browsable until Edge restarts.
    if (s.screen) {
      const frame = s.screen.snapshotSync();
      const footer = `\n── terminated (exit ${exitCode ?? "?"}) ──`;
      s.finalFrame = `${frame}${footer}`;
    } else {
      if (s.plainPending) {
        s.plainLines.push(s.plainPending);
        s.plainPending = "";
      }
      const oc =
        s.info.opencodeSessionId !== undefined
          ? `\n# opencodeSessionId=${s.info.opencodeSessionId}`
          : "";
      s.finalFrame = `${this.plainFrame(s)}${oc}\n── terminated (exit ${exitCode ?? "?"}) ──`;
    }
    const kind = classifyOutput(s.buffer.slice(-4000), true, exitCode, s.info.uiState);
    s.info.lastKind = kind;
    log(`session EXIT id=${s.info.id} label=${s.info.label} code=${exitCode} kind=${kind}`);
    bus.emit("session:exit", {
      sessionId: s.info.id,
      label: s.info.label,
      exitCode,
    });
    bus.emit("session:updated", this.status(s.info.id));
    this.notifyWaiters(s, {
      sessionId: s.info.id,
      kind,
      at: new Date().toISOString(),
      exitCode,
    });
  }

  private plainFrame(s: LiveSession): string {
    const lines = [...s.plainLines];
    if (s.plainPending) lines.push(s.plainPending);
    return lines.join("\n") || "(no output yet)";
  }

  private notifyWaiters(s: LiveSession, event: SessionEvent): void {
    const remaining: typeof s.waiters = [];
    for (const w of s.waiters) {
      if (event.kind === "busy") w.seenBusy = true;

      if (w.kinds && !w.kinds.has(event.kind)) {
        remaining.push(w);
        continue;
      }

      // Redraw spam: only wake on progress if it is the *sole* requested kind.
      if (event.kind === "progress") {
        if (!w.kinds || w.kinds.size !== 1 || !w.kinds.has("progress")) {
          remaining.push(w);
          continue;
        }
      }

      // afterBusy: ignore idle until we have seen busy since this wait started.
      if (event.kind === "idle" && w.afterBusy && !w.seenBusy) {
        remaining.push(w);
        continue;
      }

      if (!w.kinds && event.kind === "progress") {
        remaining.push(w);
        continue;
      }

      clearTimeout(w.timer);
      w.resolve(event);
    }
    s.waiters = remaining;
  }

  private async canUsePty(): Promise<boolean> {
    if (this.ptyAvailable !== null) return this.ptyAvailable;
    try {
      await import("node-pty");
      this.ptyAvailable = true;
    } catch {
      this.ptyAvailable = false;
    }
    return this.ptyAvailable;
  }

  private async spawnPty(
    live: LiveSession,
    cmd: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ): Promise<void> {
    const cols = 120;
    const rows = 40;
    live.screen = new TermScreen(cols, rows);
    const pty = await import("node-pty");
    const proc = pty.spawn(cmd, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: env as Record<string, string>,
    });
    live.ptyProcess = proc;
    proc.onData((data) => this.append(live, data));
    proc.onExit(({ exitCode }) => this.markExit(live, exitCode));
  }

  private spawnPipes(
    live: LiveSession,
    cmd: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ): void {
    const child = cpSpawn(cmd, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    live.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => this.append(live, d));
    child.stderr.on("data", (d: string) => this.append(live, d));
    child.on("error", (err) => {
      this.append(live, `\n[spawn error] ${err.message}\n`);
      this.markExit(live, 1);
    });
    child.on("close", (code) => this.markExit(live, code));
  }
}

/** Map friendly key names to PTY escape sequences. */
export function keyToSequence(name: string): string {
  const k = name.trim().toLowerCase();
  switch (k) {
    case "enter":
    case "return":
      return "\r";
    case "lf":
    case "newline":
      return "\n";
    case "esc":
    case "escape":
      return "\x1b";
    case "tab":
      return "\t";
    case "space":
      return " ";
    case "backspace":
    case "bs":
      return "\x7f";
    case "delete":
    case "del":
      return "\x1b[3~";
    case "up":
      return "\x1b[A";
    case "down":
      return "\x1b[B";
    case "right":
      return "\x1b[C";
    case "left":
      return "\x1b[D";
    case "home":
      return "\x1b[H";
    case "end":
      return "\x1b[F";
    case "pgup":
    case "pageup":
      return "\x1b[5~";
    case "pgdn":
    case "pagedown":
      return "\x1b[6~";
    case "ctrl-c":
    case "c-c":
      return "\x03";
    case "ctrl-d":
    case "c-d":
      return "\x04";
    case "ctrl-z":
    case "c-z":
      return "\x1a";
    case "ctrl-u":
    case "c-u":
      return "\x15";
    case "ctrl-a":
    case "c-a":
      return "\x01";
    case "ctrl-e":
    case "c-e":
      return "\x05";
    default:
      // Allow raw single characters or already-escaped sequences.
      if (name.length === 1) return name;
      if (name.startsWith("\x1b") || name.startsWith("\\x1b")) {
        return name.replace(/\\x1b/gi, "\x1b").replace(/\\r/g, "\r").replace(/\\n/g, "\n");
      }
      throw new Error(
        `Unknown key "${name}". Use enter, esc, tab, up/down/left/right, backspace, ctrl-c, …`,
      );
  }
}
