import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import blessed from "blessed";
import { bus } from "./bus.js";
import { log, setLogMirrorStdout, ts } from "./log.js";
import { createScope, resolveInScope } from "./scope.js";
import type { SessionInfo, SessionManager } from "./sessions.js";

const GLOBAL_ID = "__global__";
const MAX_GLOBAL_LINES = 4_000;

export interface TuiHandle {
  close(): void;
}

export function startTui(opts: {
  sessions: SessionManager;
  titleLines: string[];
  /** Directory used for Global MCP log exports (usually access root or cwd). */
  exportRoot?: string;
}): TuiHandle {
  setLogMirrorStdout(false);

  const globalLines: string[] = [];
  let selectedId = GLOBAL_ID;
  let listFocus = true;
  let followTail = true;
  let renderQueued = false;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;

  const screen = blessed.screen({
    smartCSR: true,
    fullUnicode: true,
    title: "rakazo-pc-edge",
    mouse: true,
  });

  const header = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: "100%",
    height: 2,
    tags: true,
    content: `{bold}rakazo-pc-edge{/bold}  ${opts.titleLines.join("  ")}`,
    style: { fg: "white", bg: "blue" },
  });

  const main = blessed.box({
    parent: screen,
    label: " Global (MCP) ",
    top: 2,
    left: 0,
    width: "70%",
    height: "100%-4",
    border: { type: "line" },
    tags: false,
    scrollable: true,
    alwaysScroll: true,
    mouse: true,
    keys: true,
    vi: true,
    scrollbar: { ch: " ", style: { bg: "cyan" } },
    style: {
      border: { fg: "cyan" },
      focus: { border: { fg: "green" } },
    },
  });

  const side = blessed.list({
    parent: screen,
    label: " Views ",
    top: 2,
    left: "70%",
    width: "30%",
    height: "100%-4",
    border: { type: "line" },
    keys: true,
    mouse: true,
    vi: true,
    tags: true,
    style: {
      selected: { bg: "blue", fg: "white", bold: true },
      item: { fg: "white" },
      border: { fg: "magenta" },
      focus: { border: { fg: "green" } },
    },
  });

  const footer = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: "100%",
    height: 2,
    tags: true,
    content:
      "{bold}↑↓{/bold} select  {bold}tab{/bold} focus  {bold}g{/bold} global  {bold}e{/bold}/{bold}C-e{/bold} export log  type→session  {bold}q{/bold} quit",
    style: { fg: "black", bg: "white" },
  });

  // Plain box + manual input (blessed textbox/readInput fights screen key handlers).
  const exportBox = blessed.box({
    parent: screen,
    bottom: 2,
    left: 0,
    width: "100%",
    height: 3,
    border: { type: "line" },
    label: " Export path — Enter save · Esc cancel · type to edit ",
    tags: false,
    hidden: true,
    style: {
      border: { fg: "yellow" },
      focus: { border: { fg: "green" } },
    },
  });

  void header;
  void footer;

  let exporting = false;
  let exportPath = "";

  function sessionLabel(s: SessionInfo): string {
    const short = s.id.slice(0, 8);
    const tag = s.exited ? "{red-fg}[T]{/}" : "{green-fg}[A]{/}";
    const code = s.exited ? ` exit=${s.exitCode ?? "?"}` : "";
    const ui =
      !s.exited && s.uiState && s.uiState !== "unknown"
        ? s.uiState === "busy"
          ? " {yellow-fg}busy{/}"
          : " {cyan-fg}idle{/}"
        : "";
    return `${tag} ${s.label} (${short})${ui}${code}`;
  }

  function mainInnerSize(): { cols: number; rows: number } {
    // Prefer measured widget size after render; fall back to ~70% of screen.
    const scr = screen as unknown as { width?: number; height?: number };
    const mw = typeof main.width === "number" ? main.width : Math.floor((scr.width ?? 100) * 0.7);
    const mh = typeof main.height === "number" ? main.height : Math.max(12, (scr.height ?? 30) - 4);
    return {
      cols: Math.max(40, mw - 2),
      rows: Math.max(10, mh - 2),
    };
  }

  function resizeSelectedSession(): void {
    if (selectedId === GLOBAL_ID) return;
    const { cols, rows } = mainInnerSize();
    try {
      opts.sessions.resize(selectedId, cols, rows);
    } catch {
      /* session may be gone */
    }
  }

  function scheduleResize(): void {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeSelectedSession();
      void renderMain();
    }, 80);
  }

  function refreshList(): void {
    const sessions = opts.sessions.list();
    const items = [`{bold}Global (MCP){/bold}`, ...sessions.map((s) => sessionLabel(s))];
    side.setItems(items);
    if (selectedId === GLOBAL_ID) side.select(0);
    else {
      const idx = sessions.findIndex((s) => s.id === selectedId);
      side.select(idx >= 0 ? idx + 1 : 0);
      if (idx < 0) selectedId = GLOBAL_ID;
    }
    screen.render();
  }

  async function renderMain(): Promise<void> {
    if (selectedId === GLOBAL_ID) {
      main.setLabel(" Global (MCP) ");
      main.setContent(globalLines.join("\n"));
      if (followTail) {
        try {
          main.setScrollPerc?.(100);
        } catch {
          /* ignore */
        }
      }
    } else {
      const sessions = opts.sessions.list();
      const info = sessions.find((s) => s.id === selectedId);
      const label = info ? sessionLabel(info) : selectedId.slice(0, 8);
      main.setLabel(` Session: ${label} `);
      try {
        const frame = await opts.sessions.getDisplayFrame(selectedId);
        main.setContent(frame);
        // VT frame is a fixed viewport — pin to top (not a growing log).
        try {
          main.setScrollPerc?.(0);
        } catch {
          /* ignore */
        }
      } catch {
        main.setContent("(session gone)");
      }
    }
    screen.render();
  }

  function queueRender(): void {
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(() => {
      renderQueued = false;
      void renderMain();
    }, 33);
  }

  function selectGlobal(): void {
    selectedId = GLOBAL_ID;
    side.select(0);
    followTail = true;
    void renderMain();
  }

  function selectSessionByIndex(listIndex: number): void {
    if (listIndex <= 0) {
      selectGlobal();
      return;
    }
    const sessions = opts.sessions.list();
    const s = sessions[listIndex - 1];
    if (!s) return;
    selectedId = s.id;
    followTail = true;
    resizeSelectedSession();
    void renderMain();
  }

  side.on("select", (_item: unknown, index: unknown) => {
    if (typeof index === "number") selectSessionByIndex(index);
  });
  side.on("click", () => {
    listFocus = true;
    side.focus();
    selectSessionByIndex(side.selected);
  });

  main.on("click", () => {
    listFocus = false;
    main.focus();
    screen.render();
  });

  screen.key(["C-c"], () => {
    if (exporting) {
      void completeExport(false);
      return;
    }
    cleanup();
    process.exit(0);
  });

  screen.key(["q"], () => {
    if (exporting) return;
    if (!listFocus && selectedId !== GLOBAL_ID) return;
    cleanup();
    process.exit(0);
  });

  screen.key(["g"], () => {
    if (exporting) return;
    if (!listFocus && selectedId !== GLOBAL_ID) return;
    selectGlobal();
  });

  // While the export prompt is open, also accept Enter/Esc at screen level
  // (textbox grabKeys is flaky across blessed versions).
  screen.key(["enter"], () => {
    if (!exporting) return;
    void completeExport(true);
  });
  screen.key(["escape"], () => {
    if (!exporting) return;
    void completeExport(false);
  });

  screen.key(["tab"], () => {
    if (exporting) return;
    listFocus = !listFocus;
    if (listFocus) side.focus();
    else main.focus();
    screen.render();
  });

  async function defaultExportPath(): Promise<string> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    if (selectedId === GLOBAL_ID) {
      const root = opts.exportRoot ?? process.cwd();
      return path.join(root, "edge-logs", `global-mcp-${stamp}.log`);
    }
    return opts.sessions.defaultExportPath(selectedId);
  }

  function flashFooter(msg: string): void {
    footer.setContent(`{bold}${msg}{/bold}`);
    screen.render();
    setTimeout(() => {
      footer.setContent(
        "{bold}↑↓{/bold} select  {bold}tab{/bold} focus  {bold}g{/bold} global  {bold}e{/bold}/{bold}C-e{/bold} export log  type→session  {bold}q{/bold} quit",
      );
      screen.render();
    }, 4_000);
  }

  function refreshExportBox(): void {
    exportBox.setContent(exportPath + "█");
    screen.render();
  }

  async function completeExport(save: boolean): Promise<void> {
    if (!exporting) return;
    const raw = exportPath.trim();
    exporting = false;
    exportBox.hide();
    exportBox.hidden = true;
    if (listFocus) side.focus();
    else main.focus();
    screen.render();

    if (!save || raw === "") {
      flashFooter("Export cancelled");
      return;
    }
    try {
      if (selectedId === GLOBAL_ID) {
        const root = opts.exportRoot ?? process.cwd();
        const scope = createScope({ workerDir: root });
        const abs = resolveInScope(scope, raw);
        await mkdir(path.dirname(abs), { recursive: true });
        const body = [
          "# rakazo-pc-edge Global (MCP) export",
          `# exportedAt=${new Date().toISOString()}`,
          "",
          ...globalLines,
          "",
        ].join("\n");
        await writeFile(abs, body, "utf8");
        log(`global EXPORT path=${abs}`);
        flashFooter(`Exported Global MCP log → ${abs}`);
      } else {
        const abs = await opts.sessions.exportSessionLog(selectedId, raw);
        flashFooter(`Exported session log → ${abs}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      flashFooter(`Export failed: ${msg}`);
    }
  }

  async function beginExport(): Promise<void> {
    if (exporting) return;
    exporting = true;
    exportPath = await defaultExportPath();
    exportBox.hidden = false;
    exportBox.show();
    exportBox.setFront?.();
    exportBox.focus();
    refreshExportBox();
  }

  // e when list/global focused; Ctrl+e always (so typing into a session still works).
  screen.key(["e"], () => {
    if (exporting) return;
    if (!listFocus && selectedId !== GLOBAL_ID) return;
    void beginExport();
  });
  screen.key(["C-e"], () => {
    if (exporting) return;
    void beginExport();
  });

  screen.on("resize", () => scheduleResize());

  // Export prompt editing + session key forwarding.
  screen.on("keypress", (ch: unknown, key: unknown) => {
    const k = key as {
      name?: string;
      ctrl?: boolean;
      meta?: boolean;
      full?: string;
      sequence?: string;
    };
    if (!k) return;

    if (exporting) {
      if (k.name === "enter" || k.name === "return" || k.name === "escape") return; // screen.key handles these
      if (k.name === "backspace" || k.full === "C-h") {
        exportPath = exportPath.slice(0, -1);
        refreshExportBox();
        return;
      }
      if (k.ctrl || k.meta) return;
      if (typeof ch === "string" && ch.length === 1 && ch >= " ") {
        exportPath += ch;
        refreshExportBox();
      }
      return;
    }

    if (listFocus || selectedId === GLOBAL_ID) return;
    if (k.ctrl || k.meta) return;
    if (k.name === "tab" || k.name === "q" || k.name === "e" || k.full === "C-c") return;
    if (k.name === "up" || k.name === "down" || k.name === "left" || k.name === "right") {
      // Arrow keys: forward to the app (OpenCode menus), not scroll the VT frame.
      const seq =
        k.name === "up"
          ? "\x1b[A"
          : k.name === "down"
            ? "\x1b[B"
            : k.name === "right"
              ? "\x1b[C"
              : "\x1b[D";
      try {
        opts.sessions.stdin(selectedId, seq, { raw: true });
      } catch {
        /* ignore */
      }
      return;
    }
    if (k.name === "escape") {
      // Esc → session first (many TUIs use it); double-Esc / list focus via Tab.
      try {
        opts.sessions.stdin(selectedId, "\x1b", { raw: true });
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      let data = "";
      if (k.name === "return" || k.name === "enter") data = "\r";
      else if (k.name === "backspace") data = "\x7f";
      else if (typeof ch === "string" && ch && !k.name?.startsWith("f")) data = ch;
      else if (k.sequence) data = k.sequence;
      if (data) opts.sessions.stdin(selectedId, data, { raw: true });
    } catch {
      /* session may have exited */
    }
  });

  bus.on("global:line", ({ at, text }) => {
    for (const line of text.split("\n")) {
      globalLines.push(`[${at}] ${line}`);
    }
    if (globalLines.length > MAX_GLOBAL_LINES) {
      globalLines.splice(0, globalLines.length - MAX_GLOBAL_LINES);
    }
    if (selectedId === GLOBAL_ID) queueRender();
  });

  bus.on("session:spawn", () => {
    refreshList();
  });
  bus.on("session:updated", () => {
    refreshList();
  });
  bus.on("session:exit", () => {
    refreshList();
    if (selectedId !== GLOBAL_ID) queueRender();
  });
  bus.on("session:output", ({ sessionId }) => {
    if (sessionId === selectedId) queueRender();
  });

  globalLines.push(
    `[${ts()}] TUI ready — Global = MCP traffic; session views use a VT screen mirror (OpenCode-safe).`,
  );
  refreshList();
  selectGlobal();
  side.focus();
  screen.render();
  scheduleResize();

  function cleanup(): void {
    clearTimeout(resizeTimer);
    setLogMirrorStdout(true);
    screen.destroy();
  }

  return { close: cleanup };
}
