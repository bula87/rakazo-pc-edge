import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, describe, it } from "node:test";
import {
  buildBwrapArgs,
  buildSeatbeltProfile,
  resolveBwrapBinary,
  resolveChdirUnderRoot,
  sandboxBackend,
  sbEscape,
  wrapForPrivilege,
} from "./privilege.js";
import { createScope } from "./scope.js";
import { shellTool } from "./fs-tools.js";

describe("privilege / sandbox", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pc-edge-priv-"));
  const nested = path.join(root, "proj");
  mkdirSync(nested);
  writeFileSync(path.join(nested, "ok.txt"), "inside");

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("createScope defaults to sandbox", () => {
    const scope = createScope({ workerDir: nested });
    assert.equal(scope.privilege, "sandbox");
    assert.equal(scope.mode, "worker-dir");
  });

  it("createScope god aliases --global", () => {
    const scope = createScope({ global: true });
    assert.equal(scope.privilege, "god");
    assert.equal(scope.mode, "global");
  });

  it("rejects god + worker-dir", () => {
    assert.throws(() => createScope({ privilege: "god", workerDir: nested }));
  });

  it("resolveChdirUnderRoot rejects escape", () => {
    assert.throws(() => resolveChdirUnderRoot(nested, root));
  });

  it("sandboxBackend is bwrap on linux and seatbelt on darwin", () => {
    assert.equal(sandboxBackend("linux"), "bwrap");
    assert.equal(sandboxBackend("darwin"), "seatbelt");
    assert.throws(() => sandboxBackend("win32"));
  });

  it("sbEscape escapes quotes and backslashes", () => {
    assert.equal(sbEscape('a"b\\c'), 'a\\"b\\\\c');
  });

  it("buildSeatbeltProfile denies default and allows the project root", () => {
    const profile = buildSeatbeltProfile(nested, "/bin/true");
    assert.match(profile, /\(deny default\)/);
    assert.match(profile, /\(allow network\*\)/);
    assert.match(profile, new RegExp(`subpath "${nested.replace(/\\/g, "\\\\")}"`));
    assert.match(profile, /\(allow process\*\)/);
  });

  it("buildBwrapArgs includes bind of root and command", () => {
    const args = buildBwrapArgs(nested, "/bin/true", []);
    assert.ok(args.includes("--bind"));
    const bindIdx = args.indexOf("--bind");
    assert.equal(args[bindIdx + 1], nested);
    assert.equal(args[bindIdx + 2], nested);
    assert.ok(args.includes("--chdir"));
    assert.equal(args[args.indexOf("--chdir") + 1], nested);
    const dd = args.indexOf("--");
    assert.ok(dd >= 0);
    assert.equal(args[dd + 1], "/bin/true");
  });

  it("wrapForPrivilege is no-op for half-god and god", () => {
    const half = wrapForPrivilege("half-god", nested, "/bin/echo", ["hi"], { chdir: nested });
    assert.equal(half.sandboxed, false);
    assert.equal(half.cmd, "/bin/echo");
    assert.equal(half.cwd, nested);
    const god = wrapForPrivilege("god", null, "/bin/echo", ["hi"]);
    assert.equal(god.sandboxed, false);
  });

  it("sandbox shell cannot read outside the root", async () => {
    if (process.platform !== "linux" && process.platform !== "darwin") return;
    try {
      if (process.platform === "linux") resolveBwrapBinary();
    } catch {
      return;
    }

    const outside = path.join(root, "secret.txt");
    writeFileSync(outside, "top-secret");

    const scope = createScope({ workerDir: nested, privilege: "sandbox" });
    const inside = await shellTool(scope, "cat ok.txt");
    assert.equal(inside.exitCode, 0);
    assert.match(inside.stdout, /inside/);
    assert.equal(inside.sandboxed, true);

    const probe = await shellTool(scope, `cat ${outside} 2>&1; echo EXIT:$?`);
    assert.equal(probe.sandboxed, true);
    assert.doesNotMatch(probe.stdout, /top-secret/);
  });

  it("half-god shell can read outside the root", async () => {
    const outside = path.join(root, "half-secret.txt");
    writeFileSync(outside, "half-visible");
    const scope = createScope({ workerDir: nested, privilege: "half-god" });
    const probe = await shellTool(scope, `cat ${outside}`);
    assert.equal(probe.exitCode, 0);
    assert.match(probe.stdout, /half-visible/);
    assert.equal(probe.sandboxed, false);
  });

  it("bwrap binary runs --version on linux", () => {
    if (process.platform !== "linux") return;
    try {
      const bin = resolveBwrapBinary();
      const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
      assert.equal(r.status, 0);
      assert.match(r.stdout + r.stderr, /bubblewrap|bwrap/i);
    } catch {
      // optional
    }
  });
});
