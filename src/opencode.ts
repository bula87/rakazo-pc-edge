/**
 * Dedicated OpenCode driver — prefer this over steering the fullscreen TUI.
 *
 * Uses OpenCode's own surfaces:
 * - `opencode run --standalone --auto --format json` for one-shot + resume (live Edge session)
 * - `opencode api session.list` to discover ses_… ids
 *
 * Generic PTY sessions remain available for interactive apps that have no API.
 */
import { execFile, spawn as cpSpawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { log, summarize } from "./log.js";
import { wrapForPrivilege } from "./privilege.js";
import type { AccessScope } from "./scope.js";
import { resolveInScope } from "./scope.js";
import type { SessionManager } from "./sessions.js";

const execFileAsync = promisify(execFile);

export interface OpencodeSessionInfo {
  id: string;
  title?: string;
  directory?: string;
  outcome?: string;
  time?: {
    created?: number;
    updated?: number;
    busy?: number;
    idle?: number;
  };
  cost?: number;
}

export interface OpencodeRunSpawnResult {
  edgeSessionId: string;
  /** Present when continuing; otherwise filled once JSON events stream. Check status later. */
  opencodeSessionId?: string;
  /** Model ref passed as --model, if any. */
  model?: string;
  label: string;
  cwd: string;
  cmd: string;
  args: string[];
  hint: string;
}

let cachedBinary: string | null = null;

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function which(cmd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("which", [cmd], { encoding: "utf8" });
    const p = stdout.trim().split("\n")[0]?.trim();
    return p || null;
  } catch {
    return null;
  }
}

/** Resolve absolute path to opencode (spawn without shell cannot rely on PATH alone). */
export async function resolveOpencodeBinary(): Promise<string> {
  if (cachedBinary) return cachedBinary;
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const candidates = [
    process.env.OPENCODE_BIN,
    home ? path.join(home, ".opencode", "bin", "opencode") : "",
    await which("opencode"),
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    if (await fileExists(c)) {
      cachedBinary = c;
      log(`opencode binary=${c}`);
      return c;
    }
  }
  throw new Error(
    "opencode binary not found (set OPENCODE_BIN or install to ~/.opencode/bin/opencode)",
  );
}

function parseApiJson(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) throw new Error("opencode api returned empty output");
  // Prefer last JSON object/array line (ignore banners).
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.startsWith("{") || line.startsWith("[")) {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        /* try full text */
      }
    }
  }
  return JSON.parse(text) as unknown;
}

export async function opencodeApi(
  operation: string,
  opts?: {
    data?: unknown;
    params?: Record<string, string>;
    cwd?: string;
    standalone?: boolean;
    timeoutMs?: number;
    /** When set, sandbox wraps this API call according to privilege. */
    scope?: AccessScope;
  },
): Promise<unknown> {
  const bin = await resolveOpencodeBinary();
  const args: string[] = [];
  if (opts?.standalone) args.push("--standalone");
  args.push("api", operation);
  if (opts?.params) {
    for (const [k, v] of Object.entries(opts.params)) {
      args.push("--param", `${k}=${v}`);
    }
  }
  if (opts?.data !== undefined) {
    args.push("--data", JSON.stringify(opts.data));
  }

  const chdir = opts?.cwd ?? opts?.scope?.root ?? undefined;
  const wrapped = opts?.scope
    ? wrapForPrivilege(opts.scope.privilege, opts.scope.root, bin, args, {
        chdir: chdir ?? opts.scope.root ?? undefined,
      })
    : { cmd: bin, args, sandboxed: false };

  log(
    `opencode api op=${operation} sandboxed=${wrapped.sandboxed} cwd=${opts?.cwd ?? "(default)"} args=${summarize(args)}`,
  );

  return new Promise((resolve, reject) => {
    const child = cpSpawn(wrapped.cmd, wrapped.args, {
      cwd: wrapped.sandboxed ? undefined : opts?.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`opencode api timed out after ${opts?.timeoutMs ?? 60_000}ms`));
    }, opts?.timeoutMs ?? 60_000);
    timer.unref?.();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      stdout += d;
    });
    child.stderr.on("data", (d: string) => {
      stderr += d;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `opencode api ${operation} exited ${code}: ${(stderr || stdout).slice(0, 800)}`,
          ),
        );
        return;
      }
      try {
        resolve(parseApiJson(stdout));
      } catch (err) {
        reject(
          new Error(
            `opencode api ${operation} bad JSON: ${err instanceof Error ? err.message : err}; out=${stdout.slice(0, 400)}`,
          ),
        );
      }
    });
  });
}

function unwrapData<T>(raw: unknown): T {
  if (raw && typeof raw === "object" && "data" in raw) {
    return (raw as { data: T }).data;
  }
  return raw as T;
}

