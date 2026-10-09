// Bundles src/ + pdf.js into one self-contained, offline HTML page for the desktop app (app/index.html).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const pkg = 'node_modules/pdfjs-dist/';
const packBuf = (buf) => gzipSync(buf, { level: 9 }).toString('base64').replace(/(.{1000})/g, '$1\n');
// Local files can only start *classic* web workers, so turn pdf.js's module worker into a classic script.
function classicWorker(path) {
  let src = readFileSync(path, 'utf8');
  const exp = 'export{WorkerMessageHandler};';
  if (!src.trimEnd().endsWith(exp)) throw new Error('unexpected worker footer');
  src = src.trimEnd().slice(0, -exp.length);
  src = src.split('import.meta.url').join('self.location.href');
  if (/import\.meta|^\s*(import|export)\s/m.test(src)) throw new Error('worker still has module syntax');
  return Buffer.from(src);
}
const pack = (path) => gzipSync(readFileSync(path), { level: 9 }).toString('base64').replace(/(.{1000})/g, '$1\n');

let html = readFileSync('src/index.html', 'utf8');
const css = readFileSync('src/app.css', 'utf8');
const js = ['app.js', 'online.js', 'edition.js', 'notebooks.js', 'study.js'].map((f) => readFileSync('src/' + f, 'utf8')).join('\n') + '\ninit();\n';
if (/<\/script/i.test(js)) throw new Error('app.js must not contain a closing script tag');

const version = JSON.parse(readFileSync(pkg + 'package.json', 'utf8')).version;
const swap = (token, value) => { if (!html.includes(token)) throw new Error('missing ' + token); html = html.split(token).join(value); };
swap('/*__CSS__*/', css);
swap('/*__JS__*/', js);
swap('__LIB_PDF__', pack(pkg + 'legacy/build/pdf.min.mjs'));
swap('__LIB_WORKER__', packBuf(classicWorker(pkg + 'legacy/build/pdf.worker.min.mjs')));
swap('__LIB_OPENJPEG__', pack(pkg + 'wasm/openjpeg.wasm'));
swap('__LIB_JBIG2__', pack(pkg + 'wasm/jbig2.wasm'));
swap('__LIB_PDFLIB__', pack('node_modules/pdf-lib/dist/pdf-lib.min.js'));
swap('__PDFJS_VERSION__', version);

mkdirSync('app', { recursive: true });
writeFileSync('app/index.html', html);
console.log('app/index.html', (html.length / 1024).toFixed(0) + ' KB, pdf.js ' + version);
