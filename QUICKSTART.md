# QUICKSTART

Get JordanClawMax running locally in under 5 minutes.

## 1. Start the bridge server (inside WSL)

OpenClaw's real local install has no REST API - `JordanClawMax` is an agent
skill, not a callable microservice. `bridge-server/` drives the agent and
exposes plain HTTP for this app to talk to. It must run inside WSL, next to
`openclaw`/`ffmpeg`/`whisper`:

```bash
cd bridge-server
npm install
node server.js
```

Leave this running. See [bridge-server/README.md](./bridge-server/README.md)
for what it does and why jobs can take a while.

## 2. Install app dependencies

```bash
npm install
```

## 3. Configure environment variables

```bash
cp .env.example .env
```

The default `.env.example` values (bridge at `http://localhost:8787`) work
as-is if you haven't changed the bridge server's port.

## 4. Start the dev server

```bash
npm start
```

The app opens at [http://localhost:3000](http://localhost:3000).

## 5. Use the app

1. Drag a video (MP4/MOV/WebM/MKV, up to 2GB) into the upload zone, or click to browse.
2. Adjust extraction settings on the right — number of clips, max clip length, and styles (funny/exciting/trending/intense).
3. Click **Extract clips**. This uploads your video to the bridge server, which drives the `JordanClawMax` agent skill and polls until results are ready. This can take a while - the local model finishes roughly one clip per turn and needs repeated nudges to complete a job, so a 10-clip job is meaningfully slower than a 2-clip one.
4. Browse the resulting clips in the gallery, preview them in the iPhone-style frame, and download individually or all at once.

## Scripts

| Command         | Description                              |
|-----------------|-------------------------------------------|
| `npm start`     | Run the app in development mode           |
| `npm run build` | Build a production bundle to `/build`     |
| `npm test`      | Run the test runner                       |

## Next steps

- Read [SETUP_INSTRUCTIONS.md](./SETUP_INSTRUCTIONS.md) for a deeper walkthrough of OpenClaw configuration.
- Read [FILE_MANIFEST.md](./FILE_MANIFEST.md) for a map of the codebase.
