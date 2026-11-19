import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  DEFAULT_CHUNK_BYTES,
  fileInfoTool,
  readFileChunkTool,
  writeFileChunkTool,
} from "./fs-tools.js";
import { createScope } from "./scope.js";

describe("chunked file transfer", () => {
  it("round-trips a multi-chunk binary file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pc-edge-xfer-"));
    try {
      const scope = createScope({ workerDir: dir });
      const src = Buffer.alloc(DEFAULT_CHUNK_BYTES + 1234, 0);
      for (let i = 0; i < src.length; i++) src[i] = i % 256;
      const remote = "big.bin";

      // Upload in two chunks.
      const c1 = src.subarray(0, DEFAULT_CHUNK_BYTES);
      const c2 = src.subarray(DEFAULT_CHUNK_BYTES);
      const w1 = await writeFileChunkTool(scope, remote, c1.toString("base64"), {
        offset: 0,
        encoding: "base64",
        truncate: true,
      });
      assert.equal(w1.bytesWritten, c1.length);
      assert.equal(w1.nextOffset, c1.length);
      const w2 = await writeFileChunkTool(scope, remote, c2.toString("base64"), {
        offset: w1.nextOffset,
        encoding: "base64",
      });
      assert.equal(w2.size, src.length);

      const info = await fileInfoTool(scope, remote);
      assert.equal(info.size, src.length);
      assert.equal(info.isFile, true);

      // Download until eof.
      const parts: Buffer[] = [];
      let offset = 0;
      for (;;) {
        const chunk = await readFileChunkTool(scope, remote, { offset, length: 200_000 });
        if (chunk.bytesRead) parts.push(Buffer.from(chunk.content, "base64"));
        if (chunk.eof) break;
        offset = chunk.nextOffset!;
      }
      const got = Buffer.concat(parts);
      assert.equal(got.length, src.length);
      assert.ok(got.equals(src));

      // On-disk check
      const disk = await readFile(path.join(dir, remote));
      assert.ok(disk.equals(src));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects offset past EOF on read", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pc-edge-xfer-"));
    try {
      const scope = createScope({ workerDir: dir });
      await writeFile(path.join(dir, "tiny.txt"), "hi");
      await assert.rejects(
        () => readFileChunkTool(scope, "tiny.txt", { offset: 99 }),
        /past end/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
