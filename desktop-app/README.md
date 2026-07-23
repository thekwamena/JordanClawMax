# JordanClawMax Desktop

A standalone Windows desktop build of JordanClawMax. Unlike the browser +
WSL dev setup (see the repo root [SETUP_INSTRUCTIONS.md](../SETUP_INSTRUCTIONS.md)),
this is meant to be **sent to someone else** - they download one installer,
run it, and a guided first-run wizard gets the local AI stack set up on
their own Windows machine.

WSL is not *required* - the wizard can install everything natively via
`winget`/`pip`/`npm` on a completely fresh machine. But if the machine
already has OpenClaw/Ollama set up inside a WSL distro (a very common setup:
"Windows host + Linux VM" almost always means WSL2 in practice) and nothing
equivalent natively, the app detects that at startup and uses the WSL
install directly instead of trying to install a second, redundant native
stack - see "Using an existing WSL install" below.

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

## Using an existing WSL install

Before doing anything else, `desktop-app/bridge/server.js` runs `wsl.exe -l -q`
and, for each distro found, checks (via a login shell, so PATH customizations
in `.bashrc`/`.zshrc`/linuxbrew setups are picked up) whether `openclaw`,
`ollama`, and `node` are all on its `PATH`. If one is, that distro is used
directly for the rest of the app's lifetime:

- The core bridge (`bridge-server/server.js`) spawns `openclaw agent ...` via
  `wsl.exe -d <distro> --cd <workspace> -- openclaw agent ...` instead of
  spawning `openclaw` natively, and routes the `ffmpeg`/`ffprobe`
  re-encode/probe calls in `ensureVertical()` through `wsl.exe` the same way.
- Its `WORKSPACE` points at the distro's `~/.openclaw/workspace` via the
  `\\wsl.localhost\<distro>\...` UNC path, so this process's own file
  operations (serving clips, scanning for `clips.json`, etc.) work exactly
  as they do natively - WSL2 exposes its filesystem to Windows this way with
  no extra setup.
- The Setup Wizard is skipped entirely: `/api/setup/status` reports
  everything as ready and shows a banner naming the detected distro, rather
  than running (and failing) all the native-Windows checks below.
- `/api/setup/install/*`, `/api/setup/pull-model`, and
  `/api/setup/configure-gateway` all refuse to run in this mode - patching in
  a fresh gateway config/token would be unsafe against a config the app
  doesn't know the shape of. If the gateway isn't already running, start it
  from inside WSL directly (`openclaw gateway status` / `gateway start`).

This detection only looks at `PATH` inside WSL, not whether the gateway is
actually running yet - `/api/setup/status` checks that separately with a
real `openclaw gateway status` call through `wsl.exe`.

## Windows-only dependency stack (fallback: no WSL detected)

