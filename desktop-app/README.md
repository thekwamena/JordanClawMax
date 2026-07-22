# JordanClawMax Desktop

A standalone Windows desktop build of JordanClawMax. Unlike the browser +
WSL dev setup (see the repo root [SETUP_INSTRUCTIONS.md](../SETUP_INSTRUCTIONS.md)),
this is meant to be **sent to someone else** - they download one installer,
run it, and a guided first-run wizard gets the local AI stack set up on
their own Windows machine. No WSL required.

## What this actually is

An Electron app that:

- Embeds the same bridge server logic from [bridge-server/](../bridge-server/)
  directly in its main process (forked as a child process on launch) - one
  `.exe`, no separate terminal/server to start manually.
- Loads the same React UI from the repo root (`npm run build` output).
- Adds a **Setup Wizard** ([src/components/SetupWizard.jsx](../src/components/SetupWizard.jsx))
  that only shows up in the desktop build (gated on `window.jordanClawMaxDesktop.isDesktop`,
  set by `preload.js`) - it detects what's missing (Node, ffmpeg, Python,
  whisper, Ollama + a model, the openclaw CLI, the OpenClaw gateway config)
  and can run the install for each, streaming raw output so a failure is
  debuggable rather than a silent black box.

This is a **guided wizard, not a silent one-click installer** - deliberately.
Some things (Node.js itself, if totally absent) may need the user to finish
a dialog themselves; everything else is automated via `winget`/`pip`/`npm`
where possible.

## Windows-only dependency stack (no WSL)

The browser/WSL dev setup runs `ffmpeg`/`whisper`/`ollama`/`openclaw` inside
WSL Ubuntu. This build targets **native Windows** installs of all of them
instead, since requiring WSL (admin rights, a reboot, Windows Pro/Home
considerations) is a much bigger ask for someone just trying the app out:

| Tool | Install method | winget/pip package |
|---|---|---|
| Node.js | winget | `OpenJS.NodeJS` |
| ffmpeg | winget | `Gyan.FFmpeg` |
| Python | winget | `Python.Python.3.12` |
| whisper | pip (after Python) | `openai-whisper` |
| Ollama | winget | `Ollama.Ollama` |
| openclaw | npm | `openclaw` (global) |

**Important:** `execFile`/`spawn` on Windows can't resolve npm-global `.cmd`
shims (like `openclaw.cmd`) without `shell: true` - every command the bridge
runs uses `shell: IS_WINDOWS` for exactly this reason. Model names (the one
piece of user input that reaches a shell-invoked command) are validated
against Ollama's tag syntax (`/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/`) before ever
reaching a shell.

**Also important:** `openclaw gateway restart`/`start` exit **0** even when
reporting "Gateway service missing" - it's informational, not a failure. The
gateway-configure step checks the message content, not the exit code, and
falls back to `openclaw gateway install` (registers a Windows Scheduled
Task) before retrying `start` on a machine where the service was never
registered.

## Building

```bash
# from the repo root, once:
npm install
npm run build          # builds the React UI into ../build

cd desktop-app
npm install
npm run dist            # produces desktop-app/release/JordanClawMax Setup <version>.exe
```

`npm start` (inside `desktop-app/`) runs it unpackaged for development -
rebuild the root React app (`npm run build`) first if you've changed `src/`,
since the desktop app loads the built output, not the dev server.

## Known gaps / what's untested

- **Whisper's install step uses the same `pip install openai-whisper`
  command already validated to work (on WSL, earlier in this project) - but
  hasn't been run start-to-finish natively on Windows** in this repo. The
  mechanism itself (winget install progress streaming, task polling) is
  validated via the ffmpeg step, which does go through the exact same code
  path.
- **Only tested on one machine.** A genuinely fresh machine may hit
  package-manager states this wasn't tested against (e.g. no `winget` at
  all - rare on modern Windows 10/11, but not universal).
- **No custom app icon yet** - electron-builder uses the default Electron
  icon. Add one at `build-resources/icon.ico` and reference it in
  `package.json`'s `build.win.icon` to fix this.
- **GPU/VRAM sizing isn't automatic.** The gateway config step sets a fixed
  `contextWindow` of 32768 for whatever model is chosen - see
  [bridge-server/README.md](../bridge-server/README.md) ("Local model
  performance") for why an oversized context window can silently stall
  every agent turn on a smaller GPU. Someone with a lot more or a lot less
  VRAM than this project's dev machine may need to adjust this by hand
  (`openclaw config patch`) after the wizard finishes.
