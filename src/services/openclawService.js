import axios from 'axios';

// This talks to the local bridge server in bridge-server/, not OpenClaw
// directly - OpenClaw's real local install is a WebSocket gateway with no
// REST API, and the JordanClawMax skill is an agent skill (ffmpeg/whisper/LLM
// via the agent's exec tool), not a callable microservice. The bridge server
// runs the agent turn(s), watches the output directory, and exposes plain
// HTTP so this browser app can drive it. See bridge-server/README.md.
//
// In the desktop app, the bridge's actual port is decided at runtime (see
// desktop-app/main.js) and handed to us via preload.js rather than baked in
// at build time, in case the default port was already taken on someone's
// machine.
const BRIDGE_URL = window.jordanClawMaxDesktop?.bridgePort
  ? `http://localhost:${window.jordanClawMaxDesktop.bridgePort}`
  : process.env.REACT_APP_BRIDGE_URL || 'http://localhost:8787';

const POLL_INTERVAL_MS = Number(
  process.env.REACT_APP_OPENCLAW_POLL_INTERVAL_MS || 5000
);
// Must stay comfortably above the bridge server's own BRIDGE_MAX_TOTAL_MS
// (default 30 min) - otherwise this can time out independently right as the
// bridge is about to report its own completed/failed state, which is
// confusing ("Timed out..." even though the job basically finished).
const POLL_TIMEOUT_MS = Number(
  process.env.REACT_APP_OPENCLAW_POLL_TIMEOUT_MS || 60 * 60 * 1000
);

const bridge = axios.create({ baseURL: BRIDGE_URL });

/**
 * Upload a source video to the bridge server, which stores it under the
 * OpenClaw workspace so the agent can reference it by relative path.
 * Reports upload progress via onProgress(percent).
 * Returns { assetId, path }.
 */
export async function uploadVideo(file, onProgress) {
  if (!file) {
    throw new Error('uploadVideo: a video file is required');
  }

  const formData = new FormData();
  formData.append('file', file, file.name);

  const response = await bridge.post('/api/upload', formData, {
    onUploadProgress: (event) => {
      if (!onProgress || !event.total) return;
      const percent = Math.round((event.loaded * 100) / event.total);
      onProgress(percent);
    },
  });

  return response.data;
}

/**
 * Start a JordanClawMax extraction job for a previously uploaded asset.
 * `settings` is { numClips, styles, maxLength } - see ControlPanel.
 * Returns { jobId, status }.
 */
export async function invokeJordanClawMax(assetId, settings = {}) {
  if (!assetId) {
    throw new Error('invokeJordanClawMax: assetId is required');
  }

  const response = await bridge.post('/api/extract', {
    assetId,
    settings: {
      numClips: settings.numClips ?? 5,
      styles: settings.styles ?? ['funny'],
      maxLength: settings.maxLength ?? 30,
    },
  });

  return response.data;
}

/**
 * Fetch the current status/result of a job.
 * Returns { status: 'queued' | 'running' | 'completed' | 'failed', progress, result, error }.
 */
export async function getJobStatus(jobId) {
  if (!jobId) {
    throw new Error('getJobStatus: jobId is required');
  }

  const response = await bridge.get(`/api/jobs/${jobId}`);
  return response.data;
}

/**
 * Cancel an in-flight job.
 */
export async function cancelJob(jobId) {
  if (!jobId) {
    throw new Error('cancelJob: jobId is required');
  }

  const response = await bridge.delete(`/api/jobs/${jobId}`);
  return response.data;
}

/**
 * Poll a job until it reaches a terminal state ('completed' or 'failed'),
 * or until POLL_TIMEOUT_MS elapses. The underlying agent needs repeated
 * nudges to finish multi-clip jobs, so this can legitimately take a long
 * time for a large clip count - POLL_TIMEOUT_MS defaults to 2 hours.
 *
 * onProgress(jobStatus) is called after every poll.
 * Returns the final job status payload.
 * Throws on timeout or on a 'failed' job status.
 */
export async function pollForResults(jobId, onProgress) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    const jobStatus = await getJobStatus(jobId);

    if (onProgress) onProgress(jobStatus);

    if (jobStatus.status === 'completed') {
      return jobStatus;
    }

    if (jobStatus.status === 'failed') {
      throw new Error(jobStatus.error || 'JordanClawMax job failed');
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for job ${jobId} after ${POLL_TIMEOUT_MS}ms`);
}

/**
 * Convenience end-to-end helper: upload a video, invoke the skill, and poll
 * until clips are ready.
 *
 * callbacks: { onUploadProgress(percent), onJobProgress(jobStatus) }
 * Returns the array of extracted clips.
 */
export async function extractClips(file, settings, callbacks = {}) {
  const { onUploadProgress, onJobProgress } = callbacks;

  const asset = await uploadVideo(file, onUploadProgress);
  const job = await invokeJordanClawMax(asset.assetId, settings);
  const finalStatus = await pollForResults(job.jobId, onJobProgress);

  return finalStatus.result?.clips ?? [];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const openclawService = {
  uploadVideo,
  invokeJordanClawMax,
  getJobStatus,
  cancelJob,
  pollForResults,
  extractClips,
};

export default openclawService;
