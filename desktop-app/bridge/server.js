// Extends the core bridge-server (bridge-server/server.js, shared with the
// WSL/dev setup) with desktop-only routes: detecting and installing the
// local-AI stack (Node, ffmpeg, Python, whisper, Ollama, openclaw, and the
// OpenClaw gateway config itself) on a fresh Windows machine that has none
// of this installed yet. See desktop-app/README.md for the full picture.
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile, execFileSync, spawn } = require('child_process');

// Some machines have OpenClaw/Ollama set up only inside a WSL distro, with
// nothing equivalent installed natively on Windows (confirmed the hard way:
// on such a machine, every extraction job silently failed instantly and
// looped until the 30-minute ceiling, because there was no native openclaw
// to spawn at all). Detect that *before* requiring the core bridge, since
// WORKSPACE there is computed once at module-load time from
// OPENCLAW_WORKSPACE - if a usable WSL install exists, route everything
// through it instead of the native-install wizard below.
function decodeWslOutput(buf) {
  // wsl.exe -l -q has historically emitted UTF-16LE (with embedded null
  // bytes) on older Windows builds, plain UTF-8 on newer ones - stripping
  // null bytes recovers the distro names either way without needing to
  // detect which encoding actually produced them.
  return buf.toString('utf8').replace(/\u0000/g, '');
}

function detectWsl() {
  if (process.platform !== 'win32') return null;
  let distros;
  try {
    const out = execFileSync('wsl.exe', ['-l', '-q'], { timeout: 5000 });
    distros = decodeWslOutput(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch (err) {
    return null; // wsl.exe not installed / no distros - stay in native mode
  }

  for (const distro of distros) {
    try {
      const out = execFileSync(
        'wsl.exe',
        [
          '-d', distro, '--', 'bash', '-lc',
          'command -v openclaw >/dev/null && command -v ollama >/dev/null && command -v node >/dev/null && echo "$HOME"',
        ],
        { timeout: 8000 }
      );
      const home = decodeWslOutput(out).trim().split('\n').pop();
      if (home && home.startsWith('/')) return { distro, home };
    } catch (err) {
      // This distro doesn't have the full stack on a login shell's PATH - try the next one.
    }
  }
  return null;
}

function hasNativeStack() {
  if (process.platform !== 'win32') return true;
  try {
    execFileSync('openclaw', ['--version'], { shell: true, timeout: 5000 });
    execFileSync('ollama', ['--version'], { shell: true, timeout: 5000 });
    return true;
  } catch (err) {
    return false;
  }
}

// Prefer an already-working native install over WSL - a machine that has
// both (e.g. this project's own dev machine, set up natively via the wizard
// well before WSL detection existed) should keep behaving exactly as it did
// before this existed. Only probe WSL at all when native isn't usable.
const wslStack = hasNativeStack() ? null : detectWsl();
let WSL_INFO;
if (wslStack) {
  const uncWorkspace = `\\\\wsl.localhost\\${wslStack.distro}${wslStack.home.replace(/\//g, '\\')}\\.openclaw\\workspace`;
  process.env.JCM_EXEC_MODE = 'wsl';
  process.env.JCM_WSL_DISTRO = wslStack.distro;
  process.env.OPENCLAW_WORKSPACE = uncWorkspace;
  process.env.JCM_WSL_WORKSPACE = `${wslStack.home}/.openclaw/workspace`;
  WSL_INFO = {
    active: true,
    distro: wslStack.distro,
    detail: `Using OpenClaw/Ollama already set up in WSL distro "${wslStack.distro}" - no native Windows install needed.`,
  };
} else {
  WSL_INFO = { active: false };
}

const CORE_PATH = process.env.JCM_CORE_BRIDGE_PATH || path.join(__dirname, '..', '..', 'bridge-server', 'server.js');
const { app, PORT, WORKSPACE } = require(CORE_PATH);

const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_CONTEXT_WINDOW = 32768;

// npm/winget-installed CLIs (openclaw, npm itself) are .cmd shims on
// Windows, which execFile/spawn can't resolve without going through a shell -
// unlike on Linux/WSL, where these are plain executables. Windows-only.
const IS_WINDOWS = process.platform === 'win32';

// Model names are the one piece of user input that reaches a shell-invoked
// command (ollama pull / config patch) - constrain to Ollama's actual tag
// syntax so shell:true on Windows can't be handed anything unexpected.
const MODEL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;

function isValidModelName(name) {
  return typeof name === 'string' && name.length > 0 && name.length < 200 && MODEL_NAME_PATTERN.test(name);
}

/**
 * winget/npm installs update the User/Machine PATH in the registry, but this
 * already-running process's process.env.PATH is a snapshot from when it
 * launched - Windows has no equivalent of re-sourcing a shell rc file, so
 * without this, every install step after the first "works" (winget reports
 * success, files land on disk) but the tool still shows as missing until the
 * whole app is restarted. Re-read both PATH scopes from the registry and
 * merge them into this process's env after anything that might have changed
 * them.
 */
async function refreshPath() {
  if (!IS_WINDOWS) return;
  try {
    const script =
      "[System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + " +
      "[System.Environment]::GetEnvironmentVariable('Path','User')";
    const result = await run('powershell.exe', ['-NoProfile', '-Command', script], { shell: false, timeout: 10000 });
    if (result.ok && result.stdout) {
      process.env.PATH = result.stdout.trim();
    }
  } catch (err) {
    // Best-effort - if this fails, commands just keep using the PATH the app launched with.
  }
}

// Python's default console encoding on Windows is the legacy cp1252 codepage,
// not UTF-8 - whisper's own --help text lists supported languages using
// non-Latin1 characters (e.g. Chinese), which crashes with a
// UnicodeEncodeError before it ever gets to argument parsing. This isn't
// whisper being broken, it's this one Windows default; force UTF-8 for every
// command this file spawns so detection doesn't trip over it, and (see the
// whisper install step) persist it system-wide so the OpenClaw agent's own
// later whisper invocations - a separate process this file doesn't control -
// don't hit the same crash mid-transcription on non-English content.
const PY_ENV = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000, shell: IS_WINDOWS, env: { ...process.env, ...PY_ENV }, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
    });
  });
}

