import { EventEmitter } from "node:events";
import type { SessionInfo } from "./sessions.js";

export type GlobalLine = { at: string; text: string };

export type BusEvents = {
  "global:line": [GlobalLine];
  "session:spawn": [SessionInfo];
  "session:output": [{ sessionId: string; label: string; chunk: string }];
  "session:exit": [{ sessionId: string; label: string; exitCode: number | null }];
  "session:stdin": [{ sessionId: string; label: string; data: string }];
  "session:updated": [SessionInfo];
};

class EdgeBus extends EventEmitter {
  emit<K extends keyof BusEvents>(event: K, ...args: BusEvents[K]): boolean {
    return super.emit(event, ...args);
  }
  on<K extends keyof BusEvents>(event: K, listener: (...args: BusEvents[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  off<K extends keyof BusEvents>(event: K, listener: (...args: BusEvents[K]) => void): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }
}

/** Process-wide event bus for logs + sessions (TUI and plain console both listen). */
export const bus = new EdgeBus();
bus.setMaxListeners(50);
