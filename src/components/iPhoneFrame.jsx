import React from 'react';
import '../styles/iPhoneFrame.css';

/**
 * Decorative iPhone-style frame used to preview vertical (9:16) clips the
 * way they'll look on a phone screen. Anything passed as children is
 * rendered inside the "screen" area.
 */
function IPhoneFrame({ children, label }) {
  return (
    <div className="iphone-frame">
      <div className="iphone-frame__notch" />
      <div className="iphone-frame__screen">
        {children ? (
          children
        ) : (
          <div className="iphone-frame__placeholder">No preview</div>
        )}
      </div>
      <div className="iphone-frame__home-indicator" />
      {label && <div className="iphone-frame__label">{label}</div>}
    </div>
  );
}

export default IPhoneFrame;