If no WSL distro has the full stack on its `PATH` (or WSL isn't installed at
all), this build falls back to targeting **native Windows** installs of
everything, since requiring WSL (admin rights, a reboot, Windows Pro/Home
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

## Troubleshooting

Things actually hit (and fixed) while building/testing this, in case they
show up again on someone else's machine. All of these are fixed as of
v1.2.0 - if you're on an older build, update first.

### App is stuck on "Starting JordanClawMax..." and eventually fails with "Timed out after 30 minutes without producing clips.json"

**Symptom:** the Setup Wizard (if shown) reports everything green, you start
an extraction, and it just sits there until it times out with zero clips -
no errors visible anywhere in the UI.

**Two separate causes were found, both silent by design (which made this
hard to diagnose) - both are fixed as of the version after v1.3.0:**

1. **Missing `shell: true` on the actual job-running command.** The bridge
   invokes the agent via `spawn('openclaw', [...])` - on Windows, `openclaw`
   resolves to an `openclaw.cmd` npm shim, which `spawn` cannot launch
   without `shell: true` (unlike a plain executable). Without it, the spawn
   fails instantly with `ENOENT` on *every single attempt*, and the error
   handler silently resolved and moved on - so the job just spun through
   attempts for the full 30 minutes and reported a generic timeout with no
   indication anything had gone wrong. Check the app's console/terminal
   output for `[runAgentTurn] failed to spawn openclaw` - if you see that
   repeating rapidly, you're on a build before this fix; update.
2. **OpenClaw/Ollama only installed inside WSL, not natively on Windows.**
   If your setup is "Windows machine running a Linux VM with Ubuntu" (this
   almost always means WSL2), the Setup Wizard's native-Windows checks are
   irrelevant to your actual install - the app now auto-detects a WSL distro
   with the full stack on its `PATH` and uses that instead (see "Using an
   existing WSL install" above). If you're on a build before this fix, the
   native checks would show red (or, worse, could pass if you happen to
   also have a partial native install, while the actual job still fails)
   with no way to point the app at WSL. Update to a build with WSL
   auto-detection, and make sure `openclaw gateway status` shows `Runtime:
   running` **from inside WSL** (not a native Windows PowerShell - they are
   two completely separate installs even if both show a program named
   `openclaw`).

### "Re-check everything" still shows a tool as missing right after installing it

**Symptom:** the wizard's install step reports success, but the checklist
still shows that tool as pending/missing even after clicking "Re-check
everything" a few times.

**Cause:** winget/pip/npm installs update the Windows registry's PATH, but
this app is a single already-running process - it read PATH once at launch
and, unlike a shell, has no way to "re-source" it. Every install after the
first one so far in this session doesn't take effect until something
re-reads PATH.

**Fixed in the app itself** (v1.2.0+): "Re-check everything" now re-reads
PATH from the registry before checking anything. If you're still stuck,
**fully quit and relaunch the app** - that always picks up a fresh PATH.

### Python step fails with "Found an existing package already installed... No available upgrade found" then the whole step fails

**Cause:** same root issue as above, just via a different symptom - winget
correctly sees Python is already installed (from an earlier attempt) and
has nothing to do, but the app's PATH is still stale so it still shows
Python as missing, and you end up re-clicking Install into a dead end.

**Fix:** click "Re-check everything" (or relaunch the app) rather than
re-running Install once winget says there's nothing to upgrade.

### Whisper install "succeeds" (you can see it download/install in the log) but never gets a green checkmark, and the detail line just says "Traceback (most recent call last):"

**Cause:** this is not a failed install. `whisper --help` prints its list of
supported languages, which includes non-Latin1 characters (e.g. Chinese) -
Python's default console encoding on Windows (`cp1252`) can't represent
those characters, so the health-check command itself crashes with a
`UnicodeEncodeError`, even though `openai-whisper` is genuinely installed
and works fine for actual transcription.

**Fixed in the app** (v1.2.0+): every command this app runs sets
`PYTHONUTF8=1`/`PYTHONIOENCODING=utf-8`, and the whisper install step also
persists `PYTHONUTF8=1` for your Windows user account (`setx`) so later
transcription runs - driven by a separate OpenClaw process this app doesn't
control - don't hit the same crash on non-English audio.

**If you still see this:** open a terminal and run
`python -m pip show openai-whisper` - if that shows a version, whisper is
installed and this is just the same display bug; update to the latest
build. If it shows nothing, the install genuinely failed - re-run the
Whisper install step and read the full log for the real error.

### "openclaw" shows as missing even though you can run it fine in PowerShell

**Cause:** `openclaw` (and `npm`) install as `.cmd` shims on Windows, which
Node's `execFile`/`spawn` can't resolve without going through a shell -
unlike Linux/WSL, where these are plain executables.

**Fixed in the app** - every command runs with `shell: true` on Windows for
exactly this reason. If you still see this on a very old build, update.

### Gateway configuration hangs on "Gateway service missing... Start with: openclaw gateway install"

**Cause:** on a completely fresh machine, `openclaw gateway restart`/`start`
manage an *existing* Windows Scheduled Task - there isn't one yet on a first
run. Confusingly, `openclaw` exits with code **0** even when reporting this,
so it's easy to assume it's a warning rather than a real failure.

**Fixed in the app** - the gateway-configure step now detects this message
and runs `openclaw gateway install` first (registers the Scheduled Task),
then retries `start`. If you hit this manually outside the wizard, the fix
is literally to run `openclaw gateway install` yourself first.

### `EADDRINUSE: address already in use :::8787` in the console / app won't start

**Cause:** another copy of the app (or a leftover process from a crashed
one) is still running and holding the bridge server's port.

**Fix:** open Task Manager, end any other `JordanClawMax`/`electron.exe`
processes, then relaunch. (If you're building from source and testing
multiple copies at once, run one with a different port:
`$env:PORT=8788; .\JordanClawMax.exe`.)

### A Windows Firewall / "Windows Security" prompt appears on first launch

This is expected, not a bug - the app's local bridge server is binding a
network port (loopback-only; nothing external can reach it). Click **Allow**.

### `winget` isn't available at all

Rare on a modern Windows 10/11 install, but if `winget` genuinely isn't
present, the automated install steps (Node, ffmpeg, Python, Ollama) will
fail outright. Install `App Installer` from the Microsoft Store (which
provides `winget`), then retry.
