/**
 * Process privilege modes for PC Edge.
 *
 * - sandbox (default): file tools scoped to access root; shell/sessions/OpenCode
 *   run under bubblewrap so they cannot see or change paths outside the root.
 * - half-god: file tools scoped; shell/sessions run unsandboxed (can leave the root).
 * - god: file tools + shell have full PC access (former --global).
 */
import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export type PrivilegeMode = "sandbox" | "half-god" | "god";

export interface SpawnSpec {
  cmd: string;
  args: string[];
  /** True when the command was wrapped with bwrap. */
  sandboxed: boolean;
}

let cachedBwrap: string | null | undefined;

export function resolveBwrapBinary(): string {
  if (cachedBwrap) return cachedBwrap;
  const fromEnv = process.env.BWRAP_BIN?.trim();
  const candidates = [fromEnv, "/usr/bin/bwrap", "bwrap"].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      if (c.includes("/") && !existsSync(c)) continue;
      execFileSync(c, ["--version"], { stdio: "ignore", timeout: 3000 });
      cachedBwrap = c.includes("/") ? c : whichSync(c) ?? c;
      return cachedBwrap;
    } catch {
      /* try next */
    }
  }
  throw new Error(
    "bubblewrap (bwrap) not found. Install it (e.g. apt install bubblewrap) or set BWRAP_BIN. Use --half-god or --god to run without a sandbox.",
  );
}

function whichSync(cmd: string): string | null {
  try {
    const out = execFileSync("which", [cmd], { encoding: "utf8" }).trim();
    return out.split("\n")[0]?.trim() || null;
  } catch {
    return null;
  }
}

/** Fail fast when sandbox mode is selected. */
export function assertSandboxAvailable(): void {
  resolveBwrapBinary();
}

/**
 * Wrap a command for the given privilege mode.
 * In sandbox mode, `root` must be an absolute directory that will be the only RW tree.
 * `chdir` (optional) must resolve under `root` — defaults to `root`.
 */
export function wrapForPrivilege(
  privilege: PrivilegeMode,
  root: string | null,
  cmd: string,
  args: string[] = [],
  opts?: { chdir?: string },
): SpawnSpec {
  if (privilege !== "sandbox") {
    return { cmd, args, sandboxed: false };
  }
  if (!root) {
    throw new Error("sandbox privilege requires an access root (--worker-dir or cwd)");
  }
  const bwrap = resolveBwrapBinary();
  const bwrapArgs = buildBwrapArgs(root, cmd, args, opts?.chdir);
  return { cmd: bwrap, args: bwrapArgs, sandboxed: true };
}

/** Build bwrap argv (everything after the bwrap binary), ending with cmd + args. */
export function buildBwrapArgs(
  root: string,
  cmd: string,
  args: string[],
  chdir?: string,
): string[] {
  const absRoot = path.resolve(root);
  if (!existsSync(absRoot) || !statSync(absRoot).isDirectory()) {
    throw new Error(`sandbox root is not a directory: ${absRoot}`);
  }
  const absChdir = resolveChdirUnderRoot(absRoot, chdir ?? absRoot);

  const out: string[] = [
    "--die-with-parent",
    "--unshare-pid",
    "--unshare-uts",
    "--share-net",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/var/tmp",
  ];

  const roSystem = [
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/lib32",
    "/etc/resolv.conf",
    "/etc/hosts",
    "/etc/nsswitch.conf",
    "/etc/passwd",
    "/etc/group",
    "/etc/ssl",
    "/etc/ca-certificates",
    "/etc/ssl/certs",
    "/etc/pki",
    "/etc/localtime",
    "/etc/timezone",
  ];
  for (const p of roSystem) {
    out.push("--ro-bind-try", p, p);
  }

  // Worker dir is the only broad project read-write mount.
  out.push("--bind", absRoot, absRoot);

  // OpenCode (and similar) need their host state dirs writable for sessions/config.
  const rwState = new Set<string>();
  for (const p of collectWritableToolStateDirs()) {
    if (p === absRoot || p.startsWith(absRoot + path.sep)) continue;
    out.push("--bind", p, p);
    rwState.add(p);
  }

  for (const p of collectExtraRoPaths(cmd)) {
    if (p === absRoot || p.startsWith(absRoot + path.sep)) continue;
    if (rwState.has(p) || [...rwState].some((s) => p.startsWith(s + path.sep))) continue;
    out.push("--ro-bind-try", p, p);
  }

  out.push("--chdir", absChdir);
  out.push("--", cmd, ...args);
  return out;
}

export function resolveChdirUnderRoot(root: string, chdir: string): string {
  const absRoot = path.resolve(root);
  let abs = path.resolve(chdir);
  if (existsSync(abs)) {
    try {
      abs = realpathSync(abs);
    } catch {
      /* keep */
    }
  }
  const rootWithSep = absRoot.endsWith(path.sep) ? absRoot : absRoot + path.sep;
  if (abs !== absRoot && !abs.startsWith(rootWithSep)) {
    throw new Error(`sandbox chdir outside access root (${absRoot}): ${chdir}`);
  }
  return abs;
}

/** Host dirs tools may need to write (OpenCode sessions/config) — still not the whole home. */
export function collectWritableToolStateDirs(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return [];
  const candidates = [
    path.join(home, ".opencode"),
    path.join(home, ".config", "opencode"),
    path.join(home, ".local", "share", "opencode"),
    path.join(home, ".cache", "opencode"),
  ];
  const out: string[] = [];
  for (const p of candidates) {
    try {
      if (existsSync(p)) out.push(realpathSync(p));
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** Host paths the sandbox still needs read-only (toolchains, binary dirs). */
export function collectExtraRoPaths(cmd: string): string[] {
  const paths = new Set<string>();
  const add = (p: string | undefined | null) => {
    if (!p) return;
    try {
      const abs = path.resolve(p);
      if (!existsSync(abs)) return;
      paths.add(realpathSync(abs));
    } catch {
      /* ignore */
    }
  };

  add(cmd);
  add(process.execPath);

  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    add(path.join(home, ".opencode"));
    add(path.join(home, ".config", "opencode"));
    add(path.join(home, ".local", "share", "opencode"));
  }
  if (process.env.OPENCODE_BIN) add(process.env.OPENCODE_BIN);

  // Parent dirs of binaries so dynamic loaders / adjacent files resolve.
  for (const p of [...paths]) {
    add(path.dirname(p));
  }

  return [...paths].sort();
}

/** Reset caches (tests). */
export function _resetBwrapCacheForTests(): void {
  cachedBwrap = undefined;
}

export function privilegeLabel(privilege: PrivilegeMode): string {
  switch (privilege) {
    case "sandbox":
      return "sandbox (bwrap)";
    case "half-god":
      return "half-god (scoped files, free shell)";
    case "god":
      return "god (full PC)";
  }
}

/** Best-effort check that a path is executable (used by tests/helpers). */
export function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
