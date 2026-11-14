// Bundles the renderer (src/renderer/js) into src/renderer/dist/app.js.
const esbuild = require('esbuild');
const path = require('path');
const watch = process.argv.includes('--watch');
const opts = {
  entryPoints: [path.join(__dirname, '../src/renderer/js/app.js')],
  outfile: path.join(__dirname, '../src/renderer/dist/app.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome130',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  legalComments: 'none',
  logLevel: 'info',
};
if (watch) esbuild.context(opts).then((c) => c.watch());
else esbuild.build(opts).catch(() => process.exit(1));
