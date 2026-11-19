/** Ambient types so the package typechecks when optional `node-pty` is absent. */
declare module "node-pty" {
  export interface IPty {
    pid: number;
    write(data: string): void;
    kill(signal?: string): void;
    resize(cols: number, rows: number): void;
    onData(callback: (data: string) => void): void;
    onExit(callback: (e: { exitCode: number; signal?: number }) => void): void;
  }

  export function spawn(
    file: string,
    args: string[] | string,
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string>;
    },
  ): IPty;
}
