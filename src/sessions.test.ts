import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, after } from "node:test";
import { createScope } from "./scope.js";
import { SessionManager } from "./sessions.js";
import { listDir } from "./fs-tools.js";

describe("SessionManager concurrency", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pc-edge-sess-"));
  writeFileSync(path.join(root, "note.txt"), "hello");
  const scope = createScope({ workerDir: root });
  const sessions = new SessionManager(scope);

  after(() => {
    sessions.closeAll();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps a session open while list_dir still works", async () => {
    const info = await sessions.spawn({
      cmd: "bash",
      args: ["-lc", "echo START; sleep 2; echo END"],
      pty: false,
      label: "sleeper",
    });
    assert.equal(info.exited, false);

    const entries = await listDir(scope, ".");
    assert.ok(entries.some((e) => e.name === "note.txt"));

    const event = await sessions.waitEvent(info.id, ["done", "error"], 10_000);
    assert.equal(event.kind, "done");
    const read = sessions.read(info.id, 0);
    assert.match(read.text, /START/);
    assert.match(read.text, /END/);
  });

  it("accepts stdin on a pipe session", async () => {
    const info = await sessions.spawn({
      cmd: "bash",
      args: ["-lc", "read line; echo got:$line"],
      pty: false,
    });
    sessions.stdin(info.id, "ping");
    const event = await sessions.waitEvent(info.id, ["done", "error"], 10_000);
    assert.equal(event.kind, "done");
    assert.match(sessions.read(info.id, 0).text, /got:ping/);
  });
});