async function checkCommand(cmd, versionArgs) {
  const result = await run(cmd, versionArgs);
  return { present: result.ok, detail: result.ok ? result.stdout.split('\n')[0] : result.stderr.split('\n')[0] || null };
}

async function checkOllamaModels() {
  const result = await run('ollama', ['list']);
  if (!result.ok) return { present: false, models: [] };
  const lines = result.stdout.split('\n').slice(1).filter(Boolean);
  const models = lines.map((l) => l.split(/\s+/)[0]).filter(Boolean);
  return { present: models.length > 0, models };
}

function openclawConfigPath() {
  return path.join(os.homedir(), '.openclaw', 'openclaw.json');
}

async function checkOpenclawGateway() {
  const configExists = fs.existsSync(openclawConfigPath());
  const statusResult = await run('openclaw', ['gateway', 'status'], { timeout: 10000 });
  const running = /Runtime:\s*running/i.test(statusResult.stdout);
  return { configExists, running, detail: statusResult.stdout || statusResult.stderr };
}

app.get('/api/setup/status', async (req, res) => {
  // When a usable WSL install was found at startup, the native-Windows
  // checks below are all moot (and would just show red, since nothing was
  // ever installed natively) - report the WSL stack as ready instead of
  // running them, but still genuinely check the gateway itself (command
  // presence alone doesn't guarantee it's actually running). See
  // SetupWizard.jsx, which shows a banner and skips straight past the
  // wizard when status.wsl.active is true.
  if (WSL_INFO.active) {
    const ready = { present: true, detail: WSL_INFO.detail };
    const gatewayResult = await run('wsl.exe', ['-d', WSL_INFO.distro, '--', 'openclaw', 'gateway', 'status'], { timeout: 10000 });
    const running = /Runtime:\s*running/i.test(gatewayResult.stdout);
    return res.json({
      wsl: WSL_INFO,
      node: ready,
      ffmpeg: ready,
      python: ready,
      whisper: ready,
      ollama: ready,
      ollamaModels: { present: true, models: [] },
      openclaw: ready,
      gateway: { configExists: true, running, detail: gatewayResult.stdout || gatewayResult.stderr || WSL_INFO.detail },
    });
  }

  await refreshPath();
  const [node, ffmpeg, python, whisper, ollama, ollamaModels, openclaw, gateway] = await Promise.all([
    checkCommand('node', ['--version']),
    checkCommand('ffmpeg', ['-version']),
    checkCommand('python', ['--version']),
    checkCommand('whisper', ['--help']),
    checkCommand('ollama', ['--version']),
    checkOllamaModels(),
    checkCommand('openclaw', ['--version']),
    checkOpenclawGateway(),
  ]);

  res.json({ wsl: WSL_INFO, node, ffmpeg, python, whisper, ollama, ollamaModels, openclaw, gateway });
});

