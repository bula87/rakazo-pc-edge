/**
 * Persistent VNC client (inspired by cookiemonster0921/vincent-vnc-mcp).
 * Connects to local Screen Sharing / VNC, keeps a JPEG frame cache, injects
 * pointer/keyboard over RFB via `rfb2`.
 */
import { log } from "../log.js";
import type { DesktopFrame, MouseButton, ScreenSize, VncSettings } from "./types.js";

export type VncState = "disconnected" | "connecting" | "connected" | "reconnecting";

type RfbModule = typeof import("rfb2");

export class VncSession {
  private client: Awaited<ReturnType<RfbModule["connect"]>> | null = null;
  private fb: InstanceType<RfbModule["Framebuffer"]> | null = null;
  private rfb: RfbModule | null = null;
  private state: VncState = "disconnected";
  private latest: DesktopFrame | null = null;
  private mouse = { x: 0, y: 0 };
  private maintainTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private jpegQuality: number;
  private frameIntervalMs: number;

  constructor(
    private readonly settings: VncSettings,
    opts?: { jpegQuality?: number; frameIntervalMs?: number },
  ) {
    this.jpegQuality = opts?.jpegQuality ?? 55;
    this.frameIntervalMs = opts?.frameIntervalMs ?? 400;
  }

  getState(): VncState {
    return this.state;
  }

  getLatestFrame(): DesktopFrame | null {
    return this.latest;
  }

  getMouse(): { x: number; y: number } {
    return { ...this.mouse };
  }

  async start(): Promise<void> {
    this.stopping = false;
    void this.maintainLoop();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.maintainTimer) clearTimeout(this.maintainTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    await this.disconnect();
    this.state = "disconnected";
  }

  private async loadRfb(): Promise<RfbModule> {
    if (this.rfb) return this.rfb;
    try {
      this.rfb = await import("rfb2");
      return this.rfb;
    } catch (err) {
      throw new Error(
        `rfb2 not available (${err instanceof Error ? err.message : err}). Use Node 22.12+ and npm install rfb2, or set desktop backend to native.`,
      );
    }
  }

  private async maintainLoop(): Promise<void> {
    let backoff = 1000;
    while (!this.stopping) {
      try {
        this.state = this.client ? "reconnecting" : "connecting";
        await this.connect();
        this.state = "connected";
        backoff = 1000;
        log(
          `desktop VNC connected ${this.settings.host}:${this.settings.port} ${this.client?.width}x${this.client?.height}`,
        );
        await this.refreshLoop();
      } catch (err) {
        if (this.stopping) break;
        log(
          `desktop VNC error: ${err instanceof Error ? err.message : err}; retry in ${backoff}ms`,
        );
        this.state = "reconnecting";
        await this.disconnect();
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 15_000);
      }
    }
  }

  private async connect(): Promise<void> {
    await this.disconnect();
    const rfb = await this.loadRfb();
    const client = await rfb.connect({
      host: this.settings.host,
      port: this.settings.port,
      username: this.settings.username,
      password: this.settings.password,
      shared: true,
      autoUpdate: true,
      timeout: 15_000,
    });
    this.client = client;
    this.fb = rfb.Framebuffer.attach(client);
    // Kick one full update
    await this.captureJpeg();
  }

  private async disconnect(): Promise<void> {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        /* ignore */
      }
    }
    this.client = null;
    this.fb = null;
  }

  private async refreshLoop(): Promise<void> {
    while (!this.stopping && this.client) {
      try {
        await this.captureJpeg();
      } catch (err) {
        throw err;
      }
      await sleep(this.frameIntervalMs);
    }
  }

  private requireClient() {
    if (!this.client || this.state !== "connected") {
      throw new Error(`VNC not connected (state=${this.state})`);
    }
    return this.client;
  }

  private async captureJpeg(): Promise<DesktopFrame> {
    const client = this.requireClient();
    const fb = this.fb;
    if (!fb) throw new Error("VNC framebuffer missing");
    const rgba = fb.toRgba();
    const jpeg = await rgbaToJpeg(Buffer.from(rgba), client.width, client.height, this.jpegQuality);
    const frame: DesktopFrame = {
      width: client.width,
      height: client.height,
      format: "jpeg",
      bytes: jpeg,
      backend: "vnc",
      capturedAt: new Date().toISOString(),
    };
    this.latest = frame;
    return frame;
  }

  async screenshot(region?: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): Promise<DesktopFrame> {
    const full = await this.captureJpeg();
    if (!region) return full;
    // Region crop is approximate after JPEG; re-capture full and crop raw RGBA when possible
    const client = this.requireClient();
    const fb = this.fb;
    if (!fb) return full;
    const rgba = Buffer.from(fb.toRgba());
    const cropped = cropRgba(rgba, client.width, client.height, region);
    const jpeg = await rgbaToJpeg(cropped.buf, cropped.width, cropped.height, this.jpegQuality);
    return {
      width: cropped.width,
      height: cropped.height,
      format: "jpeg",
      bytes: jpeg,
      backend: "vnc",
      capturedAt: new Date().toISOString(),
    };
  }

  screenSize(): ScreenSize {
    const client = this.requireClient();
    return { width: client.width, height: client.height, backend: "vnc" };
  }

  async move(x: number, y: number): Promise<void> {
    const client = this.requireClient();
    const rfb = await this.loadRfb();
    client.pointerEvent(Math.round(x), Math.round(y), 0);
    this.mouse = { x: Math.round(x), y: Math.round(y) };
    void rfb; // keep typed
  }

  async click(x: number, y: number, button: MouseButton = "left", double = false): Promise<void> {
    const client = this.requireClient();
    const rfb = await this.loadRfb();
    const mask =
      button === "right" ? rfb.buttons.right : button === "middle" ? rfb.buttons.middle : rfb.buttons.left;
    const xi = Math.round(x);
    const yi = Math.round(y);
    client.pointerEvent(xi, yi, mask);
    client.pointerEvent(xi, yi, 0);
    if (double) {
      client.pointerEvent(xi, yi, mask);
      client.pointerEvent(xi, yi, 0);
    }
    this.mouse = { x: xi, y: yi };
  }

  async drag(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    button: MouseButton = "left",
  ): Promise<void> {
    const client = this.requireClient();
    const rfb = await this.loadRfb();
    const mask =
      button === "right" ? rfb.buttons.right : button === "middle" ? rfb.buttons.middle : rfb.buttons.left;
    const a = { x: Math.round(x1), y: Math.round(y1) };
    const b = { x: Math.round(x2), y: Math.round(y2) };
    client.pointerEvent(a.x, a.y, 0);
    client.pointerEvent(a.x, a.y, mask);
    client.pointerEvent(b.x, b.y, mask);
    client.pointerEvent(b.x, b.y, 0);
    this.mouse = { x: b.x, y: b.y };
  }

  async scroll(x: number, y: number, dy: number): Promise<void> {
    const client = this.requireClient();
    const rfb = await this.loadRfb();
    const xi = Math.round(x);
    const yi = Math.round(y);
    client.pointerEvent(xi, yi, 0);
    const n = Math.min(20, Math.abs(dy) || 1);
    // wheel via button 4/5 if available
    const wheel = dy < 0 ? rfb.buttons.wheelUp : rfb.buttons.wheelDown;
    for (let i = 0; i < n; i++) {
      client.pointerEvent(xi, yi, wheel);
      client.pointerEvent(xi, yi, 0);
    }
    this.mouse = { x: xi, y: yi };
  }

  async typeText(text: string): Promise<void> {
    const client = this.requireClient();
    const rfb = await this.loadRfb();
    const ks = rfb.keysyms as unknown as Record<string, number | undefined>;
    for (const ch of text) {
      const sym = ks[ch] ?? ch.codePointAt(0)!;
      client.keyEvent(sym, true);
      client.keyEvent(sym, false);
    }
  }

  async pressKeys(keys: string[]): Promise<void> {
    const client = this.requireClient();
    const rfb = await this.loadRfb();
    const syms = keys.map((k) => resolveKeysym(rfb, k));
    for (const s of syms) client.keyEvent(s, true);
    for (const s of [...syms].reverse()) client.keyEvent(s, false);
  }
}

