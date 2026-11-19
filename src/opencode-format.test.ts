import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatOpencodeJsonLine, OpencodeJsonPretty } from "./opencode-format.js";

describe("formatOpencodeJsonLine", () => {
  it("formats tool_use and text; hides step_start", () => {
    assert.equal(
      formatOpencodeJsonLine(
        JSON.stringify({ type: "step_start", sessionID: "ses_x" }),
      ).text,
      null,
    );
    const tool = formatOpencodeJsonLine(
      JSON.stringify({
        type: "tool_use",
        sessionID: "ses_x",
        part: {
          tool: "write",
          state: {
            status: "completed",
            input: { path: "main.py", content: 'print("hi")\n' },
            output: "Created file successfully: main.py",
          },
        },
      }),
    );
    assert.match(tool.text ?? "", /tool write/);
    assert.match(tool.text ?? "", /main\.py/);
    assert.equal(tool.sessionId, "ses_x");

    const text = formatOpencodeJsonLine(
      JSON.stringify({
        type: "text",
        sessionID: "ses_x",
        part: { text: "Done." },
      }),
    );
    assert.equal(text.text, "assistant: Done.");
  });

  it("formats retries", () => {
    const r = formatOpencodeJsonLine(
      JSON.stringify({
        type: "retry",
        sessionID: "ses_x",
        attempt: 2,
        error: { message: "The inference service is overloaded." },
      }),
    );
    assert.match(r.text ?? "", /retry #2/);
  });
});

describe("OpencodeJsonPretty", () => {
  it("buffers partial lines and tracks session id", () => {
    const p = new OpencodeJsonPretty();
    const a = p.push('{"type":"step_start","sessionID":"ses_abc","part":{}}\n');
    assert.equal(a, "");
    assert.equal(p.opencodeSessionId, "ses_abc");
    const b = p.push(
      '{"type":"text","sessionID":"ses_abc","part":{"text":"hello"}}\n',
    );
    assert.match(b, /assistant: hello/);
  });
});
