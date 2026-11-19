import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keyToSequence } from "./sessions.js";

describe("keyToSequence", () => {
  it("maps enter to CR for PTY TUIs", () => {
    assert.equal(keyToSequence("enter"), "\r");
    assert.equal(keyToSequence("return"), "\r");
  });

  it("maps common navigation keys", () => {
    assert.equal(keyToSequence("esc"), "\x1b");
    assert.equal(keyToSequence("up"), "\x1b[A");
    assert.equal(keyToSequence("ctrl-c"), "\x03");
  });
});
