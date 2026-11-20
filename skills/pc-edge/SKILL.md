---
name: pc-edge
description: Use Rakazo PC Edge (edge_* MCP tools) when the user wants work on their real Linux/WSL/macOS PC — project files, shell, long-lived CLI agents, optional desktop control — not the bot sandbox. Check edge_info.privilege (sandbox/half-god/god) and desktopEnabled. Prefer edge_* over sandbox read_file/shell/user_computer_* for PC work.
---

# Rakazo PC Edge

PC Edge is a self-hosted MCP server on the user's machine. Tools are prefixed **`edge_`**. Do **not** use sandbox `read_file`, `write_file`, or `shell` for the user's PC once Edge is connected.

## Before first use

1. Confirm tools exist: call the **info** tool for this Edge. Names are usually `edge_<name>_info` (default style `insert`). Note `name`, `toolPrefix`, `toolExample`, and `privilege`. If tools are missing, tell the user to:
   - Run Edge (`--name macbook` recommended when multiple PCs; default privilege is **sandbox**)
   - Set `RAKAZO_PC_EDGE_TOKEN` and register `http(s)://<reachable-host>:8765/mcp` with Bearer auth
   - Self-hosted Rakazo: set `MCP_ALLOW_PRIVATE_ENDPOINT=true` on api + worker for LAN/Tailscale URLs
2. Use tools with the **same name prefix** as that info tool (e.g. `edge_macbook_list_dir`, not bare `edge_list_dir`, unless `toolStyle` is `bare`).
3. Prefer the scoped root from info — never assume `--god` / `--global`.

| `privilege` | File tools | Shell / sessions / OpenCode |
|-------------|------------|-----------------------------|
| `sandbox` (default) | Access root only | OS jail (bwrap / Seatbelt) — cannot leave the root |
| `half-god` | Access root only | **Not** sandboxed — can leave the root |
| `god` | Whole PC | Whole PC |

`sandboxBackend` is `bwrap` or `seatbelt` when privilege is sandbox. Two machines should use different `--name` values so tool names do not collide.

## Files and shell

| Goal | Tool leaf (after `edge_<name>_`) |
|------|------|
| List | `list_dir` |
| Small file ≤2 MiB | `read_file` / `write_file` |
| Large file ≤200 MiB | `file_info` + chunk tools (see **pc-edge-files** skill) |
| Short command | `shell` (timeout; not for long agents) |

## Long-running processes

- Spawn with `edge_session_spawn`; steer with `edge_session_stdin` / `edge_session_prompt` / `edge_session_keys`.
- Monitor with `edge_session_snapshot` and `edge_session_wait_event` (`done`, `error`, `idle`, `busy`).
- Stop with `edge_session_kill`; clear with `edge_session_remove`.
- For **OpenCode**, use the **pc-edge-opencode** skill (`edge_opencode_run` / `edge_opencode_prompt`) instead of typing into the OpenCode TUI.

## Desktop / computer-use

When `edge_info` shows `desktopEnabled: true` (Edge started with `--desktop`):

1. Call `desktop_info` first — note `activeBackend` (`vnc` or `native`) and `liveViewPath`.
2. Loop: `desktop_snapshot` → act with `desktop_mouse_*` / `desktop_type` / `desktop_keys` → optional `desktop_wait_change`.
3. Prefer `desktop_open` for apps/URLs instead of clicking dock icons blindly.
4. Coordinates are absolute screen pixels from `desktop_screen_size` / the snapshot.

| Leaf | Use |
|------|-----|
| `desktop_info` / `desktop_vnc_status` | Backend + VNC health |
| `desktop_snapshot` | JPEG (base64); optional region |
| `desktop_mouse_move` / `_click` / `_scroll` / `_drag` | Pointer |
| `desktop_wait_change` | Wait for UI change |
| `desktop_type` / `desktop_keys` | Typing / chords (`cmd`,`c`) |
| `desktop_open` | Native open app/URL |

If desktop tools are missing, ask the user to restart Edge with `--desktop` (and optionally `EDGE_VNC_USER` + `EDGE_VNC_PASSWORD` for Screen Sharing).

## Rules of thumb

- Always use `edge_*` names so you do not hit the bot sandbox by mistake.
- After writes or agent runs, verify with `edge_list_dir` / `edge_read_file`.
- Never ask the user to paste API keys into chat; Edge tokens stay in Integrations / env.
- If a tool refuses a secret-like path (`.env`, keys), explain and only use `allowSecrets` when the user explicitly requests it.
