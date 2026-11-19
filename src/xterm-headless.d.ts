declare module "@xterm/headless" {
  export class Terminal {
    constructor(options?: {
      cols?: number;
      rows?: number;
      allowProposedApi?: boolean;
      scrollback?: number;
    });
    readonly cols: number;
    readonly rows: number;
    readonly buffer: {
      active: {
        viewportY: number;
        getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined;
      };
    };
    write(data: string | Uint8Array, callback?: () => void): void;
    resize(cols: number, rows: number): void;
    dispose(): void;
  }

  const _default: { Terminal: typeof Terminal };
  export default _default;
}
