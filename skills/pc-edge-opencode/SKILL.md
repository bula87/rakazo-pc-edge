---
name: pc-edge-opencode
description: Drive OpenCode on the user's PC through Rakazo PC Edge. Use for coding tasks on a real project folder via edge_opencode_run / edge_opencode_prompt, model listing, and session resume by ses_ id.
---

# OpenCode via PC Edge

Prefer dedicated OpenCode tools over spawning the fullscreen OpenCode TUI.

In **sandbox** privilege (default), OpenCode runs under bubblewrap with the Edge access root RW (plus limited OpenCode state dirs). Stay inside that project `cwd`. In **half-god** / **god**, OpenCode can reach the whole PC.

## One-shot task

1. Optional: `edge_opencode_models` → pick a `ref` (e.g. `opencode/big-pickle` or a configured provider model).
2. `edge_opencode_run` with `message`, `cwd` (project path on the PC), optional `model`.
3. `edge_session_wait_event` on the returned Edge session id with kinds `["done","error"]`.
4. Read `edge_session_status` — save **`opencodeSessionId`** (`ses_…`) for later turns.
5. Verify results with `edge_list_dir` / `edge_read_file` on the project.

Completion is **process exit** (`done`), not spinner heuristics.

## Continue a previous OpenCode session

```text
edge_opencode_prompt({
  opencodeSessionId: "ses_…",
  text: "…follow-up…",
  cwd: "/path/on/pc"
})
```

Wait for `done`/`error` on the **new** Edge session id. Do not send raw stdin into an old finished session.

## Models and providers

| Tool | Use |
|------|-----|
| `edge_opencode_models` | List model refs |
| `edge_opencode_providers` | List providers (secrets redacted) |
| `edge_opencode_test_model` | Smoke-test a model |

Models come from the user's local OpenCode install/config. Edge does not ship API keys.

## Avoid

- Fighting the OpenCode fullscreen TUI with `edge_session_stdin` for normal coding tasks.
- Assuming the sandbox created the files — always check via `edge_*` on the PC path.
