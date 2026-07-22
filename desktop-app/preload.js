const { contextBridge } = require('electron');

// The bridge server's port is passed via the page URL's query string (see
// main.js's loadFile call) rather than baked into the React build at compile
// time, so the desktop app isn't locked to whatever port happened to be free
// when it was built.
const params = new URLSearchParams(window.location.search);

contextBridge.exposeInMainWorld('jordanClawMaxDesktop', {
  bridgePort: params.get('bridgePort') || '8787',
  isDesktop: true,
});