/** Strip secrets from OpenCode API payloads before returning to Rakazo. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = k.toLowerCase();
    if (
      key === "apikey" ||
      key === "api_key" ||
      key === "authorization" ||
      key === "token" ||
      key === "password" ||
      key.endsWith("secret") ||
      key.endsWith("apikey")
    ) {
      out[k] = typeof v === "string" && v.length ? "[redacted]" : v;
      continue;
    }
    out[k] = redactSecrets(v);
  }
  return out;
}

export interface OpencodeModelInfo {
  /** Use this with edge_opencode_run / prompt `model` (provider/model). */
  ref: string;
  id: string;
  modelID: string;
  providerID: string;
  name?: string;
  type?: string;
  enabled?: boolean;
  status?: unknown;
}

export interface OpencodeProviderInfo {
  id: string;
  name?: string;
  activation?: string;
  integrationID?: string;
  /** Sanitized — apiKey never returned. */
  settings?: Record<string, unknown>;
}

export async function opencodeListModels(opts?: {
  cwd?: string;
  scope?: AccessScope;
}): Promise<OpencodeModelInfo[]> {
  const raw = await opencodeApi("model.list", { cwd: opts?.cwd, scope: opts?.scope });
  const data = unwrapData<Record<string, unknown>[]>(raw);
  if (!Array.isArray(data)) return [];
  return data.map((m) => {
    const providerID = String(m.providerID ?? m.provider ?? "unknown");
    const modelID = String(m.modelID ?? m.id ?? "");
    const id = String(m.id ?? modelID);
    return {
      ref: `${providerID}/${modelID || id}`,
      id,
      modelID: modelID || id,
      providerID,
      name: typeof m.name === "string" ? m.name : undefined,
      type: typeof m.type === "string" ? m.type : undefined,
      enabled: typeof m.enabled === "boolean" ? m.enabled : undefined,
      status: m.status,
    };
  });
}

/** Simple `provider/model` id list from `opencode models` CLI (fallback / quick). */
export async function opencodeListModelRefs(opts?: {
  cwd?: string;
  scope?: AccessScope;
}): Promise<string[]> {
  const bin = await resolveOpencodeBinary();
  const args = ["models"];
  const wrapped = opts?.scope
    ? wrapForPrivilege(opts.scope.privilege, opts.scope.root, bin, args, {
        chdir: opts.cwd ?? opts.scope.root ?? undefined,
      })
    : { cmd: bin, args, sandboxed: false };
  return new Promise((resolve, reject) => {
    const child = cpSpawn(wrapped.cmd, wrapped.args, {
      cwd: wrapped.sandboxed ? undefined : opts?.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("opencode models timed out"));
    }, 30_000);
    timer.unref?.();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      stdout += d;
    });
    child.stderr.on("data", (d: string) => {
      stderr += d;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`opencode models exited ${code}: ${(stderr || stdout).slice(0, 400)}`));
        return;
      }
      const refs = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#") && l.includes("/"));
      resolve(refs);
    });
  });
}

export async function opencodeListProviders(opts?: {
  cwd?: string;
  scope?: AccessScope;
}): Promise<OpencodeProviderInfo[]> {
  const raw = await opencodeApi("provider.list", { cwd: opts?.cwd, scope: opts?.scope });
  const data = unwrapData<Record<string, unknown>[]>(raw);
  if (!Array.isArray(data)) return [];
  return data.map((p) => {
    const settings = p.settings
      ? (redactSecrets(p.settings) as Record<string, unknown>)
      : undefined;
    return {
      id: String(p.id ?? ""),
      name: typeof p.name === "string" ? p.name : undefined,
      activation: typeof p.activation === "string" ? p.activation : undefined,
      integrationID: typeof p.integrationID === "string" ? p.integrationID : undefined,
      settings,
    };
  });
}

export async function opencodeListSessions(opts?: {
  cwd?: string;
  scope?: AccessScope;
}): Promise<OpencodeSessionInfo[]> {
  const raw = await opencodeApi("session.list", { cwd: opts?.cwd, scope: opts?.scope });
  const data = unwrapData<OpencodeSessionInfo[]>(raw);
  return Array.isArray(data) ? data : [];
}

export async function opencodeCreateSession(opts: {
  cwd: string;
  title?: string;
  scope?: AccessScope;
}): Promise<OpencodeSessionInfo> {
  const raw = await opencodeApi("session.create", {
    cwd: opts.cwd,
    scope: opts.scope,
    data: {
      title: opts.title ?? `rakazo-edge ${new Date().toISOString()}`,
      location: { directory: opts.cwd },
    },
  });
  return unwrapData<OpencodeSessionInfo>(raw);
}

