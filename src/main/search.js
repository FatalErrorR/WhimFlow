'use strict';
// Folder search off the main process. Each search runs in its own worker thread:
// a regular expression with catastrophic backtracking can hang a worker, never the
// app. A newer search from the same window cancels the older one, and a search
// that takes too long is stopped and reported as { code: 'timeout' }.
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

const DEFAULT_TIMEOUT = 8000;

// The worker is started from source text (eval) rather than a file path, so it also
// works when the app is packed into an asar archive.
let source = null;
function workerSource() {
  if (source) return source;
  const core = fs.readFileSync(path.join(__dirname, 'search-core.js'), 'utf8');
  source = `const module = { exports: {} };
(function (module, exports) {
${core}
})(module, module.exports);
const { parentPort, workerData } = require('worker_threads');
module.exports.search(workerData.folder, workerData.query, workerData.opts).then(
  (r) => parentPort.postMessage(r),
  (e) => parentPort.postMessage({ error: String((e && e.message) || e), code: 'failed', files: [], total: 0 }));
`;
  return source;
}

function createSearch({ timeout = () => DEFAULT_TIMEOUT } = {}) {
  const running = new Map(); // key (a window) -> { worker, finish }

  function cancel(key) {
    const job = running.get(key);
    if (job) job.finish({ canceled: true, files: [], total: 0 });
  }

  /** Search `folder`; resolves with results, { error, code } or { canceled: true }. */
  function run(key, folder, query, opts = {}) {
    cancel(key);
    if (!folder || !query) return Promise.resolve({ files: [], total: 0, capped: false });
    return new Promise((resolve) => {
      let done = false, timer = null;
      const worker = new Worker(workerSource(), { eval: true, workerData: { folder, query, opts } });
      const job = {
        worker,
        finish(result) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (running.get(key) === job) running.delete(key);
          worker.terminate().catch(() => {});
          resolve(result);
        },
      };
      running.set(key, job);
      timer = setTimeout(() => job.finish({ error: 'timeout', code: 'timeout', files: [], total: 0 }), timeout() || DEFAULT_TIMEOUT);
      worker.once('message', (r) => job.finish(r));
      worker.once('error', (e) => job.finish({ error: String((e && e.message) || e), code: 'failed', files: [], total: 0 }));
      worker.once('exit', () => job.finish({ error: 'search stopped', code: 'failed', files: [], total: 0 }));
    });
  }

  return { run, cancel };
}

module.exports = { createSearch, DEFAULT_TIMEOUT };
