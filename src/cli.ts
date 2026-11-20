#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import {
  formatToolName,
  parseToolStyle,
  resolveEdgeInstance,
  type ToolNameStyle,
} from "./instance.js";
import { DesktopController, parseDesktopBackend, type DesktopBackend } from "./desktop/index.js";
import { assertSandboxAvailable, privilegeLabel, type PrivilegeMode } from "./privilege.js";
import { createScope } from "./scope.js";
import { SessionManager } from "./sessions.js";
import { listenMcp, startStdioMcp } from "./mcp-server.js";
import { startTui } from "./tui.js";

function usage(): never {
  console.error(`Usage:
  rakazo-pc-edge [options]

Instance name (for multi-PC / tool namespaces):
  --name <slug>          Friendly name baked into MCP tool names (default: stable
                         auto name from hostname + machine id)
  --tool-style <style>   insert|prefix|suffix|bare (default: insert)

Desktop / computer-use (hybrid native + local VNC):
  --desktop              Enable screenshot + mouse/keyboard tools (+ live /desktop/frame.jpg)
  --desktop-backend <b>  auto|native|vnc (default: auto — VNC when connected, else native)

Privilege (pick one; default is sandbox):
  (default) / --sandbox  File tools + shell/sessions/OpenCode confined to the access root
  --half-god             File tools scoped; shell/sessions can leave the root
  --god                  Full PC access for tools and shell (alias: --global)

Access root (sandbox / half-god):
  (default)              Current working directory
  --worker-dir <path>    Use <path> as the access root

Server:
  --host <addr>          Bind address (default 127.0.0.1)
  --port <n>             Port (default 8765)
  --token <secret>       Bearer token (or env RAKAZO_PC_EDGE_TOKEN)
  --stdio                Speak MCP over stdio instead of HTTP
  --plain / --no-tui     Logs to stdout instead of TUI

Env:
  RAKAZO_PC_EDGE_TOKEN / RAKAZO_PC_EDGE_NAME / RAKAZO_PC_EDGE_TOOL_STYLE
  EDGE_DESKTOP=1              Same as --desktop
  EDGE_DESKTOP_BACKEND        auto|native|vnc
  EDGE_VNC_HOST / VNC_HOST    default 127.0.0.1
  EDGE_VNC_PORT / VNC_PORT    default 5900
  EDGE_VNC_USER / VNC_USER    macOS Screen Sharing username (vincent-style)
  EDGE_VNC_PASSWORD / VNC_PASSWORD
  BWRAP_BIN / SEATBELT_BIN / OPENCODE_BIN
`);
  process.exit(2);
}

function parseArgs(argv: string[]) {
  const out: {
    workerDir?: string;
    privilege?: PrivilegeMode;
    name?: string;
    toolStyle?: ToolNameStyle;
    desktop?: boolean;
    desktopBackend?: DesktopBackend;
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
    else if (a === "--sandbox") {
      if (out.privilege && out.privilege !== "sandbox") {
        console.error("Use only one of --sandbox, --half-god, --god/--global");
        usage();
      }
      out.privilege = "sandbox";
    } else if (a === "--half-god") {
      if (out.privilege && out.privilege !== "half-god") {
        console.error("Use only one of --sandbox, --half-god, --god/--global");
        usage();
      }
      out.privilege = "half-god";
    } else if (a === "--god" || a === "--global") {
      if (out.privilege && out.privilege !== "god") {
        console.error("Use only one of --sandbox, --half-god, --god/--global");
        usage();
      }
      out.privilege = "god";
    } else if (a === "--desktop") out.desktop = true;
    else if (a === "--desktop-backend") {
      out.desktopBackend = parseDesktopBackend(argv[++i]);
    } else if (a === "--stdio") out.stdio = true;
    else if (a === "--plain" || a === "--no-tui") out.plain = true;
    else if (a === "--worker-dir") out.workerDir = argv[++i];
    else if (a === "--name") out.name = argv[++i];
    else if (a === "--tool-style") {
      const raw = argv[++i] ?? "";
      const style = parseToolStyle(raw);
      if (!style) {
        console.error("Invalid --tool-style (use insert|prefix|suffix|bare)");
        usage();
      }
      out.toolStyle = style;
    } else if (a === "--host") out.host = argv[++i] ?? out.host;
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
  const privilege: PrivilegeMode = args.privilege ?? "sandbox";
  const instance = resolveEdgeInstance({
    name: args.name,
    toolStyle: args.toolStyle,
  });

  const desktopEnabled =
    Boolean(args.desktop) ||
    process.env.EDGE_DESKTOP === "1" ||
    process.env.RAKAZO_PC_EDGE_DESKTOP === "1";
  const desktopBackend = args.desktopBackend ?? parseDesktopBackend(process.env.EDGE_DESKTOP_BACKEND);
  const desktop = new DesktopController(desktopEnabled, desktopBackend);

  if (privilege === "sandbox") {
    try {
      assertSandboxAvailable();
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  }

  const scope = createScope({
    workerDir: args.workerDir,
    privilege,
    cwd: process.cwd(),
  });

  if (scope.privilege === "god") {
    console.warn(
      "[rakazo-pc-edge] WARNING: god mode (--god/--global). Tools and shell can read/write/execute anywhere this OS user can.",
    );
  } else if (scope.privilege === "half-god") {
    console.warn(
      "[rakazo-pc-edge] WARNING: half-god mode. File tools stay in the access root, but shell/sessions are NOT sandboxed and can leave it.",
    );
  }
  if (desktopEnabled) {
    console.warn(
      "[rakazo-pc-edge] Desktop control enabled (screenshot/mouse/keyboard + optional local VNC). Treat the Bearer token like console access.",
    );
  }

  const sessions = new SessionManager(scope);
  const infoTool = formatToolName(instance, "info");

  if (args.stdio) {
    await startStdioMcp(scope, sessions, instance, desktop);
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
    instance,
    desktop,
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
    `name=${instance.name}`,
    `tools=${instance.toolStyle}`,
    desktopEnabled ? `desktop=${desktopBackend}` : null,
    `privilege=${privilegeLabel(scope.privilege)}`,
    `mode=${scope.mode}`,
    `root=${scope.root ?? "(global)"}`,
    url,
  ].filter(Boolean) as string[];

  if (useTui) {
    tui = startTui({
      sessions,
      titleLines: titleBits,
      exportRoot: scope.root ?? process.cwd(),
    });
  } else {
    console.log(
      `[rakazo-pc-edge] name=${instance.name} (${instance.nameSource}) toolStyle=${instance.toolStyle} example=${infoTool}`,
    );
    console.log(
      `[rakazo-pc-edge] privilege=${privilegeLabel(scope.privilege)} mode=${scope.mode} root=${scope.root ?? "(global)"}`,
    );
    if (desktopEnabled) {
      console.log(
        `[rakazo-pc-edge] desktop=${desktopBackend} live=http://${args.host}:${args.port}/desktop/frame.jpg`,
      );
    }
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
