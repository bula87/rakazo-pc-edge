/**
 * Hybrid desktop control for PC Edge.
 * - native: OS screenshot + input (macOS Swift helper / Linux xdotool)
 * - vnc: persistent RFB client to local Screen Sharing (vincent-vnc-mcp style)
 * - auto: prefer VNC when connected, else native
 */
import { log } from "../log.js";
import {
  nativeAvailable,
  nativeClick,
  nativeDrag,
  nativeHints,
  nativeKey,
  nativeMove,
  nativeOpen,
  nativeScreenSize,
  nativeScreenshot,
  nativeScroll,
  nativeType,
} from "./native.js";
import { readVncSettingsFromEnv, VncSession, type VncState } from "./vnc.js";
import type {
  DesktopBackend,
  DesktopCapabilities,
  DesktopFrame,
  MouseButton,
  ScreenSize,
  VncSettings,
} from "./types.js";

export type { DesktopBackend, DesktopCapabilities, DesktopFrame, MouseButton, ScreenSize };

export class DesktopController {
  private vnc: VncSession | null = null;
  private started = false;

  constructor(
    private readonly enabled: boolean,
    private readonly preferredBackend: DesktopBackend = "auto",
    private readonly vncSettings: VncSettings = readVncSettingsFromEnv(),
  ) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  async start(): Promise<void> {
    if (!this.enabled || this.started) return;
    this.started = true;
    if (this.preferredBackend === "vnc" || this.preferredBackend === "auto") {
      if (this.vncSettings.password || this.vncSettings.username) {
        this.vnc = new VncSession(this.vncSettings);
        await this.vnc.start();
        log(
          `desktop VNC manager started → ${this.vncSettings.host}:${this.vncSettings.port} (vincent-style persistent client)`,
        );
      } else if (this.preferredBackend === "vnc") {
        log(
          "desktop: VNC backend requested but EDGE_VNC_PASSWORD / VNC_PASSWORD not set — waiting for connect via tools",
        );
        this.vnc = new VncSession(this.vncSettings);
        await this.vnc.start();
      }
    }
  }

