/**
 * Process privilege modes for PC Edge.
 *
 * - sandbox (default): file tools scoped to access root; shell/sessions/OpenCode
 *   run under an OS jail (bubblewrap on Linux, Seatbelt/sandbox-exec on macOS).
 * - half-god: file tools scoped; shell/sessions run unsandboxed (can leave the root).
 * - god: file tools + shell have full PC access (former --global).
 */
import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export type PrivilegeMode = "sandbox" | "half-god" | "god";
export type SandboxBackend = "bwrap" | "seatbelt";

export interface SpawnSpec {
  cmd: string;
  args: string[];
  /** True when the command was wrapped with the OS sandbox. */
  sandboxed: boolean;
  /**
   * Host cwd for spawn()/pty.
   * - bwrap: omit (undefined) — bwrap sets --chdir inside the jail
   * - seatbelt / unsandboxed: set to the desired working directory
   */
  cwd?: string;
}

let cachedBwrap: string | null | undefined;
let cachedSeatbelt: string | null | undefined;

function whichSync(cmd: string): string | null {
  try {
    const out = execFileSync("which", [cmd], { encoding: "utf8" }).trim();
    return out.split("\n")[0]?.trim() || null;
  } catch {
    return null;
  }
}

/** Which jail backend this host uses for --sandbox. */
export function sandboxBackend(platform: NodeJS.Platform = process.platform): SandboxBackend {
  if (platform === "darwin") return "seatbelt";
  if (platform === "linux") return "bwrap";
  throw new Error(
    `sandbox mode is not supported on ${platform}. Use --half-god or --god, or run on Linux/macOS.`,
  );
}

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

export function resolveSeatbeltBinary(): string {
  if (cachedSeatbelt) return cachedSeatbelt;
  const fromEnv = process.env.SEATBELT_BIN?.trim();
  const candidates = [fromEnv, "/usr/bin/sandbox-exec"].filter(Boolean) as string[];
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    try {
      accessSync(c, constants.X_OK);
      cachedSeatbelt = c;
      return cachedSeatbelt;
    } catch {
      /* try next */
    }
  }
  throw new Error(
    "macOS sandbox-exec not found at /usr/bin/sandbox-exec (set SEATBELT_BIN). Use --half-god or --god to run without a sandbox.",
  );
}

/** Fail fast when sandbox mode is selected. */
export function assertSandboxAvailable(platform: NodeJS.Platform = process.platform): void {
  const backend = sandboxBackend(platform);
  if (backend === "bwrap") {
    resolveBwrapBinary();
    return;
  }
  const bin = resolveSeatbeltBinary();
  // Smoke-test that Seatbelt profiles still execute on this macOS.
  try {
    execFileSync(bin, ["-p", "(version 1)(allow default)", "/usr/bin/true"], {
      stdio: "ignore",
      timeout: 5000,
    });
  } catch (err) {
    throw new Error(
      `sandbox-exec is present but failed a smoke test: ${err instanceof Error ? err.message : err}. Use --half-god or --god.`,
    );
  }
}

