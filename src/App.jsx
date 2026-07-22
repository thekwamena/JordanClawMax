import React, { useCallback, useState } from 'react';
import VideoUpload from './components/VideoUpload';
import ControlPanel from './components/ControlPanel';
import ClipGallery from './components/ClipGallery';
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

// view: 'upload' | 'processing' | 'results'
function App() {
  // Only the desktop build has a bridge server capable of answering
  // /api/setup/* - the browser/WSL dev setup assumes those tools are already
  // configured (see SETUP_INSTRUCTIONS.md), so it skips straight past this.
  const [setupReady, setSetupReady] = useState(!IS_DESKTOP);
  const [view, setView] = useState('upload');
  const [video, setVideo] = useState(null);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);

  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  const [jobProgress, setJobProgress] = useState(null);
  const [clips, setClips] = useState([]);
  const [isJobRunning, setIsJobRunning] = useState(false);
  const [error, setError] = useState(null);
  const [previewClip, setPreviewClip] = useState(null);

  const handleVideoSelected = useCallback((file) => {
    setVideo(file);
    setError(null);
  }, []);

  const handleClearVideo = useCallback(() => {
    setVideo(null);
    setUploadProgress(0);
  }, []);

  const resetToUpload = useCallback(() => {
    setView('upload');
    setVideo(null);
    setClips([]);
    setIsJobRunning(false);
    setError(null);
    setJobProgress(null);
    setUploadProgress(0);
    setIsUploading(false);
  }, []);

  const handleExtract = useCallback(async () => {
    if (!video) {
      setError('Please select a video first.');
      return;
    }

    setError(null);
    setView('processing');

    // Local flag rather than reading the `clips` state back inside this
    // same async run - state updates from setClips() below don't retroactively
    // change what this closure already captured.
    let gotPartialResults = false;

    try {
      setIsUploading(true);
      setUploadProgress(0);
      const asset = await uploadVideo(video, (percent) => setUploadProgress(percent));
      setIsUploading(false);

      setJobProgress({ message: 'Starting JordanClawMax…', percent: 0 });
      setIsJobRunning(true);
      const job = await invokeJordanClawMax(asset.assetId, settings);

      const finalStatus = await pollForResults(job.jobId, (status) => {
        setJobProgress({
          message: status.progress?.message || `Status: ${status.status}`,
          percent: status.progress?.percent ?? 0,
        });
        // Show clips as they're found instead of waiting for the whole job -
        // a multi-clip job can take a long time, and there's no reason to
        // hide clips that are already done.
        if (status.result?.clips?.length > 0) {
          gotPartialResults = true;
          setClips(status.result.clips);
          setView('results');
        }
      });

      setClips(finalStatus.result?.clips ?? []);
      setIsJobRunning(false);
      setView('results');
    } catch (err) {
      setIsUploading(false);
      setIsJobRunning(false);
      if (gotPartialResults) {
        // Don't wipe out clips the user can already see over a late error
        // (e.g. a timeout) - just note that extraction stopped early.
        setError(`Stopped early: ${err.message || 'ran out of time'}. Showing the clips found so far.`);
      } else {
        setError(err.message || 'Something went wrong while extracting clips.');
        setView('upload');
      }
    }
  }, [video, settings]);

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
    clips.forEach((clip) => handleDownload(clip));
  }, [clips, handleDownload]);

  if (!setupReady) {
    return <SetupWizard onReady={() => setSetupReady(true)} />;
  }

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
          {view !== 'upload' && (
            <button type="button" className="app__reset" onClick={resetToUpload}>
              Start over
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

      {error && (
        <div className="app__error" role="alert">
          {error}
        </div>
      )}

      <main className="app__main">
        {view === 'upload' && (
          <div className="app__layout">
            <section className="app__panel app__panel--upload">
              <VideoUpload
                video={video}
                onVideoSelected={handleVideoSelected}
                onClear={handleClearVideo}
                uploadProgress={uploadProgress}
                isUploading={isUploading}
              />
            </section>
            <section className="app__panel app__panel--controls">
              <ControlPanel
                settings={settings}
                onSettingsChange={setSettings}
                onSubmit={handleExtract}
                disabled={!video || isUploading}
                isProcessing={isUploading}
              />
            </section>
          </div>
        )}

        {view === 'processing' && (
          <section className="app__panel app__panel--processing">
            <ClipGallery
              clips={[]}
              isLoading
              progress={
                isUploading
                  ? { message: `Uploading video… ${uploadProgress}%`, percent: uploadProgress }
                  : jobProgress
              }
            />
          </section>
        )}

        {view === 'results' && (
          <section className="app__panel app__panel--results">
            <ClipGallery
              clips={clips}
              isLoading={false}
              stillProcessing={isJobRunning}
              processingMessage={jobProgress?.message}
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
