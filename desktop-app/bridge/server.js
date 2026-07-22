// Extends the core bridge-server (bridge-server/server.js, shared with the
// WSL/dev setup) with desktop-only routes: detecting and installing the
// local-AI stack (Node, ffmpeg, Python, whisper, Ollama, openclaw, and the
// OpenClaw gateway config itself) on a fresh Windows machine that has none
// of this installed yet. See desktop-app/README.md for the full picture.
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

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

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000, shell: IS_WINDOWS, ...opts }, (err, stdout, stderr) => {
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

  res.json({ node, ffmpeg, python, whisper, ollama, ollamaModels, openclaw, gateway });
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
        const child = spawn(cmd, args, { shell: IS_WINDOWS });
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
  whisper: () => [['python', ['-m', 'pip', 'install', '-U', 'openai-whisper']]],
  ollama: () => [['winget', ['install', '--id', 'Ollama.Ollama', ...WINGET_COMMON]]],
  openclaw: () => [['npm', ['install', '-g', 'openclaw']]],
};

app.post('/api/setup/install/:step', (req, res) => {
  const buildCommands = INSTALL_STEPS[req.params.step];
  if (!buildCommands) return res.status(400).json({ error: `unknown step: ${req.params.step}` });
  const taskId = startTask(buildCommands());
  res.json({ taskId });
});

app.post('/api/setup/pull-model', (req, res) => {
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
