# Setup Instructions

This document covers full setup of JordanClawMax: the bridge server, the
OpenClaw/skill side, environment variables, and troubleshooting.

There is no hosted OpenClaw API to sign up for. OpenClaw is a local
WebSocket gateway + agent runtime, and `JordanClawMax` is an agent skill
(ffmpeg/whisper/LLM driven via the agent's `exec` tool), not a callable
microservice. This app talks to a local bridge server
([bridge-server/](./bridge-server/)) that drives the agent and exposes plain
HTTP - there's nothing to sign up for or authenticate against externally.

## Prerequisites

- Node.js 18+ and npm 9+, on both Windows (for this app) and inside WSL (for the bridge server), if you're on Windows/WSL like this project's reference setup.
- `openclaw` CLI installed and configured (`openclaw setup` / `openclaw configure`), with the gateway running locally (`openclaw gateway status` should show `Runtime: running`).
- `ffmpeg` and `whisper` on `PATH` in the environment the bridge server runs in.
- The `JordanClawMax` skill present under the OpenClaw workspace's `skills/` directory (see [bridge-server/README.md](./bridge-server/README.md) for its manifest requirements).
- An Ollama (or other) model configured for the agent, with a **reasonable context window for your GPU's VRAM** - see the "Local model performance" note below.

## 1. Start the bridge server

```bash
cd bridge-server
npm install
node server.js
```

Leave this running in its own terminal (inside WSL). It listens on
`http://localhost:8787` by default. See
[bridge-server/README.md](./bridge-server/README.md) for what it does, its
endpoints, and why extraction jobs need repeated "continue" nudges on a
small local model.

## 2. Install app dependencies

```bash
npm install
```

This installs React, `axios` (HTTP client used by `openclawService.js`), and
the standard Create React App toolchain (`react-scripts`).

## 3. Configure environment variables

```bash
cp .env.example .env
```

| Variable                                  | Default                   | Description                                      |
|--------------------------------------------|----------------------------|---------------------------------------------------|
| `REACT_APP_BRIDGE_URL`                     | `http://localhost:8787`   | Base URL of the bridge server                      |
| `REACT_APP_OPENCLAW_POLL_INTERVAL_MS`      | `5000`                     | How often to poll job status while processing      |
| `REACT_APP_OPENCLAW_POLL_TIMEOUT_MS`       | `7200000` (2h)             | Max time to wait for a job before giving up         |

The poll timeout defaults high because a multi-clip job on a small local
model can take a long time - see "Local model performance" below.

> **Never commit `.env`.** It's already listed in `.gitignore`.

## 4. Run the app

```bash
npm start
```

Visit `http://localhost:3000`.

## 5. Build for production

```bash
npm run build
```

Output is written to `/build`. This app assumes the bridge server and
OpenClaw gateway are reachable at `REACT_APP_BRIDGE_URL` from wherever it's
served - there's no remote-hosted option, so "production" here means "your
own machine, always on," not a public deploy target.

## How the integration works

`src/services/openclawService.js` exposes:

- `uploadVideo(file, onProgress)` — uploads the source file to the bridge server (`POST /api/upload`), which stores it under the OpenClaw workspace so the agent can reference it by relative path.
- `invokeJordanClawMax(assetId, settings)` — starts a job (`POST /api/extract`) with `{ numClips, styles, maxLength }`, returning a `jobId`.
- `getJobStatus(jobId)` — fetches current job state (`GET /api/jobs/:id`).
- `pollForResults(jobId, onProgress)` — polls on an interval until the job completes or fails, or the configured timeout elapses.
- `cancelJob(jobId)` — best-effort cancel (`DELETE /api/jobs/:id`).
- `extractClips(file, settings, callbacks)` — convenience wrapper that chains upload → invoke → poll and returns the final clip array.

`src/App.jsx` orchestrates these calls and drives the three app views:
`upload` (pick a video + configure settings), `processing` (upload +
job progress), and `results` (clip gallery).

## Local model performance

The reference setup for this project uses a local Ollama model
(`qwen3.5:latest`, 9.7B, Q4 quantized) on a single consumer GPU. Two things
matter a lot for reliability:

- **Context window vs. VRAM**: a very large configured `contextWindow` (e.g. the model's max, 262144) can nearly max out a 16GB card just holding it loaded, making every agent turn extremely slow or causing turns to stall entirely with no visible error. A very small window (e.g. 16384) avoids that but then truncates large tool outputs (like a verbose whisper transcript), which can confuse the model into hallucinating bad paths. `32768` worked reliably in testing here. Adjust via `openclaw config patch` on `models.providers.ollama.models[].contextWindow`, then `openclaw gateway restart`.
- **One clip per turn**: even correctly configured, this local model tends to finish about one clip per agent turn before stopping, regardless of how many were requested. The bridge server's job runner handles this by re-nudging the same session until the manifest exists - see [bridge-server/README.md](./bridge-server/README.md).

If you swap in a stronger/faster/hosted model, both of these become
non-issues and jobs should complete in far fewer turns.

## Troubleshooting

- **`ERR_NAME_NOT_RESOLVED` in the browser console** — this app no longer talks to any `*.openclaw.ai` hostname. If you see this, something is still pointing at old config; check `.env` has `REACT_APP_BRIDGE_URL` and that `openclawService.js` matches this doc.
- **Bridge server can't reach `openclaw`** — confirm `openclaw gateway status` shows `Runtime: running` and that `openclaw`, `ffmpeg`, and `whisper` are all on `PATH` in the shell the bridge server was started from.
- **Job stuck at 0% for a long time / never progresses** — check the bridge server's terminal output, and check `openclaw doctor` for session locks or GPU/VRAM issues (see "Local model performance" above).
- **Polling times out** — large videos and/or many requested clips can take a long time on a small local model; raise `REACT_APP_OPENCLAW_POLL_TIMEOUT_MS` and/or `BRIDGE_MAX_TOTAL_MS` (bridge server env var).
- **CORS errors in the browser console** — the bridge server enables CORS for all origins by default (`cors()` with no options in `bridge-server/server.js`); if you've changed that, make sure it allows your dev origin (`http://localhost:3000`).
