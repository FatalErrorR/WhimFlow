// Runs before the shared app: on iPhone and iPad, window.api is answered by the app's
// own storage (platform/mobile-api.js) instead of Electron's main process.
import { createMobileApi } from '../platform/mobile-api.js';

export const hooks = {}; // filled in by ui.js: toast, confirm, the current folder, …
window.api = createMobileApi(hooks);
window.WHIMFLOW_MERMAID = 'vendor/mermaid.min.js';
