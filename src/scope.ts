import { realpathSync, existsSync, statSync } from "node:fs";
import path from "node:path";

export type ScopeMode = "cwd" | "worker-dir" | "global";

export interface AccessScope {
  mode: ScopeMode;
  /** Absolute resolved root; null when mode is global. */
  root: string | null;
}

const DEFAULT_DENIED_BASENAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
]);

export function createScope(opts: {
  workerDir?: string;
  global?: boolean;
  cwd?: string;
}): AccessScope {
  if (opts.global && opts.workerDir) {
    throw new Error("Use either --global or --worker-dir, not both");
  }
  if (opts.global) {
    return { mode: "global", root: null };
  }
  const raw = opts.workerDir ? path.resolve(opts.workerDir) : path.resolve(opts.cwd ?? process.cwd());
  if (!existsSync(raw) || !statSync(raw).isDirectory()) {
    throw new Error(`Access root does not exist or is not a directory: ${raw}`);
  }
  const root = realpathSync(raw);
  return { mode: opts.workerDir ? "worker-dir" : "cwd", root };
}

/** Resolve a user-supplied path against the access root. Throws if outside scope. */
export function resolveInScope(scope: AccessScope, userPath: string): string {
  const candidate = path.isAbsolute(userPath)
    ? path.normalize(userPath)
    : path.resolve(scope.root ?? process.cwd(), userPath);

  if (scope.mode === "global") {
    return candidate;
  }
  if (!scope.root) {
    throw new Error("Access root is not configured");
  }

  let resolved = candidate;
  if (existsSync(candidate)) {
    try {
      resolved = realpathSync(candidate);
    } catch {
      resolved = candidate;
    }
  }

  const rootWithSep = scope.root.endsWith(path.sep) ? scope.root : scope.root + path.sep;
  if (resolved !== scope.root && !resolved.startsWith(rootWithSep)) {
    throw new Error(`Path is outside access root (${scope.root}): ${userPath}`);
  }
  return resolved;
}

export function isDeniedSecretPath(absPath: string, allowSecrets: boolean): boolean {
  if (allowSecrets) return false;
  const base = path.basename(absPath);
  if (DEFAULT_DENIED_BASENAMES.has(base)) return true;
  if (base.startsWith("id_") && !base.endsWith(".pub")) return true;
  if (base.endsWith(".pem") || base.endsWith(".key")) return true;
  return false;
}
