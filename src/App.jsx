import React, { useCallback, useEffect, useRef, useState } from 'react';
import VideoUpload from './components/VideoUpload';
import ControlPanel from './components/ControlPanel';
import ClipGallery from './components/ClipGallery';
import SessionTabs from './components/SessionTabs';
import SetupWizard from './components/SetupWizard';
import {
  uploadVideo,
  invokeJordanClawMax,
  pollForResults,
} from './services/openclawService';
import './App.css';

const DEFAULT_SETTINGS = {
  numClips: 5,
  styles: ['funny'],
  maxLength: 30,
};

const IS_DESKTOP = !!window.jordanClawMaxDesktop?.isDesktop;

// Extraction jobs can run for a long time (see bridge-server/README.md), and
// closing/switching away from one used to lose track of it entirely - there
// was only ever one job's worth of state in this component. Sessions fix
// that: each extraction gets its own entry here, tracked and polled
// independently, and persisted (minus the raw File, which can't be
// serialized) so even a page reload can resume watching a still-running job.
const STORAGE_KEY = 'jordanclawmax.sessions.v1';

// view: 'upload' | 'processing' | 'results'
function createSession(overrides = {}) {
  return {
    id: crypto.randomUUID(),
    label: 'New session',
    view: 'upload',
    settings: DEFAULT_SETTINGS,
    isUploading: false,
    uploadProgress: 0,
    jobId: null,
    jobProgress: null,
    isJobRunning: false,
    clips: [],
    error: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

function loadPersistedSessions() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    // `video` (a File) can't survive serialization - a persisted session that
    // was still on the upload screen just loses the picked file, which is
    // fine; one that already has a jobId keeps everything needed to resume.
    return parsed.map((s) => ({ ...s, video: null }));
  } catch (err) {
    return null;
  }
}

