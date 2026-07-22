const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const os = require('os');

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 8787);
// Clips are served by this same process; URLs need to be absolute since the
// React app is a separate origin (the dev server on :3000) and would
// otherwise resolve a relative "/files/..." against itself, not the bridge.
const BASE_URL = process.env.BRIDGE_BASE_URL || `http://localhost:${PORT}`;
const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.join(os.homedir(), '.openclaw', 'workspace');
const UPLOAD_DIR = path.join(WORKSPACE, 'clips', 'uploads');
const OUTPUT_ROOT = path.join(WORKSPACE, 'clips', 'editedClips');

// A single agent turn on the local model reliably produces about one clip
// before losing track of the rest of the job (see bridge-server/README.md).
// The job runner re-sends a "continue" message until clips.json shows up or
// these budgets are exhausted. Default kept well under an hour so an
// interactive session doesn't sit on a black-box spinner for 2+ hours -
// job.result is exposed incrementally (see runJob) so the GUI can show
// clips as they're found rather than waiting for this ceiling regardless.
const PER_ATTEMPT_TIMEOUT_MS = Number(process.env.BRIDGE_ATTEMPT_TIMEOUT_MS || 10 * 60 * 1000);
const MAX_TOTAL_MS = Number(process.env.BRIDGE_MAX_TOTAL_MS || 30 * 60 * 1000);

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_ROOT, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json());

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.mp4';
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 * 1024 } });

/** jobId -> { status, videoPath, numClips, maxLength, styles, outputRel, progress, result, error, cancelled } */
const jobs = new Map();

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required' });
  res.json({
    assetId: req.file.filename,
    path: `clips/uploads/${req.file.filename}`,
  });
});

app.post('/api/extract', (req, res) => {
  const { assetId, settings } = req.body || {};
  if (!assetId) return res.status(400).json({ error: 'assetId is required' });

  const jobId = crypto.randomUUID();
  const numClips = clamp(Number(settings?.numClips) || 5, 1, 25);
  const maxLength = clamp(Number(settings?.maxLength) || 30, 15, 60);
  const styles = Array.isArray(settings?.styles) && settings.styles.length ? settings.styles : ['funny'];

  const job = {
    status: 'queued',
    videoPath: `clips/uploads/${assetId}`,
    numClips,
    maxLength,
    styles,
    outputRel: `gui_${jobId}`,
    progress: { message: 'Queued', percent: 0 },
    result: null,
    error: null,
    cancelled: false,
  };
  jobs.set(jobId, job);

  runJob(jobId).catch((err) => {
    const j = jobs.get(jobId);
    if (j) {
      j.status = 'failed';
      j.error = err.message;
    }
  });

  res.json({ jobId, status: 'queued' });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json({
    status: job.status,
    progress: job.progress,
    result: job.result,
    error: job.error,
  });
});

app.delete('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  job.cancelled = true;
  res.json({ status: 'cancelling' });
});

app.use('/files', express.static(OUTPUT_ROOT));

if (require.main === module) {
  // Explicit IPv4 host - with no host given, Node defaults to the IPv6
  // wildcard (::), and WSL2's Windows<->WSL localhost-forwarding relay does
  // not reliably forward to that (confirmed by comparing against a Python
  // http.server control, which defaults to 0.0.0.0 and forwards fine).
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`JordanClawMax bridge listening on http://localhost:${PORT}`);
    console.log(`Workspace: ${WORKSPACE}`);
  });
}

module.exports = { normalizeManifest, findClipFiles, findManifestPath, ensureVertical, jobOutputDir, OUTPUT_ROOT };

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function jobOutputDir(outputRel) {
  return path.join(OUTPUT_ROOT, outputRel);
}

/**
 * SKILL.md says clips land in `{output}/clips/*.mp4`, but the agent doesn't
 * reliably put them there - observed runs have written straight to the
 * output root instead. Rather than assume a fixed layout, walk the whole
 * output directory (skipping `work/`, which holds intermediate audio/
 * transcript files) and return whatever .mp4 files actually exist, as paths
 * relative to the output root.
 */
