/**
 * Per-machine Edge identity for multi-PC setups.
 * Tool names become edge_<name>_* (default) so Rakazo can tell hosts apart.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { execFileSync } from "node:child_process";

/** How the instance name is woven into MCP tool names. */
export type ToolNameStyle = "insert" | "prefix" | "suffix" | "bare";

export interface EdgeInstance {
  /** Stable slug used in tool names (unless bare). */
  name: string;
  nameSource: "flag" | "env" | "auto";
  toolStyle: ToolNameStyle;
  hostname: string;
  /** OS machine id when available (Linux machine-id / macOS IOPlatformUUID). */
  machineId: string | null;
}

const MAX_NAME_LEN = 32;

export function slugifyName(raw: string): string {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME_LEN);
  return s || "edge";
}

export function readMachineId(): string | null {
  try {
    if (existsSync("/etc/machine-id")) {
      const id = readFileSync("/etc/machine-id", "utf8").trim();
      if (id) return id;
    }
  } catch {
    /* ignore */
  }
  if (process.platform === "darwin") {
    try {
      const out = execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
        encoding: "utf8",
        timeout: 5000,
      });
      const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (m?.[1]) return m[1];
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Short stable fingerprint of this host (not secret; for naming only). */
export function machineFingerprint(): string {
  const parts = [
    osHostname(),
    process.platform,
    process.arch,
    readMachineId() ?? "",
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 8);
}

export function autoInstanceName(): string {
  const host = slugifyName(osHostname().split(".")[0] || "host");
  const fp = machineFingerprint();
  // Keep room for edge_ + _ + leaf under typical MCP name limits.
  const budget = Math.max(8, MAX_NAME_LEN - fp.length - 1);
  const shortHost = host.slice(0, budget);
  return slugifyName(`${shortHost}-${fp}`);
}

export function resolveEdgeInstance(opts?: {
  name?: string;
  toolStyle?: ToolNameStyle;
}): EdgeInstance {
  const envName =
    process.env.RAKAZO_PC_EDGE_NAME?.trim() || process.env.EDGE_NAME?.trim() || "";
  let nameSource: EdgeInstance["nameSource"] = "auto";
  let raw: string;
  if (opts?.name?.trim()) {
    raw = opts.name.trim();
    nameSource = "flag";
  } else if (envName) {
    raw = envName;
    nameSource = "env";
  } else {
    raw = autoInstanceName();
    nameSource = "auto";
  }

  const styleEnv = (process.env.RAKAZO_PC_EDGE_TOOL_STYLE || process.env.EDGE_TOOL_STYLE || "")
    .trim()
    .toLowerCase();
  const toolStyle = opts?.toolStyle ?? parseToolStyle(styleEnv) ?? "insert";

  return {
    name: slugifyName(raw),
    nameSource,
    toolStyle,
    hostname: osHostname(),
    machineId: readMachineId(),
  };
}

export function parseToolStyle(raw: string): ToolNameStyle | undefined {
  if (raw === "insert" || raw === "prefix" || raw === "suffix" || raw === "bare") return raw;
  return undefined;
}

/**
 * Build MCP tool name from leaf (`info`, `shell`, `session_spawn`, …).
 * - insert (default): edge_<name>_info
 * - prefix: <name>_edge_info
 * - suffix: edge_info_<name>
 * - bare: edge_info (legacy; collisions if two Edges share a bot)
 */
export function formatToolName(instance: EdgeInstance, leaf: string): string {
  const bareLeaf = leaf.replace(/^edge_/, "");
  switch (instance.toolStyle) {
    case "bare":
      return `edge_${bareLeaf}`;
    case "prefix":
      return `${instance.name}_edge_${bareLeaf}`;
    case "suffix":
      return `edge_${bareLeaf}_${instance.name}`;
    case "insert":
    default:
      return `edge_${instance.name}_${bareLeaf}`;
  }
}

export function toolStyleHelp(style: ToolNameStyle, name: string): string {
  const ex = formatToolName({ name, toolStyle: style, nameSource: "flag", hostname: "", machineId: null }, "info");
  return `${style} → e.g. ${ex}`;
}
