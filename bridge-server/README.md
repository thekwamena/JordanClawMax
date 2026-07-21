# JordanClawMax bridge server

OpenClaw's real local install has no REST API - it's a WebSocket gateway, and
`JordanClawMax` is an **agent skill** (bash/ffmpeg/whisper/LLM driven via the
agent's `exec` tool), not a callable microservice with a typed request/response.
A browser app can't invoke that directly: it can't exec ffmpeg/whisper, and it
has no reasonable way to read the output files the skill writes to disk.

This server is the bridge. It runs **inside WSL**, next to the real `openclaw`
CLI, `ffmpeg`, `whisper`, and the OpenClaw workspace, and exposes plain HTTP:

- `POST /api/upload` - accepts a video file, saves it under
  `~/.openclaw/workspace/clips/uploads/` (so the agent can reference it by a
  path relative to the workspace, the same way its own sample clips work).
- `POST /api/extract` - starts a job: builds a natural-language instruction
  for the `JordanClawMax` skill from `{ numClips, styles, maxLength }` and
  spawns `openclaw agent ...` in the background. Returns a `jobId` immediately.
- `GET /api/jobs/:id` - poll for status/progress/result.
- `DELETE /api/jobs/:id` - best-effort cancel.
- `GET /files/*` - serves the output directory statically so clips can be
  played/downloaded from the React app.

## Why jobs need repeated "continue" nudges

On this machine the local model (`qwen3.5:latest` via Ollama) reliably
produces **about one clip per agent turn** before it stops, even when asked
for more. It's not crashing - each turn genuinely finishes real work (ffmpeg
runs, a real clip lands on disk) - it just doesn't reliably chain multiple
clips + the final `CLIP_RANKINGS.txt`/`clips.json` write into one turn.

The job runner in `server.js` works around this: after each `openclaw agent`
invocation returns, it checks the output directory for `clips.json`. If it's
missing, it sends a follow-up "continue, N of M clips exist, keep going"
message to the *same* session (`--session-id`) and repeats, up to
`BRIDGE_MAX_TOTAL_MS` (default 2 hours) in `BRIDGE_ATTEMPT_TIMEOUT_MS`-sized
turns (default 10 minutes each).

If you swap in a stronger/faster model, this loop still works - it'll just
usually finish in one attempt instead of `numClips` of them.

## Manifest schema

`SKILL.md` asks the agent to write `clips.json` with a specific schema (see
the skill's own "Machine-Readable Manifest" section), but the local model
doesn't always follow it exactly - in testing it sometimes used its own
richer shape (`start_time_s`/`duration_s`, `moment` instead of `title`,
`funny_score`, etc.) instead. `normalizeManifest()` in `server.js` accepts
several reasonable field-name variants rather than requiring exact compliance.

## Running it

```bash
cd bridge-server
npm install
node server.js
```

Runs on `http://localhost:8787` by default (`PORT` env var to change). WSL2
forwards localhost both directions, so the React dev server on Windows
(`http://localhost:3000`) can reach it without any extra config - just make
sure `REACT_APP_BRIDGE_URL` in the app's `.env` matches.

Requires: `openclaw` CLI configured and the gateway running (`openclaw gateway
status`), `ffmpeg`, and `whisper` all on `PATH` in the environment this server
runs in.
