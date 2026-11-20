import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { AccessScope } from "./scope.js";
import {
  DEFAULT_CHUNK_BYTES,
  fileInfoTool,
  listDir,
  MAX_CHUNK_BYTES,
  MAX_TRANSFER_BYTES,
  readFileChunkTool,
  readFileTool,
  shellTool,
  writeFileChunkTool,
  writeFileTool,
} from "./fs-tools.js";
import {
  opencodeCreateSession,
  opencodeListModelRefs,
  opencodeListModels,
  opencodeListProviders,
  opencodeListSessions,
  opencodeSpawnRun,
  opencodeWaitIdle,
  resolveOpencodeCwd,
} from "./opencode.js";
import { SessionManager } from "./sessions.js";
import type { SessionEventKind } from "./classify.js";
import { log, logBlock, summarize } from "./log.js";
import { sandboxBackend } from "./privilege.js";
import { formatToolName, type EdgeInstance } from "./instance.js";
import type { DesktopController } from "./desktop/index.js";

function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true as const,
  };
}

type ToolExtra = Record<string, unknown>;

function wrapTool<Args extends ToolExtra>(
  name: string,
  handler: (args: Args) => Promise<ReturnType<typeof jsonResult> | ReturnType<typeof errorResult>>,
) {
  return async (args: Args) => {
    const started = Date.now();
    log(`← tool ${name} args=${summarize(args)}`);
    try {
      const result = await handler(args);
      const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
      const flag = "isError" in result && result.isError ? "ERROR" : "ok";
      logBlock(`→ tool ${name} [${flag}] ${Date.now() - started}ms`, summarize(safeParse(text)));
      return result;
    } catch (err) {
      log(`→ tool ${name} THREW ${Date.now() - started}ms:`, err instanceof Error ? err.message : err);
      throw err;
    }
  };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function describeMcpBody(body: unknown): string {
  if (body == null) return "(empty)";
  if (Array.isArray(body)) {
    return body.map((item) => describeOneRpc(item)).join("\n");
  }
  return describeOneRpc(body);
}

function describeOneRpc(body: unknown): string {
  if (!body || typeof body !== "object") return summarize(body);
  const msg = body as Record<string, unknown>;
  const method = typeof msg.method === "string" ? msg.method : undefined;
  const id = msg.id;
  if (method === "tools/call") {
    const params = (msg.params ?? {}) as Record<string, unknown>;
    return `id=${summarize(id)} tools/call name=${params.name} arguments=${summarize(params.arguments)}`;
  }
  if (method) return `id=${summarize(id)} method=${method} params=${summarize(msg.params)}`;
  if ("result" in msg) return `id=${summarize(id)} result=${summarize(msg.result)}`;
  if ("error" in msg) return `id=${summarize(id)} error=${summarize(msg.error)}`;
  return summarize(body);
}

export function createEdgeMcp(
  scope: AccessScope,
  sessions: SessionManager,
  instance: EdgeInstance,
  desktop?: DesktopController,
) {
  const t = (leaf: string) => formatToolName(instance, leaf);
  const server = new McpServer({
    name: `rakazo-pc-edge:${instance.name}`,
    version: "0.1.0",
  });

  server.tool(
    t("info"),
    "PC Edge: describe access scope/root on the user's real computer (paths here need edge_read_file / edge_list_dir, not bot sandbox tools)",
    {},
    wrapTool(t("info"), async () =>
      jsonResult({
        name: instance.name,
        nameSource: instance.nameSource,
        toolStyle: instance.toolStyle,
        toolExample: t("info"),
        toolPrefix:
          instance.toolStyle === "bare"
            ? "edge_"
            : instance.toolStyle === "prefix"
              ? `${instance.name}_edge_`
              : instance.toolStyle === "suffix"
                ? "edge_*_" + instance.name
                : `edge_${instance.name}_`,
        mode: scope.mode,
        root: scope.root,
        privilege: scope.privilege,
        sandboxedProcesses: scope.privilege === "sandbox",
        sandboxBackend:
          scope.privilege === "sandbox"
            ? (() => {
                try {
                  return sandboxBackend();
                } catch {
                  return null;
                }
              })()
            : null,
        platform: process.platform,
        cwd: process.cwd(),
        hostname: instance.hostname,
        machineId: instance.machineId,
        sessions: sessions.list().length,
        desktopEnabled: Boolean(desktop?.isEnabled()),
        privilegeHelp: {
          sandbox:
            "default — file tools + shell/sessions/OpenCode under OS jail (bwrap on Linux, Seatbelt on macOS)",
          "half-god": "file tools stay in root; shell/sessions can reach the whole PC",
          god: "full PC access for tools and shell (--god / --global)",
        },
      }),
    ),
  );

  // All tools are prefixed with edge_ so they do not collide with Rakazo's
  // built-in sandbox tools (read_file, shell, list_dir, …) which only see the bot computer.
  server.tool(
    t("list_dir"),
    "PC Edge: list files on the user's real computer under the Edge access root (not the bot sandbox)",
    { path: z.string().optional().describe("Relative or absolute path under the Edge access root") },
    wrapTool(t("list_dir"), async ({ path: p }) => {
      try {
        return jsonResult({ path: p ?? ".", entries: await listDir(scope, p ?? ".") });
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.tool(
    t("read_file"),
    "PC Edge: read a small file (≤2 MiB) on the user's computer. For larger files (up to 200 MiB) use edge_file_info + edge_file_read_chunk.",
    {
      path: z.string(),
      maxBytes: z.number().int().positive().optional(),
      allowSecrets: z.boolean().optional(),
    },
    wrapTool(t("read_file"), async (args) => {
      try {
        return jsonResult(await readFileTool(scope, args.path, args));
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.tool(
    t("write_file"),
    "PC Edge: write a small file (≤2 MiB) on the user's computer. For larger files (up to 200 MiB) use edge_file_write_chunk.",
    {
      path: z.string(),
      content: z.string(),
      encoding: z.enum(["utf8", "base64"]).optional(),
      allowSecrets: z.boolean().optional(),
    },
    wrapTool(t("write_file"), async (args) => {
      try {
        return jsonResult(await writeFileTool(scope, args.path, args.content, args));
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.tool(
    t("file_info"),
    "PC Edge: file size/mtime for transfers. Use before chunked download (edge_file_read_chunk) or to verify uploads. Limits: 200 MiB total, ≤1 MiB per chunk (default 512 KiB).",
    {
      path: z.string(),
      allowSecrets: z.boolean().optional(),
    },
    wrapTool(t("file_info"), async ({ path: p, allowSecrets }) => {
      try {
        return jsonResult(await fileInfoTool(scope, p, { allowSecrets }));
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.tool(
    t("file_read_chunk"),
    `PC Edge: download a file chunk as base64 (large files up to ${MAX_TRANSFER_BYTES} bytes / 200 MiB). Loop: start offset=0, then use nextOffset until eof=true. Default chunk ${DEFAULT_CHUNK_BYTES} bytes, max ${MAX_CHUNK_BYTES}.`,
    {
      path: z.string(),
      offset: z.number().int().nonnegative().optional(),
      length: z
        .number()
        .int()
        .positive()
        .max(MAX_CHUNK_BYTES)
        .optional()
        .describe(`Raw bytes to read (default ${DEFAULT_CHUNK_BYTES}, max ${MAX_CHUNK_BYTES})`),
      allowSecrets: z.boolean().optional(),
    },
    wrapTool(t("file_read_chunk"), async (args) => {
      try {
        return jsonResult(await readFileChunkTool(scope, args.path, args));
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.tool(
    t("file_write_chunk"),
    `PC Edge: upload a file chunk (large files up to ${MAX_TRANSFER_BYTES} bytes / 200 MiB). Protocol: first call offset=0 (truncates by default) with base64 content; then offset=nextOffset for each chunk. Max chunk ${MAX_CHUNK_BYTES} raw bytes.`,
    {
      path: z.string(),
      content: z.string().describe("Chunk payload"),
      encoding: z.enum(["utf8", "base64"]).optional().describe("Default base64 for binary"),
      offset: z.number().int().nonnegative().optional(),
      truncate: z
        .boolean()
        .optional()
        .describe("When offset=0: default true (create/replace). Set false to overwrite in place."),
      allowSecrets: z.boolean().optional(),
    },
    wrapTool(t("file_write_chunk"), async (args) => {
      try {
        return jsonResult(
          await writeFileChunkTool(scope, args.path, args.content, {
            offset: args.offset,
            encoding: args.encoding,
            truncate: args.truncate,
            allowSecrets: args.allowSecrets,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.tool(
    t("shell"),
    "PC Edge: short shell on the user's real computer (not the bot sandbox). For long-lived agents use edge_session_spawn",
    {
      command: z.string(),
      cwd: z.string().optional(),
      timeoutMs: z.number().int().positive().optional(),
    },
    wrapTool(t("shell"), async (args) => {
      try {
        return jsonResult(await shellTool(scope, args.command, args));
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.tool(
    t("session_spawn"),
    "PC Edge: start a long-lived process/PTY on the user's computer. Generic interactive apps use this + stdin/keys/snapshot. For OpenCode prefer edge_opencode_run (API/CLI) instead of steering the TUI.",
    {
      cmd: z.string(),
      args: z.array(z.string()).optional(),
      cwd: z.string().optional(),
      env: z.record(z.string()).optional(),
      pty: z.boolean().optional(),
      label: z.string().optional(),
    },
    wrapTool(t("session_spawn"), async (args) => {
      try {
        return jsonResult(await sessions.spawn(args));
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.tool(
    t("session_list"),
    "PC Edge: list concurrent process sessions",
    {},
    wrapTool(t("session_list"), async () => jsonResult({ sessions: sessions.list() })),
  );

  server.tool(
    t("session_status"),
    "PC Edge: status of one session (includes uiState: idle|busy|unknown from OpenCode OSC)",
    { sessionId: z.string() },
    wrapTool(t("session_status"), async ({ sessionId }) => {
      try {
        return jsonResult(sessions.status(sessionId));
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.tool(
    t("session_read"),
    "PC Edge: raw PTY/stdout buffer since a char offset (ANSI-heavy). Prefer edge_session_snapshot for readable OpenCode screens. Includes uiState.",
    {
      sessionId: z.string(),
      since: z.number().int().nonnegative().optional(),
    },
    wrapTool(t("session_read"), async ({ sessionId, since }) => {
      try {
        return jsonResult(sessions.read(sessionId, since ?? 0));
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.tool(
    t("session_snapshot"),
    "PC Edge: plain-text decoded screen of a session (what a human sees in the Edge TUI). Use this to monitor OpenCode instead of raw edge_session_read. Returns uiState (idle|busy).",
    { sessionId: z.string() },
    wrapTool(t("session_snapshot"), async ({ sessionId }) => {
      try {
        return jsonResult(await sessions.snapshot(sessionId));
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.tool(
    t("session_stdin"),
    "PC Edge: type into a live PTY/session. For TUIs set submit=true (Enter as \\r). For OpenCode chat follow-ups prefer edge_session_prompt or edge_opencode_*.",
    {
      sessionId: z.string(),
      data: z.string().describe("Text to type into the session"),
      submit: z
        .boolean()
        .optional()
        .describe("If true, type data then press Enter (required to submit OpenCode prompts)"),
      raw: z
        .boolean()
        .optional()
        .describe("If true, send data unchanged (no automatic Enter)"),
    },
    wrapTool(t("session_stdin"), async ({ sessionId, data, submit, raw }) => {
      try {
        sessions.stdin(sessionId, data, { submit, raw });
        return jsonResult({ ok: true, sessionId, submit: Boolean(submit), raw: Boolean(raw) });
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.tool(
    t("session_prompt"),
    "PC Edge: send a chat prompt into a live TUI session (Esc Esc to leave shell/panels, then type+Enter). Prefer edge_opencode_run / edge_opencode_prompt for OpenCode.",
    {
      sessionId: z.string(),
      text: z.string().describe("Prompt text to submit"),
    },
    wrapTool(t("session_prompt"), async ({ sessionId, text }) => {
      try {
        sessions.prompt(sessionId, text);
        return jsonResult({ ok: true, sessionId });
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.tool(
    t("session_keys"),
    "PC Edge: send special keys to a PTY session (OpenCode navigation/submit). Keys: enter, esc, tab, up, down, left, right, backspace, ctrl-c, ctrl-d, ctrl-u, home, end, …",
    {
      sessionId: z.string(),
      keys: z
        .array(z.string())
        .min(1)
        .describe("Ordered key names, e.g. [\"enter\"] or [\"esc\",\"enter\"]"),
    },
    wrapTool(t("session_keys"), async ({ sessionId, keys }) => {
      try {
        sessions.sendKeys(sessionId, keys);
        return jsonResult({ ok: true, sessionId, keys });
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.tool(
    t("session_kill"),
    "PC Edge: stop an active process session (SIGTERM by default). Use this from Rakazo to tear down stuck OpenCode/PTY sessions. Session stays listed as exited until edge_session_remove.",
    {
      sessionId: z.string(),
      signal: z.string().optional(),
    },
    wrapTool(t("session_kill"), async ({ sessionId, signal }) => {
      try {
        sessions.kill(sessionId, (signal as NodeJS.Signals) || "SIGTERM");
        return jsonResult({ ok: true, sessionId });
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.tool(
    t("session_remove"),
    "PC Edge: drop an exited session from the list (must edge_session_kill first if still active).",
    { sessionId: z.string() },
    wrapTool(t("session_remove"), async ({ sessionId }) => {
      try {
        sessions.remove(sessionId);
        return jsonResult({ ok: true, sessionId });
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.tool(
    t("session_wait_event"),
    "PC Edge: block until a meaningful session event. For OpenCode (stays running), wait for kinds=[\"idle\"] with afterBusy=true after you submit work — that means the agent finished. Do NOT rely on \"done\" (process exit) or \"progress\" (every redraw). Prefer kinds idle|busy|question|permission|error; use progress alone only if you want redraw spam.",
    {
      sessionId: z.string(),
      kinds: z
        .array(
          z.enum([
            "progress",
            "question",
            "permission",
            "done",
            "error",
            "idle",
            "busy",
          ]),
        )
        .optional(),
      timeoutMs: z.number().int().positive().optional(),
      afterBusy: z
        .boolean()
        .optional()
        .describe(
          "When waiting for idle: require a busy period first (use after edge_session_stdin submit). Ignores the idle state that was already true before work started.",
        ),
    },
    wrapTool(t("session_wait_event"), async ({ sessionId, kinds, timeoutMs, afterBusy }) => {
      try {
        const event = await sessions.waitEvent(
          sessionId,
          kinds as SessionEventKind[] | undefined,
          timeoutMs ?? 120_000,
          { afterBusy },
        );
        return jsonResult(event);
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  // ── Dedicated OpenCode driver (prefer over TUI steering) ─────────────────

  server.tool(
    t("opencode_models"),
    "List available OpenCode models. Each entry has `ref` (provider/model) for edge_opencode_run / edge_opencode_prompt / edge_opencode_test_model `model` param. Set detailed=false for just ref strings.",
    {
      cwd: z.string().optional(),
      detailed: z
        .boolean()
        .optional()
        .describe("Default true — full model list via API. false = quick `opencode models` refs only."),
    },
    wrapTool(t("opencode_models"), async ({ cwd, detailed }) => {
      try {
        const dir = cwd ? resolveOpencodeCwd(scope, cwd) : undefined;
        if (detailed === false) {
          const refs = await opencodeListModelRefs({ cwd: dir, scope });
          return jsonResult({ refs });
        }
        const models = await opencodeListModels({ cwd: dir, scope });
        return jsonResult({
          models,
          hint: "Pass model: \"<ref>\" to edge_opencode_run / edge_opencode_prompt / edge_opencode_test_model",
        });
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.tool(
    t("opencode_providers"),
    "List OpenCode providers (apiKey redacted). Use with edge_opencode_models to pick a model ref.",
    { cwd: z.string().optional() },
    wrapTool(t("opencode_providers"), async ({ cwd }) => {
      try {
        const dir = cwd ? resolveOpencodeCwd(scope, cwd) : undefined;
        const providers = await opencodeListProviders({ cwd: dir, scope });
        return jsonResult({ providers });
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.tool(
    t("opencode_test_model"),
    "Smoke-test a model: short `opencode run --model <ref>` asking for a one-word reply. Wait with edge_session_wait_event kinds=[\"done\",\"error\"], then edge_session_snapshot / status.",
    {
      model: z.string().describe("Model ref from edge_opencode_models, e.g. opencode/big-pickle"),
      cwd: z.string().optional(),
      message: z
        .string()
        .optional()
        .describe("Override test prompt (default: reply with only the word pong)"),
      label: z.string().optional(),
      standalone: z.boolean().optional(),
    },
    wrapTool(t("opencode_test_model"), async ({ model, cwd, message, label, standalone }) => {
      try {
        return jsonResult(
          await opencodeSpawnRun(scope, sessions, {
            message: message ?? "Reply with only the single word: pong",
            cwd,
            model,
            title: `model-test ${model}`,
            label: label ?? `opencode-test ${model}`,
            standalone,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.tool(
    t("opencode_run"),
    "PREFERRED for OpenCode: spawn `opencode run --standalone --auto --format json <message>` as a live Edge session (pretty tool/text logs in the session pane). Optional model: \"provider/model\" from edge_opencode_models. Process exit = done — wait with edge_session_wait_event kinds=[\"done\",\"error\"]. After finish, edge_session_status includes opencodeSessionId (ses_…) for edge_opencode_prompt resume. Verify with edge_list_dir / edge_read_file.",
    {
      message: z.string().describe("Task prompt for OpenCode"),
      cwd: z.string().optional().describe("Working directory under Edge scope"),
      sessionId: z.string().optional().describe("Continue an existing OpenCode session id"),
      continueLast: z.boolean().optional().describe("Pass --continue"),
      title: z.string().optional(),
      model: z
        .string()
        .optional()
        .describe("Model ref provider/model from edge_opencode_models (passed as --model)"),
      label: z.string().optional(),
      standalone: z
        .boolean()
        .optional()
        .describe("Default true — private server (avoid shared background TUI service)"),
    },
    wrapTool(t("opencode_run"), async (args) => {
      try {
        return jsonResult(await opencodeSpawnRun(scope, sessions, args));
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.tool(
    t("opencode_session_create"),
    "OpenCode API: create a multi-turn session bound to a directory (location.directory). Then use edge_opencode_prompt + edge_opencode_wait_idle.",
    {
      cwd: z.string().optional(),
      title: z.string().optional(),
    },
    wrapTool(t("opencode_session_create"), async ({ cwd, title }) => {
      try {
        const dir = resolveOpencodeCwd(scope, cwd);
        const session = await opencodeCreateSession({ cwd: dir, title, scope });
        return jsonResult({ session, cwd: dir });
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.tool(
    t("opencode_prompt"),
    "Resume an OpenCode session with a follow-up: spawns a LIVE `opencode run --session <ses_…>` Edge session (pretty logs in the session pane). Optional model override. Wait with edge_session_wait_event kinds=[\"done\",\"error\"].",
    {
      opencodeSessionId: z.string().describe("OpenCode session id (ses_…), not Edge session id"),
      text: z.string(),
      cwd: z.string().optional(),
      title: z.string().optional(),
      model: z
        .string()
        .optional()
        .describe("Optional model ref provider/model from edge_opencode_models"),
      label: z.string().optional(),
      standalone: z.boolean().optional(),
    },
    wrapTool(
      t("opencode_prompt"),
      async ({ opencodeSessionId, text, cwd, title, model, label, standalone }) => {
        try {
          return jsonResult(
            await opencodeSpawnRun(scope, sessions, {
              message: text,
              cwd,
              sessionId: opencodeSessionId,
              title,
              model,
              label: label ?? `opencode-continue ${opencodeSessionId.slice(0, 18)}`,
              standalone,
            }),
          );
        } catch (err) {
          return errorResult(err);
        }
      },
    ),
  );

  server.tool(
    t("opencode_sessions"),
    "OpenCode API: list OpenCode sessions (session.list).",
    { cwd: z.string().optional() },
    wrapTool(t("opencode_sessions"), async ({ cwd }) => {
      try {
        const dir = cwd ? resolveOpencodeCwd(scope, cwd) : undefined;
        const list = await opencodeListSessions({ cwd: dir, scope });
        return jsonResult({ sessions: list });
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.tool(
    t("opencode_wait_idle"),
    "OpenCode API poll helper (rarely needed). For edge_opencode_run / edge_opencode_prompt, wait with edge_session_wait_event kinds=[\"done\",\"error\"] on the Edge session instead — those are live processes with session-pane logs.",
    {
      opencodeSessionId: z.string(),
      cwd: z.string().optional(),
      timeoutMs: z.number().int().positive().optional(),
      afterBusy: z.boolean().optional(),
    },
    wrapTool(t("opencode_wait_idle"), async ({ opencodeSessionId, cwd, timeoutMs, afterBusy }) => {
      try {
        const dir = cwd ? resolveOpencodeCwd(scope, cwd) : undefined;
        const session = await opencodeWaitIdle({
          sessionId: opencodeSessionId,
          cwd: dir,
          scope,
          timeoutMs,
          afterBusy,
        });
        return jsonResult({ session });
      } catch (err) {
        return errorResult(err);
      }
    }),
  );


  // ── Desktop / computer-use (native + VNC hybrid; vincent-vnc-mcp inspired) ─
  if (desktop?.isEnabled()) {
    server.tool(
      t("desktop_info"),
      "PC Edge desktop: capabilities for hybrid computer-use (native screenshot/input and/or local VNC). Call before screen/mouse tools.",
      {},
      wrapTool(t("desktop_info"), async () => {
        try {
          return jsonResult(await desktop.capabilities());
        } catch (err) {
          return errorResult(err);
        }
      }),
    );

    server.tool(
      t("desktop_snapshot"),
      "Capture the desktop as JPEG (base64). Uses VNC frame cache when connected, else native screenshot. Optional region + maxWidth.",
      {
        maxWidth: z.number().int().positive().optional(),
        quality: z.number().int().min(1).max(100).optional(),
        x: z.number().int().optional(),
        y: z.number().int().optional(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
      },
      wrapTool(t("desktop_snapshot"), async (args) => {
        try {
          const region =
            args.x != null && args.y != null && args.width != null && args.height != null
              ? { x: args.x, y: args.y, width: args.width, height: args.height }
              : undefined;
          const frame = await desktop.snapshot({
            maxWidth: args.maxWidth,
            quality: args.quality,
            region,
          });
          return jsonResult({
            width: frame.width,
            height: frame.height,
            format: frame.format,
            backend: frame.backend,
            capturedAt: frame.capturedAt,
            bytes: frame.bytes.length,
            contentBase64: frame.bytes.toString("base64"),
          });
        } catch (err) {
          return errorResult(err);
        }
      }),
    );

    server.tool(
      t("desktop_screen_size"),
      "Return desktop width/height in pixels (VNC or native).",
      {},
      wrapTool(t("desktop_screen_size"), async () => {
        try {
          return jsonResult(await desktop.screenSize());
        } catch (err) {
          return errorResult(err);
        }
      }),
    );

    server.tool(
      t("desktop_mouse_move"),
      "Move the mouse to absolute screen coordinates (x, y).",
      { x: z.number(), y: z.number() },
      wrapTool(t("desktop_mouse_move"), async ({ x, y }) => {
        try {
          return jsonResult(await desktop.move(x, y));
        } catch (err) {
          return errorResult(err);
        }
      }),
    );

    server.tool(
      t("desktop_mouse_click"),
      "Click at (x, y). button: left|middle|right. double: true for double-click.",
      {
        x: z.number(),
        y: z.number(),
        button: z.enum(["left", "middle", "right"]).optional(),
        double: z.boolean().optional(),
      },
      wrapTool(t("desktop_mouse_click"), async ({ x, y, button, double }) => {
        try {
          return jsonResult(await desktop.click(x, y, button ?? "left", Boolean(double)));
        } catch (err) {
          return errorResult(err);
        }
      }),
    );

    server.tool(
      t("desktop_mouse_scroll"),
      "Scroll at (x, y). Negative dy scrolls up, positive down (wheel clicks).",
      { x: z.number(), y: z.number(), dy: z.number().int() },
      wrapTool(t("desktop_mouse_scroll"), async ({ x, y, dy }) => {
        try {
          return jsonResult(await desktop.scroll(x, y, dy));
        } catch (err) {
          return errorResult(err);
        }
      }),
    );

    server.tool(
      t("desktop_mouse_drag"),
      "Press at (x1,y1), drag to (x2,y2), release (vincent-style). button: left|middle|right.",
      {
        x1: z.number(),
        y1: z.number(),
        x2: z.number(),
        y2: z.number(),
        button: z.enum(["left", "middle", "right"]).optional(),
      },
      wrapTool(t("desktop_mouse_drag"), async ({ x1, y1, x2, y2, button }) => {
        try {
          return jsonResult(await desktop.drag(x1, y1, x2, y2, button ?? "left"));
        } catch (err) {
          return errorResult(err);
        }
      }),
    );

    server.tool(
      t("desktop_wait_change"),
      "Block until the screen changes (VNC frame-size proxy or native snapshot compare) or timeout.",
      {
        timeoutMs: z.number().int().positive().optional(),
        pollIntervalMs: z.number().int().positive().optional(),
      },
      wrapTool(t("desktop_wait_change"), async ({ timeoutMs, pollIntervalMs }) => {
        try {
          return jsonResult(await desktop.waitForScreenChange(timeoutMs, pollIntervalMs));
        } catch (err) {
          return errorResult(err);
        }
      }),
    );

    server.tool(
      t("desktop_type"),
      "Type literal text into the focused UI (VNC or native).",
      { text: z.string() },
      wrapTool(t("desktop_type"), async ({ text }) => {
        try {
          return jsonResult(await desktop.type(text));
        } catch (err) {
          return errorResult(err);
        }
      }),
    );

    server.tool(
      t("desktop_keys"),
      "Press a key or chord, e.g. [\"enter\"] or [\"cmd\",\"c\"]. Names: enter, esc, tab, cmd/ctrl/alt/shift, arrows, letters.",
      { keys: z.array(z.string()).min(1) },
      wrapTool(t("desktop_keys"), async ({ keys }) => {
        try {
          return jsonResult(await desktop.keys(keys));
        } catch (err) {
          return errorResult(err);
        }
      }),
    );

    server.tool(
      t("desktop_open"),
      "Open a URL or file with the OS (native). Optional app name on macOS (e.g. Safari).",
      { target: z.string(), app: z.string().optional() },
      wrapTool(t("desktop_open"), async ({ target, app }) => {
        try {
          return jsonResult(await desktop.open(target, app));
        } catch (err) {
          return errorResult(err);
        }
      }),
    );

    server.tool(
      t("desktop_vnc_status"),
      "Status of the persistent local VNC/Screen Sharing client (vincent-style). Live JPEG: GET /desktop/frame.jpg with Bearer token.",
      {},
      wrapTool(t("desktop_vnc_status"), async () => {
        try {
          return jsonResult({
            ...desktop.vncStatus(),
            liveView: "/desktop/frame.jpg",
            hint: "Set EDGE_VNC_USER + EDGE_VNC_PASSWORD; enable Screen Sharing on macOS",
          });
        } catch (err) {
          return errorResult(err);
        }
      }),
    );
  }

  return server;
}

export async function startStdioMcp(
  scope: AccessScope,
  sessions: SessionManager,
  instance: EdgeInstance,
  desktop?: DesktopController,
): Promise<void> {
  log(`stdio MCP transport starting name=${instance.name} style=${instance.toolStyle}`);
  await desktop?.start();
  const mcp = createEdgeMcp(scope, sessions, instance, desktop);
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
}

function unauthorized(res: ServerResponse) {
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

function getBearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) return null;
  return h.slice("Bearer ".length).trim() || null;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (Buffer.concat(chunks).length > 12 * 1024 * 1024) {
      throw new Error("Request body too large");
    }
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  return JSON.parse(raw) as unknown;
}

export async function listenMcp(opts: {
  scope: AccessScope;
  sessions: SessionManager;
  instance: EdgeInstance;
  desktop?: DesktopController;
  host: string;
  port: number;
  token: string;
}): Promise<{ url: string; close: () => Promise<void> }> {
  await opts.desktop?.start();
  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const client = req.socket.remoteAddress ?? "?";

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          name: opts.instance.name,
          toolStyle: opts.instance.toolStyle,
          mode: opts.scope.mode,
          root: opts.scope.root,
          privilege: opts.scope.privilege,
          desktop: Boolean(opts.desktop?.isEnabled()),
          vnc: opts.desktop?.isEnabled() ? opts.desktop.vncStatus().state : null,
        }),
      );
      return;
    }

    // Live desktop view (vincent-style JPEG poller) — same Bearer as MCP
    if (url.pathname === "/desktop/frame.jpg" || url.pathname === "/desktop/frame.jpeg") {
      const token = getBearer(req) || url.searchParams.get("token");
      if (!token || token !== opts.token) {
        unauthorized(res);
        return;
      }
      if (!opts.desktop?.isEnabled()) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "desktop disabled" }));
        return;
      }
      try {
        let frame = opts.desktop.latestVncFrame();
        if (!frame) {
          frame = await opts.desktop.snapshot({ maxWidth: 1280, quality: 55 });
        }
        res.writeHead(200, {
          "content-type": "image/jpeg",
          "cache-control": "no-store",
          "x-edge-backend": frame.backend,
          "x-edge-width": String(frame.width),
          "x-edge-height": String(frame.height),
        });
        res.end(frame.bytes);
      } catch (err) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    if (url.pathname !== "/mcp") {
      log(`HTTP ${req.method} ${url.pathname} from ${client} → 404`);
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    const token = getBearer(req);
    if (!token || token !== opts.token) {
      log(`HTTP ${req.method} /mcp from ${client} → 401 (bad or missing bearer)`);
      unauthorized(res);
      return;
    }

    const mcp = createEdgeMcp(opts.scope, opts.sessions, opts.instance, opts.desktop);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const cleanup = async () => {
      await transport.close().catch(() => undefined);
      await mcp.close().catch(() => undefined);
    };
    res.on("close", () => {
      void cleanup();
    });
    try {
      await mcp.connect(transport);
      const body =
        req.method === "POST" || req.method === "PUT" ? await readBody(req) : undefined;
      logBlock(`← MCP ${req.method} /mcp from ${client}`, describeMcpBody(body));
      const started = Date.now();
      await transport.handleRequest(req, res, body);
      log(`→ MCP ${req.method} /mcp done in ${Date.now() - started}ms (status may already be sent)`);
    } catch (err) {
      log(`→ MCP error:`, err instanceof Error ? err.message : err);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      await cleanup();
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, opts.host, () => resolve());
  });

  const displayHost = opts.host === "0.0.0.0" ? "127.0.0.1" : opts.host;
  const mcpUrl = `http://${displayHost}:${opts.port}/mcp`;
  return {
    url: mcpUrl,
    close: async () => {
      opts.sessions.closeAll();
      await opts.desktop?.stop();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
