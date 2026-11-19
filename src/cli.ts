#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { createScope } from "./scope.js";
import { SessionManager } from "./sessions.js";
import { listenMcp, startStdioMcp } from "./mcp-server.js";
import { startTui } from "./tui.js";

function usage(): never {
  console.error(`Usage:
  rakazo-pc-edge [options]

Scope (pick one):
  (default)              Access root = current working directory
  --worker-dir <path>    Access root = <path>
  --global               No path restriction (dangerous; logs a warning)

Server:
  --host <addr>          Bind address (default 127.0.0.1)
  --port <n>             Port (default 8765)
  --token <secret>       Bearer token (or env RAKAZO_PC_EDGE_TOKEN)
  --stdio                Speak MCP over stdio instead of HTTP (for local MCP hosts)
  --plain                Disable interactive TUI; print logs to stdout only
  --no-tui               Alias for --plain

Env:
  RAKAZO_PC_EDGE_TOKEN   Shared secret required by Rakazo MCP registration
`);
  process.exit(2);
}

function parseArgs(argv: string[]) {
  const out: {
    workerDir?: string;
    global?: boolean;
    host: string;
    port: number;
    token?: string;
    stdio?: boolean;
    plain?: boolean;
    help?: boolean;
  } = {
    host: "127.0.0.1",
    port: 8765,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--global") out.global = true;
    else if (a === "--stdio") out.stdio = true;
    else if (a === "--plain" || a === "--no-tui") out.plain = true;
    else if (a === "--worker-dir") out.workerDir = argv[++i];
    else if (a === "--host") out.host = argv[++i] ?? out.host;
    else if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--token") out.token = argv[++i];
    else {
      console.error(`Unknown argument: ${a}`);
      usage();
    }
  }
  if (out.help) usage();
  if (!Number.isFinite(out.port) || out.port <= 0) {
    console.error("Invalid --port");
    usage();
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scope = createScope({
    workerDir: args.workerDir,
    global: args.global,
    cwd: process.cwd(),
  });

  if (scope.mode === "global") {
    console.warn(
      "[rakazo-pc-edge] WARNING: --global enabled. This process can read/write/execute anywhere the OS user can.",
    );
  }

  const sessions = new SessionManager(scope);

  if (args.stdio) {
    await startStdioMcp(scope, sessions);
    return;
  }

  let token = args.token ?? process.env.RAKAZO_PC_EDGE_TOKEN;
  if (!token) {
    token = randomBytes(24).toString("hex");
    console.warn(
      `[rakazo-pc-edge] No token provided; generated ephemeral token (set RAKAZO_PC_EDGE_TOKEN to pin it):\n  ${token}`,
    );
  }

  const useTui = !args.plain && Boolean(process.stdout.isTTY && process.stdin.isTTY);
  let tui: { close(): void } | undefined;

  const { url, close } = await listenMcp({
    scope,
    sessions,
    host: args.host,
    port: args.port,
    token,
  });

  const shutdown = async () => {
    tui?.close();
    await close();
  };

  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });

  const titleBits = [
    `mode=${scope.mode}`,
    `root=${scope.root ?? "(global)"}`,
    url,
  ];

  if (useTui) {
    tui = startTui({
      sessions,
      titleLines: titleBits,
      exportRoot: scope.root ?? process.cwd(),
    });
  } else {
    console.log(`[rakazo-pc-edge] mode=${scope.mode} root=${scope.root ?? "(global)"}`);
    console.log(`[rakazo-pc-edge] MCP endpoint: ${url}`);
    console.log(`[rakazo-pc-edge] health: http://${args.host}:${args.port}/healthz`);
    console.log(`[rakazo-pc-edge] Authorization: Bearer <token>`);
    console.log(
      `[rakazo-pc-edge] Logging: MCP + sessions on stdout (--plain). Use a TTY without --plain for the interactive UI.`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