export async function opencodePrompt(opts: {
  sessionId: string;
  text: string;
  cwd?: string;
  scope?: AccessScope;
}): Promise<unknown> {
  return opencodeApi("session.prompt", {
    cwd: opts.cwd,
    scope: opts.scope,
    params: { sessionID: opts.sessionId },
    data: { text: opts.text },
    timeoutMs: 120_000,
  });
}

export async function opencodeGetSession(
  sessionId: string,
  opts?: { cwd?: string; scope?: AccessScope },
): Promise<OpencodeSessionInfo | null> {
  const list = await opencodeListSessions({ cwd: opts?.cwd, scope: opts?.scope });
  return list.find((s) => s.id === sessionId) ?? null;
}

/**
 * Poll until the OpenCode session is idle after having been busy (API multi-turn).
 */
export async function opencodeWaitIdle(opts: {
  sessionId: string;
  cwd?: string;
  scope?: AccessScope;
  timeoutMs?: number;
  afterBusy?: boolean;
  pollMs?: number;
}): Promise<OpencodeSessionInfo> {
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const pollMs = opts.pollMs ?? 1_500;
  const afterBusy = opts.afterBusy !== false;
  const started = Date.now();
  let sawBusy = !afterBusy;

  while (Date.now() - started < timeoutMs) {
    const s = await opencodeGetSession(opts.sessionId, { cwd: opts.cwd, scope: opts.scope });
    if (!s) throw new Error(`OpenCode session not found: ${opts.sessionId}`);
    const busyAt = s.time?.busy ?? 0;
    const idleAt = s.time?.idle ?? 0;
    // OpenCode stamps time.busy while working and time.idle when finished.
    const isBusy = busyAt > idleAt;
    if (isBusy) sawBusy = true;
    if (sawBusy && !isBusy) {
      return s;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(
    `opencode wait idle timed out after ${timeoutMs}ms (session=${opts.sessionId})`,
  );
}

/**
 * Spawn `opencode run` as an Edge process session (new or continue).
 * Process exit = task finished (`done`). Live pretty logs appear in the Edge session pane.
 */
export async function opencodeSpawnRun(
  scope: AccessScope,
  sessions: SessionManager,
  opts: {
    message: string;
    cwd?: string;
    /** OpenCode ses_… id to continue (preferred resume path). */
    sessionId?: string;
    continueLast?: boolean;
    title?: string;
    model?: string;
    label?: string;
    /** Default true — private server, don't attach shared TUI service. */
    standalone?: boolean;
  },
): Promise<OpencodeRunSpawnResult> {
  const cwd = resolveInScope(scope, opts.cwd ?? scope.root ?? process.cwd());
  const bin = await resolveOpencodeBinary();
  const args: string[] = [];
  if (opts.standalone !== false) args.push("--standalone");
  args.push("run", "--auto", "--format", "json");
  if (opts.sessionId) args.push("--session", opts.sessionId);
  if (opts.continueLast) args.push("--continue");
  if (opts.title) args.push("--title", opts.title);
  if (opts.model) args.push("--model", opts.model);
  args.push(opts.message);

  const resuming = Boolean(opts.sessionId || opts.continueLast);
  const label =
    opts.label ??
    (resuming
      ? `opencode-continue ${opts.sessionId?.slice(0, 16) ?? "last"}…`
      : `opencode-run ${opts.message.slice(0, 40)}${opts.message.length > 40 ? "…" : ""}`);

  // Ensure ~/.opencode/bin is on PATH for any child tools OpenCode may spawn.
  const home = process.env.HOME || "";
  const ocBinDir = home ? path.join(home, ".opencode", "bin") : "";
  const envPath = [ocBinDir, process.env.PATH].filter(Boolean).join(path.delimiter);

  const info = await sessions.spawn({
    cmd: bin,
    args,
    cwd,
    pty: false,
    label,
    pretty: "opencode-json",
    opencodeSessionId: opts.sessionId,
    env: { PATH: envPath },
  });

  return {
    edgeSessionId: info.id,
    opencodeSessionId: opts.sessionId ?? info.opencodeSessionId,
    model: opts.model,
    label: info.label,
    cwd,
    cmd: bin,
    args,
    hint: resuming
      ? "Resumed as a live Edge session — watch the session pane; wait with edge_session_wait_event kinds=[\"done\",\"error\"]. opencodeSessionId appears on status once JSON streams."
      : "Wait with edge_session_wait_event kinds=[\"done\",\"error\"]. To continue later: edge_opencode_prompt with the opencodeSessionId from edge_session_status (or edge_opencode_sessions). Verify with edge_list_dir / edge_read_file.",
  };
}

/** Resolve a cwd under Edge scope for OpenCode API calls. */
export function resolveOpencodeCwd(scope: AccessScope, cwd?: string): string {
  return resolveInScope(scope, cwd ?? scope.root ?? process.cwd());
}
