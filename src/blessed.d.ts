declare module "blessed" {
  const blessed: Blessed;
  export default blessed;

  interface Blessed {
    screen(opts?: Record<string, unknown>): Widgets.Screen;
    box(opts?: Record<string, unknown>): Widgets.Box;
    list(opts?: Record<string, unknown>): Widgets.List;
    textbox(opts?: Record<string, unknown>): Widgets.Textbox;
    text(opts?: Record<string, unknown>): Widgets.Box;
  }

  namespace Widgets {
    interface Screen {
      append(node: unknown): void;
      render(): void;
      destroy(): void;
      key(keys: string | string[], cb: (ch: string, key: Key) => void): void;
      on(event: string, cb: (...args: unknown[]) => void): void;
      title: string;
      program: { disableMouse(): void; enableMouse(): void };
    }
    interface Box {
      setContent(text: string): void;
      setLabel(label: string): void;
      focus(): void;
      show(): void;
      hide(): void;
      setFront?(): void;
      on(event: string, cb: (...args: unknown[]) => void): void;
      key(keys: string | string[], cb: (ch: string, key: Key) => void): void;
      getScrollHeight?(): number;
      setScrollPerc?(n: number): void;
      scrollTo?(n: number): void;
      width: number | string;
      height: number | string;
      hidden: boolean;
    }
    interface List extends Box {
      setItems(items: string[]): void;
      select(index: number): void;
      selected: number;
    }
    interface Textbox extends Box {
      readInput(cb: (err: Error | null, value?: string) => void): void;
      clearValue(): void;
      setValue?(value: string): void;
      getValue?(): string;
      setFront?(): void;
      show(): void;
      hide(): void;
      focus(): void;
      hidden: boolean;
      value?: string;
      inputOnFocus?: boolean;
    }
    interface Key {
      name?: string;
      full?: string;
      ctrl?: boolean;
      meta?: boolean;
      shift?: boolean;
      sequence?: string;
    }
  }
}
