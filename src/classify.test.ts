import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyOutput, isStickyKind } from "./classify.js";
import { collectPtyAnswers, inferBusyFromScreen, parseOpenTuiState } from "./pty-answers.js";

describe("classifyOutput", () => {
  it("detects questions and permissions", () => {
    assert.equal(classifyOutput("Which framework should I use?", false, null), "question");
    assert.equal(classifyOutput("Allow writing to package.json? [y/N]", false, null), "permission");
  });

  it("marks exit as done or error", () => {
    assert.equal(classifyOutput("ok", true, 0), "done");
    assert.equal(classifyOutput("boom", true, 1), "error");
  });

  it("prefers OpenCode uiState idle/busy over text heuristics", () => {
    assert.equal(classifyOutput("Which framework?", false, null, "busy"), "busy");
    assert.equal(classifyOutput("Allow write? [y/N]", false, null, "idle"), "idle");
  });
});

describe("isStickyKind", () => {
  it("treats idle/busy as sticky", () => {
    assert.equal(isStickyKind("idle"), true);
    assert.equal(isStickyKind("busy"), true);
    assert.equal(isStickyKind("progress"), false);
  });
});

describe("parseOpenTuiState", () => {
  it("parses OSC 7501 idle and busy", () => {
    assert.equal(parseOpenTuiState("\x1b]7501;state=idle:app=opencode\x07"), "idle");
    assert.equal(parseOpenTuiState("noise]7501;state=busy:app=opencode\x1b\\more"), "busy");
    assert.equal(parseOpenTuiState("]7501;state=clear:id=ses_x\x1b\\"), null);
    assert.equal(parseOpenTuiState("no state here"), null);
  });
});

describe("inferBusyFromScreen", () => {
  it("detects spinners and Thought", () => {
    assert.equal(inferBusyFromScreen("Python project ⠹ New session"), true);
    assert.equal(inferBusyFromScreen("     + Thought · 1.2s"), true);
    assert.equal(inferBusyFromScreen("ready for input"), false);
  });
});

describe("collectPtyAnswers", () => {
  it("answers cursor position and DA queries", () => {
    const a = collectPtyAnswers("\x1b[6n\x1b[0c", { row: 40, col: 1 });
    assert.match(a, /\x1b\[40;1R/);
    assert.match(a, /\x1b\[\?1;2c/);
  });
});
