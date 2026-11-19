/**
 * VT/ANSI screen mirror for interactive CLIs (OpenCode, etc.).
 * Interprets cursor addressing into a 2D buffer so the TUI can show a stable frame
 * instead of a garbled stream of escape sequences.
 */
import xterm from "@xterm/headless";

const Terminal = xterm.Terminal;

export class TermScreen {
  private term: InstanceType<typeof Terminal>;
  private cols: number;
  private rows: number;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(cols = 120, rows = 40) {
    this.cols = Math.max(20, cols);
    this.rows = Math.max(5, rows);
    this.term = new Terminal({
      cols: this.cols,
      rows: this.rows,
      allowProposedApi: true,
      scrollback: 1_000,
    });
  }

  /** Feed raw PTY bytes/string (may include CSI cursor moves, clears, colors). */
  write(chunk: string): void {
    this.writeChain = this.writeChain.then(async () => {
      await new Promise<void>((resolve) => {
        this.term.write(chunk, () => resolve());
      });
    });
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  resize(cols: number, rows: number): void {
    const c = Math.max(20, Math.floor(cols));
    const r = Math.max(5, Math.floor(rows));
    if (c === this.cols && r === this.rows) return;
    this.cols = c;
    this.rows = r;
    this.term.resize(c, r);
  }

  get size(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }

  /**
   * Visible viewport as plain text lines (colors stripped by translateToString).
   * Prefer this for blessed boxes that don't render ANSI.
   */
  async snapshot(): Promise<string> {
    await this.flush();
    const buf = this.term.buffer.active;
    const lines: string[] = [];
    const base = buf.viewportY;
    for (let y = 0; y < this.term.rows; y++) {
      const line = buf.getLine(base + y);
      lines.push(line ? line.translateToString(true) : "");
    }
    // Trim trailing empty lines for slightly cleaner display, keep at least one.
    while (lines.length > 1 && lines[lines.length - 1]?.trim() === "") lines.pop();
    return lines.join("\n");
  }

  /** Sync-ish snapshot for callers that already awaited recent writes via bus timing. */
  snapshotSync(): string {
    const buf = this.term.buffer.active;
    const lines: string[] = [];
    const base = buf.viewportY;
    for (let y = 0; y < this.term.rows; y++) {
      const line = buf.getLine(base + y);
      lines.push(line ? line.translateToString(true) : "");
    }
    while (lines.length > 1 && lines[lines.length - 1]?.trim() === "") lines.pop();
    return lines.join("\n");
  }
}
