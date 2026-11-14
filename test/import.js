// Dragging files into a sidebar folder (src/main/importer.js): what is copied, what is not.
const path = require('path'), fs = require('fs'), os = require('os');
const assert = require('assert');
const { importInto, imageLinks } = require('../src/main/importer.js');

const step = (name) => console.log('  ✓', name);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'whimflow-import-'));
const w = (rel, s) => { const p = path.join(work, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); return p; };
const r = (rel) => fs.readFileSync(path.join(work, rel), 'utf8');
const has = (rel) => fs.existsSync(path.join(work, rel));

(async () => {
  try {
    assert.deepStrictEqual(imageLinks('![a](assets/a.png) ![b](<my pics/b.jpg> "t") ![w](https://x.com/c.png) ![d](data:image/png;base64,x) <img src="./c%20d.gif"> ![n](notes.md) ![abs](/etc/x.png)').sort(),
      ['./c d.gif', 'assets/a.png', 'my pics/b.jpg']);
    step('image links: relative ones only, decoded');

    const lib = path.join(work, 'lib'); fs.mkdirSync(lib);
    const doc = w('desk/旅行.md', '# 旅行\n\n![海](assets/海.png)\n![上一级](../outside.png)\n<img src="assets/山.jpg">');
    w('desk/assets/海.png', 'sea'); w('desk/assets/山.jpg', 'hill'); w('desk/assets/没用到.png', 'unused'); w('outside.png', 'x');
    let res = await importInto(lib, [doc]);
    assert.deepStrictEqual(res.added, [path.join(lib, '旅行.md')]);
    assert.strictEqual(res.images, 2);
    assert(has('lib/assets/海.png') && has('lib/assets/山.jpg'), 'the images it shows come along');
    assert(!has('lib/assets/没用到.png') && !has('outside.png'.replace(/^/, 'lib/')), 'not the others, nothing from above its folder');
    assert(has('desk/旅行.md'), 'copied, not moved');
    step('a document comes with the images it shows, at the same place beside it');

    w('desk/assets/海.png', 'another sea');
    res = await importInto(lib, [doc]);
    assert.deepStrictEqual(res.added, [path.join(lib, '旅行 2.md')], 'a taken name gets a number');
    assert.strictEqual(r('lib/assets/海.png'), 'sea', 'an image already there is never overwritten');
    assert.deepStrictEqual(res.skipped, ['assets/海.png']);
    step('nothing is overwritten: names get a number, images already there stay');

    w('proj/笔记/a.md', 'a'); w('proj/笔记/sub/b.md', 'b'); w('proj/笔记/sub/pic.webp', 'p'); w('proj/笔记/.DS_Store', 'x');
    w('proj/笔记/node_modules/x.md', 'x'); w('proj/笔记/build.sh', 'x'); w('proj/表格.xlsx', 'x');
    res = await importInto(lib, [path.join(work, 'proj/笔记'), path.join(work, 'proj/表格.xlsx'), path.join(work, 'nope.md')]);
    assert.deepStrictEqual(res.added, [path.join(lib, '笔记')]);
    assert(has('lib/笔记/a.md') && has('lib/笔记/sub/b.md') && has('lib/笔记/sub/pic.webp'), 'a folder: its documents and images');
    assert(!has('lib/笔记/.DS_Store') && !has('lib/笔记/node_modules') && !has('lib/笔记/build.sh'), 'nothing else');
    assert.deepStrictEqual(res.skipped, ['表格.xlsx', 'nope.md'], 'other kinds and missing paths are reported');
    res = await importInto(path.join(lib, '笔记', 'sub'), [path.join(lib, '笔记')]);
    assert.deepStrictEqual([res.added, res.skipped], [[], ['笔记']], 'a folder is not copied into itself');
    step('folders bring their documents and images; other files are left out');
    console.log('IMPORT OK');
  } catch (err) {
    console.error('IMPORT FAIL', err);
    process.exitCode = 1;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
})();