function findClipFiles(outputRel) {
  const rootDir = jobOutputDir(outputRel);
  if (!fs.existsSync(rootDir)) return [];

  const results = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase() === 'work') continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.mp4')) {
        results.push(path.join(dir, entry.name));
      }
    }
  };
  walk(rootDir);

  return results
    .map((abs) => path.relative(rootDir, abs))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** Same idea as findClipFiles: clips.json isn't reliably at the output root. */
function findManifestPath(outputRel) {
  const rootDir = jobOutputDir(outputRel);
  if (!fs.existsSync(rootDir)) return null;

  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase() !== 'work') stack.push(full);
      } else if (entry.name === 'clips.json') {
        return full;
      }
    }
  }
  return null;
}

// The skill folder has accumulated a JordanClawMax.sh at various points that
// looks plausible but isn't: it calls whisper with a flag that doesn't exist
// (--timestamped), so it silently falls back to a hardcoded fake transcript,
// its "scores" are formulaic (line_num % 5, etc.) rather than real analysis,
// and its clip-seek math feeds a duration string through `date -d`, which
// parses it as a time-of-day rather than an offset. Explicitly steering the
// agent away from it and back to direct bash/ffmpeg/whisper calls, since
// that's the approach already validated to produce real, non-fabricated output.
const NO_SCRIPT_INSTRUCTION =
  `Do not run or rely on any JordanClawMax.sh script even if one exists in the skill folder - ` +
  `it has known bugs (fake fallback transcript, non-existent whisper flag, broken seek-time math). ` +
  `Perform each step directly via individual bash/ffmpeg/whisper commands (the skill's own Workflow ` +
  `section), not a pre-written script.`;

// Observed once: the model improvised `ffmpeg -acodec libopus ... audio.wav`
// for the audio-extraction step - Opus can't be muxed into a WAV container,
// so every attempt failed on literally the first command and the job timed
// out having produced nothing at all. Giving the exact tested command up
// front costs a few tokens and removes a whole class of self-inflicted
// failure that a "do it correctly" instruction alone doesn't prevent.
const AUDIO_EXTRACT_INSTRUCTION =
  `For audio extraction use exactly this command (pcm_s16le is WAV-compatible; ` +
  `do not substitute a different codec like libopus, which cannot be muxed into a .wav file): ` +
  `ffmpeg -i {video} -vn -acodec pcm_s16le -ar 16000 -ac 1 {output}/work/audio.wav`;

// Each attempt runs in its own fresh Gateway session (see runJob) to avoid
// the context filling up and getting compacted/truncated over a long,
// multi-nudge job - observed to make the model lose track of which time
// ranges it already used and start repeating itself. Because of that, every
// message must be fully self-contained: a fresh session has no memory of
// anything from a prior attempt, so parameters and progress-so-far both need
// restating every time, not just on the first message.
function commonParams(job) {
  const outputForSkill = `clips/editedClips/${job.outputRel}`;
  // A zero-width range (e.g. "15-15" when maxLength is the slider's 15s
  // minimum) leaves the model no freedom to match clip boundaries to actual
  // content - observed to produce mechanical, uniform back-to-back chunks
  // instead of real highlight selection. Always leave some flex below the max.
  const clipLengthLower = Math.max(5, Math.round(job.maxLength * 0.5));
  return (
    `video=${job.videoPath}, output=${outputForSkill}, clip_length=${clipLengthLower}-${job.maxLength}, ` +
    `styles=${job.styles.join(',')}. Use the real whisper CLI for the transcript step if work/audio.srt ` +
    `doesn't already exist (output format srt, not json - keep tool output small; if it already exists, ` +
    `reuse it, do not re-run whisper). Do not skip or fabricate transcript content. Clip duration should ` +
    `vary based on the actual content/moment, not be a fixed length - do not just chop the video into ` +
    `uniform back-to-back windows. ` +
    `${AUDIO_EXTRACT_INSTRUCTION} ` +
    `${NO_SCRIPT_INSTRUCTION}`
  );
}

