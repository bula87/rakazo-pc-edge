/**
 * Native desktop capture/input (no VNC).
 * macOS: screencapture + compiled helpers/macos-input.swift
 * Linux: ImageMagick/gnome-screenshot/grim + xdotool
 */
import { spawn, execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { DesktopFrame, MouseButton, ScreenSize } from "./types.js";

const execFileAsync = promisify(execFile);

function which(cmd: string): string | null {
  try {
    return execFileSync("which", [cmd], { encoding: "utf8" }).trim().split("\n")[0] || null;
  } catch {
    return null;
  }
}

function packageRoot(): string {
  // src/desktop -> ../../helpers or dist/desktop -> ../../helpers
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../helpers"),
    path.resolve(here, "../helpers"),
    path.resolve(process.cwd(), "helpers"),
  ];
  for (const c of candidates) {
    if (existsSync(path.join(c, "macos-input.swift"))) return path.dirname(c);
  }
  return process.cwd();
}

let cachedMacHelper: string | null | undefined;

async function ensureMacInputHelper(): Promise<string> {
  if (cachedMacHelper && existsSync(cachedMacHelper)) return cachedMacHelper;
  const root = packageRoot();
  const src = path.join(root, "helpers", "macos-input.swift");
  if (!existsSync(src)) {
    throw new Error(`macos-input.swift not found at ${src}`);
  }
  const cacheDir = path.join(
    process.env.HOME || tmpdir(),
    ".cache",
    "rakazo-pc-edge",
  );
  mkdirSync(cacheDir, { recursive: true });
  const hash = createHash("sha1").update(readFileSync(src)).digest("hex").slice(0, 12);
  const out = path.join(cacheDir, `macos-input-${hash}`);
  if (!existsSync(out)) {
    const swiftc = which("swiftc");
    if (!swiftc) {
      throw new Error(
        "swiftc not found — install Xcode Command Line Tools (`xcode-select --install`) to enable native mouse/keyboard",
      );
    }
    await execFileAsync(swiftc, ["-O", "-framework", "Cocoa", "-o", out, src], {
      timeout: 120_000,
    });
  }
  cachedMacHelper = out;
  return out;
}

async function macInput(args: string[]): Promise<string> {
  const bin = await ensureMacInputHelper();
  const { stdout } = await execFileAsync(bin, args, { encoding: "utf8", timeout: 15_000 });
  return stdout.trim();
}

export function nativeHints(): string[] {
  if (process.platform === "darwin") {
    return [
      "Grant Screen Recording + Accessibility to Terminal/node (System Settings → Privacy & Security)",
      "Compile uses Xcode CLT (swiftc) once into ~/.cache/rakazo-pc-edge/",
    ];
  }
  if (process.platform === "linux") {
    return [
      "Install xdotool for mouse/keyboard (X11)",
      "Install imagemagick (import) or gnome-screenshot or grim (Wayland) for screenshots",
    ];
  }
  return ["Native desktop control is not supported on this platform — use VNC backend"];
}

export async function nativeAvailable(): Promise<boolean> {
  if (process.platform === "darwin") {
    return Boolean(which("screencapture"));
  }
  if (process.platform === "linux") {
    return Boolean(which("xdotool") || which("import") || which("gnome-screenshot") || which("grim"));
  }
  return false;
}

export async function nativeScreenSize(): Promise<ScreenSize> {
  if (process.platform === "darwin") {
    const out = await macInput(["size"]);
    const [w, h] = out.split(/\s+/).map(Number);
    if (!w || !h) throw new Error(`bad size from macos-input: ${out}`);
    return { width: w, height: h, backend: "native" };
  }
  if (process.platform === "linux") {
    const xdotool = which("xdotool");
    if (xdotool) {
      const { stdout } = await execFileAsync(xdotool, ["getdisplaygeometry"], { encoding: "utf8" });
      const [w, h] = stdout.trim().split(/\s+/).map(Number);
      return { width: w, height: h, backend: "native" };
    }
  }
  throw new Error("native screen size unavailable");
}

