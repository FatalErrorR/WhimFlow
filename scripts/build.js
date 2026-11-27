// Bundles the renderer.
//   node scripts/build.js            desktop: src/renderer/js/app.js -> src/renderer/dist/app.js
//   node scripts/build.js mobile     iPhone / iPad: src/renderer/js/mobile/main.js -> mobile/www/
//                                    (page, styles, fonts, KaTeX and Mermaid included; then
//                                    `npx cap sync ios` in mobile/ copies it into the Xcode project)
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const watch = process.argv.includes('--watch');
const mobile = process.argv.includes('mobile');

const common = { bundle: true, format: 'iife', platform: 'browser', minify: !watch, sourcemap: watch ? 'inline' : false, legalComments: 'none', logLevel: 'info' };

if (!mobile) {
  // what the app shows from KaTeX and Mermaid, copied beside the page: only these files are packaged,
  // not the packages (Mermaid alone brings 150 MB of builds and dependencies)
  const vendor = path.join(root, 'src/renderer/vendor');
  fs.rmSync(vendor, { recursive: true, force: true });
  fs.mkdirSync(path.join(vendor, 'katex'), { recursive: true });
  fs.cpSync(path.join(root, 'node_modules/katex/dist/katex.min.css'), path.join(vendor, 'katex/katex.min.css'));
  fs.cpSync(path.join(root, 'node_modules/katex/dist/fonts'), path.join(vendor, 'katex/fonts'), { recursive: true });
  fs.writeFileSync(path.join(vendor, 'katex/VERSION'), require(path.join(root, 'node_modules/katex/package.json')).version);
  fs.cpSync(path.join(root, 'node_modules/mermaid/dist/mermaid.min.js'), path.join(vendor, 'mermaid.min.js'));
  const opts = { ...common, entryPoints: [path.join(root, 'src/renderer/js/app.js')], outfile: path.join(root, 'src/renderer/dist/app.js'), target: 'chrome130' };
  if (watch) esbuild.context(opts).then((c) => c.watch());
  else esbuild.build(opts).catch(() => process.exit(1));
} else {
  const www = path.join(root, 'mobile/www');
  const mods = path.join(root, 'mobile/node_modules');
  if (!fs.existsSync(path.join(mods, '@capacitor/core'))) {
    console.error('mobile/node_modules is missing: run `npm ci` in mobile/ first');
    process.exit(1);
  }
  fs.rmSync(www, { recursive: true, force: true });
  fs.mkdirSync(path.join(www, 'vendor'), { recursive: true });
  const copy = (from, to) => fs.cpSync(path.join(root, from), path.join(www, to), { recursive: true });
  // iOS 16.4 is the oldest system it runs on (the styles need color-mix, iOS 16.2+)
  esbuild.build({ ...common, entryPoints: [path.join(root, 'src/renderer/js/mobile/main.js')], outfile: path.join(www, 'app.js'), target: ['safari16.4'], nodePaths: [mods] })
    .then(() => {
      for (const css of ['content.css', 'app.css', 'editor.css', 'mobile.css']) copy('src/renderer/' + css, css);
      copy('src/renderer/fonts', 'fonts');
      copy('node_modules/katex/dist/katex.min.css', 'vendor/katex/katex.min.css');
      copy('node_modules/katex/dist/fonts', 'vendor/katex/fonts');
      copy('node_modules/mermaid/dist/mermaid.min.js', 'vendor/mermaid.min.js');
      let html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
      const swap = (a, b) => { if (!html.includes(a)) throw new Error('index.html changed: ' + a); html = html.replace(a, b); };
      swap('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">');
      swap("script-src 'self' file: 'unsafe-eval';", "script-src 'self' file: blob: 'unsafe-eval'; worker-src 'self' blob:;"); // search runs in a worker
      // the sync server: https anywhere; plain http only on this computer (as the app itself allows: tests)
      swap("script-src 'self' file: blob:", "connect-src 'self' file: data: blob: https: http://127.0.0.1:* http://localhost:*; script-src 'self' file: blob:");
      swap('<link rel="stylesheet" href="editor.css">', '<link rel="stylesheet" href="editor.css">\n<link rel="stylesheet" href="mobile.css">');
      swap('<script src="dist/app.js"></script>', '<script src="app.js"></script>');
      fs.writeFileSync(path.join(www, 'index.html'), html);
      console.log('mobile web app written to', path.relative(root, www));
    })
    .catch((err) => { console.error(err); process.exit(1); });
}
