// Entry point of the iPhone / iPad app (bundled into mobile/www/app.js).
import { hooks } from './install.js';
import '../app.js';
import { initMobile } from './ui.js';

window.addEventListener('whimflow-ready', () => {
  window.__whimflowMobile = initMobile(window.__whimflow, hooks);
}, { once: true });
