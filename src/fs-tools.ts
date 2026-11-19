import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AccessScope } from "./scope.js";
import { isDeniedSecretPath, resolveInScope } from "./scope.js";

const MAX_READ_BYTES = 2 * 1024 * 1024;
/** Max total file size for chunked transfer (read or write). */
export const MAX_TRANSFER_BYTES = 200 * 1024 * 1024;
/** Default / max raw bytes per chunk (base64 expands ~4/3). */
export const DEFAULT_CHUNK_BYTES = 512 * 1024;
export const MAX_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_SHELL_TIMEOUT_MS = 120_000;

export async function listDir(scope: AccessScope, userPath: string) {
  const abs = resolveInScope(scope, userPath || ".");
  const entries = await fs.readdir(abs, { withFileTypes: true });
  return entries
    .map((e) => ({
      name: e.name,
      type: e.isDirectory() ? "dir" : e.isSymbolicLink() ? "symlink" : "file",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function readFileTool(
  scope: AccessScope,
  userPath: string,
  opts?: { maxBytes?: number; allowSecrets?: boolean },
) {
  const abs = resolveInScope(scope, userPath);
  if (isDeniedSecretPath(abs, opts?.allowSecrets === true)) {
    throw new Error(`Refusing to read secret-like file: ${path.basename(abs)} (pass allowSecrets)`);
  }
  const max = Math.min(opts?.maxBytes ?? MAX_READ_BYTES, MAX_READ_BYTES);
  const stat = await fs.stat(abs);
  if (!stat.isFile()) throw new Error(`Not a file: ${userPath}`);
  if (stat.size > max) {
    throw new Error(`File exceeds ${max} bytes (${stat.size}). Raise maxBytes or read a smaller file.`);
  }
  const buf = await fs.readFile(abs);
  const text = buf.toString("utf8");
  // Detect obvious binary
  if (buf.includes(0)) {
    return { path: abs, encoding: "base64" as const, content: buf.toString("base64"), bytes: buf.length };
  }
  return { path: abs, encoding: "utf8" as const, content: text, bytes: buf.length };
}

export async function writeFileTool(
  scope: AccessScope,
  userPath: string,
  content: string,
  opts?: { allowSecrets?: boolean; encoding?: "utf8" | "base64" },
) {
  const abs = resolveInScope(scope, userPath);
  if (isDeniedSecretPath(abs, opts?.allowSecrets === true)) {
    throw new Error(`Refusing to write secret-like file: ${path.basename(abs)}`);
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const data = opts?.encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
  if (data.length > MAX_READ_BYTES) {
    throw new Error(
      `Payload ${data.length} bytes exceeds ${MAX_READ_BYTES}. Use edge_file_write_chunk for large files (up to 200 MiB).`,
    );
  }
  await fs.writeFile(abs, data);
  return { path: abs, bytes: data.length };
}

export async function fileInfoTool(
  scope: AccessScope,
  userPath: string,
  opts?: { allowSecrets?: boolean },
) {
  const abs = resolveInScope(scope, userPath);
  if (isDeniedSecretPath(abs, opts?.allowSecrets === true)) {
    throw new Error(`Refusing to stat secret-like file: ${path.basename(abs)} (pass allowSecrets)`);
  }
  const stat = await fs.stat(abs);
  return {
    path: abs,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
    maxTransferBytes: MAX_TRANSFER_BYTES,
    maxChunkBytes: MAX_CHUNK_BYTES,
    defaultChunkBytes: DEFAULT_CHUNK_BYTES,
  };
}

/**
 * Read a slice of a file as base64 (for large transfers up to MAX_TRANSFER_BYTES).
 * Rakazo should loop until eof=true.
 */
export async function readFileChunkTool(
  scope: AccessScope,
  userPath: string,
  opts: { offset?: number; length?: number; allowSecrets?: boolean },
) {
  const abs = resolveInScope(scope, userPath);
  if (isDeniedSecretPath(abs, opts.allowSecrets === true)) {
    throw new Error(`Refusing to read secret-like file: ${path.basename(abs)} (pass allowSecrets)`);
  }
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const want = Math.min(
    Math.max(1, Math.floor(opts.length ?? DEFAULT_CHUNK_BYTES)),
    MAX_CHUNK_BYTES,
  );
  const stat = await fs.stat(abs);
  if (!stat.isFile()) throw new Error(`Not a file: ${userPath}`);
  if (stat.size > MAX_TRANSFER_BYTES) {
    throw new Error(
      `File ${stat.size} bytes exceeds transfer limit ${MAX_TRANSFER_BYTES} (200 MiB)`,
    );
  }
  if (offset > stat.size) {
    throw new Error(`offset ${offset} past end of file (${stat.size})`);
  }
  if (offset === stat.size) {
    return {
      path: abs,
      offset,
      bytesRead: 0,
      totalSize: stat.size,
      eof: true,
      encoding: "base64" as const,
      content: "",
    };
  }

  const fh = await fs.open(abs, "r");
  try {
    const buf = Buffer.alloc(want);
    const { bytesRead } = await fh.read(buf, 0, want, offset);
    const slice = buf.subarray(0, bytesRead);
    const next = offset + bytesRead;
    return {
      path: abs,
      offset,
      bytesRead,
      totalSize: stat.size,
      eof: next >= stat.size,
      nextOffset: next,
      encoding: "base64" as const,
      content: slice.toString("base64"),
    };
  } finally {
    await fh.close();
  }
}

/**
 * Write a chunk at an absolute offset (for large uploads up to MAX_TRANSFER_BYTES).
 * Protocol: first chunk with offset=0 and truncate=true, then subsequent chunks at next offset.
 */
export async function writeFileChunkTool(
  scope: AccessScope,
  userPath: string,
  content: string,
  opts: {
    offset?: number;
    encoding?: "utf8" | "base64";
    truncate?: boolean;
    allowSecrets?: boolean;
  },
) {
  const abs = resolveInScope(scope, userPath);
  if (isDeniedSecretPath(abs, opts.allowSecrets === true)) {
    throw new Error(`Refusing to write secret-like file: ${path.basename(abs)}`);
  }
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const encoding = opts.encoding ?? "base64";
  const data =
    encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
  if (data.length === 0 && offset > 0) {
    throw new Error("Empty chunk with offset > 0");
  }
  if (data.length > MAX_CHUNK_BYTES) {
    throw new Error(`Chunk ${data.length} bytes exceeds max chunk ${MAX_CHUNK_BYTES}`);
  }
  const end = offset + data.length;
  if (end > MAX_TRANSFER_BYTES) {
    throw new Error(`Write would exceed transfer limit ${MAX_TRANSFER_BYTES} (200 MiB)`);
  }

  await fs.mkdir(path.dirname(abs), { recursive: true });
  const truncate = opts.truncate === true || (offset === 0 && opts.truncate !== false);
  // First upload chunk: create/truncate. Later chunks: open r+ (file must exist).
  const flag = offset === 0 && truncate ? "w" : "r+";
  const fh = await fs.open(abs, flag);
  try {
    if (offset === 0 && truncate) {
      await fh.truncate(0);
    }
    await fh.write(data, 0, data.length, offset);
    const stat = await fh.stat();
    return {
      path: abs,
      offset,
      bytesWritten: data.length,
      nextOffset: end,
      size: stat.size,
      eofHint: end >= MAX_TRANSFER_BYTES,
    };
  } finally {
    await fh.close();
  }
}

export async function shellTool(
  scope: AccessScope,
  command: string,
  opts?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
): Promise<{ stdout: string; stderr: string; exitCode: number; cwd: string }> {
  const cwd = resolveInScope(scope, opts?.cwd ?? ".");
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS;
  const shell = process.env.SHELL || "/bin/bash";

  return new Promise((resolve, reject) => {
    const child = spawn(shell, ["-lc", command], {
      cwd,
      env: { ...process.env, ...(opts?.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const max = 2 * 1024 * 1024;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      if (stdout.length < max) stdout += d;
    });
    child.stderr.on("data", (d: string) => {
      if (stderr.length < max) stderr += d;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`shell timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1, cwd });
    });
  });
}
