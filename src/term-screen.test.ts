import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TermScreen } from "./term-screen.js";

describe("TermScreen", () => {
  it("applies cursor addressing instead of appending garbled CSI", async () => {
    const screen = new TermScreen(40, 5);
    screen.write("\x1b[2J\x1b[HLine1\x1b[2;1HLine2");
    const snap = await screen.snapshot();
    const lines = snap.split("\n");
    assert.equal(lines[0]?.trimEnd(), "Line1");
    assert.equal(lines[1]?.trimEnd(), "Line2");
    assert.ok(!snap.includes("\x1b"));
  });

  it("overwrites in place like a real TUI redraw", async () => {
    const screen = new TermScreen(20, 3);
    screen.write("\x1b[2J\x1b[HAAAA");
    screen.write("\x1b[1;1HBB");
    const snap = await screen.snapshot();
    assert.match(snap.split("\n")[0] ?? "", /^BB/);
  });
});