function buildInitialMessage(job) {
  return (
    `Use the JordanClawMax skill exactly as documented in skills/JordanClawMax/SKILL.md. ` +
    `Parameters: ${commonParams(job)} num_clips=${job.numClips}. ` +
    `Every clip must come from a different, non-overlapping part of the video, spread across its full ` +
    `duration - do not pick the same or an overlapping moment twice. If the video genuinely doesn't contain ` +
    `${job.numClips} distinct notable moments, it's fine to produce fewer, well-separated clips instead of ` +
    `padding the count with repeats or overlaps. ` +
    `Finish by writing CLIP_RANKINGS.txt, execution_log.txt, and clips.json (per the Machine-Readable Manifest ` +
    `section of SKILL.md) to the output root.`
  );
}

function buildContinueMessage(job, clipsSoFar, usedRanges) {
  const usedRangesText = usedRanges
    .map(([s, e]) => `${Math.round(s)}-${Math.round(e)}s`)
    .join(', ') || 'none yet';
  return (
    `Use the JordanClawMax skill exactly as documented in skills/JordanClawMax/SKILL.md. ` +
    `This continues an existing job - the transcript and some clips already exist on disk. ` +
    `Parameters: ${commonParams(job)} num_clips=${job.numClips}. ` +
    `${clipsSoFar.length} of ${job.numClips} genuinely distinct clips confirmed so far. Time ranges already ` +
    `used (do not reuse or overlap these): ${usedRangesText}. Find ${job.numClips - clipsSoFar.length} more ` +
    `clips from moments NOT in those ranges. ` +
    `Rewrite clips.json (per the Machine-Readable Manifest section of SKILL.md) to include all clips - ` +
    `both previously finished and new - in the output root.`
  );
}