/** taskId -> { status, log: string[], error } */
const setupTasks = new Map();

function startTask(commands) {
  const taskId = crypto.randomUUID();
  const task = { status: 'running', log: [], error: null };
  setupTasks.set(taskId, task);

  (async () => {
    for (const [cmd, args] of commands) {
      task.log.push(`$ ${cmd} ${args.join(' ')}`);
      const ok = await new Promise((resolve) => {
        const child = spawn(cmd, args, { shell: IS_WINDOWS, env: { ...process.env, ...PY_ENV } });
        child.stdout.on('data', (d) => task.log.push(d.toString()));
        child.stderr.on('data', (d) => task.log.push(d.toString()));
        child.on('close', (code) => resolve(code === 0));
        child.on('error', (err) => {
          task.log.push(`error: ${err.message}`);
          resolve(false);
        });
      });
      if (!ok) {
        task.status = 'failed';
        task.error = `Command failed: ${cmd} ${args.join(' ')}`;
        return;
      }
    }
    task.status = 'completed';
  })();

  return taskId;
}

const WINGET_COMMON = ['-e', '--silent', '--accept-package-agreements', '--accept-source-agreements'];

const INSTALL_STEPS = {
  node: () => [['winget', ['install', '--id', 'OpenJS.NodeJS', ...WINGET_COMMON]]],
  ffmpeg: () => [['winget', ['install', '--id', 'Gyan.FFmpeg', ...WINGET_COMMON]]],
  python: () => [['winget', ['install', '--id', 'Python.Python.3.12', ...WINGET_COMMON]]],
  // setx persists PYTHONUTF8 for the user account (registry), not just this
  // process - so the OpenClaw agent's own later whisper invocations (a
  // separate process this file has no control over) also avoid the
  // UnicodeEncodeError crash whisper's --help hits on Windows' default
  // console encoding (see PY_ENV above).
  whisper: () => [
    ['python', ['-m', 'pip', 'install', '-U', 'openai-whisper']],
    ['setx', ['PYTHONUTF8', '1']],
  ],
  ollama: () => [['winget', ['install', '--id', 'Ollama.Ollama', ...WINGET_COMMON]]],
  openclaw: () => [['npm', ['install', '-g', 'openclaw']]],
};

app.post('/api/setup/install/:step', (req, res) => {
  if (WSL_INFO.active) {
    return res.status(400).json({ error: `Already using the stack set up in WSL distro "${WSL_INFO.distro}" - nothing to install natively.` });
  }
  const buildCommands = INSTALL_STEPS[req.params.step];
  if (!buildCommands) return res.status(400).json({ error: `unknown step: ${req.params.step}` });
  const taskId = startTask(buildCommands());
  res.json({ taskId });
});

app.post('/api/setup/pull-model', (req, res) => {
  if (WSL_INFO.active) {
    return res.status(400).json({ error: `Already using the model(s) pulled in WSL distro "${WSL_INFO.distro}" - pull additional models there with "ollama pull".` });
  }
  const modelName = (req.body?.modelName || '').trim();
  if (!isValidModelName(modelName)) return res.status(400).json({ error: 'invalid modelName' });
  const taskId = startTask([['ollama', ['pull', modelName]]]);
  res.json({ taskId });
});

