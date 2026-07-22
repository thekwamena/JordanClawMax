import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import '../styles/SetupWizard.css';

const BRIDGE_URL = window.jordanClawMaxDesktop?.bridgePort
  ? `http://localhost:${window.jordanClawMaxDesktop.bridgePort}`
  : process.env.REACT_APP_BRIDGE_URL || 'http://localhost:8787';

const bridge = axios.create({ baseURL: BRIDGE_URL });

const DEFAULT_MODEL_SUGGESTION = 'qwen2.5:7b';

/**
 * First-run dependency checklist for the desktop app: Node, ffmpeg, Python,
 * whisper, Ollama (+ a pulled model), the openclaw CLI, and the OpenClaw
 * gateway config itself. Each step runs on the bridge server, since only it
 * can reach the local machine's package managers - this is a guided wizard,
 * not a silent one-shot installer: some steps (Node itself) may need the
 * user to finish an installer dialog, and every step's raw output is shown
 * so a failure is debuggable rather than a black box.
 */
function SetupWizard({ onReady }) {
  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(true);
  const [runningStep, setRunningStep] = useState(null);
  const [log, setLog] = useState('');
  const [modelName, setModelName] = useState(DEFAULT_MODEL_SUGGESTION);
  const pollRef = useRef(null);

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      const { data } = await bridge.get('/api/setup/status');
      setStatus(data);
    } catch (err) {
      setStatus(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (status && isEverythingReady(status)) {
      onReady();
    }
  }, [status, onReady]);

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  const runTask = useCallback((taskId, stepKey) => {
    setRunningStep(stepKey);
    setLog('');
    if (pollRef.current) clearInterval(pollRef.current);

    pollRef.current = setInterval(async () => {
      try {
        const { data } = await bridge.get(`/api/setup/tasks/${taskId}`);
        setLog((data.log || []).join('\n'));
        if (data.status === 'completed' || data.status === 'failed') {
          clearInterval(pollRef.current);
          setRunningStep(null);
          if (data.status === 'failed') setLog((prev) => `${prev}\n\nFAILED: ${data.error || 'unknown error'}`);
          refresh();
        }
      } catch (err) {
        clearInterval(pollRef.current);
        setRunningStep(null);
      }
    }, 1000);
  }, [refresh]);

  const install = useCallback((stepKey) => async () => {
    try {
      const { data } = await bridge.post(`/api/setup/install/${stepKey}`);
      runTask(data.taskId, stepKey);
    } catch (err) {
      setLog(`Could not start install: ${err.message}`);
    }
  }, [runTask]);

  const pullModel = useCallback(async () => {
    try {
      const { data } = await bridge.post('/api/setup/pull-model', { modelName });
      runTask(data.taskId, 'ollama-model');
    } catch (err) {
      setLog(`Could not start model pull: ${err.message}`);
    }
  }, [modelName, runTask]);

  const configureGateway = useCallback(async () => {
    try {
      const { data } = await bridge.post('/api/setup/configure-gateway', { modelName });
      runTask(data.taskId, 'configure-gateway');
    } catch (err) {
      setLog(`Could not start gateway configuration: ${err.message}`);
    }
  }, [modelName, runTask]);

  if (checking && !status) {
    return (
      <div className="setup-wizard setup-wizard--loading">
        <div className="setup-wizard__spinner" />
        <p>Checking your system…</p>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="setup-wizard setup-wizard--error">
        <p>Couldn't reach the local bridge server. It may still be starting up.</p>
        <button type="button" onClick={refresh}>Retry</button>
      </div>
    );
  }

  const steps = buildSteps(status, {
    installNode: install('node'),
    installFfmpeg: install('ffmpeg'),
    installPython: install('python'),
    installWhisper: install('whisper'),
    installOllama: install('ollama'),
    installOpenclaw: install('openclaw'),
    pullModel,
    configureGateway,
  });

  return (
    <div className="setup-wizard">
      <header className="setup-wizard__header">
        <h1>Set up JordanClawMax</h1>
        <p>
          This is a one-time setup - JordanClawMax runs entirely on your own machine, using a
          local AI model, so there's a short checklist of tools to install first.
        </p>
      </header>

      <ol className="setup-wizard__steps">
        {steps.map((step) => (
          <li key={step.key} className={`setup-wizard__step setup-wizard__step--${step.state}`}>
            <div className="setup-wizard__step-info">
              <span className="setup-wizard__step-icon">
                {step.state === 'ready' ? '✓' : step.state === 'blocked' ? '•' : '○'}
              </span>
              <div>
                <h3>{step.title}</h3>
                <p>{step.description}</p>
                {step.detail && <p className="setup-wizard__step-detail">{step.detail}</p>}
              </div>
            </div>

            {step.key === 'ollama-model' && step.state !== 'ready' && (
              <div className="setup-wizard__model-input">
                <input
                  type="text"
                  value={modelName}
                  onChange={(e) => setModelName(e.target.value)}
                  placeholder="e.g. qwen2.5:7b"
                  disabled={!!runningStep}
                />
              </div>
            )}

            {step.state !== 'ready' && (
              <button
                type="button"
                className="setup-wizard__action"
                onClick={step.action}
                disabled={!!runningStep || step.state === 'blocked'}
              >
                {runningStep === step.key ? 'Working…' : step.actionLabel}
              </button>
            )}
          </li>
        ))}
      </ol>

      {log && <pre className="setup-wizard__log">{log}</pre>}

      <footer className="setup-wizard__footer">
        <button type="button" onClick={refresh} disabled={!!runningStep || checking}>
          {checking ? 'Checking…' : 'Re-check everything'}
        </button>
      </footer>
    </div>
  );
}

