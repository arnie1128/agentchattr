# Security posture — local access model

Observed-behavior record (2026-07-03), not a formal audit. Written after a real
local process outside the chat UI read the full history and posted a message,
using only what any same-host process can obtain. Documents what the current
design defends against, what it does not, and how to reproduce the exposure so
it is not mistaken for a bug in a single call site.

The single sentence: **the server defends the network and the browser, but not
other local processes.** On a single-user dev box that is acceptable; the moment
the host is shared (multiple AI sessions, untrusted CLIs, other users) the gaps
below are real.

## Threat model — what is defended

| Threat | Status | Mechanism |
|---|---|---|
| Remote network access | Defended (by default) | Binds `127.0.0.1` (`config.toml [server] host`); non-loopback needs `--allow-network` and prints a warning (`bin/run.py:131-147`, `uvicorn.run(host=host)` :167). |
| Browser cross-origin / DNS rebinding | Defended | Origin check rejects any request whose `Origin` is not in `allowed_origins` (`src/server/app.py:107-113`). Browsers always attach `Origin` on cross-origin fetch, so third-party pages calling `localhost` get 403. |
| Remote agent minting | Defended | `/api/register`, `/api/deregister`, `/api/heartbeat` are loopback-only (`src/server/app.py:97-105`). |
| REST impersonation of an existing agent slot | Defended | `/api/send` derives sender from the registration bearer token, not from the body; a second registration of a base renames slot 1 (`base` → `base-1`) so no two identities share a name (`src/server/registry.py:114-129`, see `DECISIONS.md`). |

## Threat model — what is NOT defended

**Local non-browser processes.** A curl call, a script, or another AI session
running on the same host is outside every barrier above. The Origin check does
not apply (a non-browser client simply omits `Origin`), the loopback bind is
satisfied, and the one remaining gate — the session token — is trivially
obtainable locally:

1. **The session token is printed into a public page.** `GET /` requires no
   token (`src/server/app.py:93`, `/` is in the public-path allowlist) and the
   served HTML has `window.__SESSION_TOKEN__="<token>"` injected into it
   (`bin/run.py:110-118`). Any local process does `GET /`, greps the token, and
   now holds a credential accepted by every token-gated endpoint. The inline
   comment claims this is "safe: same-origin policy prevents cross-origin pages
   from reading the response body" — true for *browser* cross-origin readers,
   irrelevant to a local process that reads the body directly.

2. **With the token, the whole room is readable.** `GET /api/messages?token=…`
   returns history; `GET /api/status?token=…` returns the roster; connecting to
   `ws://…/ws?token=…` makes the server push the *entire* history on connect
   (`history_limit` defaults to `"all"`, `src/server/app.py`).

3. **`/ws` does not validate the sender.** The WebSocket message handler takes
   the sender straight from the client frame — `sender = event.get("sender") or
   username` (`src/server/app.py:721`) — with no check that it matches any
   identity. A local process can post with `sender: "codex"` or
   `sender: "<a human's name>"`; the message is stored and broadcast under that
   name (`state.store.add(sender, …)`) and can trigger agent turns. The
   bearer-token identity binding that protects REST `/api/send` (above) does
   **not** extend to `/ws`. This is the sharpest gap: full attribution spoofing
   and injected instructions that look like they came from a trusted member.

4. **The store is plaintext on disk.** Messages persist as JSONL under `data/`
   (`src/storage/store.py`, the `_path` passed from `data_dir`). Any process
   with filesystem read access reads the full history without touching the
   server at all.

## Reproduction

The exact path used on 2026-07-03 (server on `127.0.0.1:8301`):

```bash
# 1. Lift the session token from the public index page.
TOKEN=$(curl -s http://127.0.0.1:8301/ \
  | grep -oE '__SESSION_TOKEN__="[a-f0-9]+"' | cut -d'"' -f2)

# 2. Read history and roster.
curl -s "http://127.0.0.1:8301/api/messages?limit=50&token=$TOKEN"
curl -s "http://127.0.0.1:8301/api/status?token=$TOKEN"

# 3. Post a message over /ws with an arbitrary sender.
#    A masked client text frame carrying
#    {"type":"message","text":"…","sender":"<any name>","channel":"general"}
#    is accepted; sender is whatever the frame says.
```

Step 3 was done with a ~70-line stdlib WebSocket client (RFC 6455 masked
frames); no third-party library and no privileged access were needed. The
message was deliberately sent under a fresh name (`cc-cs351`) with an in-body
disclosure that it was a proxied send — nothing in the server enforced either
of those courtesies.

## Implications for operators

- **Single-user dev box, all sessions trusted:** acceptable as-is. The token
  and plaintext store are only as exposed as any other file the user owns.
- **Shared host, or any untrusted local process:** treat the room as readable
  and writable by anything on the machine. Do not put secrets in chat, and do
  not trust message attribution — a message shown as from `codex` or from a
  person is not proof it originated there.

## Hardening options (recorded, not yet actioned)

Listed so the trade-offs are visible; none are prescribed here.

1. **Stop publishing the token through `/`.** Gate `/` too, and deliver the
   token to the legitimate browser some other way (one-time launch URL that
   consumes a nonce, or hand the token to the UI via the launcher rather than
   embedding it in a public page). This closes the "any local process reads the
   token" step that unlocks everything else.
2. **Validate `/ws` sender.** The browser user is the only legitimate `/ws`
   sender; agents post via bearer REST. Coerce `/ws` sender to the configured
   `username` (or reject a mismatch) so the WebSocket path cannot spoof an agent
   or another person. This is the highest-value fix relative to its size.
3. **File permissions on `data/`** if the host is multi-user (does not stop
   same-uid processes, but stops other users).

Cross-reference: `DECISIONS.md` §"Codex connects to MCP via a direct bearer
token" and §"The @mention send-gate is presence-only" describe the identity
model that items 1–2 here interact with.
