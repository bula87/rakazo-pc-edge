# Rakazo PC Edge

**Give your [Rakazo](https://rakazo.com) bot real access to your computer** — files, shell, and long-running CLI agents like [OpenCode](https://opencode.ai) — without uploading your whole disk to the cloud.

PC Edge runs on your Linux PC or Windows (WSL2). Rakazo talks to it over **MCP** (HTTP + bearer token). You choose which folder it can see.

---

## Why this exists

Rakazo’s built-in sandbox only sees a virtual bot computer. The official Desktop / `USER_DEVICES` path can run short shells, but it does **not** give you:

- A scoped project folder (`--worker-dir`)
- Concurrent long-lived PTY sessions
- A solid way to drive **OpenCode** (run / resume / models) from chat

PC Edge fills that gap.

| You want… | Use |
|-----------|-----|
| Read/write files on your PC | `edge_read_file` / `edge_write_file` (small) or chunked transfer (large) |
| Short commands | `edge_shell` |
| OpenCode coding agent | `edge_opencode_run` / `edge_opencode_prompt` |
| Any other interactive CLI | `edge_session_spawn` + stdin/keys |
| Screen / mouse / keyboard | `--desktop` → `edge_*_desktop_*` (native + optional local VNC) |
| Watch what’s happening | Local TUI with live session panes + Global MCP log |

---

## Features

- **Privilege modes** — **sandbox** (default: bubblewrap on Linux, Seatbelt on macOS), **half-god**, or **god**
- **Instance name** — `--name` or a stable auto name; tools become `edge_<name>_…` so two PCs don’t collide
- **Scoped filesystem** — cwd or `--worker-dir` (god mode = whole PC)
- **macOS (Apple Silicon / Intel)** — same CLI; sandbox uses built-in `sandbox-exec`
- **MCP tools** prefixed `edge_*` (no clash with Rakazo sandbox tools)
- **Concurrent sessions** — multiple agents at once; filesystem tools still work
- **OpenCode driver** — `opencode run` with pretty logs, model pick, resume by `ses_…`
- **Large file transfer** — chunked upload/download up to **200 MiB**
- **Local TUI** — Global MCP traffic + per-session views, export logs, kill sessions
- **Desktop / computer-use** — `--desktop`: native screenshot + mouse/keyboard, optional persistent VNC to local Screen Sharing (vincent-vnc-mcp style), live `GET /desktop/frame.jpg`
- **Auth** — bearer token required on every MCP request

---

## Requirements

- **Node.js 20+** (VNC backend via `rfb2` prefers **Node 22.12+**)
- **Linux**, **macOS** (Apple Silicon or Intel), or **Windows + WSL2**
- Default **sandbox** jail:
  - **Linux / WSL2:** [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`) — e.g. `sudo apt install bubblewrap` (runtime needs no sudo)
  - **macOS:** built-in **Seatbelt** via `/usr/bin/sandbox-exec` (no extra install)
- A self-hosted or reachable **Rakazo** instance that can call your Edge URL
- Optional: **[OpenCode](https://opencode.ai)** installed (`opencode` on `PATH`, or `~/.opencode/bin/opencode`, or `OPENCODE_BIN`)
- Optional **desktop**:
  - **macOS native:** Screen Recording + Accessibility for the Edge process; Xcode CLT (`swiftc`) once
  - **Linux native:** `xdotool` + `grim` / ImageMagick / `gnome-screenshot`
  - **VNC:** Screen Sharing (or any RFB) on `127.0.0.1:5900` + `EDGE_VNC_PASSWORD` (and usually `EDGE_VNC_USER` on macOS)

---

## Quick start

```bash
git clone https://github.com/bula87/rakazo-pc-edge.git
cd rakazo-pc-edge
npm install
npm run build
npm test                             # optional

export RAKAZO_PC_EDGE_TOKEN="$(openssl rand -hex 24)"
# Default privilege = sandbox (bwrap). Pick a project folder Edge may touch:
node dist/cli.js --worker-dir ~/Projects/my-app --host 0.0.0.0 --port 8765
# after global install: rakazo-pc-edge --worker-dir … --host 0.0.0.0 --port 8765
```

### Instance name & tool namespaces

| Flag / env | Meaning |
|------------|---------|
| `--name <slug>` / `RAKAZO_PC_EDGE_NAME` | Friendly id (e.g. `macbook`, `wsl-dev`) |
| *(default)* | Stable auto name: `hostname` + short machine fingerprint |
| `--tool-style insert` *(default)* | `edge_<name>_info`, `edge_<name>_shell`, … |
| `--tool-style prefix` | `<name>_edge_info`, … |
| `--tool-style suffix` | `edge_info_<name>`, … |
| `--tool-style bare` | Classic `edge_info` (legacy; bad if two Edges share one bot) |

Call the info tool first (e.g. `edge_macbook_info`) — it returns `name`, `toolExample`, and `toolPrefix`.

```bash
# Two machines, no collisions:
node dist/cli.js --name macbook --god --host 0.0.0.0 --port 8765
node dist/cli.js --name wsl --worker-dir ~/proj --host 0.0.0.0 --port 8765
```

### Privilege modes

| Mode | Flag | File tools | Shell / sessions / OpenCode |
|------|------|------------|-----------------------------|
| **sandbox** (default) | `--sandbox` | Access root only | OS jail: **bwrap** (Linux) or **Seatbelt** (macOS) |
| **half-god** | `--half-god` | Access root only | **Not** sandboxed — can leave the root |
| **god** | `--god` / `--global` | Whole PC | Whole PC |

Sandbox still allows a few host paths (toolchain RO; OpenCode state dirs RW when present) so agents can run — not your whole home.


You should see a TUI (or use `--plain` for classic logs). Check health:

```bash
curl -s http://127.0.0.1:8765/healthz
```

### Install the CLI globally (optional)

```bash
npm run build && npm install -g .
rakazo-pc-edge --help
```

After pulling updates: `npm run build && npm install -g .`

### Register in Rakazo

1. On Rakazo **api** + **worker**, allow private MCP URLs if you use LAN/Tailscale:
   ```env
   MCP_ALLOW_PRIVATE_ENDPOINT=true
   ```
2. Recreate / restart those services.
3. In Rakazo → MCP / integrations, add:
   - **URL:** `http://<your-pc-reachable-ip>:8765/mcp`
   - **Auth:** Bearer → same value as `RAKAZO_PC_EDGE_TOKEN`
4. In chat, tell the bot to use **`edge_*` tools** (e.g. `edge_list_dir`), not sandbox `read_file`.

> **WSL2 tip:** Register the **Windows LAN IP**, not WSL’s `172.x` address. Bind with `--host 0.0.0.0` and use mirrored networking or Windows `portproxy` + firewall for TCP `8765`.

### Rakazo plugin (skills)

This repo is also a **skills-only** [Rakazo plugin](https://rakazo.com/docs/build-a-plugin/). Marketplace plugins cannot ship a private/LAN MCP URL, so each user still **adds their own Edge server** under Integrations. The plugin installs skills that teach bots to use `edge_*` tools.

**Install in Rakazo**

1. Run Edge and register its MCP URL + bearer token (steps above).
2. Integrations → **+** → **From GitHub** → `https://github.com/bula87/rakazo-pc-edge`
3. Preview → add skills → for the MCP server, choose **Use in this bot**.

Skills included: `pc-edge`, `pc-edge-opencode`, `pc-edge-files`.

**Submit to the marketplace** (optional)

1. Push these files to the public GitHub repo.
2. Test From GitHub install + a real `edge_info` call.
3. Open [Submit a plugin](https://rakazo.com/plugins/submit/) with:
   - **Logo:** `https://raw.githubusercontent.com/bula87/rakazo-pc-edge/main/assets/logo.svg`
   - **Source:** `https://github.com/bula87/rakazo-pc-edge`
   - **Testing:** install Edge locally → register MCP with a throwaway bearer token → install this plugin → `edge_info` / `edge_list_dir` (no real secrets in the form)

---

## Usage examples

### OpenCode: one task

```text
edge_opencode_run({
  message: "Add a README to this project",
  cwd: "/home/you/Projects/my-app",
  model: "opencode/big-pickle"   // from edge_opencode_models
})
→ wait edge_session_wait_event kinds=["done","error"]
→ save opencodeSessionId from edge_session_status for later
→ verify with edge_list_dir / edge_read_file
```

### OpenCode: continue later

```text
edge_opencode_prompt({
  opencodeSessionId: "ses_…",
  text: "Also add unit tests",
  cwd: "/home/you/Projects/my-app"
})
→ wait done/error on the new Edge session id
```

### Large image (PC ↔ Rakazo), up to 200 MiB

**Download:** `edge_file_info` → loop `edge_file_read_chunk` until `eof`  
**Upload:** loop `edge_file_write_chunk` (`offset: 0` first, then `nextOffset`)

Small files (≤2 MiB) can use `edge_read_file` / `edge_write_file` directly.

---

## Local TUI

```text
┌─ main pane ─────────────────────────────┬─ Views ──────────┐
│ Global MCP log  — or —  session output  │ Global (MCP)     │
│ (pretty OpenCode logs, VT for PTYs)     │ [A] run…  idle   │
│                                         │ [T] finished…    │
└─────────────────────────────────────────┴──────────────────┘
```

| Key | Action |
|-----|--------|
| ↑↓ / click | Select view |
| Tab | Focus list ↔ main |
| g | Jump to Global |
| e / Ctrl+E | Export current log |
| Type | Send keys into focused session |
| q / Ctrl+C | Quit |

Sessions stay listed after exit (`[T]`) until you remove them or restart Edge.

---

## MCP tool reference

All tools are prefixed with **`edge_`**.

### Files & shell

| Tool | Purpose |
|------|---------|
| `edge_info` | Scope mode and root |
| `edge_list_dir` | List a directory |
| `edge_read_file` / `edge_write_file` | Small files ≤2 MiB |
| `edge_file_info` | Size / mtime / transfer limits |
| `edge_file_read_chunk` | Download chunk (≤200 MiB files) |
| `edge_file_write_chunk` | Upload chunk (≤200 MiB files) |
| `edge_shell` | Short shell with timeout |

### Generic sessions

| Tool | Purpose |
|------|---------|
| `edge_session_spawn` | Start a process/PTY |
| `edge_session_list` / `edge_session_status` | Inspect (`uiState`, `opencodeSessionId`, …) |
| `edge_session_snapshot` | Human-readable screen / pretty log |
| `edge_session_stdin` / `edge_session_prompt` / `edge_session_keys` | Steer the process |
| `edge_session_wait_event` | Wait for `done`, `error`, `idle`, `busy`, … |
| `edge_session_kill` / `edge_session_remove` | Stop / clear from list |

### OpenCode (preferred over TUI steering)

| Tool | Purpose |
|------|---------|
| `edge_opencode_run` | Live `opencode run --standalone --auto` |
| `edge_opencode_prompt` | Resume `ses_…` with a live run session |
| `edge_opencode_models` / `edge_opencode_providers` | List models (`ref`) & providers |
| `edge_opencode_test_model` | Smoke-test a model |
| `edge_opencode_sessions` | List OpenCode sessions |
| `edge_opencode_session_create` / `edge_opencode_wait_idle` | Lower-level API helpers |

**Tip:** Prefer `edge_opencode_run` over typing into the OpenCode fullscreen TUI. Process exit = finished; the Edge pane shows pretty tool/assistant lines.

### Desktop / computer-use (`--desktop`)

Hybrid control inspired by [vincent-vnc-mcp](https://github.com/cookiemonster0921/vincent-vnc-mcp): one persistent local VNC client + JPEG frame cache for tools and a live poller, with native OS fallback when VNC is down.

```bash
# Native only (screenshot + input helpers)
node dist/cli.js --name macbook --god --desktop --desktop-backend native --host 0.0.0.0 --port 8765

# Prefer Screen Sharing on localhost (macOS): enable Sharing → Screen Sharing, then:
export EDGE_VNC_USER="$USER"
export EDGE_VNC_PASSWORD='…'   # that account’s password
node dist/cli.js --name macbook --god --desktop --host 0.0.0.0 --port 8765
```

| Tool leaf (after `edge_<name>_`) | Purpose |
|----------------------------------|---------|
| `desktop_info` | Capabilities, active backend, VNC state, live-view path |
| `desktop_snapshot` | JPEG screenshot (base64); optional region / maxWidth |
| `desktop_screen_size` | Width / height |
| `desktop_mouse_move` / `_click` / `_scroll` / `_drag` | Pointer |
| `desktop_wait_change` | Wait until the frame changes (or timeout) |
| `desktop_type` / `desktop_keys` | Keyboard |
| `desktop_open` | Native `open` / `xdg-open` (apps & URLs) |
| `desktop_vnc_status` | VNC connection + frame age |

Live view (same Bearer as MCP): `GET http://<host>:<port>/desktop/frame.jpg`

**macOS tip (vincent):** connecting VNC as a *different* user than the console creates a separate virtual session. Same-user credentials mirror the live console.

---

## Configuration

### Access root & privilege

| Setting | Meaning |
|---------|---------|
| *(default cwd)* / `--worker-dir` | Access root for sandbox / half-god |
| `--sandbox` | Default: jail shell/sessions/OpenCode (bwrap or Seatbelt) |
| `--half-god` | Scoped file tools; unsandboxed shell |
| `--god` / `--global` | Full PC (warning logged) |

### Auth & network

| Setting | Meaning |
|---------|---------|
| `RAKAZO_PC_EDGE_TOKEN` or `--token` | Shared secret (required for Rakazo) |
| `--host` / `--port` | Bind address (default `127.0.0.1:8765`) |
| `--plain` / `--no-tui` | Logs to stdout instead of TUI |
| `--stdio` | MCP over stdio (local hosts) |
| `OPENCODE_BIN` | Absolute path to `opencode` if not on `PATH` |
| `BWRAP_BIN` | Absolute path to `bwrap` if not on `PATH` (Linux) |
| `SEATBELT_BIN` | Absolute path to `sandbox-exec` (macOS; default `/usr/bin/sandbox-exec`) |
| `--desktop` / `EDGE_DESKTOP=1` | Enable desktop tools + `/desktop/frame.jpg` |
| `--desktop-backend` / `EDGE_DESKTOP_BACKEND` | `auto` (default) \| `native` \| `vnc` |
| `EDGE_VNC_HOST` / `VNC_HOST` | Default `127.0.0.1` |
| `EDGE_VNC_PORT` / `VNC_PORT` | Default `5900` |
| `EDGE_VNC_USER` / `VNC_USER` | Screen Sharing username (macOS) |
| `EDGE_VNC_PASSWORD` / `VNC_PASSWORD` | Screen Sharing / VNC password |

MCP URL: `http://<host>:<port>/mcp`  
Health: `http://<host>:<port>/healthz`  
Desktop live JPEG: `http://<host>:<port>/desktop/frame.jpg`

### OpenCode on the host

Models/providers come from your local OpenCode install and config (e.g. `~/.opencode/opencode.json`). Edge does not ship API keys.

---

## Reachability (LAN & internet)

**Same LAN:** register `http://<pc-lan-ip>:8765/mcp` and set `MCP_ALLOW_PRIVATE_ENDPOINT=true` on Rakazo.

**Internet:** do **not** expose Edge on a raw public port. Prefer an outbound tunnel:

| Option | Idea |
|--------|------|
| Cloudflare Tunnel | HTTPS hostname → `127.0.0.1:8765` |
| Tailscale | Tailnet IP / MagicDNS (+ Funnel if needed) |
| ngrok | `ngrok http 8765` |
| SSH reverse tunnel | VPS + Caddy/nginx in front |

Always keep a strong bearer token. Prefer HTTPS. Prefer `--worker-dir` + default **sandbox** over `--half-god` / `--god` when remote.

---

## Security notes

- **sandbox** (default): file tools refuse paths outside the root; shell/sessions/OpenCode run under **bubblewrap** (Linux) or **Seatbelt** (macOS) so they cannot see or delete the rest of the PC.
- **half-god / god**: shell can leave the root (or the whole machine) — treat the bearer token like login access.
- Secret-like names (`.env`, SSH keys, `*.pem`) are blocked unless `allowSecrets` is set.
- Cap: 16 concurrent sessions; ~512 KiB ring buffer per session (chunked file transfer is separate).
- Never register an unauthenticated Edge URL on the public internet.
- Tool logs redact tokens / API keys where possible.

---

## Development

```bash
npm install
npm run build
npm test
npm run typecheck
npm run dev -- --host 127.0.0.1 --port 8765 --worker-dir .
```

---

## How this relates to Rakazo Desktop

The official Desktop / `user_computer_*` tools can run commands on your machine. They are **not** a replacement for PC Edge when you need scoped folders, concurrent PTY agents, or first-class OpenCode control from Rakazo chat.

---

## License

[MIT](./LICENSE)
