import React from 'react';
import ClipCard from './ClipCard';
import '../styles/ClipGallery.css';

/**
 * Grid of extracted clips. Handles empty and loading states; delegates
 * per-clip rendering to ClipCard.
 */
function ClipGallery({
  clips,
  isLoading,
  progress,
  stillProcessing,
  processingMessage,
  onDownload,
  onPreview,
  onDownloadAll,
}) {
  if (isLoading) {
    return (
      <div className="clip-gallery clip-gallery--loading">
        <div className="clip-gallery__spinner" />
        <p className="clip-gallery__loading-text">
          {progress?.message || 'JordanClawMax is analyzing your video…'}
        </p>
        {typeof progress?.percent === 'number' && (
          <div className="clip-gallery__progress-track">
            <div
              className="clip-gallery__progress-fill"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
        )}
      </div>
    );
  }

  if (!clips || clips.length === 0) {
    return (
      <div className="clip-gallery clip-gallery--empty">
        <p>No clips yet. Upload a video and hit "Extract clips" to get started.</p>
      </div>
    );
  }

  return (
    <div className="clip-gallery">
      <div className="clip-gallery__header">
        <div>
          <h2>
            {clips.length} clip{clips.length === 1 ? '' : 's'} {stillProcessing ? 'so far' : 'ready'}
          </h2>
          {stillProcessing && (
            <p className="clip-gallery__still-processing">
              {processingMessage || 'Still looking for more clips…'}
            </p>
          )}
        </div>
        {onDownloadAll && (
          <button type="button" className="clip-gallery__download-all" onClick={onDownloadAll}>
            Download all
          </button>
        )}
      </div>
      <div className="clip-gallery__grid">
        {clips.map((clip) => (
          <ClipCard key={clip.id} clip={clip} onDownload={onDownload} onPreview={onPreview} />
        ))}
      </div>
    </div>
  );
}

export default ClipGallery;