function App() {
  // Only the desktop build has a bridge server capable of answering
  // /api/setup/* - the browser/WSL dev setup assumes those tools are already
  // configured (see SETUP_INSTRUCTIONS.md), so it skips straight past this.
  const [setupReady, setSetupReady] = useState(!IS_DESKTOP);
  const [sessions, setSessions] = useState(() => {
    const persisted = loadPersistedSessions();
    return persisted && persisted.length > 0 ? persisted : [createSession()];
  });
  const [activeSessionId, setActiveSessionId] = useState(() => sessions[0].id);
  const [previewClip, setPreviewClip] = useState(null);
  const resumedRef = useRef(false);

  const updateSession = useCallback((sessionId, updates) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === sessionId ? { ...s, ...(typeof updates === 'function' ? updates(s) : updates) } : s))
    );
  }, []);

  // Persist on every change, video (File) stripped since it can't be serialized.
  useEffect(() => {
    try {
      const serializable = sessions.map(({ video, ...rest }) => rest);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
    } catch (err) {
      // Storage full or unavailable - persistence is a nice-to-have, not required.
    }
  }, [sessions]);

  const runExtraction = useCallback(async (session) => {
    const { id: sessionId, video, settings } = session;

    updateSession(sessionId, { error: null, view: 'processing' });

    let gotPartialResults = false;

    try {
      updateSession(sessionId, { isUploading: true, uploadProgress: 0 });
      const asset = await uploadVideo(video, (percent) => updateSession(sessionId, { uploadProgress: percent }));
      updateSession(sessionId, { isUploading: false });

      const job = await invokeJordanClawMax(asset.assetId, settings);
      updateSession(sessionId, {
        jobId: job.jobId,
        isJobRunning: true,
        jobProgress: { message: 'Starting JordanClawMax…', percent: 0 },
      });

      const finalStatus = await pollForResults(job.jobId, (status) => {
        const jobProgress = {
          message: status.progress?.message || `Status: ${status.status}`,
          percent: status.progress?.percent ?? 0,
        };
        // Show clips as they're found instead of waiting for the whole job -
        // a multi-clip job can take a long time, and there's no reason to
        // hide clips that are already done.
        if (status.result?.clips?.length > 0) {
          gotPartialResults = true;
          updateSession(sessionId, { jobProgress, clips: status.result.clips, view: 'results' });
        } else {
          updateSession(sessionId, { jobProgress });
        }
      });

      updateSession(sessionId, {
        clips: finalStatus.result?.clips ?? [],
        isJobRunning: false,
        view: 'results',
      });
    } catch (err) {
      updateSession(sessionId, (s) => ({
        isUploading: false,
        isJobRunning: false,
        error: gotPartialResults
          ? `Stopped early: ${err.message || 'ran out of time'}. Showing the clips found so far.`
          : err.message || 'Something went wrong while extracting clips.',
        view: gotPartialResults ? 'results' : 'upload',
      }));
    }
  }, [updateSession]);

  // Resume watching any session that was still running when the page was
  // last closed/reloaded - it has a jobId, so this just re-attaches polling
  // rather than starting a new job.
  useEffect(() => {
    if (resumedRef.current) return;
    resumedRef.current = true;

    sessions.forEach((session) => {
      if (session.jobId && session.isJobRunning) {
        (async () => {
          let gotPartialResults = session.clips.length > 0;
          try {
            const finalStatus = await pollForResults(session.jobId, (status) => {
              const jobProgress = {
                message: status.progress?.message || `Status: ${status.status}`,
                percent: status.progress?.percent ?? 0,
              };
              if (status.result?.clips?.length > 0) {
                gotPartialResults = true;
                updateSession(session.id, { jobProgress, clips: status.result.clips, view: 'results' });
              } else {
                updateSession(session.id, { jobProgress });
              }
            });
            updateSession(session.id, {
              clips: finalStatus.result?.clips ?? [],
              isJobRunning: false,
              view: 'results',
            });
          } catch (err) {
            updateSession(session.id, {
              isJobRunning: false,
              error: gotPartialResults
                ? `Stopped early: ${err.message || 'ran out of time'}. Showing the clips found so far.`
                : err.message || 'Lost track of this job after reloading.',
              view: gotPartialResults ? 'results' : 'upload',
            });
          }
        })();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleNewSession = useCallback(() => {
    const session = createSession();
    setSessions((prev) => [...prev, session]);
    setActiveSessionId(session.id);
  }, []);

  const handleCloseSession = useCallback((sessionId) => {
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== sessionId);
      return next.length > 0 ? next : [createSession()];
    });
    setActiveSessionId((prevActive) => {
      if (prevActive !== sessionId) return prevActive;
      const remaining = sessions.filter((s) => s.id !== sessionId);
      return remaining.length > 0 ? remaining[remaining.length - 1].id : null;
    });
  }, [sessions]);

  const handleVideoSelected = useCallback((file) => {
    updateSession(activeSessionId, { video: file, label: file.name, error: null });
  }, [activeSessionId, updateSession]);

  const handleClearVideo = useCallback(() => {
    updateSession(activeSessionId, { video: null, uploadProgress: 0 });
  }, [activeSessionId, updateSession]);

  const handleSettingsChange = useCallback((settings) => {
    updateSession(activeSessionId, { settings });
  }, [activeSessionId, updateSession]);

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? sessions[0];

  const handleExtract = useCallback(() => {
    if (!activeSession?.video) {
      updateSession(activeSession.id, { error: 'Please select a video first.' });
      return;
    }
    runExtraction(activeSession);
  }, [activeSession, runExtraction, updateSession]);

  const resetActiveSession = useCallback(() => {
    updateSession(activeSessionId, {
      view: 'upload',
      video: null,
      clips: [],
      isJobRunning: false,
      error: null,
      jobProgress: null,
      jobId: null,
      uploadProgress: 0,
      isUploading: false,
    });
  }, [activeSessionId, updateSession]);

  const handleDownload = useCallback((clip) => {
    const link = document.createElement('a');
    link.href = clip.videoUrl;
    link.download = `${clip.title || 'clip'}.mp4`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, []);

  const handleDownloadAll = useCallback(() => {
    (activeSession?.clips ?? []).forEach((clip) => handleDownload(clip));
  }, [activeSession, handleDownload]);

  if (!setupReady) {
    return <SetupWizard onReady={() => setSetupReady(true)} />;
  }

  if (!activeSession) return null;

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__brand">
          <span className="app__logo">🐾</span>
          <div>
            <h1>JordanClawMax</h1>
            <p>Turn long-form video into share-ready clips, powered by OpenClaw.</p>
          </div>
        </div>
        <div className="app__header-actions">
          {activeSession.view !== 'upload' && (
            <button type="button" className="app__reset" onClick={resetActiveSession}>
              Reset this session
            </button>
          )}
          {IS_DESKTOP && (
            <button
              type="button"
              className="app__settings"
              title="Setup & local model status"
              onClick={() => setSetupReady(false)}
            >
              ⚙
            </button>
          )}
        </div>
      </header>

      <SessionTabs
        sessions={sessions}
        activeSessionId={activeSession.id}
        onSelect={setActiveSessionId}
        onNew={handleNewSession}
        onClose={handleCloseSession}
      />

      {activeSession.error && (
        <div className="app__error" role="alert">
          {activeSession.error}
        </div>
      )}

      <main className="app__main">
        {activeSession.view === 'upload' && (
          <div className="app__layout">
            <section className="app__panel app__panel--upload">
              <VideoUpload
                video={activeSession.video}
                onVideoSelected={handleVideoSelected}
                onClear={handleClearVideo}
                uploadProgress={activeSession.uploadProgress}
                isUploading={activeSession.isUploading}
              />
            </section>
            <section className="app__panel app__panel--controls">
              <ControlPanel
                settings={activeSession.settings}
                onSettingsChange={handleSettingsChange}
                onSubmit={handleExtract}
                disabled={!activeSession.video || activeSession.isUploading}
                isProcessing={activeSession.isUploading}
              />
            </section>
          </div>
        )}

        {activeSession.view === 'processing' && (
          <section className="app__panel app__panel--processing">
            <ClipGallery
              clips={[]}
              isLoading
              progress={
                activeSession.isUploading
                  ? { message: `Uploading video… ${activeSession.uploadProgress}%`, percent: activeSession.uploadProgress }
                  : activeSession.jobProgress
              }
            />
          </section>
        )}

        {activeSession.view === 'results' && (
          <section className="app__panel app__panel--results">
            <ClipGallery
              clips={activeSession.clips}
              isLoading={false}
              stillProcessing={activeSession.isJobRunning}
              processingMessage={activeSession.jobProgress?.message}
              onDownload={handleDownload}
              onDownloadAll={handleDownloadAll}
              onPreview={setPreviewClip}
            />
          </section>
        )}
      </main>

      {previewClip && (
        <div className="app__modal" onClick={() => setPreviewClip(null)}>
          <div className="app__modal-content" onClick={(e) => e.stopPropagation()}>
            <video src={previewClip.videoUrl} controls autoPlay />
            <button type="button" className="app__modal-close" onClick={() => setPreviewClip(null)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
