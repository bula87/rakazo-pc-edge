export type DesktopBackend = "auto" | "native" | "vnc";

export type MouseButton = "left" | "middle" | "right";

export interface DesktopFrame {
  width: number;
  height: number;
  format: "jpeg" | "png";
  /** Raw image bytes (not base64). */
  bytes: Buffer;
  backend: "native" | "vnc";
  capturedAt: string;
}

export interface ScreenSize {
  width: number;
  height: number;
  backend: "native" | "vnc";
}

export interface DesktopCapabilities {
  enabled: boolean;
  preferredBackend: DesktopBackend;
  activeBackend: "native" | "vnc" | null;
  native: {
    available: boolean;
    platform: NodeJS.Platform;
    hints: string[];
  };
  vnc: {
    configured: boolean;
    connected: boolean;
    host: string;
    port: number;
    state: string;
    hints: string[];
  };
  liveViewPath: string;
}

export interface VncSettings {
  host: string;
  port: number;
  username?: string;
  password?: string;
}
