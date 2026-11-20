---
name: pc-edge
description: Use Rakazo PC Edge (edge_* MCP tools) when the user wants work on their real Linux/WSL PC — project files, shell, long-lived CLI agents — not the bot sandbox. Check edge_info.privilege (sandbox/half-god/god). Prefer edge_* over sandbox read_file/shell/user_computer_* for PC work.
---

# Rakazo PC Edge

PC Edge is a self-hosted MCP server on the user's machine. Tools are prefixed **`edge_`**. Do **not** use sandbox `read_file`, `write_file`, or `shell` for the user's PC once Edge is connected.

## Before first use

1. Confirm tools exist: call `edge_info`. Note `privilege` (`sandbox` | `half-god` | `god`). If missing, tell the user to:
   - Run Edge on their PC (`rakazo-pc-edge --worker-dir <project> --host 0.0.0.0 --port 8765`; default privilege is **sandbox** — bwrap on Linux, Seatbelt on macOS)
   - Set `RAKAZO_PC_EDGE_TOKEN` and register `http(s)://<reachable-host>:8765/mcp` in Rakazo Integrations with Bearer auth
   - Self-hosted Rakazo: set `MCP_ALLOW_PRIVATE_ENDPOINT=true` on api + worker for LAN/Tailscale URLs
2. Prefer the scoped root from `edge_info` — never assume `--god` / `--global`.

| `privilege` | File tools | Shell / sessions / OpenCode |
|-------------|------------|-----------------------------|
| `sandbox` (default) | Access root only | OS jail (bwrap / Seatbelt) — cannot leave the root |
| `half-god` | Access root only | **Not** sandboxed — can leave the root |
| `god` | Whole PC | Whole PC |

`edge_info.sandboxBackend` is `bwrap` or `seatbelt` when privilege is sandbox.

## Files and shell

| Goal | Tool |
|------|------|
| List | `edge_list_dir` |
| Small file ≤2 MiB | `edge_read_file` / `edge_write_file` |
| Large file ≤200 MiB | `edge_file_info` + chunk tools (see **pc-edge-files** skill) |
| Short command | `edge_shell` (timeout; not for long agents) |

## Long-running processes

- Spawn with `edge_session_spawn`; steer with `edge_session_stdin` / `edge_session_prompt` / `edge_session_keys`.
- Monitor with `edge_session_snapshot` and `edge_session_wait_event` (`done`, `error`, `idle`, `busy`).
- Stop with `edge_session_kill`; clear with `edge_session_remove`.
- For **OpenCode**, use the **pc-edge-opencode** skill (`edge_opencode_run` / `edge_opencode_prompt`) instead of typing into the OpenCode TUI.

## Rules of thumb

- Always use `edge_*` names so you do not hit the bot sandbox by mistake.
- After writes or agent runs, verify with `edge_list_dir` / `edge_read_file`.
- Never ask the user to paste API keys into chat; Edge tokens stay in Integrations / env.
- If a tool refuses a secret-like path (`.env`, keys), explain and only use `allowSecrets` when the user explicitly requests it.
