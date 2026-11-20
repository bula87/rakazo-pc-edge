---
name: pc-edge-files
description: Transfer large files (images, archives, up to 200 MiB) between Rakazo and the user's PC via PC Edge chunked MCP tools edge_file_info, edge_file_read_chunk, and edge_file_write_chunk.
---

# Large file transfer (PC Edge)

Use when the user needs files larger than ~2 MiB (or any binary) moved to/from the PC. Small text files can use the instance’s `read_file` / `write_file` tools (e.g. `edge_<name>_read_file`). Chunk tools are `edge_<name>_file_*`.

## Limits

- Max file size: **200 MiB**
- Default chunk: **512 KiB** (max **1 MiB** per call)
- Content is **base64** in tool results/arguments

## Download (PC → you)

1. `edge_file_info` on the path → check `size`, `eof` plan.
2. Loop `edge_file_read_chunk` with `offset` (start `0`) and `length`.
3. Stop when `eof` is true. Use `nextOffset` for the next call.
4. Decode/reassemble base64 chunks in order.

## Upload (you → PC)

1. First chunk: `edge_file_write_chunk` with `offset: 0` and `truncate: true` (creates/replaces).
2. Later chunks: write at `offset` from the previous `nextOffset` (do not truncate).
3. Continue until all bytes are written; confirm with `edge_file_info`.

## Tips

- Prefer chunk tools for images, zips, and anything near or above the small-file limit.
- Stay inside the Edge access root (`edge_info`).
- Do not put bearer tokens or secrets in file paths or chat.
