import React from 'react';
import '../styles/ControlPanel.css';

const STYLES = [
  { value: 'funny', label: 'Funny' },
  { value: 'exciting', label: 'Exciting' },
  { value: 'trending', label: 'Trending' },
  { value: 'intense', label: 'Intense' },
];

/**
 * Settings form for a JordanClawMax extraction job. Controlled by the
 * `settings` object from the parent; changes are pushed up via
 * onSettingsChange(partialSettings). Submitting triggers onSubmit().
 *
 * These three fields (numClips, styles, maxLength) are exactly what the
 * JordanClawMax agent skill accepts - see bridge-server/README.md. Output is
 * always 9:16 (the skill hardcodes this), so there's no aspect ratio control.
 */
function ControlPanel({ settings, onSettingsChange, onSubmit, disabled, isProcessing }) {
  const update = (patch) => onSettingsChange({ ...settings, ...patch });

  const toggleStyle = (value) => {
    const has = settings.styles.includes(value);
    const next = has
      ? settings.styles.filter((s) => s !== value)
      : [...settings.styles, value];
    update({ styles: next.length > 0 ? next : [value] });
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    onSubmit();
  };

  return (
    <form className="control-panel" onSubmit={handleSubmit}>
      <h2 className="control-panel__heading">Extraction settings</h2>

      <div className="control-panel__field">
        <label htmlFor="numClips">
          Number of clips <span className="control-panel__value">{settings.numClips}</span>
        </label>
        <input
          id="numClips"
          type="range"
          min={1}
          max={25}
          step={1}
          value={settings.numClips}
          onChange={(e) => update({ numClips: Number(e.target.value) })}
          disabled={disabled}
        />
      </div>

      <div className="control-panel__field">
        <label htmlFor="maxLength">
          Max clip length <span className="control-panel__value">{settings.maxLength}s</span>
        </label>
        <input
          id="maxLength"
          type="range"
          min={15}
          max={60}
          step={5}
          value={settings.maxLength}
          onChange={(e) => update({ maxLength: Number(e.target.value) })}
          disabled={disabled}
        />
      </div>

      <div className="control-panel__field">
        <label>Styles</label>
        <div className="control-panel__keywords">
          {STYLES.map((style) => {
            const active = settings.styles.includes(style.value);
            return (
              <button
                type="button"
                key={style.value}
                className={`control-panel__keyword-chip${active ? ' control-panel__keyword-chip--active' : ''}`}
                onClick={() => toggleStyle(style.value)}
                disabled={disabled}
                aria-pressed={active}
              >
                {style.label}
              </button>
            );
          })}
        </div>
      </div>

      <button type="submit" className="control-panel__submit" disabled={disabled}>
        {isProcessing ? 'Extracting…' : 'Extract clips'}
      </button>
    </form>
  );
}

export default ControlPanel;
