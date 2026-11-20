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

export function createEdgeMcp(scope: AccessScope, sessions: SessionManager) {
  const server = new McpServer({
    name: "rakazo-pc-edge",
    version: "0.1.0",
  });

  server.tool(
    "edge_info",
    "PC Edge: describe access scope/root on the user's real computer (paths here need edge_read_file / edge_list_dir, not bot sandbox tools)",
    {},
    wrapTool("edge_info", async () =>
      jsonResult({
        mode: scope.mode,
        root: scope.root,
        privilege: scope.privilege,
        sandboxedProcesses: scope.privilege === "sandbox",
        platform: process.platform,
        cwd: process.cwd(),
        hostname: process.env.HOSTNAME ?? null,
        sessions: sessions.list().length,
        privilegeHelp: {
          sandbox: "default — file tools + shell/sessions/OpenCode under bubblewrap (bwrap)",
          "half-god": "file tools stay in root; shell/sessions can reach the whole PC",
          god: "full PC access for tools and shell (--god / --global)",
        },
      }),
    ),
  );

  // All tools are prefixed with edge_ so they do not collide with Rakazo's
  // built-in sandbox tools (read_file, shell, list_dir, …) which only see the bot computer.
  server.tool(
    "edge_list_dir",
    "PC Edge: list files on the user's real computer under the Edge access root (not the bot sandbox)",
    { path: z.string().optional().describe("Relative or absolute path under the Edge access root") },
    wrapTool("edge_list_dir", async ({ path: p }) => {
      try {
        return jsonResult({ path: p ?? ".", entries: await listDir(scope, p ?? ".") });
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.tool(
    "edge_read_file",
    "PC Edge: read a small file (≤2 MiB) on the user's computer. For larger files (up to 200 MiB) use edge_file_info + edge_file_read_chunk.",
    {
      path: z.string(),
      maxBytes: z.number().int().positive().optional(),
      allowSecrets: z.boolean().optional(),
    },
    wrapTool("edge_read_file", async (args) => {
      try {
        return jsonResult(await readFileTool(scope, args.path, args));
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.tool(
    "edge_write_file",
    "PC Edge: write a small file (≤2 MiB) on the user's computer. For larger files (up to 200 MiB) use edge_file_write_chunk.",
    {
      path: z.string(),
      content: z.string(),
      encoding: z.enum(["utf8", "base64"]).optional(),
      allowSecrets: z.boolean().optional(),
    },
    wrapTool("edge_write_file", async (args) => {
      try {
        return jsonResult(await writeFileTool(scope, args.path, args.content, args));
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.tool(
    "edge_file_info",
    "PC Edge: file size/mtime for transfers. Use before chunked download (edge_file_read_chunk) or to verify uploads. Limits: 200 MiB total, ≤1 MiB per chunk (default 512 KiB).",
    {
      path: z.string(),
      allowSecrets: z.boolean().optional(),
    },
    wrapTool("edge_file_info", async ({ path: p, allowSecrets }) => {
      try {
        return jsonResult(await fileInfoTool(scope, p, { allowSecrets }));
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.tool(
    "edge_file_read_chunk",
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
    wrapTool("edge_file_read_chunk", async (args) => {
      try {
        return jsonResult(await readFileChunkTool(scope, args.path, args));
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.tool(
    "edge_file_write_chunk",
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
    wrapTool("edge_file_write_chunk", async (args) => {
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
    "edge_shell",
    "PC Edge: short shell on the user's real computer (not the bot sandbox). For long-lived agents use edge_session_spawn",
    {
      command: z.string(),
      cwd: z.string().optional(),
      timeoutMs: z.number().int().positive().optional(),
    },
    wrapTool("edge_shell", async (args) => {
      try {
        return jsonResult(await shellTool(scope, args.command, args));
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.tool(
    "edge_session_spawn",
    "PC Edge: start a long-lived process/PTY on the user's computer. Generic interactive apps use this + stdin/keys/snapshot. For OpenCode prefer edge_opencode_run (API/CLI) instead of steering the TUI.",
    {
      cmd: z.string(),
      args: z.array(z.string()).optional(),
      cwd: z.string().optional(),
      env: z.record(z.string()).optional(),
      pty: z.boolean().optional(),
      label: z.string().optional(),
    },
    wrapTool("edge_session_spawn", async (args) => {
      try {
        return jsonResult(await sessions.spawn(args));
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.tool(
    "edge_session_list",
    "PC Edge: list concurrent process sessions",
    {},
    wrapTool("edge_session_list", async () => jsonResult({ sessions: sessions.list() })),
  );

  server.tool(
    "edge_session_status",
    "PC Edge: status of one session (includes uiState: idle|busy|unknown from OpenCode OSC)",
    { sessionId: z.string() },
    wrapTool("edge_session_status", async ({ sessionId }) => {
      try {
        return jsonResult(sessions.status(sessionId));
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.tool(
    "edge_session_read",
    "PC Edge: raw PTY/stdout buffer since a char offset (ANSI-heavy). Prefer edge_session_snapshot for readable OpenCode screens. Includes uiState.",
    {
      sessionId: z.string(),
      since: z.number().int().nonnegative().optional(),
    },
    wrapTool("edge_session_read", async ({ sessionId, since }) => {
      try {
        return jsonResult(sessions.read(sessionId, since ?? 0));
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.tool(
    "edge_session_snapshot",
    "PC Edge: plain-text decoded screen of a session (what a human sees in the Edge TUI). Use this to monitor OpenCode instead of raw edge_session_read. Returns uiState (idle|busy).",
    { sessionId: z.string() },
    wrapTool("edge_session_snapshot", async ({ sessionId }) => {
      try {
        return jsonResult(await sessions.snapshot(sessionId));
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.tool(
    "edge_session_stdin",
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
    wrapTool("edge_session_stdin", async ({ sessionId, data, submit, raw }) => {
      try {
        sessions.stdin(sessionId, data, { submit, raw });
        return jsonResult({ ok: true, sessionId, submit: Boolean(submit), raw: Boolean(raw) });
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.tool(
    "edge_session_prompt",
    "PC Edge: send a chat prompt into a live TUI session (Esc Esc to leave shell/panels, then type+Enter). Prefer edge_opencode_run / edge_opencode_prompt for OpenCode.",
    {
      sessionId: z.string(),
      text: z.string().describe("Prompt text to submit"),
    },
    wrapTool("edge_session_prompt", async ({ sessionId, text }) => {
      try {
        sessions.prompt(sessionId, text);
        return jsonResult({ ok: true, sessionId });
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.tool(
    "edge_session_keys",
    "PC Edge: send special keys to a PTY session (OpenCode navigation/submit). Keys: enter, esc, tab, up, down, left, right, backspace, ctrl-c, ctrl-d, ctrl-u, home, end, …",
    {
      sessionId: z.string(),
      keys: z
        .array(z.string())
        .min(1)
        .describe("Ordered key names, e.g. [\"enter\"] or [\"esc\",\"enter\"]"),
    },
    wrapTool("edge_session_keys", async ({ sessionId, keys }) => {
      try {
        sessions.sendKeys(sessionId, keys);
        return jsonResult({ ok: true, sessionId, keys });
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.tool(
    "edge_session_kill",
    "PC Edge: stop an active process session (SIGTERM by default). Use this from Rakazo to tear down stuck OpenCode/PTY sessions. Session stays listed as exited until edge_session_remove.",
    {
      sessionId: z.string(),
      signal: z.string().optional(),
    },
    wrapTool("edge_session_kill", async ({ sessionId, signal }) => {
      try {
        sessions.kill(sessionId, (signal as NodeJS.Signals) || "SIGTERM");
        return jsonResult({ ok: true, sessionId });
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.tool(
    "edge_session_remove",
    "PC Edge: drop an exited session from the list (must edge_session_kill first if still active).",
    { sessionId: z.string() },
    wrapTool("edge_session_remove", async ({ sessionId }) => {
      try {
        sessions.remove(sessionId);
        return jsonResult({ ok: true, sessionId });
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.tool(
    "edge_session_wait_event",
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
    wrapTool("edge_session_wait_event", async ({ sessionId, kinds, timeoutMs, afterBusy }) => {
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
    "edge_opencode_models",
    "List available OpenCode models. Each entry has `ref` (provider/model) for edge_opencode_run / edge_opencode_prompt / edge_opencode_test_model `model` param. Set detailed=false for just ref strings.",
    {
      cwd: z.string().optional(),
      detailed: z
        .boolean()
        .optional()
        .describe("Default true — full model list via API. false = quick `opencode models` refs only."),
    },
    wrapTool("edge_opencode_models", async ({ cwd, detailed }) => {
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
    "edge_opencode_providers",
    "List OpenCode providers (apiKey redacted). Use with edge_opencode_models to pick a model ref.",
    { cwd: z.string().optional() },
    wrapTool("edge_opencode_providers", async ({ cwd }) => {
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
    "edge_opencode_test_model",
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
    wrapTool("edge_opencode_test_model", async ({ model, cwd, message, label, standalone }) => {
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
    "edge_opencode_run",
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
    wrapTool("edge_opencode_run", async (args) => {
      try {
        return jsonResult(await opencodeSpawnRun(scope, sessions, args));
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.tool(
    "edge_opencode_session_create",
    "OpenCode API: create a multi-turn session bound to a directory (location.directory). Then use edge_opencode_prompt + edge_opencode_wait_idle.",
    {
      cwd: z.string().optional(),
      title: z.string().optional(),
    },
    wrapTool("edge_opencode_session_create", async ({ cwd, title }) => {
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
    "edge_opencode_prompt",
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
      "edge_opencode_prompt",
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
    "edge_opencode_sessions",
    "OpenCode API: list OpenCode sessions (session.list).",
    { cwd: z.string().optional() },
    wrapTool("edge_opencode_sessions", async ({ cwd }) => {
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
    "edge_opencode_wait_idle",
    "OpenCode API poll helper (rarely needed). For edge_opencode_run / edge_opencode_prompt, wait with edge_session_wait_event kinds=[\"done\",\"error\"] on the Edge session instead — those are live processes with session-pane logs.",
    {
      opencodeSessionId: z.string(),
      cwd: z.string().optional(),
      timeoutMs: z.number().int().positive().optional(),
      afterBusy: z.boolean().optional(),
    },
    wrapTool("edge_opencode_wait_idle", async ({ opencodeSessionId, cwd, timeoutMs, afterBusy }) => {
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

  return server;
}

export async function startStdioMcp(scope: AccessScope, sessions: SessionManager): Promise<void> {
  log("stdio MCP transport starting");
  const mcp = createEdgeMcp(scope, sessions);
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
  host: string;
  port: number;
  token: string;
}): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const client = req.socket.remoteAddress ?? "?";

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          mode: opts.scope.mode,
          root: opts.scope.root,
          privilege: opts.scope.privilege,
        }),
      );
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

    const mcp = createEdgeMcp(opts.scope, opts.sessions);
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
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
