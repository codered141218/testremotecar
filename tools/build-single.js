#!/usr/bin/env node
// Bundles index.html + css + js into one self-contained HTML file (no build tools needed).
//   node tools/build-single.js [out.html] [--hosted]
// --hosted marks the build as a sandboxed preview where only Simulation mode can work.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const out = process.argv.slice(2).find((a) => !a.startsWith('--')) || path.join(root, 'dist', 'remote.html');
const hosted = process.argv.includes('--hosted');

const html = read('index.html');
const css = read('css/style.css');
const strip = (src) => src.replace(/^import .*$/gm, '').replace(/^export (class|function|const)/gm, '$1');
let js = [strip(read('js/transport.js')), strip(read('js/tracker.js')), strip(read('js/app.js'))].join('\n\n');
if (hosted) {
  js = js.replace(
    "log('Ready. Pick a link type and press Connect. Simulation works without any hardware.');",
    "log('Hosted preview: only Simulation can connect here. For Wi-Fi, Bluetooth or USB links, run the app from GitHub Pages or a local server (see README).');"
  );
}

const title = /<title>(.*?)<\/title>/.exec(html)[1];
const body = /<body>([\s\S]*)<\/body>/.exec(html)[1]
  .replace(/\s*<script type="module" src="js\/app.js"><\/script>/, '');

const page = `<title>${title}</title>\n<style>\n${css}</style>\n${body.trim()}\n<script type="module">\n${js}\n</script>\n`;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, page);
console.log(`wrote ${out} (${(page.length / 1024).toFixed(1)} KB)`);