async function resizeJpeg(inputPath: string, maxWidth: number, quality: number): Promise<Buffer> {
  const outPath = `${inputPath}.jpg`;
  if (process.platform === "darwin" && which("sips")) {
    // sips can re-encode; resize if needed
    await execFileAsync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", String(quality), inputPath, "--out", outPath], {
      timeout: 30_000,
    });
    if (maxWidth > 0) {
      await execFileAsync("sips", ["--resampleWidth", String(maxWidth), outPath], { timeout: 30_000 }).catch(
        () => undefined,
      );
    }
    const buf = readFileSync(outPath);
    try {
      unlinkSync(outPath);
    } catch {
      /* ignore */
    }
    return buf;
  }
  const convert = which("magick") || which("convert");
  if (convert) {
    const args =
      maxWidth > 0
        ? [inputPath, "-resize", `${maxWidth}>`, "-quality", String(quality), outPath]
        : [inputPath, "-quality", String(quality), outPath];
    await execFileAsync(convert, args, { timeout: 30_000 });
    const buf = readFileSync(outPath);
    try {
      unlinkSync(outPath);
    } catch {
      /* ignore */
    }
    return buf;
  }
  // Fallback: return PNG as-is (caller may still base64 it)
  return readFileSync(inputPath);
}

export async function nativeScreenshot(opts?: {
  maxWidth?: number;
  quality?: number;
  region?: { x: number; y: number; width: number; height: number };
}): Promise<DesktopFrame> {
  const maxWidth = opts?.maxWidth ?? 1280;
  const quality = opts?.quality ?? 55;
  const tmp = path.join(
    tmpdir(),
    `edge-desk-${Date.now()}-${Math.random().toString(36).slice(2)}.png`,
  );

  try {
    if (process.platform === "darwin") {
      const args = ["-x", "-t", "png"];
      if (opts?.region) {
        const { x, y, width, height } = opts.region;
        args.push("-R", `${x},${y},${width},${height}`);
      }
      args.push(tmp);
      await execFileAsync("screencapture", args, { timeout: 20_000 });
    } else if (process.platform === "linux") {
      if (which("grim")) {
        const args = opts?.region
          ? ["-g", `${opts.region.x},${opts.region.y} ${opts.region.width}x${opts.region.height}`, tmp]
          : [tmp];
        await execFileAsync("grim", args, { timeout: 20_000 });
      } else if (which("import")) {
        const args = opts?.region
          ? [
              "-window",
              "root",
              "-crop",
              `${opts.region.width}x${opts.region.height}+${opts.region.x}+${opts.region.y}`,
              tmp,
            ]
          : ["-window", "root", tmp];
        await execFileAsync("import", args, { timeout: 20_000 });
      } else if (which("gnome-screenshot")) {
        await execFileAsync("gnome-screenshot", ["-f", tmp], { timeout: 20_000 });
      } else {
        throw new Error("No screenshot tool (install grim, imagemagick, or gnome-screenshot)");
      }
    } else {
      throw new Error(`native screenshot unsupported on ${process.platform}`);
    }

    const jpeg = await resizeJpeg(tmp, maxWidth, quality);
    const size = await nativeScreenSize().catch(() => ({ width: 0, height: 0, backend: "native" as const }));
    return {
      width: size.width || maxWidth,
      height: size.height || 0,
      format: "jpeg",
      bytes: jpeg,
      backend: "native",
      capturedAt: new Date().toISOString(),
    };
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

export async function nativeMove(x: number, y: number): Promise<void> {
  if (process.platform === "darwin") {
    await macInput(["move", String(Math.round(x)), String(Math.round(y))]);
    return;
  }
  const xdotool = which("xdotool");
  if (!xdotool) throw new Error("xdotool not found");
  await execFileAsync(xdotool, ["mousemove", "--sync", String(Math.round(x)), String(Math.round(y))]);
}

export async function nativeClick(
  x: number,
  y: number,
  button: MouseButton = "left",
  double = false,
): Promise<void> {
  if (process.platform === "darwin") {
    const args = ["click", button];
    if (double) args.push("double");
    args.push(String(Math.round(x)), String(Math.round(y)));
    await macInput(args);
    return;
  }
  const xdotool = which("xdotool");
  if (!xdotool) throw new Error("xdotool not found");
  const map = { left: "1", middle: "2", right: "3" };
  await execFileAsync(xdotool, [
    "mousemove",
    "--sync",
    String(Math.round(x)),
    String(Math.round(y)),
    "click",
    "--repeat",
    double ? "2" : "1",
    map[button],
  ]);
}

export async function nativeDrag(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  button: MouseButton = "left",
): Promise<void> {
  if (process.platform === "darwin") {
    await macInput([
      "drag",
      String(Math.round(x1)),
      String(Math.round(y1)),
      String(Math.round(x2)),
      String(Math.round(y2)),
      button === "right" ? "right" : "left",
    ]);
    return;
  }
  const xdotool = which("xdotool");
  if (!xdotool) throw new Error("xdotool not found");
  const map = { left: "1", middle: "2", right: "3" };
  await execFileAsync(xdotool, [
    "mousemove",
    "--sync",
    String(Math.round(x1)),
    String(Math.round(y1)),
    "mousedown",
    map[button],
    "mousemove",
    "--sync",
    String(Math.round(x2)),
    String(Math.round(y2)),
    "mouseup",
    map[button],
  ]);
}

export async function nativeScroll(x: number, y: number, dy: number, dx = 0): Promise<void> {
  if (process.platform === "darwin") {
    await macInput(["move", String(Math.round(x)), String(Math.round(y))]);
    await macInput(["scroll", String(-dy), String(dx)]);
    return;
  }
  const xdotool = which("xdotool");
  if (!xdotool) throw new Error("xdotool not found");
  await execFileAsync(xdotool, ["mousemove", "--sync", String(Math.round(x)), String(Math.round(y))]);
  const btn = dy < 0 ? "4" : "5";
  const n = Math.min(20, Math.abs(dy) || 1);
  for (let i = 0; i < n; i++) {
    await execFileAsync(xdotool, ["click", btn]);
  }
}

export async function nativeType(text: string): Promise<void> {
  if (process.platform === "darwin") {
    await macInput(["type", text]);
    return;
  }
  const xdotool = which("xdotool");
  if (!xdotool) throw new Error("xdotool not found");
  await execFileAsync(xdotool, ["type", "--clearmodifiers", "--", text]);
}

export async function nativeKey(keys: string[]): Promise<void> {
  if (process.platform === "darwin") {
    // Chord: hold modifiers then tap last key — simplified: tap each / hotkey via first key names
    if (keys.length === 1) {
      await macInput(["key", keys[0]!, "tap"]);
      return;
    }
    // Use AppleScript keystroke for chords when possible
    const map: Record<string, string> = {
      cmd: "command down",
      command: "command down",
      shift: "shift down",
      option: "option down",
      alt: "option down",
      ctrl: "control down",
      control: "control down",
    };
    const mods = keys.slice(0, -1).map((k) => map[k.toLowerCase()]).filter(Boolean);
    const last = keys[keys.length - 1]!;
    if (mods.length && last.length === 1) {
      const script = `tell application "System Events" to keystroke "${last.replace(/"/g, '\\"')}" using {${mods.join(", ")}}`;
      await execFileAsync("osascript", ["-e", script]);
      return;
    }
    for (const k of keys) await macInput(["key", k, "tap"]);
    return;
  }
  const xdotool = which("xdotool");
  if (!xdotool) throw new Error("xdotool not found");
  const joined = keys.map((k) => k.toLowerCase()).join("+");
  await execFileAsync(xdotool, ["key", "--clearmodifiers", joined]);
}

/** Best-effort open app / URL on the host GUI session. */
export async function nativeOpen(target: string, app?: string): Promise<void> {
  if (process.platform === "darwin") {
    if (app) {
      await execFileAsync("open", ["-a", app, target]);
    } else {
      await execFileAsync("open", [target]);
    }
    return;
  }
  if (process.platform === "linux") {
    const opener = which("xdg-open");
    if (!opener) throw new Error("xdg-open not found");
    spawn(opener, [target], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  throw new Error("native open unsupported");
}