/**
 * Wrap a command for the given privilege mode.
 * In sandbox mode, `root` must be an absolute directory that will be the only broad RW tree.
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
    return {
      cmd,
      args,
      sandboxed: false,
      cwd: opts?.chdir ? path.resolve(opts.chdir) : undefined,
    };
  }
  if (!root) {
    throw new Error("sandbox privilege requires an access root (--worker-dir or cwd)");
  }
  const absRoot = path.resolve(root);
  if (!existsSync(absRoot) || !statSync(absRoot).isDirectory()) {
    throw new Error(`sandbox root is not a directory: ${absRoot}`);
  }
  const absChdir = resolveChdirUnderRoot(absRoot, opts?.chdir ?? absRoot);
  const backend = sandboxBackend();

  if (backend === "bwrap") {
    const bwrap = resolveBwrapBinary();
    return {
      cmd: bwrap,
      args: buildBwrapArgs(absRoot, cmd, args, absChdir),
      sandboxed: true,
      // bwrap --chdir handles the working directory inside the mount namespace.
      cwd: undefined,
    };
  }

  const seatbelt = resolveSeatbeltBinary();
  const profile = buildSeatbeltProfile(absRoot, cmd);
  return {
    cmd: seatbelt,
    args: ["-p", profile, cmd, ...args],
    sandboxed: true,
    cwd: absChdir,
  };
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

  out.push("--bind", absRoot, absRoot);

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

/** Escape a path for an SBPL string literal. */
export function sbEscape(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function sbSubpath(p: string): string {
  return `(subpath "${sbEscape(p)}")`;
}

function sbLiteral(p: string): string {
  return `(literal "${sbEscape(p)}")`;
}

/**
 * Build a Seatbelt (sandbox-exec -p) profile: deny-by-default, RW project root,
 * RO system/toolchain, RW OpenCode state + temp dirs, network allowed.
 */
export function buildSeatbeltProfile(root: string, cmd: string): string {
  const absRoot = path.resolve(root);
  const rwDirs = new Set<string>([absRoot, ...collectWritableToolStateDirs()]);
  // macOS temp / caches processes often need.
  for (const p of [
    "/tmp",
    "/private/tmp",
    "/var/folders",
    "/private/var/folders",
    "/var/tmp",
    "/private/var/tmp",
  ]) {
    if (existsSync(p)) {
      try {
        rwDirs.add(realpathSync(p));
      } catch {
        rwDirs.add(p);
      }
    } else {
      rwDirs.add(p);
    }
  }

  const roDirs = new Set<string>([
    "/usr",
    "/bin",
    "/sbin",
    "/System",
    "/Library",
    "/opt",
    "/Applications",
    "/private/etc",
    "/etc",
    "/dev",
    "/private/var/db/dyld",
  ]);
  for (const p of collectExtraRoPaths(cmd)) {
    if (rwDirs.has(p) || [...rwDirs].some((s) => p === s || p.startsWith(s + path.sep))) continue;
    roDirs.add(p);
    roDirs.add(path.dirname(p));
  }

  const rwFilters = [...rwDirs].map(sbSubpath).join(" ");
  const roFilters = [...roDirs].map(sbSubpath).join(" ");

  const lines = [
    "(version 1)",
    "(deny default)",
    "; process + IPC",
    "(allow process*)",
    "(allow signal)",
    "(allow sysctl*)",
    "(allow mach*)",
    "(allow device*)",
    "(allow file-ioctl)",
    "(allow file-read-metadata)",
    "(allow file-map-executable)",
    "(allow user-preference-read)",
    "; network (package managers, model APIs)",
    "(allow network*)",
    "; device nodes commonly needed by shells/PTYs",
    `(allow file-read* file-write-data file-ioctl ${[
      "/dev/null",
      "/dev/zero",
      "/dev/tty",
      "/dev/ptmx",
      "/dev/dtracehelper",
    ]
      .map(sbLiteral)
      .join(" ")})`,
    "; system + toolchain (read-only)",
    `(allow file-read* ${roFilters})`,
    `(allow file-read* ${sbLiteral("/")})`,
    "; project root + tool state + temps (read-write)",
    `(allow file-read* file-write* ${rwFilters})`,
  ];
  return lines.join("\n");
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
    // macOS app-support style locations some CLIs use
    path.join(home, "Library", "Application Support", "opencode"),
    path.join(home, "Library", "Caches", "opencode"),
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
    add(path.join(home, ".nvm"));
    add(path.join(home, ".local", "share", "fnm"));
    add(path.join(home, "Library", "Application Support", "opencode"));
  }
  if (process.env.OPENCODE_BIN) add(process.env.OPENCODE_BIN);
  // Homebrew on Apple Silicon / Intel
  add("/opt/homebrew");
  add("/usr/local");

  for (const p of [...paths]) {
    add(path.dirname(p));
  }

  return [...paths].sort();
}

/** Reset caches (tests). */
export function _resetSandboxCachesForTests(): void {
  cachedBwrap = undefined;
  cachedSeatbelt = undefined;
}

/** @deprecated use _resetSandboxCachesForTests */
export function _resetBwrapCacheForTests(): void {
  _resetSandboxCachesForTests();
}

export function privilegeLabel(
  privilege: PrivilegeMode,
  platform: NodeJS.Platform = process.platform,
): string {
  switch (privilege) {
    case "sandbox": {
      try {
        const backend = sandboxBackend(platform);
        return backend === "seatbelt" ? "sandbox (seatbelt)" : "sandbox (bwrap)";
      } catch {
        return "sandbox";
      }
    }
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