function isEverythingReady(status) {
  return (
    status.node.present &&
    status.ffmpeg.present &&
    status.whisper.present &&
    status.ollama.present &&
    status.ollamaModels.present &&
    status.openclaw.present &&
    status.gateway.configExists &&
    status.gateway.running
  );
}

function buildSteps(status, handlers) {
  const nodeReady = status.node.present;
  const pythonReady = status.python.present;
  const whisperReady = status.whisper.present;
  const ffmpegReady = status.ffmpeg.present;
  const ollamaReady = status.ollama.present;
  const modelReady = status.ollamaModels.present;
  const openclawReady = status.openclaw.present;
  const gatewayReady = status.gateway.configExists && status.gateway.running;

  return [
    {
      key: 'node',
      title: 'Node.js',
      description: 'Needed to install and run the OpenClaw CLI.',
      detail: status.node.detail,
      state: nodeReady ? 'ready' : 'pending',
      action: handlers.installNode,
      actionLabel: 'Install',
    },
    {
      key: 'ffmpeg',
      title: 'ffmpeg',
      description: 'Used to extract audio and encode the final 9:16 clips.',
      detail: status.ffmpeg.detail,
      state: ffmpegReady ? 'ready' : 'pending',
      action: handlers.installFfmpeg,
      actionLabel: 'Install',
    },
    {
      key: 'python',
      title: 'Python',
      description: 'Needed to install whisper (speech-to-text) below.',
      detail: status.python.detail,
      state: pythonReady ? 'ready' : 'pending',
      action: handlers.installPython,
      actionLabel: 'Install',
    },
    {
      key: 'whisper',
      title: 'Whisper (transcription)',
      description: 'Real speech-to-text so clips are chosen from actual dialogue, not guesses.',
      detail: status.whisper.detail,
      state: whisperReady ? 'ready' : pythonReady ? 'pending' : 'blocked',
      action: handlers.installWhisper,
      actionLabel: 'Install',
    },
    {
      key: 'ollama',
      title: 'Ollama',
      description: 'Runs the local LLM that reasons about your video and picks moments.',
      detail: status.ollama.detail,
      state: ollamaReady ? 'ready' : 'pending',
      action: handlers.installOllama,
      actionLabel: 'Install',
    },
    {
      key: 'ollama-model',
      title: 'A local model',
      description: `A model Ollama will run locally (e.g. "${DEFAULT_MODEL_SUGGESTION}"). Larger models are smarter but slower and need more disk space/VRAM.`,
      detail: status.ollamaModels.present ? status.ollamaModels.models.join(', ') : null,
      state: modelReady ? 'ready' : ollamaReady ? 'pending' : 'blocked',
      action: handlers.pullModel,
      actionLabel: 'Pull model',
    },
    {
      key: 'openclaw',
      title: 'OpenClaw CLI',
      description: 'The agent runtime that actually drives ffmpeg/whisper/the model.',
      detail: status.openclaw.detail,
      state: openclawReady ? 'ready' : nodeReady ? 'pending' : 'blocked',
      action: handlers.installOpenclaw,
      actionLabel: 'Install',
    },
    {
      key: 'configure-gateway',
      title: 'Connect everything',
      description: 'Points OpenClaw at your local Ollama and starts its gateway.',
      detail: status.gateway.detail,
      state: gatewayReady ? 'ready' : openclawReady && modelReady ? 'pending' : 'blocked',
      action: handlers.configureGateway,
      actionLabel: 'Configure',
    },
  ];
}

export default SetupWizard;
