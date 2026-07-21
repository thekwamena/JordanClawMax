import React, { useCallback, useRef, useState } from 'react';
import '../styles/VideoUpload.css';

const ACCEPTED_TYPES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska'];
const MAX_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2GB

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/**
 * Drag-and-drop / click-to-browse video uploader. Reports the selected
 * File object up to the parent via onVideoSelected. Also renders upload
 * progress when the parent is actively uploading to OpenClaw.
 */
function VideoUpload({ video, onVideoSelected, onClear, uploadProgress, isUploading }) {
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  const validateAndEmit = useCallback(
    (file) => {
      if (!file) return;

      if (!ACCEPTED_TYPES.includes(file.type)) {
        setError('Unsupported file type. Please upload an MP4, MOV, WebM, or MKV video.');
        return;
      }

      if (file.size > MAX_SIZE_BYTES) {
        setError('File is too large. Max size is 2GB.');
        return;
      }

      setError(null);
      onVideoSelected(file);
    },
    [onVideoSelected]
  );

  const handleDrop = useCallback(
    (event) => {
      event.preventDefault();
      setIsDragging(false);
      const file = event.dataTransfer.files?.[0];
      validateAndEmit(file);
    },
    [validateAndEmit]
  );

  const handleDragOver = useCallback((event) => {
    event.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((event) => {
    event.preventDefault();
    setIsDragging(false);
  }, []);

  const handleInputChange = useCallback(
    (event) => {
      const file = event.target.files?.[0];
      validateAndEmit(file);
    },
    [validateAndEmit]
  );

  const handleBrowseClick = () => {
    inputRef.current?.click();
  };

  if (video) {
    return (
      <div className="video-upload video-upload--selected">
        <div className="video-upload__preview">
          <video
            className="video-upload__video"
            src={URL.createObjectURL(video)}
            controls
            muted
          />
        </div>
        <div className="video-upload__meta">
          <div className="video-upload__filename" title={video.name}>
            {video.name}
          </div>
          <div className="video-upload__filesize">{formatBytes(video.size)}</div>
        </div>

        {isUploading && (
          <div className="video-upload__progress">
            <div
              className="video-upload__progress-bar"
              style={{ width: `${uploadProgress ?? 0}%` }}
            />
            <span className="video-upload__progress-label">
              Uploading… {uploadProgress ?? 0}%
            </span>
          </div>
        )}

        {!isUploading && (
          <button type="button" className="video-upload__clear" onClick={onClear}>
            Choose a different video
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="video-upload">
      <div
        className={`video-upload__dropzone ${isDragging ? 'video-upload__dropzone--active' : ''}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={handleBrowseClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && handleBrowseClick()}
      >
        <input
          ref={inputRef}
          type="file"
          accept="video/mp4,video/quicktime,video/webm,video/x-matroska"
          className="video-upload__input"
          onChange={handleInputChange}
        />
        <div className="video-upload__icon">⬆</div>
        <p className="video-upload__title">Drop your video here</p>
        <p className="video-upload__subtitle">or click to browse (MP4, MOV, WebM, MKV — up to 2GB)</p>
      </div>

      {error && <div className="video-upload__error">{error}</div>}
    </div>
  );
}

export default VideoUpload;
