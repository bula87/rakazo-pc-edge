import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, after } from "node:test";
import { createScope, resolveInScope, isDeniedSecretPath } from "./scope.js";

describe("scope", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pc-edge-"));
  const nested = path.join(root, "proj");
  mkdirSync(nested);
  writeFileSync(path.join(nested, "a.txt"), "hi");

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("scopes to worker-dir", () => {
    const scope = createScope({ workerDir: nested });
    assert.equal(scope.mode, "worker-dir");
    assert.equal(resolveInScope(scope, "a.txt"), path.join(nested, "a.txt"));
    assert.throws(() => resolveInScope(scope, path.join(root, "outside.txt")));
  });

  it("allows global anywhere", () => {
    const scope = createScope({ global: true });
    assert.equal(scope.mode, "global");
    assert.ok(resolveInScope(scope, "/tmp").startsWith("/"));
  });

  it("denies secret basenames", () => {
    assert.equal(isDeniedSecretPath("/x/.env", false), true);
    assert.equal(isDeniedSecretPath("/x/.env", true), false);
    assert.equal(isDeniedSecretPath("/x/readme.md", false), false);
  });
});
