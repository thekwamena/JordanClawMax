import React from 'react';
import '../styles/SessionTabs.css';

/**
 * Horizontal list of extraction sessions (past and present) plus a "New"
 * button that's always clickable - starting a new extraction never has to
 * wait for an earlier one to finish, and switching tabs doesn't touch any
 * other session's in-flight upload/poll loop.
 */
function SessionTabs({ sessions, activeSessionId, onSelect, onNew, onClose }) {
  return (
    <div className="session-tabs">
      <div className="session-tabs__list">
        {sessions.map((session) => {
          const status = statusOf(session);
          return (
            <div
              key={session.id}
              className={`session-tabs__tab session-tabs__tab--${status}${
                session.id === activeSessionId ? ' session-tabs__tab--active' : ''
              }`}
            >
              <button type="button" className="session-tabs__tab-main" onClick={() => onSelect(session.id)}>
                <span className={`session-tabs__dot session-tabs__dot--${status}`} />
                <span className="session-tabs__label" title={session.label}>{session.label}</span>
                {session.view === 'results' && session.clips.length > 0 && (
                  <span className="session-tabs__count">{session.clips.length}</span>
                )}
              </button>
              {status !== 'running' && sessions.length > 1 && (
                <button
                  type="button"
                  className="session-tabs__close"
                  aria-label={`Close session ${session.label}`}
                  onClick={() => onClose(session.id)}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button type="button" className="session-tabs__new" onClick={onNew}>
        + New
      </button>
    </div>
  );
}

function statusOf(session) {
  if (session.isUploading || session.isJobRunning) return 'running';
  if (session.error && session.clips.length === 0) return 'failed';
  if (session.view === 'results') return 'done';
  return 'idle';
}

export default SessionTabs;
