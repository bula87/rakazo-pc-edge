import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  autoInstanceName,
  formatToolName,
  resolveEdgeInstance,
  slugifyName,
} from "./instance.js";

describe("instance naming", () => {
  it("slugifyName normalizes", () => {
    assert.equal(slugifyName(" MacBook Air!! "), "macbook-air");
    assert.equal(slugifyName("---"), "edge");
  });

  it("formatToolName styles", () => {
    const base = {
      name: "mac",
      nameSource: "flag" as const,
      hostname: "x",
      machineId: null,
    };
    assert.equal(formatToolName({ ...base, toolStyle: "insert" }, "info"), "edge_mac_info");
    assert.equal(formatToolName({ ...base, toolStyle: "prefix" }, "shell"), "mac_edge_shell");
    assert.equal(
      formatToolName({ ...base, toolStyle: "suffix" }, "list_dir"),
      "edge_list_dir_mac",
    );
    assert.equal(formatToolName({ ...base, toolStyle: "bare" }, "info"), "edge_info");
  });

  it("resolveEdgeInstance uses --name", () => {
    const inst = resolveEdgeInstance({ name: "My Mac", toolStyle: "insert" });
    assert.equal(inst.name, "my-mac");
    assert.equal(inst.nameSource, "flag");
    assert.equal(formatToolName(inst, "info"), "edge_my-mac_info");
  });

  it("autoInstanceName is stable within a process", () => {
    assert.equal(autoInstanceName(), autoInstanceName());
    assert.match(autoInstanceName(), /^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});