  async stop(): Promise<void> {
    await this.vnc?.stop();
    this.vnc = null;
    this.started = false;
  }

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new Error(
        "Desktop control disabled. Restart Edge with --desktop (and optionally EDGE_VNC_PASSWORD for Screen Sharing).",
      );
    }
  }

  private vncReady(): boolean {
    return this.vnc?.getState() === "connected";
  }

  private useVnc(): boolean {
    if (this.preferredBackend === "native") return false;
    if (this.preferredBackend === "vnc") return true;
    return this.vncReady();
  }

  async capabilities(): Promise<DesktopCapabilities> {
    const nativeOk = await nativeAvailable();
    const vncState: VncState = this.vnc?.getState() ?? "disconnected";
    return {
      enabled: this.enabled,
      preferredBackend: this.preferredBackend,
      activeBackend: this.enabled ? (this.useVnc() && this.vncReady() ? "vnc" : nativeOk ? "native" : null) : null,
      native: {
        available: nativeOk,
        platform: process.platform,
        hints: nativeHints(),
      },
      vnc: {
        configured: Boolean(this.vncSettings.password || this.vncSettings.username),
        connected: this.vncReady(),
        host: this.vncSettings.host,
        port: this.vncSettings.port,
        state: vncState,
        hints: [
          "Inspired by vincent-vnc-mcp: connect to localhost Screen Sharing (port 5900)",
          "Set EDGE_VNC_USER + EDGE_VNC_PASSWORD (macOS Screen Sharing user)",
          "Enable System Settings → General → Sharing → Screen Sharing",
          "Live view: GET /desktop/frame.jpg with the same Bearer token as MCP",
        ],
      },
      liveViewPath: "/desktop/frame.jpg",
    };
  }

  async screenSize(): Promise<ScreenSize> {
    this.assertEnabled();
    if (this.useVnc() && this.vncReady()) return this.vnc!.screenSize();
    return nativeScreenSize();
  }

  async snapshot(opts?: {
    maxWidth?: number;
    quality?: number;
    region?: { x: number; y: number; width: number; height: number };
  }): Promise<DesktopFrame> {
    this.assertEnabled();
    if (this.useVnc() && this.vncReady()) {
      return this.vnc!.screenshot(opts?.region);
    }
    return nativeScreenshot(opts);
  }

  /** Cached VNC frame for live HTTP viewer (null if none). */
  latestVncFrame(): DesktopFrame | null {
    return this.vnc?.getLatestFrame() ?? null;
  }

  async move(x: number, y: number): Promise<{ backend: string }> {
    this.assertEnabled();
    if (this.useVnc() && this.vncReady()) {
      await this.vnc!.move(x, y);
      return { backend: "vnc" };
    }
    await nativeMove(x, y);
    return { backend: "native" };
  }

  async click(
    x: number,
    y: number,
    button: MouseButton = "left",
    double = false,
  ): Promise<{ backend: string }> {
    this.assertEnabled();
    if (this.useVnc() && this.vncReady()) {
      await this.vnc!.click(x, y, button, double);
      return { backend: "vnc" };
    }
    await nativeClick(x, y, button, double);
    return { backend: "native" };
  }

  async scroll(x: number, y: number, dy: number): Promise<{ backend: string }> {
    this.assertEnabled();
    if (this.useVnc() && this.vncReady()) {
      await this.vnc!.scroll(x, y, dy);
      return { backend: "vnc" };
    }
    await nativeScroll(x, y, dy);
    return { backend: "native" };
  }

  async drag(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    button: MouseButton = "left",
  ): Promise<{ backend: string }> {
    this.assertEnabled();
    if (this.useVnc() && this.vncReady()) {
      await this.vnc!.drag(x1, y1, x2, y2, button);
      return { backend: "vnc" };
    }
    await nativeDrag(x1, y1, x2, y2, button);
    return { backend: "native" };
  }

  /** Vincent-style: poll cached VNC frame size as a cheap change proxy. */
  async waitForScreenChange(timeoutMs = 10_000, pollIntervalMs = 500): Promise<{
    changed: boolean;
    backend: string;
  }> {
    this.assertEnabled();
    if (this.useVnc() && this.vncReady()) {
      const baseline = this.vnc!.getLatestFrame();
      const baselineLen = baseline?.bytes.length ?? null;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        const frame = this.vnc!.getLatestFrame();
        if (frame && frame.bytes.length !== baselineLen) {
          return { changed: true, backend: "vnc" };
        }
      }
      return { changed: false, backend: "vnc" };
    }
    // Native: compare successive screenshots (smaller maxWidth for speed)
    const first = await nativeScreenshot({ maxWidth: 640, quality: 40 });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      const next = await nativeScreenshot({ maxWidth: 640, quality: 40 });
      if (next.bytes.length !== first.bytes.length || !next.bytes.equals(first.bytes)) {
        return { changed: true, backend: "native" };
      }
    }
    return { changed: false, backend: "native" };
  }

  async type(text: string): Promise<{ backend: string }> {
    this.assertEnabled();
    if (this.useVnc() && this.vncReady()) {
      await this.vnc!.typeText(text);
      return { backend: "vnc" };
    }
    await nativeType(text);
    return { backend: "native" };
  }

  async keys(keys: string[]): Promise<{ backend: string }> {
    this.assertEnabled();
    if (this.useVnc() && this.vncReady()) {
      await this.vnc!.pressKeys(keys);
      return { backend: "vnc" };
    }
    await nativeKey(keys);
    return { backend: "native" };
  }

  async open(target: string, app?: string): Promise<{ backend: string }> {
    this.assertEnabled();
    // App launching is always native (vincent does the same for open/pbcopy).
    await nativeOpen(target, app);
    return { backend: "native" };
  }

  vncStatus(): {
    state: VncState;
    mouse: { x: number; y: number };
    frameAgeMs: number | null;
    host: string;
    port: number;
  } {
    const frame = this.vnc?.getLatestFrame();
    const age = frame ? Date.now() - Date.parse(frame.capturedAt) : null;
    return {
      state: this.vnc?.getState() ?? "disconnected",
      mouse: this.vnc?.getMouse() ?? { x: 0, y: 0 },
      frameAgeMs: age,
      host: this.vncSettings.host,
      port: this.vncSettings.port,
    };
  }
}

export function parseDesktopBackend(raw: string | undefined): DesktopBackend {
  if (raw === "native" || raw === "vnc" || raw === "auto") return raw;
  return "auto";
}