function resolveKeysym(rfb: RfbModule, key: string): number {
  const aliases: Record<string, string> = {
    enter: "Return",
    return: "Return",
    esc: "Escape",
    escape: "Escape",
    cmd: "MetaLeft",
    command: "MetaLeft",
    meta: "MetaLeft",
    super: "SuperLeft",
    ctrl: "ControlLeft",
    control: "ControlLeft",
    alt: "AltLeft",
    option: "AltLeft",
    shift: "ShiftLeft",
    tab: "Tab",
    space: "Space",
    backspace: "BackSpace",
    delete: "Delete",
    up: "Up",
    down: "Down",
    left: "Left",
    right: "Right",
    pageup: "PageUp",
    pagedown: "PageDown",
  };
  const name = aliases[key.toLowerCase()] ?? key;
  const ks = rfb.keysyms as unknown as Record<string, number | undefined>;
  if (typeof ks[name] === "number") return ks[name]!;
  if (typeof ks[key] === "number") return ks[key]!;
  if (key === " " || key.toLowerCase() === "space") return 0x20;
  if (key.length === 1) return key.codePointAt(0)!;
  throw new Error(`Unknown key: ${key}`);
}

function cropRgba(
  rgba: Buffer,
  srcW: number,
  srcH: number,
  region: { x: number; y: number; width: number; height: number },
): { buf: Buffer; width: number; height: number } {
  const x = Math.max(0, Math.min(srcW - 1, region.x));
  const y = Math.max(0, Math.min(srcH - 1, region.y));
  const w = Math.max(1, Math.min(srcW - x, region.width));
  const h = Math.max(1, Math.min(srcH - y, region.height));
  const out = Buffer.alloc(w * h * 4);
  for (let row = 0; row < h; row++) {
    const srcStart = ((y + row) * srcW + x) * 4;
    rgba.copy(out, row * w * 4, srcStart, srcStart + w * 4);
  }
  return { buf: out, width: w, height: h };
}

async function rgbaToJpeg(rgba: Buffer, width: number, height: number, quality: number): Promise<Buffer> {
  const jpeg = await import("jpeg-js");
  // jpeg-js encodes RGB(A); quality 1–100
  const encoded = jpeg.encode({ data: rgba, width, height }, Math.max(1, Math.min(100, quality)));
  return Buffer.from(encoded.data);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function readVncSettingsFromEnv(): VncSettings {
  return {
    host: process.env.EDGE_VNC_HOST || process.env.VNC_HOST || "127.0.0.1",
    port: Number(process.env.EDGE_VNC_PORT || process.env.VNC_PORT || 5900),
    username: process.env.EDGE_VNC_USER || process.env.VNC_USER || undefined,
    password: process.env.EDGE_VNC_PASSWORD || process.env.VNC_PASSWORD || undefined,
  };
}