function runAgentTurn(sessionId, message, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(
      'openclaw',
      ['agent', '--agent', 'main', '--session-id', sessionId, '--message', message, '--json'],
      { cwd: WORKSPACE }
    );

    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function runJob(jobId) {
  const job = jobs.get(jobId);
  const startedAt = Date.now();
  let message = buildInitialMessage(job);
  let attempt = 0;

  // Persisted across turns: asked for more clips than the source has
  // genuinely distinct moments for, the model re-picks (sometimes
  // byte-identical) segments under a different rank. Accumulate only
  // genuinely new clips turn over turn instead of resetting each time, so a
  // duplicate-heavy manifest triggers another round asking for the shortfall
  // rather than silently returning fewer clips than requested.
  const clips = [];
  const seenHashes = new Set();
  const acceptedRanges = [];

  while (Date.now() - startedAt < MAX_TOTAL_MS) {
    if (job.cancelled) {
      job.status = 'failed';
      job.error = 'Cancelled';
      return;
    }

    job.status = 'running';
    job.progress = {
      message: `JordanClawMax is working (${clips.length}/${job.numClips} unique clips so far)…`,
      percent: Math.min(90, Math.round((clips.length / job.numClips) * 90)),
    };

    // A fresh session per attempt, not one growing session for the whole
    // job: a long job means many nudges, and letting one session's context
    // grow across all of them eventually overflows its budget and gets
    // compacted/truncated - observed to make the model lose track of which
    // clips it already made and start repeating itself. Every message is
    // self-contained (see buildInitialMessage/buildContinueMessage) so a
    // fresh session each time loses nothing essential.
    attempt += 1;
    const sessionId = `gui-${jobId}-a${attempt}`;
    await runAgentTurn(sessionId, message, PER_ATTEMPT_TIMEOUT_MS);

    const manifestPath = findManifestPath(job.outputRel);
    if (manifestPath) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const candidateClips = normalizeManifest(manifest, job);
        let addedThisRound = 0;
        for (const clip of candidateClips) {
          if (clips.length >= job.numClips) break;
          const absPath = path.join(OUTPUT_ROOT, clip.id);
          const actualDuration = await ensureVertical(absPath);
          // The agent's own clip-timing math occasionally picks a start
          // time right at the end of the source video, producing a
          // near-empty file. Drop those rather than show a broken clip.
          if (actualDuration !== null && actualDuration < 3) continue;
          // Safety net against the known JordanClawMax.sh fake-transcript
          // fallback ("Segment N: This is segment number N...") - if this
          // shows up, the transcript step didn't actually run.
          if (/segment \d+.*with some content for demonstration/i.test(clip.transcriptExcerpt)) continue;
          // Drop exact content duplicates...
          const hash = crypto.createHash('md5').update(fs.readFileSync(absPath)).digest('hex');
          if (seenHashes.has(hash)) continue;
          // ...and drop heavily-overlapping time ranges even when the
          // resulting encode isn't byte-identical.
          if (clip.start !== null && clip.end !== null) {
            const overlapsExisting = acceptedRanges.some(([s, e]) => {
              const overlap = Math.min(e, clip.end) - Math.max(s, clip.start);
              const shorter = Math.min(e - s, clip.end - clip.start);
              return shorter > 0 && overlap / shorter > 0.5;
            });
            if (overlapsExisting) continue;
            acceptedRanges.push([clip.start, clip.end]);
          }
          seenHashes.add(hash);
          clips.push(clip);
          addedThisRound += 1;
        }

        // Expose whatever's genuinely confirmed so far immediately, even
        // though the job isn't done - a slow multi-clip job can otherwise
        // look like a dead black-box spinner for a long time even though
        // clips are steadily becoming available.
        if (clips.length > 0) {
          job.result = { clips: [...clips] };
        }

        if (clips.length >= job.numClips) {
          job.result = { clips };
          job.status = 'completed';
          job.progress = { message: 'Done', percent: 100 };
          return;
        }

        // A manifest existed but every candidate was a duplicate of
        // something we already have, and clip count has been stable across
        // two full rounds - the source likely doesn't have enough distinct
        // moments left. Stop nudging and return what we've got rather than
        // loop until the time budget is exhausted.
        if (candidateClips.length > 0 && addedThisRound === 0 && job.noProgressRounds) {
          job.result = { clips };
          job.status = 'completed';
          job.progress = { message: 'Done', percent: 100 };
          return;
        }
        job.noProgressRounds = candidateClips.length > 0 && addedThisRound === 0;
      } catch (err) {
        // Manifest exists but isn't valid JSON yet (still being written) - keep nudging.
      }
    }

    message = buildContinueMessage(job, clips, acceptedRanges);
  }

  if (clips.length > 0) {
    job.result = { clips };
    job.status = 'completed';
    job.progress = { message: 'Done', percent: 100 };
    return;
  }

  job.status = 'failed';
  job.error = `Timed out after ${Math.round((Date.now() - startedAt) / 60000)} minutes without producing clips.json`;
}

/**
 * The local model doesn't reliably follow the file layout or manifest schema
 * in SKILL.md - across runs it has used different directory layouts (clips/
 * subfolder vs. output root) and different field names for the same thing
 * (file/filename/id-as-filename, start/start_time_s/startTime, ...). Trusting
 * a manifest field for the video *path* caused 404s whenever the model's
 * naming didn't match what this function guessed.
 *
 * Instead: find the real .mp4 files that actually exist anywhere under the
 * output directory (always correct, by definition - see findClipFiles) and
 * match them positionally, in order, against the manifest's clip entries
 * (sorted by rank/id if present). Manifest fields are only ever used for
 * display metadata (title, duration, transcript), never for path construction.
 */
