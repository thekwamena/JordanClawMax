import React from 'react';
import IPhoneFrame from './iPhoneFrame';
import '../styles/ClipCard.css';

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return '--:--';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * A single extracted clip: vertical preview in an iPhone frame, title,
 * score/duration meta, and download/play actions.
 */
function ClipCard({ clip, onDownload, onPreview }) {
  const { title, thumbnailUrl, videoUrl, duration, score, tags = [] } = clip;

  return (
    <div className="clip-card">
      <IPhoneFrame label={clip.aspectRatio}>
        <button
          type="button"
          className="clip-card__preview-trigger"
          onClick={() => onPreview?.(clip)}
          aria-label={`Preview ${title}`}
        >
          {thumbnailUrl ? (
            <img className="clip-card__thumbnail" src={thumbnailUrl} alt={title} />
          ) : (
            <video className="clip-card__thumbnail" src={videoUrl} muted />
          )}
          <span className="clip-card__play-badge">▶</span>
        </button>
      </IPhoneFrame>

      <div className="clip-card__body">
        <h3 className="clip-card__title" title={title}>
          {title}
        </h3>

        <div className="clip-card__meta">
          <span className="clip-card__duration">{formatDuration(duration)}</span>
          {typeof score === 'number' && (
            <span className="clip-card__score">🔥 {Math.round(score * 100)}% match</span>
          )}
        </div>

        {tags.length > 0 && (
          <div className="clip-card__tags">
            {tags.map((tag) => (
              <span key={tag} className="clip-card__tag">
                #{tag}
              </span>
            ))}
          </div>
        )}

        <div className="clip-card__actions">
          <button type="button" className="clip-card__btn clip-card__btn--primary" onClick={() => onDownload?.(clip)}>
            Download
          </button>
          <button type="button" className="clip-card__btn" onClick={() => onPreview?.(clip)}>
            Preview
          </button>
        </div>
      </div>
    </div>
  );
}

export default ClipCard;
