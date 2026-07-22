# File Manifest

Map of every file in this project and what it's responsible for.

```
jordanclawmax/
├── .env.example                    Template for bridge server URL + poll timing env vars
├── .gitignore                      Ignores node_modules, build output, .env, logs
├── package.json                    Dependencies (axios, dotenv, react) + npm scripts
├── QUICKSTART.md                   5-minute setup + run guide
├── SETUP_INSTRUCTIONS.md           Full setup, OpenClaw/bridge config, troubleshooting
├── FILE_MANIFEST.md                This file
│
├── bridge-server/                  Local Node/Express bridge (runs inside WSL) that
│   ├── server.js                    drives the JordanClawMax agent skill and exposes
│   ├── package.json                 plain HTTP for this app - see bridge-server/README.md
│   └── README.md
│
├── desktop-app/                    (desktop-app branch) Electron build - one .exe with
│   ├── main.js                      a guided first-run setup wizard, targeting native
│   ├── preload.js                   Windows installs (no WSL) of ffmpeg/whisper/Ollama/
│   ├── bridge/server.js             openclaw. Embeds bridge-server's core logic + adds
│   └── README.md                    setup/install routes. See desktop-app/README.md.
│
├── public/
│   └── index.html                  HTML shell, mounts React at #root
│
└── src/
    ├── index.js                    React entry point, renders <App />
    ├── index.css                   Global base styles (body reset, font smoothing)
    ├── App.jsx                     Root component: owns all app state, routes between
    │                                upload / processing / results views
    ├── App.css                     Layout, header, error banner, modal preview styles
    │
    ├── components/
    │   ├── VideoUpload.jsx         Drag-and-drop / click-to-browse video picker,
    │   │                            file validation, upload progress bar
    │   ├── ControlPanel.jsx        Extraction settings form (number of clips, max
    │   │                            clip length, style chips), submits the extraction job
    │   ├── ClipGallery.jsx         Grid of results; empty state, loading state with
    │   │                            progress bar, "download all" action
    │   ├── ClipCard.jsx            Single clip: iPhoneFrame preview, title, duration,
    │   │                            match score, tags, download/preview buttons
    │   └── iPhoneFrame.jsx         Reusable decorative phone-mockup frame used to
    │                                preview vertical (9:16) clip thumbnails/video
    │
    ├── services/
    │   └── openclawService.js      All bridge-server integration (see bridge-server/README.md):
    │                                - uploadVideo()          upload source video to the bridge
    │                                - invokeJordanClawMax()  start the skill job, get a jobId
    │                                - getJobStatus()         fetch job status once
    │                                - pollForResults()       poll until completed/failed/timeout
    │                                - cancelJob()            cancel an in-flight job
    │                                - extractClips()         convenience end-to-end helper
    │
    └── styles/
        ├── VideoUpload.css         Dropzone, selected-file preview, progress bar
        ├── ControlPanel.css        Form fields, sliders, keyword chips, submit button
        ├── ClipGallery.css         Grid layout, empty/loading states, spinner
        ├── ClipCard.css            Card layout, play badge, tags, action buttons
        └── iPhoneFrame.css         Phone chrome: notch, screen, home indicator
```

## Data flow summary

1. **`VideoUpload`** captures a `File` and hands it to `App` via `onVideoSelected`.
2. **`ControlPanel`** owns the extraction `settings` object (lifted into `App` state)
   and triggers `App.handleExtract()` on submit.
3. **`App.handleExtract()`** calls into `openclawService`:
   `uploadVideo()` → `invokeJordanClawMax()` → `pollForResults()`, updating
   `uploadProgress` / `jobProgress` state as it goes, and switching `view` to
   `'processing'` then `'results'`.
4. **`ClipGallery`** + **`ClipCard`** render the resulting `clips` array, each
   clip previewed inside an **`iPhoneFrame`**.

## Environment variables (declared in `.env.example`)

- `REACT_APP_BRIDGE_URL`
- `REACT_APP_OPENCLAW_POLL_INTERVAL_MS` (optional)
- `REACT_APP_OPENCLAW_POLL_TIMEOUT_MS` (optional)