function normalizeManifest(manifest, job) {
  const rawClips = Array.isArray(manifest.clips) ? manifest.clips : [];
  const orderedClips = [...rawClips].sort((a, b) => (a.rank ?? a.id ?? 0) - (b.rank ?? b.id ?? 0));
  const realFiles = findClipFiles(job.outputRel);
  const jobStyles = manifest.job?.parameters?.styles;
  const defaultStyle = Array.isArray(jobStyles) ? jobStyles[0] : jobStyles || job.styles[0];

  return realFiles.map((relFile, i) => {
    const c = orderedClips[i] || {};
    const start = timeToSeconds(c.start ?? c.start_time_s ?? c.startTime);
    const end = timeToSeconds(c.end ?? c.end_time_s ?? c.endTime);
    const duration = numberOrNull(c.duration ?? c.duration_s ?? (start !== null && end !== null ? end - start : null));
    const style = c.style || (Array.isArray(c.styles) ? c.styles[0] : c.styles) || defaultStyle;
    const scoreRaw = numberOrNull(c.score ?? c.funny_score ?? c.viral_potential ?? c.punchy_score);
    const score = scoreRaw !== null ? (scoreRaw > 1 ? scoreRaw / 100 : scoreRaw) : undefined;
    const transcriptExcerpt =
      c.transcriptExcerpt ||
      c.transcript_snippet ||
      (Array.isArray(c.transcript) ? c.transcript.map((t) => t.text).join(' ') : '');
    const fallbackTitle = path
      .basename(relFile)
      .replace(/\.mp4$/i, '')
      .replace(/^\d+[_-]/, '')
      .replace(/[_-]+/g, ' ');

    return {
      id: `${job.outputRel}/${relFile}`,
      title: c.title || c.moment || c.summary || fallbackTitle,
      duration,
      start,
      end,
      score,
      tags: style ? [style] : [],
      transcriptExcerpt,
      videoUrl: `${BASE_URL}/files/${job.outputRel}/${relFile}`,
      aspectRatio: '9:16',
    };
  });
}

function numberOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * One manifest schema variant reports start/end as "H:MM:SS" or "M:SS"
 * strings rather than raw seconds. Parse those too so overlap-based dedup
 * (which needs numeric start/end) works for that schema, not just the
 * content-hash check.
 */
function timeToSeconds(v) {
  const asNumber = numberOrNull(v);
  if (asNumber !== null) return asNumber;
  if (typeof v !== 'string' || !/^\d{1,2}(:\d{2}){1,2}$/.test(v.trim())) return null;
  const parts = v.trim().split(':').map(Number);
  return parts.reduce((acc, part) => acc * 60 + part, 0);
}

/**
 * SKILL.md tells the agent to scale every clip to 1080x1920 (9:16), but it
 * doesn't reliably do this (observed: some runs leave clips at their source
 * aspect ratio). Rather than keep tightening the prompt, enforce it
 * deterministically here - cheap for a clip this short, and guarantees the
 * format regardless of what the agent actually did.
 *
 * Returns the clip's actual duration in seconds (after any re-encode), or
 * null if ffprobe couldn't read it (missing file, corrupt, tools unavailable).
 */
async function ensureVertical(absPath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=s=x:p=0',
      absPath,
    ]);
    const [w, h] = stdout.trim().split('x').map(Number);
    if (w && h && w > h) {
      const tmpPath = `${absPath}.vertical.mp4`;
      await execFileAsync('ffmpeg', [
        '-y', '-i', absPath,
        '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black',
        '-c:v', 'libx264', '-c:a', 'aac',
        tmpPath,
      ]);
      fs.renameSync(tmpPath, absPath);
    }
  } catch (err) {
    // Best-effort: if ffprobe/ffmpeg aren't available or fail, serve the
    // original file rather than losing the clip entirely.
  }

  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      absPath,
    ]);
    const duration = Number(stdout.trim());
    return Number.isFinite(duration) ? duration : null;
  } catch (err) {
    return null;
  }
}