/**
 * Wires OpenClaw's local gateway to point at the just-installed Ollama, with
 * a random auth token and a conservative context window - see
 * bridge-server/README.md ("Local model performance") for why 32768 rather
 * than a model's much larger reported max: on this project's dev machine, an
 * oversized context window nearly maxed out GPU VRAM and made every agent
 * turn stall or time out.
 */
app.post('/api/setup/configure-gateway', async (req, res) => {
  // In WSL mode the user already has their own OpenClaw config inside WSL -
  // this flow patches in a fresh random token and model entry, which is
  // meant for a from-scratch native install and would be unsafe to run
  // against an existing config it knows nothing about. If the gateway isn't
  // already running there, that's something to fix inside WSL directly.
  if (WSL_INFO.active) {
    return res.status(400).json({
      error: `OpenClaw is set up in WSL distro "${WSL_INFO.distro}" - start its gateway there ` +
        `("openclaw gateway status" / "openclaw gateway start" from a WSL terminal) rather than ` +
        `reconfiguring it from here.`,
    });
  }

  const modelName = (req.body?.modelName || '').trim();
  if (!isValidModelName(modelName)) return res.status(400).json({ error: 'invalid modelName' });

  const token = crypto.randomBytes(24).toString('hex');
  const patch = {
    gateway: {
      mode: 'local',
      auth: { mode: 'token', token },
      port: 18789,
      bind: 'loopback',
    },
    models: {
      mode: 'merge',
      providers: {
        ollama: {
          baseUrl: OLLAMA_BASE_URL,
          api: 'ollama',
          models: [
            {
              id: modelName,
              name: modelName,
              reasoning: true,
              input: ['text'],
              contextWindow: DEFAULT_CONTEXT_WINDOW,
              maxTokens: 8192,
              compat: { supportsTools: true },
              api: 'ollama',
            },
          ],
        },
      },
    },
  };

  const taskId = crypto.randomUUID();
  const task = { status: 'running', log: [`Configuring OpenClaw gateway with model "${modelName}"...`], error: null };
  setupTasks.set(taskId, task);

  (async () => {
    const patchResult = await new Promise((resolve) => {
      const child = spawn('openclaw', ['config', 'patch', '--stdin'], { shell: IS_WINDOWS });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      child.on('close', (code) => resolve({ ok: code === 0, out }));
      child.on('error', (err) => resolve({ ok: false, out: err.message }));
      child.stdin.write(JSON.stringify(patch));
      child.stdin.end();
    });
    task.log.push(patchResult.out);

    if (!patchResult.ok) {
      task.status = 'failed';
      task.error = 'openclaw config patch failed - see log. You may need to run "openclaw setup" manually first.';
      return;
    }

    let gatewayResult = await run('openclaw', ['gateway', 'restart'], { timeout: 30000 });
    task.log.push(gatewayResult.stdout || gatewayResult.stderr);

    // openclaw exits 0 even when reporting "service missing" (it's treated
    // as informational, not a hard failure), so this has to check the
    // message content rather than the exit code.
    if (/service missing|not installed/i.test(gatewayResult.stdout + gatewayResult.stderr)) {
      // Fresh machine: no service registered yet at all (restart/start both
      // manage an existing service - see "openclaw gateway --help").
      task.log.push('No gateway service found - installing it first...');
      const installResult = await run('openclaw', ['gateway', 'install'], { timeout: 30000 });
      task.log.push(installResult.stdout || installResult.stderr);

      gatewayResult = await run('openclaw', ['gateway', 'start'], { timeout: 30000 });
      task.log.push(gatewayResult.stdout || gatewayResult.stderr);
    }

    task.status = 'completed';
  })();

  res.json({ taskId });
});

app.get('/api/setup/tasks/:taskId', (req, res) => {
  const task = setupTasks.get(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'task not found' });
  res.json(task);
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`JordanClawMax desktop bridge listening on http://localhost:${PORT}`);
    console.log(`Workspace: ${WORKSPACE}`);
  });
}

module.exports = { app, PORT };
