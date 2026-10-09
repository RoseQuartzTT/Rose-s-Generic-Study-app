'use strict';
/* Rose's generic study app — a book-style PDF reader for annotating set texts, with a lined notebook per book.
   In the desktop app everything is stored as files in the app's own folder (via window.native);
   opened as a plain web page it falls back to the browser's IndexedDB. */

/* ===================== helpers ===================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-5);
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = isMac ? '⌘' : 'Ctrl';
const SVGNS = 'http://www.w3.org/2000/svg';
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') { for (const [sk, sv2] of Object.entries(v)) { if (sk.startsWith('--')) e.style.setProperty(sk, sv2); else e.style[sk] = sv2; } }
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
}
function sv(tag, attrs = {}) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  return e;
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const escapeHTML = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function darken(h, f) { const [r, g, b] = hexToRgb(h); const d = (x) => Math.round(x * (1 - f)).toString(16).padStart(2, '0'); return '#' + d(r) + d(g) + d(b); }
function toRoman(n) { const m = [[1000,'m'],[900,'cm'],[500,'d'],[400,'cd'],[100,'c'],[90,'xc'],[50,'l'],[40,'xl'],[10,'x'],[9,'ix'],[5,'v'],[4,'iv'],[1,'i']]; let s = ''; for (const [v, r] of m) while (n >= v) { s += r; n -= v; } return s; }

let toastT;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, ms);
}
function toastAction(msg, label, fn, ms = 7000) {
  const t = $('#toast'); t.textContent = '';
  t.append(el('span', { text: msg }), el('button', { class: 'toast-btn', type: 'button', text: label, onclick: () => { t.hidden = true; fn(); } }));
  t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, ms);
}

/* ===================== storage ===================== */
const IS_APP = !!window.native;
const IdbDB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('marginalia', 4);
      r.onupgradeneeded = () => { const d = r.result; for (const s of ['books', 'files', 'annots', 'text', 'assets', 'notebooks', 'links', 'stacks']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' }); };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  run(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode); let out;
      const r = fn(t.objectStore(store)); if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  },
  get(s, id) { return this.run(s, 'readonly', (st) => st.get(id)); },
  all(s) { return this.run(s, 'readonly', (st) => st.getAll()); },
  put(s, v) { return this.run(s, 'readwrite', (st) => st.put(v)); },
  del(s, id) { return this.run(s, 'readwrite', (st) => st.delete(id)); },
};
// Desktop app: plain files on disk, so nothing depends on any browser's history or storage.
const NativeDB = {
  async open() {},
  async get(s, id) { const v = await window.native.get(s, id); if (v && s === 'files') return { id, blob: new Blob([v], { type: 'application/pdf' }) }; return v; },
  all(s) { return window.native.all(s); },
  async put(s, v) { if (s === 'files') return window.native.put(s, { id: v.id, data: new Uint8Array(await v.blob.arrayBuffer()) }); return window.native.put(s, v); },
  del(s, id) { return window.native.del(s, id); },
};
const DB = IS_APP ? NativeDB : IdbDB;
// Pasted images and snips live outside the notes so saving stays quick.
const Assets = {
  urls: new Map(),
  extOf(type) { return ((type || 'image/png').split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg').replace(/[^a-z0-9]/g, '') || 'png'; },
  async put(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (IS_APP) return window.native.putAsset(bytes, this.extOf(blob.type));
    const id = uid() + '.' + this.extOf(blob.type); await IdbDB.put('assets', { id, blob }); return id;
  },
  async url(id) {
    if (IS_APP) return 'ra://asset/' + encodeURIComponent(id);
    if (this.urls.has(id)) return this.urls.get(id);
    const r = await IdbDB.get('assets', id); const u = r ? URL.createObjectURL(r.blob) : '';
    this.urls.set(id, u); return u;
  },
  async bytes(id) {
    if (IS_APP) return window.native.getAsset(id);
    const r = await IdbDB.get('assets', id); return r ? new Uint8Array(await r.blob.arrayBuffer()) : null;
  },
};
const LS = {
  get(k, d) { try { const v = localStorage.getItem('marginalia.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('marginalia.' + k, JSON.stringify(v)); } catch {} },
};

/* ===================== pdf.js (embedded) ===================== */
let pdfjs = null;
const embedded = {};
async function unpack(id) {
  const b64 = document.getElementById(id).textContent.replace(/\s+/g, '');
  const bin = atob(b64); const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const stream = new Blob([u]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function loadPdfjs() {
  const [lib, worker, oj, jb] = await Promise.all(['lib-pdf', 'lib-worker', 'lib-openjpeg', 'lib-jbig2'].map(unpack));
  pdfjs = await import(URL.createObjectURL(new Blob([lib], { type: 'text/javascript' })));
  const workerUrl = URL.createObjectURL(new Blob([worker], { type: 'text/javascript' }));
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  // file:// pages have an opaque origin, which makes pdf.js give up on a real worker; hand it one directly.
  try { pdfjs.GlobalWorkerOptions.workerPort = new Worker(workerUrl); } catch (e) { console.warn('worker', e); }
  embedded['openjpeg.wasm'] = oj; embedded['jbig2.wasm'] = jb;
  for (const id of ['lib-pdf', 'lib-worker', 'lib-openjpeg', 'lib-jbig2']) document.getElementById(id).textContent = '';
}
class EmbeddedData {
  constructor() {}
  async fetch({ kind, filename }) {
    if (kind === 'wasmUrl' && embedded[filename]) return embedded[filename].slice();
    throw new Error('Not bundled: ' + filename);
  }
}
function openPdf(data) {
  return pdfjs.getDocument({
    data, isEvalSupported: false, enableXfa: false, useSystemFonts: true,
    useWorkerFetch: false, BinaryDataFactory: EmbeddedData, wasmUrl: 'embedded/',
  }).promise;
}

/* ===================== constants ===================== */
const HL_COLORS = ['#ffd84d', '#9be07a', '#7cc6ff', '#ff9ccf', '#ffae5c', '#c3a2ff'];
const INK_COLORS = ['#1f3a8a', '#1c2421', '#a3282c', '#2c6a5a', '#6b3fa0'];
const DEFAULTS = {
  nbRule: 8, nbFont: 'serif', nbInk: '#1f3a8a', nbText: 0.56,
  pdfScale: 0.7, layout: 'outer', paper: 'white', numbering: 'labels', page1At: 1,
  noteSize: 11, noteFont: 'sans', noteInk: '#1f3a8a', noteStyle: 'tab', noteWidth: 0.16,
  hlMode: 'snap', hlColor: '#ffd84d', hlStyle: 'hl', hlOpacity: 0.45, hlWidth: 14,
  arrowColorMode: 'match', arrowColor: '#2c6a5a', arrowOpacity: 0.8, arrowWidth: 1.4, arrowCurve: '1',
  spread: '1', coverAlone: true, zoom: 1, animate: true,
};
const RELAYOUT = new Set(['pdfScale', 'layout', 'spread', 'coverAlone', 'nbRule']);
const SHORTCUTS = [
  ['Reading', [
    [['←', '→'], 'Turn the page'],
    [['Home', 'End'], 'First or last page'],
    [['G'], 'Go to a page'],
    [['[', ']'], 'Previous or next bookmark'],
    [[MOD, 'F'], 'Search the book'],
    [['P'], 'Contents, bookmarks and notes'],
    [['D'], 'Two pages or one'],
    [['Tab'], 'Switch between the book and its notebook'],
  ]],
  ['Notebook', [
    [['Click'], 'Anywhere on a line to start writing'],
    [[MOD, 'B'], 'Bold (also I for italic, U for underline)'],
    [[MOD, 'K'], 'Add a link to a website'],
    [['p32'], 'Type a page like p32 or p. 32 — it becomes a link to that page of the book'],
    [[MOD, 'V'], 'Paste an image or a snip'],
  ]],
  ['Annotating', [
    [['V'], 'Select and read'],
    [['T'], 'Text box — click to place'],
    [['H'], 'Highlighter'],
    [['F'], 'Snap to text ↔ freehand'],
    [['U'], 'Highlight ↔ underline'],
    [['1', '–', '6'], 'Highlighter colour'],
    [['A'], 'Arrow — drag from one thing to another'],
    [['N'], 'Note beside the selected highlight, joined by an arrow'],
    [['Shift'], 'Hold while drawing freehand for a straight line'],
    [['Double-click'], 'A margin: new text box. A word: select it'],
    [['S'], 'Snip part of a page to paste into the notebook (also PrtScn)'],
    [['B'], 'Bookmark this page'],
    [['Del'], 'Delete what’s selected'],
    [[MOD, 'Z'], 'Undo'],
    [[MOD, 'Y'], 'Redo'],
  ]],
  ['Layout', [
    [['−', '='], 'Smaller or larger PDF text'],
    [[MOD, '+'], `Zoom in (${MOD} − to zoom out, or ${MOD} + scroll)`],
    [['Z'], 'Zoom to an area — drag a box round it'],
    [[MOD, '0'], 'Back to normal size'],
    [['Space'], 'Hold and drag to move around when zoomed in'],
    [['Esc'], 'Finish typing, close, deselect'],
    [['?'], 'Show these shortcuts'],
  ]],
];

/* ===================== state ===================== */
const S = {
  books: [], book: null, pdf: null, ann: null, settings: null,
  spreads: [], si: 0, sheets: [], labels: null, outline: undefined,
  tool: 'select', sel: null, editing: null, freshNote: null, focusNote: null, pendingArrow: null,
  undo: [], redo: [], cache: new Map(), textCache: new Map(), tasks: new Set(), gen: 0, H: 0,
  index: null, indexing: null, search: { q: '', results: [], cur: -1 },
  drawerTab: 'notes', notesFilter: 'all',
  doc: 'book', bookAnn: null, nbAnn: null, stacks: null, pos: { book: 0, nb: 0 }, lastPoint: null, lastSnip: null,
};
const normalizeNb = (nb) => ({ pages: Math.max(2, nb?.pages || 2), notes: nb?.notes || [], hls: nb?.hls || [], arrows: nb?.arrows || [], bms: nb?.bms || [] });
// The current document's annotations: the book's, or its notebook's. Undo works on whichever is showing.
function setAnn(obj) { if (S.doc === 'nb') S.nbAnn = obj; else if (S.doc === 'ed') S.edAnn = obj; else S.bookAnn = obj; S.ann = obj; }
const annOf = (doc) => doc === 'nb' ? S.nbAnn : doc === 'ed' ? S.edAnn : S.bookAnn;
const numPages = (doc = S.doc) => doc === 'nb' ? S.nbAnn.pages : doc === 'ed' ? S.ed.starts.length : S.pdf.numPages;
// "The book" is either the PDF's own pages or, once set up, the pages of the reader's printed edition.
const bookDoc = () => (S.book?.edition?.enabled && S.ed ? 'ed' : 'book');
const emptyAnn = (id) => ({ id, notes: [], hls: [], arrows: [], bms: [], updatedAt: 0 });
function normalizeAnn(a, id) { const e = emptyAnn(id); return { ...e, ...(a || {}), id, notes: a?.notes || [], hls: a?.hls || [], arrows: a?.arrows || [], bms: a?.bms || [] }; }

/* ===================== library ===================== */
async function showLibrary(tab) {
  $('#reader').hidden = true; $('#stackView').hidden = true; $('#library').hidden = false; document.title = "Rose's generic study app";
  if (tab && tab !== libTab) setLibTab(tab); else await renderLibrary();
  updateStorageInfo();
}
let libSeq = 0;
async function renderLibrary() {
  const seq = ++libSeq;
  const books = (await DB.all('books')).filter((b) => !isPending('book:' + b.id)).sort((a, b) => (b.openedAt || b.addedAt) - (a.openedAt || a.addedAt));
  if (seq !== libSeq) return;
  S.books = books;
  const q = $('#libFilter').value.trim().toLowerCase();
  const root = $('#shelf'); root.textContent = '';
  if (libTab === 'notebooks') { await renderNotebookShelf(root, q); return; }
  if (libTab === 'links') { await renderLinks(root, q); return; }
  if (libTab === 'cards') { await renderStacks(root, q); return; }
  if (libTab === 'games') { await renderGames(root); return; }
  const shelf = el('div', { class: 'shelf-grid' }); root.append(shelf);
  const list = S.books.filter((b) => !q || b.title.toLowerCase().includes(q));
  if (!S.books.length) {
    shelf.append(el('div', { class: 'empty' },
      el('h2', { text: 'Your shelf is empty' }),
      el('p', { text: 'Add the PDFs for your modules. Each one opens like a book, with wide margins for your notes.' }),
      el('button', { class: 'btn primary', type: 'button', text: 'Add PDFs', onclick: () => $('#fileInput').click() }),
      el('p', { class: 'small', style: { marginTop: '14px', marginBottom: '0' }, text: 'You can also drag PDFs onto this window. Used the browser version before? In it, choose “Back up notes + PDFs”, then use “Restore from backup” here.' })));
    return;
  }
  if (!list.length) { shelf.append(el('div', { class: 'empty' }, el('p', { text: `No books match “${q}”.` }))); return; }
  for (const b of list) {
    const pct = b.pageCount ? Math.round(((b.lastPage || 0) + 1) / b.pageCount * 100) : 0;
    const c = b.counts || {};
    const bits = [];
    if (c.hls) bits.push(`${c.hls} highlight${c.hls === 1 ? '' : 's'}`);
    if (c.notes) bits.push(`${c.notes} note${c.notes === 1 ? '' : 's'}`);
    if (c.nb) bits.push('notebook');
    const card = el('div', { class: 'book', tabindex: 0, role: 'button', 'aria-label': `Open ${b.title}` },
      el('div', { class: 'bk-menu' },
        el('button', { type: 'button', text: 'Rename', onclick: (e) => { e.stopPropagation(); renameBook(b); } }),
        el('button', { type: 'button', text: 'Remove', onclick: (e) => { e.stopPropagation(); removeBookFlow(b); } })),
      el('div', { class: 'cover-wrap' }, b.cover ? el('img', { src: b.cover, alt: '' }) : el('div', { class: 'cover-blank', text: b.title })),
      el('div', { class: 'cap' },
        el('h3', { text: b.title, title: b.title }),
        el('div', { class: 'meta', text: `p. ${(b.lastPage || 0) + 1} of ${b.pageCount}` + (bits.length ? ' · ' + bits.join(', ') : '') }),
        el('div', { class: 'prog' }, el('i', { style: { width: pct + '%' } }))));
    card.addEventListener('click', () => openBook(b.id));
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openBook(b.id); } if (e.key === 'Delete') removeBookFlow(b); });
    shelf.append(card);
  }
}
function renderShortcuts(target, cols) {
  const wrap = el('div', { class: 'keys' });
  for (const [group, items] of SHORTCUTS) {
    wrap.append(el('h4', { text: group }));
    for (const [keys, desc] of items) {
      const k = el('span', { class: 'k' });
      keys.forEach((key) => k.append(key === '–' ? ' – ' : el('kbd', { text: key })));
      wrap.append(k, el('span', { text: desc }));
    }
  }
  target.textContent = ''; target.append(wrap);
}
async function updateStorageInfo() {
  if (IS_APP) {
    try { const i = await window.native.info(); $('#storageInfo').textContent = `Saved on this computer in ${i.dataDir}`; } catch {}
    return;
  }
  try {
    const est = await navigator.storage?.estimate?.();
    const persisted = await navigator.storage?.persisted?.();
    if (est) $('#storageInfo').textContent = `Using ${(est.usage / 1048576).toFixed(1)} MB of this browser’s storage.` + (persisted ? ' Storage is marked as permanent.' : '');
  } catch {}
}

async function importFiles(files) {
  files = [...files].filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (!files.length) { toast('Only PDF files can be added.'); return; }
  let added = 0;
  for (const f of files) {
    toast(`Adding “${f.name}”…`, 60000);
    let doc;
    try {
      const buf = await f.arrayBuffer();
      doc = await openPdf(buf.slice(0));
      const id = doc.fingerprints?.[0] || ('f' + f.size + '-' + f.name);
      if (await DB.get('books', id)) { toast(`“${f.name}” is already on your shelf.`); doc.destroy(); continue; }
      let title = '';
      try { const md = await doc.getMetadata(); title = (md.info?.Title || '').trim(); } catch {}
      if (!title || /^(untitled|microsoft word|document\d*$)/i.test(title) || title.length < 3) title = f.name.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').trim();
      const cover = await renderCover(doc);
      await DB.put('files', { id, blob: new Blob([buf], { type: 'application/pdf' }) });
      await DB.put('books', { id, title, fileName: f.name, pageCount: doc.numPages, lastPage: 0, addedAt: Date.now(), openedAt: 0, cover, settings: { ...DEFAULTS, ...LS.get('defaults', {}) }, counts: {} });
      const existing = await DB.get('annots', id);
      if (!existing) await DB.put('annots', emptyAnn(id));
      else { const a = normalizeAnn(existing, id); const b = await DB.get('books', id); b.counts = { notes: a.notes.length, hls: a.hls.length, bms: a.bms.length }; await DB.put('books', b); }
      added++;
    } catch (e) {
      console.error(e);
      toast(e?.name === 'PasswordException' ? `“${f.name}” is password-protected, so it can’t be opened.` : `Couldn’t open “${f.name}”. It may be damaged or not a real PDF.`, 5000);
    } finally { try { doc?.destroy(); } catch {} }
  }
  if (added) { toast(added === 1 ? 'Added to your shelf.' : `Added ${added} books to your shelf.`); try { await navigator.storage?.persist?.(); } catch {} }
  if (added && libTab !== 'books' && !$('#library').hidden) setLibTab('books'); else renderLibrary();
  updateStorageInfo();
}
async function renderCover(doc) {
  try {
    const page = await doc.getPage(1);
    const v1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 280 / v1.width });
    const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    return c.toDataURL('image/jpeg', 0.82);
  } catch { return null; }
}
async function renameBook(b) {
  const v = await ask({ title: 'Rename book', input: b.title, ok: 'Rename' });
  if (v == null || !v.trim()) return;
  b.title = v.trim(); await DB.put('books', b); renderLibrary();
}
const removeBook = (b) => removeBookFlow(b);

function ask({ title, body, input, ok = 'OK', cancel = 'Cancel', danger }) {
  return new Promise((res) => {
    const card = $('#dialogCard'); card.textContent = '';
    const inp = input != null ? el('input', { type: 'text', value: input }) : null;
    const close = (v) => { $('#dialog').hidden = true; document.removeEventListener('keydown', onKey, true); res(v); };
    const okBtn = el('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), type: 'button', text: ok, onclick: () => close(inp ? inp.value : true) });
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); okBtn.click(); } };
    card.append(...[el('h2', { text: title }), body ? el('p', { text: body }) : null, inp,
      el('div', { class: 'dlg-btns' }, cancel ? el('button', { class: 'btn', type: 'button', text: cancel, onclick: () => close(null) }) : null, okBtn)].filter(Boolean));
    $('#dialog').hidden = false; document.addEventListener('keydown', onKey, true);
    (inp || okBtn).focus(); inp?.select();
  });
}

/* ===================== backup ===================== */
function download(name, blob) {
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const blobToB64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
async function b64ToBlob(b64) {
  const bin = atob(b64); const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Blob([u], { type: 'application/pdf' });
}
async function backup(withPdfs) {
  if (S.book) await saveNow();
  const keep = (pre) => (x) => !isPending(pre + x.id);
  const books = (await DB.all('books')).filter(keep('book:')), notebooks = (await DB.all('notebooks')).filter(keep('nb:')), links = (await DB.all('links')).filter(keep('link:')), stacks = (await DB.all('stacks')).filter(keep('stack:'));
  if (!books.length && !notebooks.length && !links.length && !stacks.length) { toast('There’s nothing to back up yet.'); return; }
  toast('Preparing backup…', 60000);
  const parts = [`{"app":"marginalia","version":2,"kind":"${withPdfs ? 'full' : 'notes'}","exportedAt":${Date.now()},"books":[`];
  for (let i = 0; i < books.length; i++) {
    const b = books[i];
    const raw = await DB.get('annots', b.id);
    const entry = { meta: b, annots: { ...normalizeAnn(raw, b.id), nb: normalizeNb(raw?.nb) } };
    const imgs = [...entry.annots.notes, ...entry.annots.nb.notes].filter((n) => n.img).map((n) => n.img);
    if (imgs.length) {
      entry.assets = {};
      for (const id of new Set(imgs)) { const bytes = await Assets.bytes(id); if (bytes) entry.assets[id] = await blobToB64(new Blob([bytes])); }
    }
    if (withPdfs) { const f = await DB.get('files', b.id); if (f) entry.pdf = await blobToB64(f.blob); }
    parts.push((i ? ',' : '') + JSON.stringify(entry));
  }
  parts.push('],"notebooks":[');
  for (let i = 0; i < notebooks.length; i++) {
    const n = notebooks[i], entry = { meta: { ...n, content: normalizeNb(n.content) } };
    const imgs = entry.meta.content.notes.filter((x) => x.img).map((x) => x.img);
    if (imgs.length) { entry.assets = {}; for (const id of new Set(imgs)) { const bytes = await Assets.bytes(id); if (bytes) entry.assets[id] = await blobToB64(new Blob([bytes])); } }
    parts.push((i ? ',' : '') + JSON.stringify(entry));
  }
  parts.push('],"links":' + JSON.stringify(links) + ',"stacks":[');
  for (let i = 0; i < stacks.length; i++) {
    const s = stacks[i], entry = { meta: s };
    const imgs = [...JSON.stringify(s.cards || []).matchAll(/data-asset=\\?"([\w.-]+)/g)].map((m) => m[1]);
    if (imgs.length) { entry.assets = {}; for (const id of new Set(imgs)) { const bytes = await Assets.bytes(id); if (bytes) entry.assets[id] = await blobToB64(new Blob([bytes])); } }
    parts.push((i ? ',' : '') + JSON.stringify(entry));
  }
  parts.push(']}');
  const d = new Date().toISOString().slice(0, 10);
  download(`roses-study-app-${withPdfs ? 'full-' : ''}backup-${d}.json`, new Blob(parts, { type: 'application/json' }));
  toast('Backup downloaded. Keep it somewhere safe, like OneDrive or a USB stick.', 4000);
}
async function restore(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('That file isn’t a backup from this app.'); return; }
  if (data?.app !== 'marginalia' || !Array.isArray(data.books)) { toast('That file isn’t a backup from this app.'); return; }
  const nbs = Array.isArray(data.notebooks) ? data.notebooks : [];
  const lks = Array.isArray(data.links) ? data.links : [], sts = Array.isArray(data.stacks) ? data.stacks : [];
  const ok = await ask({ title: 'Restore this backup?', body: `It holds notes for ${data.books.length} book${data.books.length === 1 ? '' : 's'}${nbs.length ? ` and ${nbs.length} notebook${nbs.length === 1 ? '' : 's'}` : ''}. Anything already saved for those will be replaced with the versions in the backup.`, ok: 'Restore' });
  if (!ok) return;
  let restored = 0, waiting = 0;
  for (const e of data.books) {
    const id = e?.meta?.id; if (!id) continue;
    if (e.pdf) await DB.put('files', { id, blob: await b64ToBlob(e.pdf) });
    const ann = { ...normalizeAnn(e.annots, id), nb: normalizeNb(e.annots?.nb) };
    if (e.assets) {
      const map = {};
      for (const [old, b64] of Object.entries(e.assets)) { const blob = await b64ToBlob(b64); map[old] = await Assets.put(new Blob([blob], { type: 'image/' + (old.split('.').pop() || 'png').replace('jpg', 'jpeg') })); }
      for (const n of [...ann.notes, ...ann.nb.notes]) if (n.img && map[n.img]) n.img = map[n.img];
    }
    await DB.put('annots', ann);
    const hasFile = !!(await DB.get('files', id));
    if (hasFile) { const cur = await DB.get('books', id); await DB.put('books', { ...e.meta, ...(cur ? { lastPage: Math.max(cur.lastPage || 0, e.meta.lastPage || 0) } : {}) }); restored++; }
    else waiting++;
  }
  for (const e of nbs) {
    const n = e?.meta; if (!n?.id) continue;
    n.content = normalizeNb(n.content);
    if (e.assets) {
      const map = {};
      for (const [old, b64] of Object.entries(e.assets)) { const blob = await b64ToBlob(b64); map[old] = await Assets.put(new Blob([blob], { type: 'image/' + (old.split('.').pop() || 'png').replace('jpg', 'jpeg') })); }
      for (const x of n.content.notes) if (x.img && map[x.img]) x.img = map[x.img];
    }
    await DB.put('notebooks', n);
  }
  for (const l of lks) if (l?.id && l.url) await DB.put('links', l);
  for (const e of sts) {
    const s = e?.meta; if (!s?.id) continue;
    let json = JSON.stringify(s.cards || []);
    if (e.assets) for (const [old, b64] of Object.entries(e.assets)) { const blob = await b64ToBlob(b64); const nid = await Assets.put(new Blob([blob], { type: 'image/' + (old.split('.').pop() || 'png').replace('jpg', 'jpeg') })); json = json.split(old).join(nid); }
    await DB.put('stacks', { ...s, cards: JSON.parse(json) });
  }
  if (lks.length || sts.length) reportCardsAvailable();
  toast(`Restored ${restored} book${restored === 1 ? '' : 's'}${nbs.length ? ` and ${nbs.length} notebook${nbs.length === 1 ? '' : 's'}` : ''}.` + (waiting ? ` Notes for ${waiting} more book${waiting === 1 ? '' : 's'} will reappear when you add those PDFs again.` : ''), 6000);
  renderLibrary(); updateStorageInfo();
}

/* ===================== opening a book ===================== */
async function openBook(id) {
  const meta = await DB.get('books', id);
  const file = await DB.get('files', id);
  if (!meta || !file) { toast('This book’s PDF is missing. Add the PDF again and your notes will come back.'); return; }
  toast('Opening…', 30000);
  try {
    S.pdf = await openPdf(await file.blob.arrayBuffer());
  } catch (e) { console.error(e); toast('Couldn’t open this PDF.'); return; }
  S.book = meta; S.settings = { ...DEFAULTS, ...(meta.settings || {}) };
  const rec = await DB.get('annots', id);
  S.nbAnn = normalizeNb(rec?.nb);
  S.edAnn = normalizeAnn(rec?.ed, id); delete S.edAnn.nb;
  S.bookAnn = normalizeAnn(rec, id); delete S.bookAnn.nb; delete S.bookAnn.ed;
  S.flow = null; S.flowNorm = null; S.ed = null; S.edIndex = null; S.edPick = null;
  if (meta.edition?.enabled) {
    try { await ensureFlowFor(meta); S.ed = paginate(meta.edition); reattachEdAnnotations(); } catch (e) { console.error(e); meta.edition.enabled = false; }
  }
  S.doc = bookDoc(); S.ann = annOf(S.doc);
  S.stacks = { book: { undo: [], redo: [] }, nb: { undo: [], redo: [] }, ed: { undo: [], redo: [] } };
  S.pos = { book: 0, nb: 0, ed: 0 };
  S.labels = null; try { S.labels = await S.pdf.getPageLabels(); } catch {}
  S.outline = undefined; S.index = null; S.indexing = null; S.search = { q: '', results: [], cur: -1 };
  S.undo = S.stacks[S.doc].undo; S.redo = S.stacks[S.doc].redo; S.cache.clear(); S.textCache.clear(); S.sel = null; S.pendingArrow = null;
  meta.openedAt = Date.now(); DB.put('books', meta);
  $('#library').hidden = true; $('#reader').hidden = false; $('#toast').hidden = true;
  $('#bookTitle').textContent = meta.title; $('#bookTitle').title = meta.title; document.title = meta.title + " — Rose's generic study app";
  $('#searchInput').value = ''; $('#searchResults').textContent = ''; $('#searchCount').textContent = ''; $('#searchBox').hidden = true;
  closeDrawer(); syncControls(); setTool('select'); updateUndoBtns(); setSaved(''); updateDocUI();
  S.spreads = computeSpreads();
  syncEdUI();
  const startAt = S.doc === 'ed' && meta.lastEdPage != null ? clamp(meta.lastEdPage, 0, numPages() - 1) : S.doc === 'ed' ? edPageOf(S.flow.pdfPageStart[clamp(meta.lastPage || 0, 0, S.pdf.numPages - 1)] ?? 0) : clamp(meta.lastPage || 0, 0, S.pdf.numPages - 1);
  await showSpread(spreadOf(startAt), 0);
  $('#stage').focus({ preventScroll: true });
}
async function closeBook(stayInReader = false) {
  if (!S.book) return;
  const wasNotebook = isStandalone();
  commitEditing(); await saveNow();
  for (const t of S.tasks) try { t.cancel(); } catch {}
  try { await S.pdf.destroy(); } catch {}
  S.pdf = null; S.book = null; S.doc = 'book'; S.flow = null; S.flowNorm = null; S.ed = null; stopPick?.(); S.cache.clear(); S.textCache.clear(); S.sheets = []; $('#spread').textContent = '';
  hidePop(); closeMenus(); hideFmt();
  if (!stayInReader) showLibrary(wasNotebook ? 'notebooks' : undefined);
}

/* ===================== book ↔ notebook ===================== */
async function switchDoc(doc, pi) {
  if (!S.book || (doc === S.doc && pi == null)) return;
  if (isStandalone() && doc !== 'nb') return;
  commitEditing(); hidePop(); closeMenus();
  if (doc !== S.doc) {
    S.pos[S.doc] = visiblePages()[0] || 0;
    S.doc = doc; S.ann = annOf(doc);
    S.undo = S.stacks[doc].undo; S.redo = S.stacks[doc].redo;
    S.sel = null; S.pendingArrow = null;
    S.search = { q: '', results: [], cur: -1 }; $('#searchInput').value = ''; $('#searchResults').textContent = ''; $('#searchCount').textContent = '';
    if (doc === 'nb' && S.tool === 'note') setTool('select');
    updateDocUI(); updateUndoBtns();
    S.spreads = computeSpreads();
  }
  const target = clamp(pi ?? S.pos[doc] ?? 0, 0, numPages() - 1);
  await showSpread(spreadOf(target), 0);
  refreshDrawer();
}
function updateDocUI() {
  const nb = S.doc === 'nb';
  $('#reader').classList.toggle('doc-nb', nb);
  $$('.docsw button').forEach((b) => b.classList.toggle('on', (b.dataset.doc === 'nb') === nb));
  $('#reader').classList.toggle('doc-ed', S.doc === 'ed');
  $('#reader').classList.toggle('standalone', isStandalone());
  $('.docsw').hidden = isStandalone();
  $('#bookTitle').classList.toggle('renamable', isStandalone());
  $$('[data-only]').forEach((x) => { x.hidden = (x.dataset.only === 'nb') !== nb; });
  $('#addPagesBtn').hidden = !nb;
  $$('#drawer .tabs button[data-tab="contents"]').forEach((b) => { b.textContent = nb ? 'Pages' : 'Contents'; });
  $('#searchInput').placeholder = nb ? 'Search this notebook' : 'Search this book';
}
function addNotebookPages(n = 2) {
  change((a) => { a.pages += n; });
  S.spreads = computeSpreads();
}

/* ===================== layout & rendering ===================== */
function computeSpreads() {
  const n = numPages(), out = [];
  if (S.settings.spread !== '1') { for (let i = 0; i < n; i++) out.push([i]); return out; }
  let i = 0; if (S.settings.coverAlone && S.doc === 'book') { out.push([0]); i = 1; }
  for (; i < n; i += 2) out.push(i + 1 < n ? [i, i + 1] : [i]);
  return out;
}
const spreadOf = (pi) => Math.max(0, S.spreads.findIndex((s) => s.includes(pi)));
const visiblePages = () => S.spreads[S.si] || [];
const sheetOf = (pi) => S.sheets.find((s) => s.pi === pi);

window.pageNameFor = (pi, doc) => pageName(pi, doc);
function pageName(pi, doc = S.doc) {
  if (doc === 'nb') return String(pi + 1);
  if (doc === 'ed') return String((S.ed?.first ?? 1) + pi);
  const s = S.settings;
  if (s.numbering === 'offset' && s.page1At >= 1) { const n = pi + 1 - (s.page1At - 1); return n >= 1 ? String(n) : toRoman(pi + 1); }
  if (s.numbering === 'labels' && S.labels && S.labels[pi]) return S.labels[pi];
  return String(pi + 1);
}
function parsePage(str, doc = S.doc) {
  str = String(str).trim().toLowerCase().split(/\s*[–-]\s*/)[0];
  if (!str) return null;
  const n = numPages(doc);
  for (let i = 0; i < n; i++) if (pageName(i, doc).toLowerCase() === str) return i;
  const m = str.match(/^(?:pdf\s*)?(\d+)$/);
  if (m) return clamp(parseInt(m[1], 10) - 1, 0, n - 1);
  return null;
}
function contentOrigin(side) {
  switch (S.settings.layout) {
    case 'outer': return [side === 'left' ? 0.82 : 0.18, 0.42];
    case 'side': return [0.14, 0.42];
    case 'bottom': return [0.5, 0.14];
    default: return [0.5, 0.5];
  }
}

async function showSpread(si, dir = 0) {
  si = clamp(si, 0, S.spreads.length - 1);
  const gen = ++S.gen;
  for (const t of S.tasks) try { t.cancel(); } catch {}
  commitEditing(); hidePop();
  S.si = si;
  const pages = S.spreads[si];
  const doc = S.doc;
  const pgs = doc === 'nb' ? pages.map(() => A4_PAGE) : doc === 'ed' ? pages.map(() => edPageShape()) : await Promise.all(pages.map((pi) => S.pdf.getPage(pi + 1)));
  if (gen !== S.gen) return;
  const stage = $('#stage');
  const availW = stage.clientWidth - 48, availH = stage.clientHeight - 36;
  const aspects = pgs.map((p) => { const v = p.getViewport({ scale: 1 }); return v.width / v.height; });
  let sumA = aspects.reduce((a, b) => a + b, 0);
  if (S.settings.spread === '1') sumA = Math.max(sumA, aspects[0] * 2);
  const H = Math.max(200, Math.floor(Math.min(availH, availW / sumA) * S.settings.zoom));
  S.H = H; S.lastStage = stage.clientWidth + 'x' + stage.clientHeight;
  const spread = $('#spread');
  spread.className = 'spread paper-' + S.settings.paper;
  spread.style.transform = ''; S.zoomBase = S.settings.zoom;
  spread.textContent = '';
  S.sheets = [];
  pages.forEach((pi, k) => {
    const side = pages.length === 2 ? (k === 0 ? 'left' : 'right') : (S.settings.spread === '1' && doc === 'book' ? (pi === 0 ? 'right' : 'solo') : 'solo');
    const sh = buildSheet(pi, pgs[k], H, side === 'right' && pages.length === 1 ? 'solo' : side, side);
    S.sheets.push(sh); spread.append(sh.el);
  });
  if (dir && S.settings.animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    spread.animate([{ transform: `translateX(${dir * 28}px)`, opacity: 0.25 }, { transform: 'none', opacity: 1 }], { duration: 170, easing: 'ease-out' });
  }
  if (doc === 'ed') for (const sh of S.sheets) renderEdSheet(sh);
  applyZoomAnchor();
  updatePager();
  if ((doc === 'book' || (doc === 'nb' && isStandalone())) && S.book.lastPage !== pages[0]) { S.book.lastPage = pages[0]; scheduleSave(); }
  if (doc === 'ed' && S.book.lastEdPage !== pages[0]) { S.book.lastEdPage = pages[0]; scheduleSave(); }
  if (doc === 'ed') { const off = S.ed.starts[pages[0]], ps = S.flow.pdfPageStart; let lp = 0; while (lp + 1 < ps.length && ps[lp + 1] <= off) lp++; if (S.book.lastPage !== lp) { S.book.lastPage = lp; scheduleSave(); } }
  for (const sh of S.sheets) drawAnnots(sh);
  if (doc === 'ed') { for (const sh of S.sheets) paintMarks(sh); return; }
  if (doc === 'nb') return;
  await Promise.all(S.sheets.map((sh, k) => renderSheet(sh, pgs[k], gen)));
  if (gen !== S.gen) return;
  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 200));
  idle(() => { if (gen === S.gen) prefetch(si + 1, H); });
}

const A4_PAGE = { getViewport: () => ({ width: 595.28, height: 841.89 }) };
/* UK A4 "feint and margin" refill paper, in millimetres. */
function nbGeom(sh) {
  const k = sh.H / 297, r = S.settings.nbRule * k, y0 = 30 * k;
  return { k, r, y0, mx: 28 * k, right: 200 * k, n: Math.floor((289 * k - y0) / r) + 1 };
}
function drawRuling(sh, cls) {
  const g = nbGeom(sh), svgEl = sv('svg', { class: 'ruling', viewBox: `0 0 ${sh.W} ${sh.H}`, 'aria-hidden': 'true' });
  for (let i = 0; i < g.n; i++) { const y = Math.round(g.y0 + i * g.r) + 0.5; svgEl.append(sv('line', { x1: 0, x2: sh.W, y1: y, y2: y, class: 'rule' })); }
  svgEl.append(sv('line', { x1: g.mx, x2: g.mx, y1: 0, y2: sh.H, class: 'margin' }));
  const holeX = cls === 'left' ? sh.W - 12 * g.k : 12 * g.k;
  for (const mm of [28.5, 108.5, 188.5, 268.5]) svgEl.append(sv('circle', { cx: holeX, cy: mm * g.k, r: 3 * g.k, class: 'hole' }));
  sh.el.style.setProperty('--rule', g.r + 'px');
  sh.el.prepend(svgEl);
}
function buildSheet(pi, page, H, cls, logicalSide) {
  const v1 = page.getViewport({ scale: 1 });
  const W = Math.round(H * v1.width / v1.height);
  const nb = S.doc === 'nb';
  const s = nb ? 1 : S.settings.pdfScale;
  const cw = Math.round(W * s), ch = Math.round(H * s);
  const [ox, oy] = contentOrigin(logicalSide === 'solo' ? 'right' : logicalSide);
  const cx = nb ? 0 : Math.round((W - cw) * ox), cy = nb ? 0 : Math.round((H - ch) * oy);
  const root = el('div', { class: 'sheet ' + cls + (nb ? ' lined' : ''), 'data-page': pi, style: { width: W + 'px', height: H + 'px' } });
  root.style.setProperty('--u', (W / 600) + 'px');
  const content = el('div', { class: 'content', style: { left: cx + 'px', top: cy + 'px', width: cw + 'px', height: ch + 'px' } },
    nb ? null : el('div', { class: 'loading', text: 'Loading page…' }));
  const hlSvg = sv('svg', { class: 'hls', viewBox: `0 0 ${cw} ${ch}` });
  const marks = el('div', { class: 'marks' });
  content.append(hlSvg, marks);
  const ovSvg = sv('svg', { class: 'overlay-svg', viewBox: `0 0 ${W} ${H}` });
  const notes = el('div', { class: 'notes' });
  const capture = el('div', { class: 'capture' });
  const name = pageName(pi);
  const pnum = el('div', { class: 'pnum' }, name, S.doc === 'book' && name !== String(pi + 1) ? el('small', { text: 'PDF ' + (pi + 1) }) : null);
  const ribbon = el('div', { class: 'ribbon ghost', title: 'Bookmark this page (B)' });
  root.append(content, ovSvg, notes, capture, pnum, ribbon);
  const sh = { pi, el: root, W, H, cx, cy, cw, ch, content, hlSvg, marks, ovSvg, notes, capture, ribbon, page, textLayer: null, nb, ed: S.doc === 'ed' };
  if (nb) drawRuling(sh, cls);
  ribbon.addEventListener('click', (e) => { e.stopPropagation(); toggleBookmark(pi); });
  wireSheet(sh);
  return sh;
}

async function renderCanvas(pi, page, cw, track = true) {
  const v1 = page.getViewport({ scale: 1 });
  const ch = cw * v1.height / v1.width;
  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (cw * ch * dpr * dpr > 16e6) dpr = Math.sqrt(16e6 / (cw * ch)); // keep very zoomed pages within memory limits
  const key = `${pi}:${cw}:${dpr.toFixed(3)}`;
  if (S.cache.has(key)) { const c = S.cache.get(key); S.cache.delete(key); S.cache.set(key, c); return c; }
  const vp = page.getViewport({ scale: (cw / v1.width) * dpr });
  const c = document.createElement('canvas');
  c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
  const task = page.render({ canvasContext: c.getContext('2d', { alpha: false }), viewport: vp });
  if (track) S.tasks.add(task);
  try { await task.promise; } catch (e) { return null; } finally { S.tasks.delete(task); }
  S.cache.set(key, c);
  while (S.cache.size > 8) S.cache.delete(S.cache.keys().next().value);
  return c;
}
async function getTextContent(pi, page) {
  if (S.textCache.has(pi)) return S.textCache.get(pi);
  const tc = await page.getTextContent();
  S.textCache.set(pi, tc);
  while (S.textCache.size > 12) S.textCache.delete(S.textCache.keys().next().value);
  return tc;
}
async function renderSheet(sh, page, gen) {
  const canvas = await renderCanvas(sh.pi, page, sh.cw);
  if (gen !== S.gen || !canvas) return;
  sh.content.querySelector('.loading')?.remove();
  sh.content.prepend(canvas);
  try {
    const v1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: sh.cw / v1.width });
    const div = el('div', { class: 'textLayer' });
    sh.content.style.setProperty('--total-scale-factor', vp.scale);
    sh.content.style.setProperty('--scale-round-x', '1px');
    sh.content.style.setProperty('--scale-round-y', '1px');
    const tc = await getTextContent(sh.pi, page);
    if (gen !== S.gen) return;
    const tl = new pdfjs.TextLayer({ textContentSource: tc, container: div, viewport: vp });
    await tl.render();
    if (gen !== S.gen) return;
    div.append(el('div', { class: 'endOfContent' }));
    sh.content.append(div); sh.textLayer = div;
    paintMarks(sh);
  } catch (e) { console.warn('text layer', e); }
}
async function prefetch(si, H) {
  if (si >= S.spreads.length || S.doc !== 'book') return;
  for (const pi of S.spreads[si]) {
    const page = await S.pdf.getPage(pi + 1);
    if (S.H !== H) return;
    const v1 = page.getViewport({ scale: 1 });
    const W = Math.round(H * v1.width / v1.height);
    await renderCanvas(pi, page, Math.round(W * S.settings.pdfScale), false);
  }
}
function relayout(keepPage = true) {
  if (!S.book || (!S.pdf && !isStandalone())) return;
  const first = visiblePages()[0] || 0;
  S.spreads = computeSpreads();
  showSpread(keepPage ? spreadOf(first) : S.si, 0);
}
function go(delta) {
  if (S.doc === 'nb' && delta > 0 && S.si >= S.spreads.length - 1) {
    const last = numPages() - 1;
    if (!S.ann.notes.some((n) => n.page >= last - 1) && !S.ann.hls.some((h) => h.page >= last - 1)) { toast('This is the last page. Write something here first, or use “Add pages”.'); return; }
    addNotebookPages(2); toast('Added two new pages.');
  }
  const si = clamp(S.si + delta, 0, S.spreads.length - 1);
  if (si !== S.si) showSpread(si, delta > 0 ? 1 : -1);
}
function goToPage(pi) {
  const si = spreadOf(clamp(pi, 0, numPages() - 1));
  if (si !== S.si) return showSpread(si, si > S.si ? 1 : -1);
  return Promise.resolve();
}
function updatePager() {
  const pages = visiblePages();
  $('#pageInput').value = pages.map((p) => pageName(p)).join('–');
  const named = S.doc === 'book' && pages.some((p) => pageName(p) !== String(p + 1));
  $('#pageLabel').textContent = S.doc === 'nb' ? 'Notebook page' : 'Page';
  $('#pageTotal').textContent = named ? `· PDF ${pages.map((p) => p + 1).join('–')} of ${numPages()}` : S.doc === 'ed' ? `of ${pageName(numPages() - 1)} (your edition)` : `of ${numPages()}`;
  $('#prevBtn').disabled = S.si === 0; $('#nextBtn').disabled = S.si >= S.spreads.length - 1;
  const bm = pages.some((p) => S.ann.bms.some((b) => b.page === p));
  $('#bmBtn').classList.toggle('on', bm);
}

/* ===================== annotation geometry ===================== */
const edPageShape = () => { const t = trimOf(S.book.edition); return { getViewport: () => ({ width: t.w * 72, height: t.h * 72 }) }; };
// Is this highlight (or part of it) on this sheet? Edition highlights are tied to the text and can run over a page break.
const onSheet = (hl, sh) => hl.type === 'span' ? (S.ed && hl.end > edRange(sh.pi)[0] && hl.start < edRange(sh.pi)[1]) : hl.page === sh.pi;
function hlRectsSheet(sh, hl) {
  if (hl.type === 'span') return spanRects(sh, hl);
  if (hl.type === 'text') return hl.rects.map(([x, y, w, h]) => [sh.cx + x * sh.cw, sh.cy + y * sh.ch, w * sh.cw, h * sh.ch]);
  const pts = hl.points.map(([x, y]) => [sh.cx + x * sh.cw, sh.cy + y * sh.ch]);
  const r = (hl.width * sh.cw) / 2;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [[Math.min(...xs) - r, Math.min(...ys) - r, Math.max(...xs) - Math.min(...xs) + 2 * r, Math.max(...ys) - Math.min(...ys) + 2 * r]];
}
function unionRect(rs) {
  const x0 = Math.min(...rs.map((r) => r[0])), y0 = Math.min(...rs.map((r) => r[1]));
  const x1 = Math.max(...rs.map((r) => r[0] + r[2])), y1 = Math.max(...rs.map((r) => r[1] + r[3]));
  return [x0, y0, x1 - x0, y1 - y0];
}
function distToSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1]; const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0; t = clamp(t, 0, 1);
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function hitHighlight(sh, p) {
  const hls = S.ann.hls.filter((h) => onSheet(h, sh));
  for (let i = hls.length - 1; i >= 0; i--) {
    const hl = hls[i];
    if (hl.type === 'text' || hl.type === 'span') {
      for (const r of hlRectsSheet(sh, hl)) if (p[0] >= r[0] - 2 && p[0] <= r[0] + r[2] + 2 && p[1] >= r[1] - 2 && p[1] <= r[1] + r[3] + 2) return hl;
    } else {
      const pts = hl.points.map(([x, y]) => [sh.cx + x * sh.cw, sh.cy + y * sh.ch]);
      const tol = Math.max((hl.width * sh.cw) / 2, 4) + 2;
      if (pts.length === 1 && Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]) < tol) return hl;
      for (let k = 1; k < pts.length; k++) if (distToSeg(p, pts[k - 1], pts[k]) < tol) return hl;
    }
  }
  return null;
}
function endpointRects(sh, end) {
  if (end.ref) {
    const nEl = sh.notes.querySelector(`.note[data-id="${end.ref}"]`);
    if (nEl) return { rects: [[nEl.offsetLeft, nEl.offsetTop, nEl.offsetWidth, nEl.offsetHeight]], pad: 3 };
    const hl = S.ann.hls.find((h) => h.id === end.ref);
    if (hl) { const rects = hlRectsSheet(sh, hl); return rects.length ? { rects, pad: 1.5 } : null; }
    return null;
  }
  return { rects: [[end.x * sh.W, end.y * sh.H, 0, 0]], pad: 0 };
}
function nearestOn(info, p) {
  let best = null, bd = Infinity;
  for (const r of info.rects) {
    const q = [clamp(p[0], r[0] - info.pad, r[0] + r[2] + info.pad), clamp(p[1], r[1] - info.pad, r[1] + r[3] + info.pad)];
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d < bd) { bd = d; best = q; }
  }
  return best;
}
function arrowGeometry(sh, ar) {
  const A = endpointRects(sh, ar.from), B = endpointRects(sh, ar.to);
  if (!A || !B) return null;
  const ua = unionRect(A.rects), ub = unionRect(B.rects);
  let a = nearestOn(A, [ub[0] + ub[2] / 2, ub[1] + ub[3] / 2]);
  let b = nearestOn(B, a);
  a = nearestOn(A, b);
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
  if (len < 4) return null;
  let c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  if (S.settings.arrowCurve === '1') {
    let nx = -dy / len, ny = dx / len;
    if (Math.abs(dx) >= Math.abs(dy)) { if (ny > 0) { nx = -nx; ny = -ny; } }
    else { const outward = c[0] < sh.W / 2 ? -1 : 1; if (Math.sign(nx) !== outward) { nx = -nx; ny = -ny; } }
    const bend = Math.min(len * 0.2, 46 * sh.W / 600);
    c = [c[0] + nx * bend, c[1] + ny * bend];
  }
  const u = sh.W / 600, w = S.settings.arrowWidth * u;
  const L = 5 * u + w * 2.6;
  const tx = b[0] - c[0], ty = b[1] - c[1], tl = Math.hypot(tx, ty) || 1;
  const ux = tx / tl, uy = ty / tl;
  const base = [b[0] - ux * L, b[1] - uy * L];
  const head = `M${b[0]},${b[1]} L${base[0] + -uy * L * 0.48},${base[1] + ux * L * 0.48} L${base[0] - -uy * L * 0.48},${base[1] - ux * L * 0.48} Z`;
  const end = [b[0] - ux * L * 0.6, b[1] - uy * L * 0.6];
  const d = S.settings.arrowCurve === '1' ? `M${a[0]},${a[1]} Q${c[0]},${c[1]} ${end[0]},${end[1]}` : `M${a[0]},${a[1]} L${end[0]},${end[1]}`;
  return { d, head, w };
}
function arrowColor(ar) {
  const s = S.settings;
  if (s.arrowColorMode === 'fixed') return s.arrowColor;
  if (s.arrowColorMode === 'ink') return s.noteInk;
  for (const end of [ar.from, ar.to]) {
    const hl = end.ref && S.ann.hls.find((h) => h.id === end.ref);
    if (hl) return darken(hl.color, 0.35);
  }
  return s.noteInk;
}

/* ===================== drawing annotations ===================== */
function drawAnnots(sh) { drawHighlights(sh); drawNotes(sh); drawOverlay(sh); drawRibbon(sh); }
function redrawAll() { for (const sh of S.sheets) drawAnnots(sh); updatePager(); }

function drawHighlights(sh) {
  const g = sh.hlSvg; g.textContent = '';
  for (const hl of S.ann.hls) {
    if (!onSheet(hl, sh)) continue;
    if (hl.type === 'span') {
      const op = hl.opacity ?? S.settings.hlOpacity;
      for (const [x, y, w, h] of spanRects(sh, hl)) {
        const X = x - sh.cx, Y = y - sh.cy;
        if (hl.style === 'ul') { const t = Math.max(1.4, h * 0.1); g.append(sv('rect', { x: X, y: Y + h - t * 0.8, width: w, height: t, fill: darken(hl.color, 0.15), 'fill-opacity': Math.min(1, op + 0.45), rx: t / 2 })); }
        else g.append(sv('rect', { x: X - 1, y: Y, width: w + 2, height: h, fill: hl.color, 'fill-opacity': op, rx: 1.5 }));
      }
      continue;
    }
    const op = hl.opacity ?? S.settings.hlOpacity;
    if (hl.type === 'text') {
      for (const [x, y, w, h] of hl.rects) {
        const X = x * sh.cw, Y = y * sh.ch, Wd = w * sh.cw, Hh = h * sh.ch;
        if (hl.style === 'ul') {
          const t = Math.max(1.4, Hh * 0.12);
          g.append(sv('rect', { x: X, y: Y + Hh - t * 0.6, width: Wd, height: t, fill: darken(hl.color, 0.15), 'fill-opacity': Math.min(1, op + 0.45), rx: t / 2 }));
        } else {
          g.append(sv('rect', { x: X - 1, y: Y, width: Wd + 2, height: Hh, fill: hl.color, 'fill-opacity': op, rx: 1.5 }));
        }
      }
    } else {
      const pts = hl.points.map(([x, y]) => `${(x * sh.cw).toFixed(1)},${(y * sh.ch).toFixed(1)}`);
      if (pts.length === 1) pts.push(pts[0]);
      g.append(sv('path', { d: 'M' + pts.join(' L'), fill: 'none', stroke: hl.style === 'ul' ? darken(hl.color, 0.15) : hl.color, 'stroke-opacity': hl.style === 'ul' ? Math.min(1, op + 0.45) : op, 'stroke-width': hl.width * sh.cw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    }
  }
}
function drawOverlay(sh) {
  const g = sh.ovSvg; g.textContent = '';
  for (const ar of S.ann.arrows) {
    if (ar.page !== sh.pi) continue;
    const geo = arrowGeometry(sh, ar); if (!geo) continue;
    const col = arrowColor(ar);
    const grp = sv('g', { 'data-id': ar.id, opacity: S.settings.arrowOpacity });
    if (S.sel?.id === ar.id) grp.append(sv('path', { d: geo.d, fill: 'none', stroke: '#e0c071', 'stroke-width': geo.w + 6, 'stroke-linecap': 'round', opacity: 0.8 }));
    grp.append(sv('path', { d: geo.d, fill: 'none', stroke: col, 'stroke-width': geo.w, 'stroke-linecap': 'round' }));
    grp.append(sv('path', { d: geo.head, fill: col }));
    const hit = sv('path', { d: geo.d, fill: 'none', stroke: 'transparent', 'stroke-width': 12, class: 'hit', 'data-id': ar.id });
    hit.addEventListener('pointerdown', (e) => { if (S.tool !== 'select') return; e.stopPropagation(); e.preventDefault(); select({ type: 'arrow', id: ar.id }); });
    grp.append(hit);
    g.append(grp);
  }
  const outline = (hlId, dash) => {
    const hl = S.ann.hls.find((h) => h.id === hlId); if (!hl || hl.page !== sh.pi) return;
    const [x, y, w, h] = unionRect(hlRectsSheet(sh, hl));
    g.append(sv('rect', { x: x - 3, y: y - 3, width: w + 6, height: h + 6, rx: 3, fill: 'none', stroke: '#2c6a5a', 'stroke-width': 1.5, 'stroke-dasharray': dash }));
  };
  if (S.sel?.type === 'hl') outline(S.sel.id, '4 3');
  if (S.pendingArrow?.page === sh.pi && S.pendingArrow.end.ref) outline(S.pendingArrow.end.ref, '2 2');
  $$('.note.pending', sh.notes).forEach((n) => n.classList.remove('pending'));
  if (S.pendingArrow?.page === sh.pi && S.pendingArrow.end.ref) sh.notes.querySelector(`.note[data-id="${S.pendingArrow.end.ref}"]`)?.classList.add('pending');
}
function drawRibbon(sh) {
  const on = S.ann.bms.some((b) => b.page === sh.pi);
  sh.ribbon.classList.toggle('ghost', !on);
  sh.ribbon.title = on ? 'Remove bookmark (B)' : 'Bookmark this page (B)';
}

function cleanHTML(html) {
  const t = document.createElement('template'); t.innerHTML = html || '';
  const OK = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'BR', 'DIV', 'P', 'SPAN', 'A']);
  const STYLES = ['background-color', 'font-weight', 'font-style', 'text-decoration-line'];
  const walk = (node) => {
    for (const c of [...node.childNodes]) {
      if (c.nodeType === 3) continue;
      if (c.nodeType !== 1) { c.remove(); continue; }
      walk(c);
      if (!OK.has(c.tagName)) { c.replaceWith(...c.childNodes); continue; }
      const keep = {};
      if (c.tagName === 'A') {
        const href = c.getAttribute('href'), pg = c.getAttribute('data-page'), pi = c.getAttribute('data-pi');
        if (href && /^(https?:|mailto:)/i.test(href)) keep.href = href;
        if (pg && /^\d{1,4}$/.test(pg)) { keep['data-page'] = pg; keep.class = 'pref'; }
        if (pi && /^\d{1,5}$/.test(pi)) { keep['data-pi'] = pi; keep.class = 'pref'; }
        if (!keep.href && !keep.class) { c.replaceWith(...c.childNodes); continue; }
      }
      if (c.tagName === 'SPAN') {
        const st = STYLES.map((k) => [k, c.style.getPropertyValue(k)]).filter(([, v]) => v && !/url\(|expression/i.test(v));
        if (st.length) keep.style = st.map(([k, v]) => `${k}: ${v}`).join('; ');
      }
      for (const a of [...c.attributes]) c.removeAttribute(a.name);
      for (const [k, v] of Object.entries(keep)) c.setAttribute(k, v);
      if (c.tagName === 'SPAN' && !c.attributes.length) c.replaceWith(...c.childNodes);
    }
  };
  walk(t.content);
  return t.innerHTML;
}
/* Turn typed web addresses and page references ("p32", "p. 32", "pp. 32–34", "page 32") into links. */
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+[^\s<>"'.,;:!?)\]]/gi;
const PREF_RE = /\b(?:pp?|pg|page)\.?\s?(\d{1,4})(?:\s?[–-]\s?\d{1,4})?\b/gi;
function linkify(root) {
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let n = tw.nextNode(); n; n = tw.nextNode()) if (!n.parentElement.closest('a')) nodes.push(n);
  let changed = false;
  for (const t of nodes) {
    const str = t.data, found = [];
    for (const m of str.matchAll(URL_RE)) found.push({ i: m.index, len: m[0].length, url: m[0] });
    if (!isStandalone()) for (const m of str.matchAll(PREF_RE)) if (!found.some((f) => m.index < f.i + f.len && m.index + m[0].length > f.i)) found.push({ i: m.index, len: m[0].length, page: m[1] });
    if (!found.length) continue;
    found.sort((a, b) => a.i - b.i);
    const frag = document.createDocumentFragment(); let last = 0;
    for (const f of found) {
      if (f.i < last) continue;
      frag.append(str.slice(last, f.i));
      const a = document.createElement('a'); a.textContent = str.substr(f.i, f.len);
      if (f.url) a.href = /^www\./i.test(f.url) ? 'https://' + f.url : f.url;
      else { a.className = 'pref'; a.dataset.page = f.page; }
      frag.append(a); last = f.i + f.len;
    }
    frag.append(str.slice(last)); t.replaceWith(frag); changed = true;
  }
  return changed;
}
async function followLink(a) {
  if (a.dataset.book && a.dataset.book !== S.book?.id) { await openBookAt(a.dataset.book, +a.dataset.pi, a.dataset.doc); return; }
  if (isStandalone() && (a.dataset.pi != null || a.dataset.page != null)) { toast('This notebook isn’t attached to a book, so page numbers here aren’t links.'); return; }
  if (a.dataset.pi != null || a.dataset.page != null) {
    const target = a.dataset.pi != null ? (a.dataset.doc === 'ed' && S.ed ? 'ed' : 'book') : bookDoc();
    const pi = a.dataset.pi != null ? +a.dataset.pi : parsePage(a.dataset.page, target);
    if (pi == null || pi < 0 || pi >= numPages(target)) { toast(`This book has no page ${a.dataset.page ?? ''}.`); return; }
    if (S.doc !== target) await switchDoc(target, pi); else await goToPage(pi);
    sheetOf(pi)?.el.animate([{ boxShadow: '0 0 0 6px rgba(220,142,160,.9)' }, { boxShadow: '0 0 0 0 rgba(220,142,160,0)' }], { duration: 1100, easing: 'ease-out' });
    return;
  }
  const href = a.getAttribute('href');
  if (href && /^(https?:|mailto:)/i.test(href)) { if (IS_APP) window.native.openExternal(href); else window.open(href, '_blank', 'noopener'); }
}
function htmlToText(html) {
  if (html == null) return '';
  const t = document.createElement('template');
  t.innerHTML = (html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p)>/gi, '\n');
  return t.content.textContent.replace(/\n{3,}/g, '\n\n').trim();
}

function drawNotes(sh) {
  const box = sh.notes, s = S.settings;
  box.style.setProperty('--fs', s.noteSize);
  box.style.setProperty('--ink', sh.nb ? s.nbInk : s.noteInk);
  box.style.setProperty('--nbtext', s.nbText);
  const keep = S.editing ? box.querySelector(`.note[data-id="${S.editing}"]`) : null;
  box.textContent = '';
  for (const n of S.ann.notes) {
    if (n.page !== sh.pi) continue;
    if (keep && n.id === S.editing) { applyNoteStyle(keep, n); box.append(keep); continue; }
    box.append(makeNote(sh, n));
  }
  if (S.focusNote) {
    const target = box.querySelector(`.note[data-id="${S.focusNote}"] .nbody`);
    if (target) { S.focusNote = null; requestAnimationFrame(() => { target.focus(); placeCaretEnd(target); }); }
  }
}
function applyNoteStyle(e, n) {
  const s = S.settings;
  e.className = (S.doc === 'nb' ? `note f-${s.nbFont}` : `note f-${s.noteFont} s-${s.noteStyle}`) + (n.img ? ' img-note' : '') + (S.sel?.id === n.id ? ' sel' : '');
  e.style.left = (n.x * 100) + '%'; e.style.top = (n.y * 100) + '%'; e.style.width = (n.w * 100) + '%';
  e.style.setProperty('--acc', n.color || s.hlColor);
}
function placeCaretEnd(node) {
  const r = document.createRange(); r.selectNodeContents(node); r.collapse(false);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
}
function makeNote(sh, n) {
  if (n.img) return makeImageNote(sh, n);
  const body = el('div', { class: 'nbody', contenteditable: 'true', spellcheck: 'true', html: cleanHTML(n.html) });
  linkify(body);
  const del = el('button', { type: 'button', title: 'Delete note', text: '×' });
  const grip = el('div', { class: 'grip', title: 'Drag to move' }, '⠿ move', del);
  const rsz = el('div', { class: 'rsz', title: 'Drag to change width' });
  const e = el('div', { 'data-id': n.id }, grip, body, rsz);
  applyNoteStyle(e, n);
  let before = null;
  body.addEventListener('focus', () => {
    if (S.editing === n.id && before) return; // focus came back after a dialog
    S.editing = n.id; before = JSON.stringify(S.ann); S.sel = { type: 'note', id: n.id };
    $$('.note.sel').forEach((x) => x !== e && x.classList.remove('sel')); e.classList.add('sel'); hidePop();
    for (const o of S.sheets) if (o !== sh) drawOverlay(o);
    showFmt(e);
  });
  body.addEventListener('input', () => { n.html = body.innerHTML; drawOverlay(sh); placeFmt(); scheduleSave(); });
  body.addEventListener('mousedown', (ev) => {
    const a = ev.target.closest('a'); if (!a) return;
    if (document.activeElement !== body || ev.ctrlKey || ev.metaKey) { ev.preventDefault(); ev.stopPropagation(); followLink(a); }
  });
  body.addEventListener('mouseover', (ev) => { const a = ev.target.closest('a'); if (a && !a.title) a.title = (a.classList.contains('pref') ? 'Go to this page of the book' : a.href) + (document.activeElement === body ? ` — ${MOD}+click while typing` : ''); });
  body.addEventListener('blur', () => {
    if (S.suspendBlur) return;
    hideFmt();
    if (S.editing === n.id) S.editing = null;
    linkify(body);
    n.html = cleanHTML(body.innerHTML);
    const empty = !htmlToText(n.html);
    if (empty) {
      if (S.freshNote === n.id) {
        // A brand-new box left empty: remove it, and drop its creation step from undo if nothing came after.
        removeItems([n.id]);
        if (S.undo.length === S.freshUndoLen) S.undo.pop();
      } else { const snap = before; removeItems([n.id]); if (snap) pushUndo(snap); }
      S.freshNote = null; S.sel = null; afterChange(false);
      return;
    }
    if (before && JSON.stringify(S.ann) !== before && S.freshNote !== n.id) pushUndo(before);
    S.freshNote = null; before = null; scheduleSave(); refreshDrawer();
  });
  body.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); body.blur(); $('#stage').focus({ preventScroll: true }); }
    if (ev.key === 'Tab') { ev.preventDefault(); document.execCommand('insertText', false, '\t'); }
  });
  del.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  del.addEventListener('click', (ev) => { ev.stopPropagation(); change(() => removeItems([n.id])); S.sel = null; redrawAll(); });
  noteDragging(sh, n, e, [grip], rsz, del, body);
  return e;
}
function noteDragging(sh, n, e, handles, rsz, del, body) {
  const drag = (handle, onMove, onEnd) => handle.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || ev.target === del || S.tool === 'arrow') return;
    ev.preventDefault(); ev.stopPropagation();
    if (body && document.activeElement === body) body.blur();
    select({ type: 'note', id: n.id });
    const start = [ev.clientX, ev.clientY], orig = { x: n.x, y: n.y, w: n.w };
    const snap = JSON.stringify(S.ann); let moved = false;
    handle.setPointerCapture(ev.pointerId);
    const mv = (m) => {
      const dx = (m.clientX - start[0]) / sh.W, dy = (m.clientY - start[1]) / sh.H;
      if (!moved && Math.hypot(m.clientX - start[0], m.clientY - start[1]) < 2) return;
      moved = true; onMove(dx, dy, orig); applyNoteStyle(e, n); drawOverlay(sh);
    };
    const up = () => {
      handle.removeEventListener('pointermove', mv); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up);
      if (moved) { onEnd?.(); applyNoteStyle(e, n); drawOverlay(sh); pushUndo(snap); scheduleSave(); }
    };
    handle.addEventListener('pointermove', mv); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
  });
  const snapLine = () => { if (sh.nb && !n.img) n.y = nbLineTop(sh, n.y * sh.H + nbGeom(sh).r * 0.4) / sh.H; };
  for (const h of handles) drag(h, (dx, dy, o) => { n.x = clamp(o.x + dx, -0.02, 0.98 - Math.min(n.w, 0.2)); n.y = clamp(o.y + dy, 0, 0.98); }, snapLine);
  drag(rsz, (dx, dy, o) => { n.w = clamp(o.w + dx, 0.05, 0.95); });
}
function makeImageNote(sh, n) {
  const img = el('img', { alt: 'Pasted image', draggable: 'false' });
  Assets.url(n.img).then((u) => { img.src = u; });
  img.addEventListener('load', () => drawOverlay(sh));
  const del = el('button', { type: 'button', title: 'Delete image', text: '×' });
  const grip = el('div', { class: 'grip', title: 'Drag to move' }, '⠿ move', del);
  const rsz = el('div', { class: 'rsz', title: 'Drag to resize' });
  const srcDoc = n.srcDoc === 'ed' && S.ed ? 'ed' : 'book';
  const otherBook = n.srcBook && n.srcBook !== S.book.id;
  const cap = n.srcPage == null ? null
    : otherBook ? el('a', { class: 'pref src', 'data-pi': n.srcPage, 'data-doc': n.srcDoc || 'book', 'data-book': n.srcBook, text: `from ${n.srcTitle || 'a book'}, p. ${n.srcLabel ?? n.srcPage + 1}`, title: 'Open that book at this page' })
    : (n.srcDoc !== 'ed' || S.ed) ? el('a', { class: 'pref src', 'data-pi': n.srcPage, 'data-doc': srcDoc, text: `from p. ${pageName(n.srcPage, srcDoc)}`, title: 'Go to this page of the book' }) : null;
  cap?.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  cap?.addEventListener('click', (ev) => { ev.stopPropagation(); followLink(cap); });
  const e = el('div', { 'data-id': n.id }, grip, el('div', { class: 'nimg' }, img, cap), rsz);
  applyNoteStyle(e, n);
  del.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  del.addEventListener('click', (ev) => { ev.stopPropagation(); change(() => removeItems([n.id])); S.sel = null; redrawAll(); });
  noteDragging(sh, n, e, [grip, img], rsz, del, null);
  return e;
}

/* ===================== model changes, undo, save ===================== */
function pushUndo(snap) { S.undo.push(snap); if (S.undo.length > 200) S.undo.shift(); S.redo.length = 0; updateUndoBtns(); }
function change(fn) { const snap = JSON.stringify(S.ann); fn(S.ann); pushUndo(snap); afterChange(); }
function afterChange(redraw = true) { scheduleSave(); if (redraw) redrawAll(); else redrawAll(); refreshDrawer(); updateUndoBtns(); }
function removeItems(ids) {
  const set = new Set(ids);
  S.ann.notes = S.ann.notes.filter((n) => !set.has(n.id));
  S.ann.hls = S.ann.hls.filter((h) => !set.has(h.id));
  S.ann.arrows = S.ann.arrows.filter((a) => !set.has(a.id) && !set.has(a.from.ref) && !set.has(a.to.ref));
}
function commitEditing() { const a = document.activeElement; if (a?.classList?.contains('nbody')) a.blur(); }
function undo() { commitEditing(); if (!S.undo.length) { toast('Nothing to undo.'); return; } S.redo.push(JSON.stringify(S.ann)); setAnn(JSON.parse(S.undo.pop())); afterUndo(); }
function redo() { commitEditing(); if (!S.redo.length) { toast('Nothing to redo.'); return; } S.undo.push(JSON.stringify(S.ann)); setAnn(JSON.parse(S.redo.pop())); afterUndo(); }
function afterUndo() {
  S.sel = null; hidePop();
  if (S.doc === 'nb') { const si = S.si; S.spreads = computeSpreads(); if (si >= S.spreads.length) { showSpread(S.spreads.length - 1); } }
  afterChange();
}
function updateUndoBtns() { $('#undoBtn').disabled = !S.undo.length; $('#redoBtn').disabled = !S.redo.length; }

let saveTimer;
function setSaved(t) { $('#savedTag').textContent = t; }
function scheduleSave() { if (!S.book) return; setSaved('Saving…'); clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 450); }
async function saveNow() {
  clearTimeout(saveTimer);
  if (!S.book || !S.bookAnn) return;
  try {
    if (isStandalone()) { await saveNotebookNow(); setSaved('Saved'); return; }
    const b = S.bookAnn, nb = S.nbAnn;
    S.book.settings = S.settings;
    S.book.counts = { notes: b.notes.length, hls: b.hls.length, bms: b.bms.length, nb: nb.notes.length + nb.hls.length };
    await DB.put('annots', { ...b, id: S.book.id, nb, ed: S.edAnn, updatedAt: Date.now() });
    await DB.put('books', S.book);
    setSaved('Saved');
  } catch (e) { console.error(e); setSaved('Not saved!'); toast(IS_APP ? 'Couldn’t save — the disk may be full.' : 'Couldn’t save — your browser storage may be full.', 5000); }
}

/* ===================== selection & popover ===================== */
function select(sel) {
  S.sel = sel; hidePop();
  $$('.note.sel').forEach((x) => x.classList.toggle('sel', x.dataset.id === sel?.id));
  if (sel?.type === 'note') $(`.note[data-id="${sel.id}"]`)?.classList.add('sel');
  for (const sh of S.sheets) drawOverlay(sh);
  if (sel?.type === 'hl') showHlPop(sel.id);
  if (sel?.type === 'arrow') showArrowPop(sel.id);
}
function hidePop() { $('#pop').hidden = true; }
function placePop(clientRect) {
  const pop = $('#pop'); pop.hidden = false;
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let x = clientRect.left + clientRect.width / 2 - pw / 2, y = clientRect.top - ph - 10;
  if (y < 56) y = clientRect.bottom + 10;
  pop.style.left = clamp(x, 8, innerWidth - pw - 8) + 'px'; pop.style.top = clamp(y, 56, innerHeight - ph - 50) + 'px';
}
function swatchButtons(current, onPick) {
  return HL_COLORS.map((c, i) => el('button', { type: 'button', class: 'sw' + (c === current ? ' on' : ''), style: { background: c }, title: `Colour ${i + 1}`, onclick: () => onPick(c) }));
}
function showHlPop(id) {
  const hl = S.ann.hls.find((h) => h.id === id); const sh = hl && sheetOf(hl.page); if (!sh) return;
  const pop = $('#pop'); pop.textContent = '';
  pop.append(...swatchButtons(hl.color, (c) => { change(() => { hl.color = c; }); select({ type: 'hl', id }); }),
    el('span', { class: 'sep' }),
    el('button', { class: 'pbtn', type: 'button', text: hl.style === 'ul' ? 'Highlight' : 'Underline', onclick: () => { change(() => { hl.style = hl.style === 'ul' ? 'hl' : 'ul'; }); select({ type: 'hl', id }); } }),
    el('button', { class: 'pbtn', type: 'button', onclick: () => createLinkedNote(hl) }, 'Add note', el('kbd', { text: 'N' })),
    el('button', { class: 'pbtn del', type: 'button', text: 'Delete', onclick: () => { change(() => removeItems([id])); S.sel = null; hidePop(); redrawAll(); } }));
  const r = unionRect(hlRectsSheet(sh, hl)); const sr = sh.el.getBoundingClientRect();
  placePop({ left: sr.left + r[0], top: sr.top + r[1], width: r[2], height: r[3], bottom: sr.top + r[1] + r[3] });
}
function showArrowPop(id) {
  const ar = S.ann.arrows.find((a) => a.id === id); const sh = ar && sheetOf(ar.page); if (!sh) return;
  const g = sh.ovSvg.querySelector(`g[data-id="${id}"]`); if (!g) return;
  const pop = $('#pop'); pop.textContent = '';
  pop.append(el('button', { class: 'pbtn del', type: 'button', text: 'Delete arrow', onclick: () => { change(() => removeItems([id])); S.sel = null; hidePop(); } }));
  placePop(g.getBoundingClientRect());
}
function showSelectionPop() {
  const sel = getSelection(); if (!sel.rangeCount || sel.isCollapsed || !sel.toString().trim()) return;
  const r = sel.getRangeAt(0).getBoundingClientRect();
  const pop = $('#pop'); pop.textContent = '';
  pop.append(...swatchButtons(null, (c) => { highlightSelection(c, S.settings.hlStyle); }),
    el('span', { class: 'sep' }),
    el('button', { class: 'pbtn', type: 'button', text: 'Underline', onclick: () => highlightSelection(S.settings.hlColor, 'ul') }),
    el('button', { class: 'pbtn', type: 'button', text: 'Copy', onclick: async () => { try { await navigator.clipboard.writeText(getSelection().toString()); toast('Copied.'); } catch { document.execCommand('copy'); } hidePop(); } }));
  placePop(r);
}

/* ===================== creating annotations ===================== */
function sheetFromNode(node) {
  const e = node?.nodeType === 1 ? node : node?.parentElement;
  const root = e?.closest?.('.sheet'); return root ? S.sheets.find((s) => s.el === root) : null;
}
function highlightSelection(color, style) {
  const sel = getSelection(); if (!sel.rangeCount || sel.isCollapsed) return false;
  const range = sel.getRangeAt(0).cloneRange();
  snapToWords(range);
  const text = rangeText(range);
  if (!text) return false;
  const sh = sheetFromNode(range.startContainer); if (!sh || !sh.textLayer) return false;
  if (sh.ed) {
    const a = domToOffset(range.startContainer, range.startOffset), b = domToOffset(range.endContainer, range.endOffset);
    if (a == null || b == null || b <= a) return false;
    const hl = { id: uid(), page: edPageOf(a), type: 'span', start: a, end: b, color, style, text: S.flow.text.slice(a, b).replace(/\s+/g, ' '), created: Date.now() };
    sel.removeAllRanges(); hidePop();
    change((x) => x.hls.push(hl));
    select({ type: 'hl', id: hl.id });
    return true;
  }
  const cr = sh.content.getBoundingClientRect();
  let rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5 && r.height < cr.height * 0.12 && r.right > cr.left && r.left < cr.right && r.bottom > cr.top && r.top < cr.bottom);
  if (!rects.length) return false;
  rects.sort((a, b) => (a.top + a.height / 2) - (b.top + b.height / 2));
  const lines = [];
  for (const r of rects) {
    const cy = r.top + r.height / 2;
    const ln = lines.find((l) => Math.abs(l.cy - cy) < Math.min(l.h, r.height) * 0.5);
    if (ln) { ln.l = Math.min(ln.l, r.left); ln.r = Math.max(ln.r, r.right); ln.t = Math.min(ln.t, r.top); ln.b = Math.max(ln.b, r.bottom); }
    else lines.push({ cy, h: r.height, l: r.left, r: r.right, t: r.top, b: r.bottom });
  }
  const norm = lines.map((l) => [(l.l - cr.left) / cr.width, (l.t - cr.top) / cr.height, (l.r - l.l) / cr.width, (l.b - l.t) / cr.height]);
  const hl = { id: uid(), page: sh.pi, type: 'text', color, style, rects: norm, text, created: Date.now() };
  sel.removeAllRanges(); hidePop();
  change((a) => a.hls.push(hl));
  select({ type: 'hl', id: hl.id });
  return true;
}
function rangeText(range) {
  // range.toString() drops the line breaks pdf.js marks with <br>, gluing words together.
  const frag = range.cloneContents(); const pieces = [];
  const tw = document.createTreeWalker(frag, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) { if (n.nodeType === 3) pieces.push(n.data); else if (n.tagName === 'BR') pieces.push(null); }
  let out = '';
  for (const p of pieces) {
    if (p == null) { if (/[\p{L}]-$/u.test(out)) out = out.slice(0, -1); else out += ' '; continue; }
    out += p;
  }
  return out.replace(/\u00AD/g, '').replace(/\s+/g, ' ').trim();
}
function snapToWords(range) {
  const isW = (c) => /[\p{L}\p{N}'’]/u.test(c || '');
  const sc = range.startContainer, ec = range.endContainer;
  if (sc.nodeType === 3) { let o = range.startOffset; while (o > 0 && isW(sc.data[o - 1]) && isW(sc.data[o])) o--; range.setStart(sc, o); }
  if (ec.nodeType === 3) { let o = range.endOffset; while (o < ec.data.length && isW(ec.data[o]) && isW(ec.data[o - 1])) o++; range.setEnd(ec, o); }
}
function createNoteAt(sh, x, y, opts = {}) {
  const s = S.settings;
  const w = opts.w ?? s.noteWidth;
  const n = { id: uid(), page: sh.pi, x: clamp(Math.min(x / sh.W, 0.99 - w), 0.005, 0.95), y: clamp(y / sh.H, 0, 0.97), w, html: '', color: opts.color || s.hlColor, created: Date.now() };
  S.freshNote = n.id; S.focusNote = n.id;
  change((a) => { a.notes.push(n); if (opts.link) a.arrows.push({ id: uid(), page: sh.pi, from: { ref: opts.link }, to: { ref: n.id } }); });
  S.freshUndoLen = S.undo.length;
  return n;
}
/* Notebook: text sits on the ruled lines. A block's top is placed so its baselines land on the rules. */
function nbLineTop(sh, y) {
  const g = nbGeom(sh);
  const k = clamp(Math.ceil((y - g.y0) / g.r), 0, g.n - 1);
  return g.y0 + (k - 1) * g.r + g.r * 0.24;
}
function createNbBlock(sh, p, opts = {}) {
  const g = nbGeom(sh);
  let x = p[0] < g.mx && p[0] > g.mx - 6 * g.k ? g.mx + 2 * g.k : Math.max(3 * g.k, p[0]);
  const right = x < g.mx ? g.mx - 2 * g.k : g.right;
  const w = Math.max(right - x, 30 * g.k) / sh.W;
  return createNoteAt(sh, x, nbLineTop(sh, p[1]), { w, ...opts });
}
async function createLinkedNote(hl) {
  if (!sheetOf(hl.page)) await goToPage(hl.page);
  const sh = sheetOf(hl.page); if (!sh) return;
  hidePop();
  const [bx, by, bw] = unionRect(hlRectsSheet(sh, hl));
  if (sh.nb) { createNbBlock(sh, [bx, by + unionRect(hlRectsSheet(sh, hl))[3] + nbGeom(sh).r * 0.6], { link: hl.id, color: hl.color }); return; }
  const leftSpace = sh.cx, rightSpace = sh.W - (sh.cx + sh.cw);
  let side;
  if (S.settings.layout === 'outer' && sh.el.classList.contains('left')) side = 'left';
  else if (S.settings.layout === 'outer') side = 'right';
  else if (Math.abs(leftSpace - rightSpace) < sh.W * 0.03) side = (bx + bw / 2) < sh.cx + sh.cw / 2 ? 'left' : 'right';
  else side = leftSpace > rightSpace ? 'left' : 'right';
  const space = side === 'left' ? leftSpace : rightSpace;
  let w = S.settings.noteWidth * sh.W;
  if (space - 10 < w) w = Math.max(space - 10, sh.W * 0.1);
  const x = side === 'left' ? Math.max(4, (leftSpace - w) / 2) : sh.cx + sh.cw + Math.max(4, (rightSpace - w) / 2);
  let y = by - 4;
  const others = [...sh.notes.querySelectorAll('.note')].map((e) => [e.offsetLeft, e.offsetTop, e.offsetWidth, e.offsetHeight]);
  for (let tries = 0; tries < 30; tries++) {
    const hit = others.find(([ox, oy, ow, oh]) => ox < x + w && ox + ow > x && oy < y + 30 && oy + oh > y);
    if (!hit) break; y = hit[1] + hit[3] + 6;
  }
  createNoteAt(sh, x, y, { w: w / sh.W, link: hl.id, color: hl.color });
}
function toggleBookmark(pi) {
  const i = S.ann.bms.findIndex((b) => b.page === pi);
  change((a) => { if (i >= 0) a.bms.splice(i, 1); else a.bms.push({ page: pi, label: '', created: Date.now() }); });
  toast(i >= 0 ? `Bookmark removed from p. ${pageName(pi)}.` : `Bookmarked p. ${pageName(pi)}.`);
}
function jumpBookmark(dir) {
  const bms = [...S.ann.bms].sort((a, b) => a.page - b.page);
  if (!bms.length) { toast('No bookmarks yet — press B to bookmark a page.'); return; }
  const pages = visiblePages();
  const t = dir > 0 ? bms.find((b) => b.page > pages[pages.length - 1]) : [...bms].reverse().find((b) => b.page < pages[0]);
  if (!t) { toast(dir > 0 ? 'No more bookmarks after this page.' : 'No bookmarks before this page.'); return; }
  goToPage(t.page);
}

/* ===================== pointer wiring ===================== */
function sheetPoint(sh, e) { const r = sh.el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
function objectAt(sh, e, p) {
  const n = document.elementsFromPoint(e.clientX, e.clientY).find((x) => x.classList?.contains('note') && sh.el.contains(x));
  if (n) return { ref: n.dataset.id };
  const hl = hitHighlight(sh, p);
  return hl ? { ref: hl.id } : null;
}
function wireSheet(sh) {
  const cap = sh.capture;
  // capture layer: text boxes, arrows, freehand highlighter
  cap.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); hidePop(); closeMenus();
    const p = sheetPoint(sh, e);
    if (S.tool === 'note') {
      const n = document.elementsFromPoint(e.clientX, e.clientY).find((x) => x.classList?.contains('note') && sh.el.contains(x));
      if (n) { n.querySelector('.nbody')?.focus(); return; }
      if (sh.nb) createNbBlock(sh, p); else createNoteAt(sh, p[0], p[1] - 8);
      setTool('select');
      return;
    }
    if (S.tool === 'arrow') return arrowDrag(sh, e, p);
    if (S.tool === 'hl' && S.settings.hlMode === 'free') return freeDraw(sh, e, p, cap);
  });
  // select tool: click highlights, double-click margins for a note
  let down = null;
  sh.el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.note, .capture, .ribbon, .hit, .edfix')) return;
    if (S.edPick != null && sh.ed) { e.preventDefault(); pickAt(sh, e); return; }
    down = [e.clientX, e.clientY];
    S.lastPoint = { pi: sh.pi, doc: S.doc, p: sheetPoint(sh, e) };
    const hadSel = !!S.sel;
    if (S.sel && !S.editing) { S.sel = null; hidePop(); $$('.note.sel').forEach((x) => x.classList.remove('sel')); for (const o of S.sheets) drawOverlay(o); }
    down.hadSel = hadSel;
    const snapHl = S.tool === 'hl' && S.settings.hlMode === 'snap';
    // Snap mode on paper with no text (the notebook, or a scanned page) highlights freehand instead.
    if (snapHl && (sh.nb || (sh.textLayer && !sh.textLayer.querySelector('span')))) { freeDraw(sh, e, sheetPoint(sh, e), sh.el); return; }
    if (snapHl || (S.tool === 'select' && e.target.closest('.textLayer span'))) textDrag(sh, e);
  });
  sh.el.addEventListener('pointerup', (e) => {
    if (!down || e.target.closest('.note, .capture, .ribbon')) { down = null; return; }
    const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4; down = null;
    if (moved || (S.tool !== 'select' && S.tool !== 'hl')) return;
    const sel = getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return;
    const hl = hitHighlight(sh, sheetPoint(sh, e));
    if (hl) select({ type: 'hl', id: hl.id });
    else if (sh.nb && S.tool === 'select' && !e.target.closest('.hit')) createNbBlock(sh, sheetPoint(sh, e));
  });
  sh.el.addEventListener('dblclick', (e) => {
    if (sh.nb || e.target.closest('.note, .ribbon, .capture')) return;
    if (e.target.closest('.textLayer span') && (S.tool === 'select' || S.tool === 'hl')) {
      if (!selectWordAt(sh, e)) return;
      if (S.tool === 'hl') highlightSelection(S.settings.hlColor, S.settings.hlStyle); else showSelectionPop();
      return;
    }
    if (S.tool !== 'select') return;
    const p = sheetPoint(sh, e);
    getSelection().removeAllRanges();
    createNoteAt(sh, p[0], p[1] - 8);
  });
}
/* Text selection is driven by hand: native drag-selection is unreliable over pdf.js's
   absolutely-positioned text spans, and doing it ourselves lets a drag that starts in the
   margin or between lines snap to the nearest words. */
function caretAt(tl, x, y) {
  let node = null, off = 0;
  if (document.caretPositionFromPoint) { const c = document.caretPositionFromPoint(x, y); if (c) { node = c.offsetNode; off = c.offset; } }
  else if (document.caretRangeFromPoint) { const r = document.caretRangeFromPoint(x, y); if (r) { node = r.startContainer; off = r.startOffset; } }
  if (node && node.nodeType === 3 && tl.contains(node)) return { node, off };
  let best = null, bd = Infinity;
  for (const sp of tl.querySelectorAll('span')) {
    const t = sp.firstChild; if (!t || t.nodeType !== 3 || !t.data.trim()) continue;
    const r = sp.getBoundingClientRect(); if (r.width < 1) continue;
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    const d = dy * 3 + dx; if (d < bd) { bd = d; best = { t, r }; }
  }
  if (!best) return null;
  const cx = clamp(x, best.r.left + 0.5, best.r.right - 0.5), cy = (best.r.top + best.r.bottom) / 2;
  if (document.caretPositionFromPoint) { const c = document.caretPositionFromPoint(cx, cy); if (c && c.offsetNode === best.t) return { node: best.t, off: c.offset }; }
  else if (document.caretRangeFromPoint) { const r = document.caretRangeFromPoint(cx, cy); if (r && r.startContainer === best.t) return { node: best.t, off: r.startOffset }; }
  return { node: best.t, off: x <= best.r.left ? 0 : best.t.length };
}
function textDrag(sh, e) {
  const tl = sh.textLayer; if (!tl) return false;
  const start = caretAt(tl, e.clientX, e.clientY); if (!start) return false;
  e.preventDefault(); commitEditing(); hidePop();
  const sel = getSelection(); sel.setBaseAndExtent(start.node, start.off, start.node, start.off);
  const target = e.currentTarget; target.setPointerCapture(e.pointerId);
  const mv = (m) => { const f = caretAt(tl, m.clientX, m.clientY); if (f) sel.setBaseAndExtent(start.node, start.off, f.node, f.off); };
  const up = () => { target.removeEventListener('pointermove', mv); target.removeEventListener('pointerup', up); target.removeEventListener('pointercancel', up); };
  target.addEventListener('pointermove', mv); target.addEventListener('pointerup', up); target.addEventListener('pointercancel', up);
  return true;
}
function selectWordAt(sh, e) {
  const c = sh.textLayer && caretAt(sh.textLayer, e.clientX, e.clientY); if (!c) return false;
  const r = document.createRange(); r.setStart(c.node, c.off); r.setEnd(c.node, c.off); snapToWords(r);
  if (r.collapsed) return false;
  getSelection().removeAllRanges(); getSelection().addRange(r);
  return true;
}
function arrowDrag(sh, e, p) {
  const start = objectAt(sh, e, p);
  const cap = sh.capture; cap.setPointerCapture(e.pointerId);
  const tmp = sv('path', { fill: 'none', stroke: '#2c6a5a', 'stroke-width': 1.6, 'stroke-dasharray': '5 4' });
  sh.ovSvg.append(tmp);
  const startPt = () => { const info = start && endpointRects(sh, start); return info ? nearestOn(info, cur) : p; };
  let cur = p;
  const mv = (m) => { cur = sheetPoint(sh, m); const a = startPt(); tmp.setAttribute('d', `M${a[0]},${a[1]} L${cur[0]},${cur[1]}`); };
  const up = (u) => {
    cap.removeEventListener('pointermove', mv); cap.removeEventListener('pointerup', up); tmp.remove();
    const q = sheetPoint(sh, u);
    const moved = Math.hypot(q[0] - p[0], q[1] - p[1]) > 6;
    const asEnd = (obj, pt) => obj || { x: clamp(pt[0] / sh.W, 0, 1), y: clamp(pt[1] / sh.H, 0, 1) };
    if (!moved) {
      if (!S.pendingArrow) {
        S.pendingArrow = { page: sh.pi, end: asEnd(start, p) };
        drawOverlay(sh);
        toast('Now click where the arrow should point.');
      } else {
        const from = S.pendingArrow; S.pendingArrow = null;
        if (from.page !== sh.pi) { toast('Arrows join things on the same page.'); drawOverlay(sh); return; }
        if (start && from.end.ref === start.ref) { drawOverlay(sh); return; }
        change((a) => a.arrows.push({ id: uid(), page: sh.pi, from: from.end, to: asEnd(start, p) }));
      }
      return;
    }
    if (q[0] < 0 || q[1] < 0 || q[0] > sh.W || q[1] > sh.H) { toast('Arrows join things on the same page.'); return; }
    const target = objectAt(sh, u, q);
    if (start && target && start.ref === target.ref) return;
    S.pendingArrow = null;
    change((a) => a.arrows.push({ id: uid(), page: sh.pi, from: asEnd(start, p), to: asEnd(target, q) }));
  };
  cap.addEventListener('pointermove', mv); cap.addEventListener('pointerup', up);
}
function freeDraw(sh, e, p, cap = sh.capture) {
  e.preventDefault(); commitEditing();
  const s = S.settings; cap.setPointerCapture(e.pointerId);
  const toC = (q) => [(q[0] - sh.cx) / sh.cw, (q[1] - sh.cy) / sh.ch];
  let pts = [toC(p)]; let last = p;
  const width = (s.hlWidth * sh.W / 600) / sh.cw;
  const path = sv('path', { fill: 'none', stroke: s.hlColor, 'stroke-opacity': s.hlOpacity, 'stroke-width': width * sh.cw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  sh.hlSvg.append(path);
  const render = () => { const d = pts.map(([x, y]) => `${x * sh.cw},${y * sh.ch}`); if (d.length === 1) d.push(d[0]); path.setAttribute('d', 'M' + d.join(' L')); };
  render();
  const mv = (m) => {
    const q = sheetPoint(sh, m);
    if (m.shiftKey) { pts = [pts[0], toC(q)]; render(); return; }
    if (Math.hypot(q[0] - last[0], q[1] - last[1]) < 1.5) return;
    last = q; pts.push(toC(q)); render();
  };
  const up = () => {
    cap.removeEventListener('pointermove', mv); cap.removeEventListener('pointerup', up); path.remove();
    const r4 = (v) => Math.round(v * 10000) / 10000;
    change((a) => a.hls.push({ id: uid(), page: sh.pi, type: 'free', color: s.hlColor, style: s.hlStyle, points: pts.map(([x, y]) => [r4(x), r4(y)]), width, created: Date.now() }));
  };
  cap.addEventListener('pointermove', mv); cap.addEventListener('pointerup', up);
}
document.addEventListener('pointerup', () => {
  if (!S.book || $('#reader').hidden) return;
  setTimeout(() => {
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed || !sel.toString().trim()) return;
    const body = (sel.anchorNode?.nodeType === 1 ? sel.anchorNode : sel.anchorNode?.parentElement)?.closest?.('.nbody');
    if (body) { if (S.tool === 'hl' && body.contains(sel.focusNode)) markText(S.settings.hlStyle, S.settings.hlColor); return; }
    const sh = sheetFromNode(sel.anchorNode);
    if (!sh || !sh.textLayer || !sh.textLayer.contains(sel.anchorNode)) return;
    if (S.tool === 'hl' && S.settings.hlMode === 'snap') highlightSelection(S.settings.hlColor, S.settings.hlStyle);
    else if (S.tool === 'select') showSelectionPop();
  }, 0);
});

/* ===================== text formatting inside notes ===================== */
const hexA = (h, a) => { const [r, g, b] = hexToRgb(h); return `rgba(${r}, ${g}, ${b}, ${a})`; };
function activeBody() { const a = document.activeElement; return a?.classList?.contains('nbody') ? a : null; }
function markText(style, color) {
  if (!activeBody()) return;
  if (style === 'ul') document.execCommand('underline');
  else { document.execCommand('styleWithCSS', false, true); document.execCommand('hiliteColor', false, hexA(color, Math.min(0.75, S.settings.hlOpacity + 0.1))); document.execCommand('styleWithCSS', false, false); }
  getSelection().collapseToEnd();
}
let fmtNote = null;
function showFmt(noteEl) { fmtNote = noteEl; $('#fmtBar').hidden = false; placeFmt(); syncFmt(); }
function hideFmt() { fmtNote = null; $('#fmtBar').hidden = true; }
function placeFmt() {
  if (!fmtNote) return;
  const bar = $('#fmtBar'), r = fmtNote.getBoundingClientRect(), st = $('#stage').getBoundingClientRect();
  let y = r.top - bar.offsetHeight - 20; if (y < st.top + 4) y = r.bottom + 8;
  bar.style.left = clamp(r.left, 8, innerWidth - bar.offsetWidth - 8) + 'px'; bar.style.top = clamp(y, st.top + 4, innerHeight - bar.offsetHeight - 50) + 'px';
}
function syncFmt() {
  if ($('#fmtBar').hidden) return;
  for (const b of $$('#fmtBar [data-cmd]')) { const c = b.dataset.cmd; if (['bold', 'italic', 'underline'].includes(c)) b.classList.toggle('on', document.queryCommandState(c)); }
  $('#fmtMarkSw').style.background = S.settings.hlColor;
}
async function insertLink() {
  const body = activeBody(); if (!body) { toast('Click into some text first.'); return; }
  const sel = getSelection(); const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  const text = range ? range.toString().trim() : '';
  S.suspendBlur = true;
  let url = await ask({ title: 'Add a link', body: 'Paste the address of the article or web page.', input: /^(https?:\/\/|www\.)/i.test(text) ? text : 'https://', ok: 'Add link' });
  S.suspendBlur = false;
  body.focus();
  if (range) { sel.removeAllRanges(); sel.addRange(range); }
  url = (url || '').trim();
  if (!url || url === 'https://') return;
  if (!/^(https?:\/\/|mailto:)/i.test(url)) url = 'https://' + url.replace(/^\/+/, '');
  if (!range || range.collapsed) document.execCommand('insertHTML', false, `<a href="${escapeHTML(url)}">${escapeHTML(url)}</a>&nbsp;`);
  else document.execCommand('createLink', false, url);
}
function applyFmt(cmd) {
  if (!activeBody()) { toast('Click into some text first.'); return; }
  if (cmd === 'link') return insertLink();
  if (cmd === 'mark') { const sel = getSelection(); if (sel.isCollapsed) { toast('Select some words to highlight.'); return; } markText('hl', S.settings.hlColor); return; }
  if (cmd === 'clear') { document.execCommand('removeFormat'); document.execCommand('unlink'); return; }
  document.execCommand(cmd); syncFmt();
}

/* ===================== pasting images and text ===================== */
async function imageSize(blob) { try { const b = await createImageBitmap(blob); const r = { w: b.width, h: b.height }; b.close?.(); return r; } catch { return { w: 400, h: 300 }; } }
function pastePlace() {
  const lp = S.lastPoint;
  const sh = (lp && lp.doc === S.doc && sheetOf(lp.pi)) || S.sheets[S.sheets.length > 1 ? 0 : 0];
  return { sh, p: lp && lp.doc === S.doc && sheetOf(lp.pi) ? lp.p : [sh.W * 0.15, sh.H * 0.18] };
}
async function pasteImage(blob, body) {
  if (!S.sheets.length) return;
  toast('Pasting image…', 20000);
  const id = await Assets.put(blob);
  const { w: iw, h: ih } = await imageSize(blob);
  let sh, x, y;
  const noteEl = body?.closest('.note');
  if (noteEl) { sh = sheetFromNode(noteEl); x = noteEl.offsetLeft; y = noteEl.offsetTop + noteEl.offsetHeight + 8; commitEditing(); }
  else ({ sh, p: [x, y] } = pastePlace());
  const css = iw / (window.devicePixelRatio || 1);
  const maxW = sh.nb ? (nbGeom(sh).right - Math.max(x, nbGeom(sh).mx)) : sh.W * 0.6;
  const w = clamp(Math.min(css, maxW), 40, sh.W * 0.95) / sh.W;
  if (sh.nb && x < nbGeom(sh).mx) x = nbGeom(sh).mx + 4;
  const snip = S.lastSnip;
  const fromSnip = snip && Date.now() - snip.t < 30 * 60e3 && Math.abs(iw / ih - snip.ratio) < 0.03;
  const n = { id: uid(), page: sh.pi, x: clamp(Math.min(x / sh.W, 0.99 - w), 0, 0.95), y: clamp(y / sh.H, 0, 0.95), w, img: id, created: Date.now() };
  if (fromSnip && snip.pi != null) { n.srcPage = snip.pi; n.srcDoc = snip.doc; n.srcBook = snip.bookId; n.srcTitle = snip.title; n.srcLabel = snip.label; }
  change((a) => a.notes.push(n));
  select({ type: 'note', id: n.id });
  toast(fromSnip ? 'Snip pasted, with a link back to its page.' : 'Image pasted. Drag it to move it, or drag its right edge to resize.');
}
function pasteTextBlock(text) {
  const { sh, p } = pastePlace(); if (!sh) return;
  const n = sh.nb ? createNbBlock(sh, p) : createNoteAt(sh, p[0], p[1]);
  n.html = escapeHTML(text).replace(/\r?\n/g, '<br>');
  redrawAll();
}
document.addEventListener('paste', async (e) => {
  if (!S.book || $('#reader').hidden) return;
  const t = e.target;
  if (/^(INPUT|TEXTAREA)$/.test(t.tagName || '')) return;
  const items = [...(e.clipboardData?.items || [])];
  const imgItem = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'));
  const body = t.closest?.('.nbody');
  if (imgItem) { e.preventDefault(); const f = imgItem.getAsFile(); if (f) await pasteImage(f, body); return; }
  const text = e.clipboardData?.getData('text/plain') || '';
  if (body) { e.preventDefault(); document.execCommand('insertText', false, text); return; }
  if (text.trim()) { e.preventDefault(); pasteTextBlock(text); }
});

/* ===================== snip and zoom-to-area ===================== */
function areaSelect(mode) {
  commitEditing(); hidePop(); closeMenus();
  const ov = $('#areaLayer'); ov.hidden = false; ov.className = 'area-layer ' + mode;
  const box = $('#areaBox'); box.hidden = true;
  $('#areaHint').textContent = mode === 'snip' ? 'Drag over the part of the page to copy. Esc to cancel.' : 'Drag a box round the part to zoom into. Esc to cancel.';
  return new Promise((res) => {
    let start = null;
    const finish = (r) => { ov.hidden = true; box.hidden = true; ov.onpointerdown = ov.onpointermove = ov.onpointerup = null; document.removeEventListener('keydown', esc, true); res(r); };
    const esc = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(null); } };
    document.addEventListener('keydown', esc, true);
    ov.onpointerdown = (ev) => { if (ev.button !== 0) return finish(null); start = [ev.clientX, ev.clientY]; ov.setPointerCapture(ev.pointerId); box.hidden = false; ov.onpointermove(ev); };
    ov.onpointermove = (ev) => {
      if (!start) return;
      const x = Math.min(start[0], ev.clientX), y = Math.min(start[1], ev.clientY);
      Object.assign(box.style, { left: x + 'px', top: y + 'px', width: Math.abs(ev.clientX - start[0]) + 'px', height: Math.abs(ev.clientY - start[1]) + 'px' });
    };
    ov.onpointerup = (ev) => {
      if (!start) return;
      const r = { x: Math.min(start[0], ev.clientX), y: Math.min(start[1], ev.clientY), width: Math.abs(ev.clientX - start[0]), height: Math.abs(ev.clientY - start[1]) };
      finish(r.width > 6 && r.height > 6 ? r : null);
    };
  });
}
async function snip() {
  if (!S.book) return;
  const r = await areaSelect('snip'); if (!r) return;
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  const sheetEl = document.elementsFromPoint(cx, cy).find((x) => x.classList?.contains('sheet'));
  const pi = S.doc !== 'nb' && sheetEl ? +sheetEl.dataset.page : null;
  await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
  try {
    if (IS_APP) await window.native.snip(r);
    else {
      const dpr = window.devicePixelRatio || 1, c = document.createElement('canvas');
      c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      for (const cv of $$('.sheet canvas')) { const b = cv.getBoundingClientRect(); ctx.drawImage(cv, (b.left - r.x) * dpr, (b.top - r.y) * dpr, b.width * dpr, b.height * dpr); }
      const blob = await new Promise((ok) => c.toBlob(ok, 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    }
    S.lastSnip = { pi, doc: S.doc, ratio: r.width / r.height, t: Date.now(), bookId: S.book.id, title: S.book.title, label: pi != null ? pageName(pi) : null };
    toast(S.doc !== 'nb' ? 'Snip copied. Press Tab for the notebook, click where it should go, then Ctrl+V.' : 'Snip copied. Click where it should go and press Ctrl+V.', 5000);
  } catch (e) { console.error(e); toast('Couldn’t copy that snip.'); }
}
async function zoomToArea() {
  if (!S.book) return;
  const r = await areaSelect('zoom'); if (!r) return;
  const st = $('#stage');
  const f = Math.min(st.clientWidth / r.width, st.clientHeight / r.height) * 0.92;
  setZoom(S.settings.zoom * f, { x: r.x + r.width / 2, y: r.y + r.height / 2 }, true);
}

/* ===================== zoom ===================== */
const ZMIN = 0.5, ZMAX = 4;
function sheetsBox() {
  const els = $$('#spread .sheet'); if (!els.length) return null;
  const rs = els.map((e) => e.getBoundingClientRect());
  return { l: Math.min(...rs.map((r) => r.left)), t: Math.min(...rs.map((r) => r.top)), r: Math.max(...rs.map((r) => r.right)), b: Math.max(...rs.map((r) => r.bottom)) };
}
// Zoom keeping the point under the cursor in place (or bringing an area to the centre).
function setZoom(z, at, centre = false) {
  if (!S.settings) return;
  z = clamp(Math.round(z * 100) / 100, ZMIN, ZMAX);
  const old = S.settings.zoom; if (Math.abs(z - old) < 0.001) return;
  const st = $('#stage'), sr = st.getBoundingClientRect(), box = sheetsBox();
  const pt = at || { x: sr.left + st.clientWidth / 2, y: sr.top + st.clientHeight / 2 };
  if (box) {
    S.zoomAnchor = {
      fx: (pt.x - box.l) / (box.r - box.l), fy: (pt.y - box.t) / (box.b - box.t),
      sx: centre ? st.clientWidth / 2 : pt.x - sr.left, sy: centre ? st.clientHeight / 2 : pt.y - sr.top,
    };
    const sp = $('#spread'), spr = sp.getBoundingClientRect();
    sp.style.transformOrigin = `${pt.x - spr.left}px ${pt.y - spr.top}px`;
    sp.style.transform = `scale(${z / (S.zoomBase || old)})`;
  }
  S.settings.zoom = z;
  syncZoomUI(); syncControls(); relayoutSoon(); scheduleSave();
}
function applyZoomAnchor() {
  const a = S.zoomAnchor; S.zoomAnchor = null; if (!a) return;
  const st = $('#stage'), sr = st.getBoundingClientRect(), box = sheetsBox(); if (!box) return;
  const tx = box.l + a.fx * (box.r - box.l), ty = box.t + a.fy * (box.b - box.t);
  st.scrollLeft += (tx - sr.left) - a.sx; st.scrollTop += (ty - sr.top) - a.sy;
}
function syncZoomUI() {
  const z = S.settings?.zoom ?? 1;
  $('#zoomPct').textContent = Math.round(z * 100) + '%';
  $('#zoomReset').disabled = Math.abs(z - 1) < 0.001;
  $('#zoomOut').disabled = z <= ZMIN; $('#zoomIn').disabled = z >= ZMAX;
}
function zoomStep(dir) { const z = S.settings.zoom; const steps = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4]; const next = dir > 0 ? steps.find((v) => v > z + 0.01) : [...steps].reverse().find((v) => v < z - 0.01); setZoom(next ?? z); }
function resetZoom() { setZoom(1); $('#stage').scrollTo({ left: 0, top: 0 }); }

/* ===================== tools ===================== */
function setTool(t) {
  S.tool = t;
  if (t !== 'arrow' && S.pendingArrow) { S.pendingArrow = null; for (const sh of S.sheets) drawOverlay(sh); }
  const r = $('#reader');
  r.classList.remove('tool-select', 'tool-note', 'tool-hl', 'tool-arrow');
  r.classList.add('tool-' + t);
  r.classList.toggle('hl-free', t === 'hl' && S.settings.hlMode === 'free');
  $$('.tool').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  $('#hlModeTag').textContent = S.settings.hlMode === 'free' ? 'free' : 'snap';
  if (t !== 'select') hidePop();
}

/* ===================== search ===================== */
const CH = { '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'", 'ʼ': "'", '“': '"', '”': '"', '„': '"', '″': '"', '–': '-', '—': '-', '‒': '-', '―': '-', '−': '-', '‐': '-', '‑': '-', '­': '', 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st', '…': '...', ' ': ' ' };
/* pieces: array of strings, or null for a line break. Returns display text, lower-case text and a map back to [piece, offset]. */
function normPieces(pieces, wantMap) {
  let d = '', l = ''; const map = wantMap ? [] : null;
  const push = (ch, m) => {
    if (/\s/.test(ch)) { if (!d.length || d[d.length - 1] === ' ') return; ch = ' '; }
    let lc = ch.toLowerCase(); if (lc.length !== ch.length) lc = ch;
    d += ch; l += lc; if (map) for (let k = 0; k < ch.length; k++) map.push(m);
  };
  pieces.forEach((s, p) => {
    if (s == null) {
      // join words hyphenated across a line break ("won-" + "der" → "wonder")
      if (d.length > 1 && d[d.length - 1] === '-' && /\p{L}/u.test(d[d.length - 2])) { d = d.slice(0, -1); l = l.slice(0, -1); if (map) map.pop(); return; }
      push(' ', null); return;
    }
    for (let o = 0; o < s.length; o++) { const c = s[o]; const r = CH[c] ?? c; for (const ch of r) push(ch, [p, o]); }
  });
  return { disp: d, low: l, map };
}
const normQuery = (q) => normPieces([q], false).low.trim();
function itemsToPieces(items) { const out = []; for (const it of items) { if (typeof it.str !== 'string') continue; out.push(it.str); if (it.hasEOL) out.push(null); } return out; }
async function ensureIndex() {
  if (S.index) return S.index;
  if (S.indexing) return S.indexing;
  const id = S.book.id, n = S.pdf.numPages, pdf = S.pdf;
  S.indexing = (async () => {
    const cached = await DB.get('text', id);
    let pages;
    if (cached && cached.n === n && cached.v === 2) pages = cached.pages;
    else {
      pages = [];
      for (let i = 0; i < n; i++) {
        if (S.pdf !== pdf) throw new Error('closed');
        const page = await pdf.getPage(i + 1);
        const tc = await page.getTextContent();
        pages.push(normPieces(itemsToPieces(tc.items), false).disp);
        if (i % 10 === 0) $('#searchCount').textContent = `Reading the book… ${Math.round(i / n * 100)}%`;
      }
      DB.put('text', { id, n, v: 2, pages }).catch(() => {});
    }
    S.index = pages.map((disp) => ({ disp, low: [...disp].map((c) => { const lc = c.toLowerCase(); return lc.length === c.length ? lc : c; }).join('') }));
    return S.index;
  })();
  try { return await S.indexing; } finally { S.indexing = null; }
}
function edIndex() {
  if (S.edIndex) return S.edIndex;
  const t = S.flow.text, ps = S.flow.paras;
  S.edIndex = S.ed.starts.map((_, pi) => {
    const [s, e] = edRange(pi), pieces = [];
    for (let k = paraAt(s); k < ps.length && ps[k].start < e; k++) { const a = Math.max(ps[k].start, s), b = Math.min(ps[k].end, e); if (b > a) { pieces.push(t.slice(a, b), null); } }
    const { disp, low } = normPieces(pieces, false); return { disp, low };
  });
  return S.edIndex;
}
async function ensureFlowFor(meta) { if (S.book !== meta) S.book = meta; return ensureFlow(); }
async function runSearch(q) {
  S.search.q = q; const qn = normQuery(q);
  const list = $('#searchResults'), count = $('#searchCount');
  if (!qn) { S.search.results = []; S.search.cur = -1; list.textContent = ''; count.textContent = ''; paintAllMarks(); return; }
  let idx;
  const res = [];
  if (S.doc === 'nb') {
    idx = [];
    const blocks = S.ann.notes.filter((n) => !n.img).sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
    for (const n of blocks) {
      const { disp, low } = normPieces([htmlToText(n.html)], false);
      let from = 0, i;
      while ((i = low.indexOf(qn, from)) !== -1) { res.push({ p: n.page, s: i, e: i + qn.length, k: 0, id: n.id, txt: disp }); from = i + Math.max(1, qn.length); }
    }
  } else {
    if (S.doc === 'ed') {
      // Search the whole text so phrases that run over a page break are still found.
      idx = edIndex();
      const { low, map } = flowNorm(), per = new Map();
      for (let i = low.indexOf(qn); i !== -1 && res.length < 5000; i = low.indexOf(qn, i + Math.max(1, qn.length))) {
        const os = map[i], oe = map[i + qn.length - 1] + 1; if (os < 0 || os < S.ed.starts[0]) continue;
        const p = edPageOf(os), k = per.get(p) || 0; per.set(p, k + 1);
        const a = Math.max(0, os - 60);
        res.push({ p, s: os - a, e: oe - a, k, txt: S.flow.text.slice(a, oe + 70).replace(/\n/g, ' ') });
      }
    } else try { idx = await ensureIndex(); } catch { return; }
    if (S.search.q !== q) return;
    for (let p = 0; S.doc === 'book' && p < idx.length && res.length < 5000; p++) {
      let from = 0, k = 0, i;
      while ((i = idx[p].low.indexOf(qn, from)) !== -1) { res.push({ p, s: i, e: i + qn.length, k: k++ }); from = i + Math.max(1, qn.length); if (res.length >= 5000) break; }
    }
  }
  S.search.results = res;
  const first = visiblePages()[0] ?? 0;
  S.search.cur = res.length ? Math.max(0, res.findIndex((r) => r.p >= first)) : -1;
  if (S.search.cur < 0 && res.length) S.search.cur = 0;
  list.textContent = '';
  if (!res.length) { count.textContent = S.doc === 'book' && idx.every((p) => !p.disp.trim()) ? 'This PDF is a scan with no searchable text' : 'No matches'; paintAllMarks(); return; }
  const frag = document.createDocumentFragment();
  res.slice(0, 400).forEach((r, i) => {
    const t = r.txt ?? idx[r.p].disp; const a = Math.max(0, r.s - 45), b = Math.min(t.length, r.e + 55);
    frag.append(el('li', { 'data-i': i, onclick: () => gotoResult(i) },
      el('span', { class: 'pg', text: 'p. ' + pageName(r.p) }),
      el('span', {}, (a > 0 ? '…' : '') + t.slice(a, r.s), el('mark', { text: t.slice(r.s, r.e) }), t.slice(r.e, b) + (b < t.length ? '…' : ''))));
  });
  if (res.length > 400) frag.append(el('li', { class: 'more', text: `…and ${res.length - 400} more. Use Enter to step through them all.` }));
  list.append(frag);
  gotoResult(S.search.cur, false);
}
async function gotoResult(i, move = true) {
  const res = S.search.results; if (!res.length) return;
  i = ((i % res.length) + res.length) % res.length; S.search.cur = i;
  $('#searchCount').textContent = `${i + 1} of ${res.length}${res.length >= 5000 ? '+' : ''}`;
  $$('#searchResults li.cur').forEach((x) => x.classList.remove('cur'));
  const li = $(`#searchResults li[data-i="${i}"]`); if (li) { li.classList.add('cur'); li.scrollIntoView({ block: 'nearest' }); }
  if (move || !visiblePages().includes(res[i].p)) await goToPage(res[i].p);
  if (res[i].id) select({ type: 'note', id: res[i].id });
  paintAllMarks();
}
function paintAllMarks() { for (const sh of S.sheets) paintMarks(sh); }
function paintMarks(sh) {
  sh.marks.textContent = '';
  const qn = normQuery(S.search.q || ''); if (!qn || !sh.textLayer || $('#searchBox').hidden) return;
  const nodes = [], pieces = [];
  const tw = document.createTreeWalker(sh.textLayer, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    if (n.nodeType === 3) { nodes.push(n); pieces.push(n.data); }
    else if (n.tagName === 'BR' || n.classList?.contains('pe')) { nodes.push(null); pieces.push(null); }
  }
  const { low, map } = normPieces(pieces, true);
  const cur = S.search.results[S.search.cur];
  const cr = sh.content.getBoundingClientRect();
  let from = 0, k = 0, i;
  while ((i = low.indexOf(qn, from)) !== -1) {
    from = i + Math.max(1, qn.length);
    const ms = map[i], me = map[i + qn.length - 1];
    if (ms && me) {
      const range = document.createRange();
      try {
        range.setStart(nodes[ms[0]], ms[1]); range.setEnd(nodes[me[0]], me[1] + 1);
        const isCur = cur && cur.p === sh.pi && cur.k === k;
        for (const r of range.getClientRects()) {
          if (r.width < 0.5) continue;
          sh.marks.append(el('div', { class: 'm' + (isCur ? ' cur' : ''), style: { left: (r.left - cr.left) + 'px', top: (r.top - cr.top) + 'px', width: r.width + 'px', height: r.height + 'px' } }));
        }
      } catch {}
    }
    k++;
  }
}
function openSearch() {
  closeMenus(); const box = $('#searchBox'); box.hidden = false;
  const inp = $('#searchInput'); inp.focus(); inp.select();
  const s = getSelection().toString().trim();
  if (s && s.length < 80 && !inp.value) { inp.value = s; runSearch(s); }
  paintAllMarks();
}
function closeSearch() { $('#searchBox').hidden = true; paintAllMarks(); $('#stage').focus({ preventScroll: true }); }

/* ===================== drawer: contents, bookmarks, notes ===================== */
function openDrawer(tab) { closeMenus(); if (tab) S.drawerTab = tab; $('#drawer').hidden = false; $('#drawerBtn').classList.add('on'); refreshDrawer(); }
function closeDrawer() { $('#drawer').hidden = true; $('#drawerBtn').classList.remove('on'); }
function toggleDrawer() { $('#drawer').hidden ? openDrawer() : closeDrawer(); }
async function destToPage(dest) {
  try {
    if (typeof dest === 'string') dest = await S.pdf.getDestination(dest);
    if (!Array.isArray(dest)) return null;
    const ref = dest[0];
    if (ref && typeof ref === 'object') return await S.pdf.getPageIndex(ref);
    if (Number.isInteger(ref)) return ref;
  } catch {}
  return null;
}
async function refreshDrawer() {
  if ($('#drawer').hidden || !S.book) return;
  $$('#drawer .tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.drawerTab));
  const body = $('#drawerBody'); const tab = S.drawerTab;
  if (tab === 'contents' && S.doc === 'ed') {
    body.textContent = '';
    const heads = S.flow.paras.filter((p) => p.kind === 'h' && p.start >= S.ed.starts[0]);
    if (!heads.length) { body.append(el('div', { class: 'empty-note', text: 'No chapter headings were found in this text. Bookmark chapter openings with B and they’ll appear under Bookmarks.' })); return; }
    const list = el('div', { class: 'toc' }, el('ul', {}, heads.map((h) => { const pi = edPageOf(h.start); return el('li', { class: 'lvl0' }, el('a', { onclick: () => goToPage(pi) }, el('span', { text: S.flow.text.slice(h.start, h.end) }), el('span', { class: 'pg', text: pageName(pi) }))); })));
    body.append(list);
  } else if (tab === 'contents' && S.doc === 'nb') {
    body.textContent = '';
    const list = el('div', { class: 'dl' });
    for (let i = 0; i < S.nbAnn.pages; i++) {
      const first = S.nbAnn.notes.filter((n) => n.page === i && !n.img).sort((a, b) => a.y - b.y || a.x - b.x)[0];
      const imgs = S.nbAnn.notes.filter((n) => n.page === i && n.img).length;
      const txt = first ? htmlToText(first.html).split('\n')[0].slice(0, 90) : imgs ? `${imgs} image${imgs === 1 ? '' : 's'}` : 'Blank page';
      list.append(el('div', { class: 'item', onclick: () => goToPage(i) }, el('span', { class: 'pg', text: String(i + 1), style: { minWidth: '28px' } }), el('div', { class: 'txt', text: txt, style: first || imgs ? null : { color: '#8a948f', fontStyle: 'italic' } })));
    }
    body.append(list, el('div', { class: 'drawer-foot' }, el('button', { class: 'btn', type: 'button', text: 'Add two pages', onclick: () => { addNotebookPages(2); refreshDrawer(); updatePager(); } })));
  } else if (tab === 'contents') {
    if (S.outline === undefined) {
      body.innerHTML = '<div class="empty-note">Loading contents…</div>';
      let ol = null; try { ol = await S.pdf.getOutline(); } catch {}
      const walk = async (items) => Promise.all((items || []).map(async (it) => ({ title: it.title, page: await destToPage(it.dest), items: await walk(it.items) })));
      S.outline = ol ? await walk(ol) : null;
      if (S.drawerTab !== 'contents') return;
    }
    body.textContent = '';
    if (!S.outline || !S.outline.length) { body.append(el('div', { class: 'empty-note', text: 'This PDF doesn’t include a contents list. Bookmark chapter openings with B and they’ll appear under Bookmarks.' })); return; }
    const build = (items, lvl) => el('ul', {}, items.map((it) => el('li', { class: 'lvl' + lvl },
      el('a', { onclick: () => it.page != null && goToPage(it.page) }, el('span', { text: it.title }), el('span', { class: 'pg', text: it.page != null ? pageName(it.page) : '' })),
      it.items?.length ? build(it.items, lvl + 1) : null)));
    body.append(el('div', { class: 'toc' }, build(S.outline, 0)));
  } else if (tab === 'bookmarks') {
    body.textContent = '';
    const bms = [...S.ann.bms].sort((a, b) => a.page - b.page);
    if (!bms.length) { body.append(el('div', { class: 'empty-note', text: 'No bookmarks yet. Press B, or click the ribbon at the top corner of a page.' })); return; }
    const list = el('div', { class: 'dl' });
    for (const b of bms) {
      const inp = el('input', { class: 'bm-label', value: b.label || '', placeholder: 'Add a name, e.g. “Ch. 3 — the storm”', 'aria-label': 'Bookmark name' });
      inp.addEventListener('click', (e) => e.stopPropagation());
      inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') inp.blur(); });
      inp.addEventListener('change', () => change(() => { b.label = inp.value.trim(); }));
      list.append(el('div', { class: 'item', onclick: () => goToPage(b.page) },
        el('span', { class: 'chip', style: { background: 'var(--ribbon)' } }),
        el('span', { class: 'pg', text: 'p. ' + pageName(b.page), style: { minWidth: '44px' } }), inp,
        el('button', { class: 'x', type: 'button', title: 'Remove bookmark', text: '×', onclick: (e) => { e.stopPropagation(); change((a) => { a.bms = a.bms.filter((x) => x !== b); }); } })));
    }
    body.append(list);
  } else {
    body.textContent = '';
    const filters = el('div', { class: 'filter-row' });
    for (const [k, label] of [['all', 'Everything'], ['hl', 'Highlights'], ['note', 'Notes']]) filters.append(el('button', { type: 'button', class: S.notesFilter === k ? 'on' : '', text: label, onclick: () => { S.notesFilter = k; refreshDrawer(); } }));
    for (const c of HL_COLORS) filters.append(el('button', { type: 'button', class: S.notesFilter === c ? 'on' : '', title: 'Only this colour', style: { background: S.notesFilter === c ? c : '#fff', borderColor: c, width: '26px', padding: '3px' }, html: `<span style="display:block;width:12px;height:12px;border-radius:50%;background:${c};margin:auto"></span>`, onclick: () => { S.notesFilter = S.notesFilter === c ? 'all' : c; refreshDrawer(); } }));
    body.append(filters);
    const linked = new Map(); // hl id -> notes
    const linkedNotes = new Set();
    for (const ar of S.ann.arrows) {
      const ends = [ar.from.ref, ar.to.ref];
      const hl = ends.map((r) => S.ann.hls.find((h) => h.id === r)).find(Boolean);
      const nt = ends.map((r) => S.ann.notes.find((n) => n.id === r)).find(Boolean);
      if (hl && nt) { if (!linked.has(hl.id)) linked.set(hl.id, []); linked.get(hl.id).push(nt); linkedNotes.add(nt.id); }
    }
    const ypos = (o) => o.type === 'span' ? o.start / 1e7 : o.type === 'text' ? o.rects[0][1] : o.points ? o.points[0][1] : o.y;
    let items = [
      ...S.ann.hls.map((h) => ({ kind: 'hl', o: h })),
      ...S.ann.notes.filter((n) => S.notesFilter === 'note' || !linkedNotes.has(n.id)).map((n) => ({ kind: 'note', o: n })),
    ];
    const f = S.notesFilter;
    items = items.filter((it) => f === 'all' || (f === 'hl' && it.kind === 'hl') || (f === 'note' && it.kind === 'note') || (f.startsWith('#') && it.kind === 'hl' && it.o.color === f));
    items.sort((a, b) => a.o.page - b.o.page || ypos(a.o) - ypos(b.o));
    if (!items.length) { body.append(el('div', { class: 'empty-note', text: S.ann.hls.length + S.ann.notes.length ? 'Nothing matches this filter.' : 'Highlights and notes you make will be listed here, in page order, so you can find quotations quickly.' })); }
    const list = el('div', { class: 'dl' });
    for (const it of items) {
      const o = it.o;
      const txt = el('div', { class: 'txt' });
      if (it.kind === 'hl') {
        txt.append(o.text ? el('q', { text: o.text.length > 280 ? o.text.slice(0, 280) + '…' : o.text }) : el('em', { text: 'Freehand mark' }));
        for (const n of linked.get(o.id) || []) txt.append(el('span', { class: 'nt', text: '→ ' + (htmlToText(n.html) || '(empty note)') }));
      } else txt.append(el('span', { class: 'nt', text: o.img ? 'Image' + (o.srcPage != null ? (o.srcBook && o.srcBook !== S.book.id ? ` (from ${o.srcTitle || 'a book'}, p. ${o.srcLabel ?? o.srcPage + 1})` : ` (from p. ${pageName(o.srcPage, 'book')})`) : '') : htmlToText(o.html) || '(empty note)', style: { marginTop: 0 } }));
      list.append(el('div', { class: 'item', onclick: async () => { await goToPage(o.page); if (it.kind === 'hl') select({ type: 'hl', id: o.id }); else select({ type: 'note', id: o.id }); } },
        el('span', { class: 'chip', style: it.kind === 'hl' ? { background: o.color } : { background: 'transparent', border: '2px solid ' + S.settings.noteInk } }),
        txt, el('span', { class: 'pg', text: 'p. ' + pageName(o.page) })));
    }
    body.append(list);
    body.append(el('div', { class: 'drawer-foot' }, el('button', { class: 'btn', type: 'button', text: 'Export notes as text', onclick: exportNotes })));
  }
}
function exportNotes() {
  commitEditing();
  if (isStandalone()) return exportNotebook();
  const bd = bookDoc(), a = annOf(bd), lines = [];
  const pageName = (pi) => window.pageNameFor(pi, bd);
  lines.push(`Notes on ${S.book.title}`, `Exported from Rose's generic study app on ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`, '');
  const bms = [...a.bms].sort((x, y) => x.page - y.page);
  if (bms.length) { lines.push('BOOKMARKS'); for (const b of bms) lines.push(`  p. ${pageName(b.page)}${b.label ? '  ' + b.label : ''}`); lines.push(''); }
  const byPage = new Map();
  const add = (p, s) => { if (!byPage.has(p)) byPage.set(p, []); byPage.get(p).push(s); };
  const usedNotes = new Set();
  for (const h of a.hls) {
    const notes = a.arrows.filter((ar) => ar.from.ref === h.id || ar.to.ref === h.id).map((ar) => a.notes.find((n) => n.id === (ar.from.ref === h.id ? ar.to.ref : ar.from.ref))).filter(Boolean);
    notes.forEach((n) => usedNotes.add(n.id));
    const y = h.type === 'text' ? h.rects[0][1] : h.points[0][1];
    add(h.page, { y, text: (h.text ? `  “${h.text}”` : '  [freehand mark]') + (notes.length ? '\n' + notes.map((n) => '      → ' + htmlToText(n.html).replace(/\n/g, '\n        ')).join('\n') : '') });
  }
  const noteText = (n) => n.img ? '[image' + (n.srcPage != null ? ` from p. ${pageName(n.srcPage)}` : '') + ']' : htmlToText(n.html).replace(/\n/g, '\n        ');
  for (const n of a.notes) if (!usedNotes.has(n.id)) add(n.page, { y: n.y, text: '  Note: ' + noteText(n) });
  for (const p of [...byPage.keys()].sort((x, y) => x - y)) {
    lines.push(`p. ${pageName(p)}`);
    for (const it of byPage.get(p).sort((x, y) => x.y - y.y)) lines.push(it.text);
    lines.push('');
  }
  const nbBlocks = S.nbAnn.notes.slice().sort((x, y) => x.page - y.page || x.y - y.y || x.x - y.x);
  if (nbBlocks.length) {
    lines.push('', 'NOTEBOOK', '');
    let pg = -1;
    for (const n of nbBlocks) {
      if (n.page !== pg) { pg = n.page; lines.push(`Notebook page ${pg + 1}`); }
      lines.push('  ' + (n.img ? noteText(n) : htmlToText(n.html).replace(/\n/g, '\n  ')));
    }
  }
  if (!byPage.size && !bms.length && !nbBlocks.length) { toast('There are no notes in this book yet.'); return; }
  const safe = S.book.title.replace(/[\\/:*?"<>|]+/g, '').slice(0, 60);
  download(`${safe} - notes.txt`, new Blob(['﻿' + lines.join('\n').replace(/\r?\n/g, '\r\n')], { type: 'text/plain;charset=utf-8' }));
  toast('Notes exported.');
}

/* ===================== settings menus ===================== */
function closeMenus() { $$('.mpanel.open').forEach((p) => p.classList.remove('open')); $$('.mbtn').forEach((b) => b.setAttribute('aria-expanded', 'false')); }
function fmt(key, v) {
  if (key === 'pdfScale' || key === 'zoom' || key === 'hlOpacity' || key === 'arrowOpacity') return Math.round(v * 100) + '%';
  if (key === 'noteWidth') return Math.round(v * 100) + '% of page';
  if (key === 'noteSize') return v + ' pt';
  if (key === 'hlWidth') return v + ' px';
  if (key === 'nbText') return Math.round(v * 100) + '% of a line';
  if (key === 'arrowWidth') return v.toFixed(1);
  return String(v);
}
function syncControls() {
  const s = S.settings; if (!s) return;
  $$('[data-set]').forEach((inp) => {
    const k = inp.dataset.set, v = s[k];
    if (inp.type === 'checkbox') inp.checked = !!v; else inp.value = v;
  });
  $$('[data-for]').forEach((o) => { o.textContent = fmt(o.dataset.for, s[o.dataset.for]); });
  $$('[data-seg]').forEach((g) => $$('button', g).forEach((b) => b.classList.toggle('on', String(s[g.dataset.seg]) === b.dataset.v)));
  $$('[data-show]').forEach((l) => { const w = l.dataset.show; l.hidden = w === 'offset' ? s.numbering !== 'offset' : w === 'fixed' ? s.arrowColorMode !== 'fixed' : false; });
  $$('[data-swatches]').forEach((row) => {
    const key = row.dataset.swatches; const colors = key === 'noteInk' || key === 'nbInk' ? INK_COLORS : HL_COLORS;
    row.textContent = '';
    colors.forEach((c, i) => row.append(el('button', { type: 'button', class: 'sw' + (s[key] === c ? ' on' : ''), style: { background: c }, title: key === 'hlColor' ? `Colour ${i + 1} (key ${i + 1})` : 'Ink colour', onclick: () => setSetting(key, c) })));
    const custom = !colors.includes(s[key]);
    const picker = el('input', { type: 'color', value: s[key], hidden: true });
    picker.addEventListener('input', () => setSetting(key, picker.value));
    row.append(el('button', { type: 'button', class: 'sw custom' + (custom ? ' on' : ''), title: 'Pick any colour', style: custom ? { background: s[key] } : null, onclick: () => picker.click() }), picker);
  });
  $('#hlModeTag').textContent = s.hlMode === 'free' ? 'free' : 'snap';
  syncZoomUI();
}
const relayoutSoon = debounce(() => relayout(), 140);
function setSetting(key, v) {
  const s = S.settings; if (!s) return;
  if (key === 'zoom') { setZoom(v); return; }
  s[key] = v;
  if (key === 'hlColor' && S.sel?.type === 'hl') { const hl = S.ann.hls.find((h) => h.id === S.sel.id); if (hl && hl.color !== v) { change(() => { hl.color = v; }); select({ type: 'hl', id: hl.id }); } }
  if (key === 'hlMode') setTool('hl');
  syncControls();
  if (RELAYOUT.has(key)) relayoutSoon();
  else if (key === 'paper') $('#spread').className = 'spread paper-' + v;
  else if (key === 'numbering' || key === 'page1At') { relayout(); if (!$('#drawer').hidden) refreshDrawer(); }
  else redrawAll();
  if (key === 'hlMode' || key === 'hlStyle') setTool(S.tool);
  scheduleSave();
}
function wireMenus() {
  let hoverOpened = 0;
  const openMenu = (b) => { closeMenus(); hidePop(); document.getElementById(b.dataset.menu).classList.add('open'); b.setAttribute('aria-expanded', 'true'); };
  $$('.mbtn').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = document.getElementById(b.dataset.menu).classList.contains('open');
    if (open && Date.now() - hoverOpened > 400) closeMenus(); else openMenu(b);
  }));
  // once one menu is open, hovering the others switches between them, like a desktop menu bar
  $$('.mbtn').forEach((b) => b.addEventListener('mouseenter', () => { if ($('.mpanel.open') && !document.getElementById(b.dataset.menu).classList.contains('open')) { openMenu(b); hoverOpened = Date.now(); } }));
  $$('.mpanel').forEach((p) => p.addEventListener('pointerdown', (e) => e.stopPropagation()));
  $$('[data-set]').forEach((inp) => {
    const handler = () => {
      const k = inp.dataset.set; let v;
      if (inp.type === 'checkbox') v = inp.checked;
      else if (inp.type === 'range' || inp.type === 'number') { v = parseFloat(inp.value); if (Number.isNaN(v)) return; if (k === 'page1At') v = clamp(Math.round(v), 1, S.pdf?.numPages || 1); }
      else v = inp.value;
      setSetting(k, v);
    };
    inp.addEventListener(inp.type === 'range' || inp.type === 'color' ? 'input' : 'change', handler);
  });
  $$('[data-seg]').forEach((g) => $$('button', g).forEach((b) => b.addEventListener('click', () => setSetting(g.dataset.seg, b.dataset.v))));
  $('#setPage1Here').addEventListener('click', () => { S.settings.numbering = 'offset'; setSetting('page1At', (visiblePages()[0] || 0) + 1); toast(`PDF page ${(visiblePages()[0] || 0) + 1} is now page 1.`); });
  $('#saveDefaults').addEventListener('click', () => { const { zoom, page1At, numbering, ...rest } = S.settings; LS.set('defaults', rest); toast('New books will open with these settings.'); });
  $('#exportNotesBtn').addEventListener('click', () => { closeMenus(); exportNotes(); });
}

/* ===================== keyboard ===================== */
function isTyping(t) { return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)); }
function deleteSelected() {
  if (!S.sel) return;
  const id = S.sel.id; S.sel = null; hidePop();
  change(() => removeItems([id]));
}
function onKey(e) {
  if (!$('#dialog').hidden) return;
  if (!$('#finder').hidden) { if (e.key === 'Escape') closeFinder(); return; }
  if (!$('#edModal').hidden) { if (e.key === 'Escape') $('#edModal').hidden = true; return; }
  if (!$('#help').hidden) { if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); $('#help').hidden = true; } return; }
  if ($('#reader').hidden) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key;
  if (mod && (k === 'f' || k === 'F')) { e.preventDefault(); openSearch(); return; }
  if ((mod && (k === 'g' || k === 'G')) || k === 'F3') { e.preventDefault(); if ($('#searchBox').hidden) openSearch(); else gotoResult(S.search.cur + (e.shiftKey ? -1 : 1)); return; }
  if (mod && (k === '=' || k === '+')) { e.preventDefault(); zoomStep(1); return; }
  if (mod && (k === '-' || k === '_')) { e.preventDefault(); zoomStep(-1); return; }
  if (mod && k === '0') { e.preventDefault(); resetZoom(); return; }
  if (mod && e.shiftKey && (k === 's' || k === 'S')) { e.preventDefault(); snip(); return; }
  if (k === 'PrintScreen') { e.preventDefault(); snip(); return; }
  if (e.target.classList?.contains('nbody')) {
    if (mod && (k === 'k' || k === 'K')) { e.preventDefault(); insertLink(); return; }
    if (mod && /^[biu]$/i.test(k)) setTimeout(syncFmt, 0);
  }
  if (isTyping(e.target)) {
    if (k === 'Escape') { if (e.target.closest('.mpanel')) closeMenus(); e.target.blur(); $('#stage').focus({ preventScroll: true }); }
    return;
  }
  if (mod && !e.shiftKey && (k === 'z' || k === 'Z')) { e.preventDefault(); undo(); return; }
  if (mod && ((e.shiftKey && (k === 'z' || k === 'Z')) || k === 'y' || k === 'Y')) { e.preventDefault(); redo(); return; }
  if (mod || e.altKey) return;
  const handled = () => e.preventDefault();
  switch (k) {
    case 'ArrowRight': case 'PageDown': handled(); go(1); break;
    case 'ArrowLeft': case 'PageUp': handled(); go(-1); break;
    case 'Home': handled(); showSpread(0, -1); break;
    case 'End': handled(); showSpread(S.spreads.length - 1, 1); break;
    case 'Escape':
      if ($('.mpanel.open')) { closeMenus(); $('#stage').focus({ preventScroll: true }); }
      else if (!$('#searchBox').hidden) closeSearch();
      else if (S.edPick != null) { stopPick(); toast('Cancelled.'); }
      else if (S.pendingArrow) { S.pendingArrow = null; redrawAll(); }
      else if (S.sel) select(null);
      else if (!$('#drawer').hidden) closeDrawer();
      else setTool('select');
      getSelection().removeAllRanges(); hidePop();
      break;
    case 'Tab': handled(); if (isStandalone()) toast('This notebook isn’t attached to a book. Your books are in the library.'); else switchDoc(S.doc === 'nb' ? bookDoc() : 'nb'); break;
    case ' ': handled(); if (!S.spaceDown) { S.spaceDown = true; $('#stage').classList.add('panning'); } break;
    case 's': case 'S': snip(); break;
    case 'z': case 'Z': zoomToArea(); break;
    case 'v': case 'V': setTool('select'); break;
    case 't': case 'T': setTool('note'); break;
    case 'h': case 'H': setTool('hl'); break;
    case 'f': case 'F': setSetting('hlMode', S.settings.hlMode === 'free' ? 'snap' : 'free'); toast(S.settings.hlMode === 'free' ? 'Freehand highlighter — draw anywhere (hold Shift for a straight line).' : 'Snap highlighter — drag across words.'); break;
    case 'u': case 'U':
      if (S.sel?.type === 'hl') { const hl = S.ann.hls.find((h) => h.id === S.sel.id); change(() => { hl.style = hl.style === 'ul' ? 'hl' : 'ul'; }); select({ type: 'hl', id: hl.id }); }
      else { setSetting('hlStyle', S.settings.hlStyle === 'ul' ? 'hl' : 'ul'); toast(S.settings.hlStyle === 'ul' ? 'Underline mode.' : 'Highlight mode.'); }
      break;
    case 'a': case 'A': setTool('arrow'); break;
    case 'n': case 'N': {
      handled();
      const hl = S.sel?.type === 'hl' && S.ann.hls.find((h) => h.id === S.sel.id);
      if (hl) createLinkedNote(hl); else if (S.doc === 'nb') toast('Click on any line to start writing.'); else { setTool('note'); toast('Click where the note should go.'); }
      break;
    }
    case 'b': case 'B': {
      const hovered = $$('.sheet:hover')[0]; const pi = hovered ? +hovered.dataset.page : visiblePages()[0];
      toggleBookmark(pi); break;
    }
    case '[': jumpBookmark(-1); break;
    case ']': jumpBookmark(1); break;
    case 'g': case 'G': handled(); $('#pageInput').focus(); $('#pageInput').select(); break;
    case 'p': case 'P': toggleDrawer(); break;
    case 'd': case 'D': setSetting('spread', S.settings.spread === '1' ? '0' : '1'); break;
    case '-': case '_': if (S.doc === 'nb') break; setSetting('pdfScale', clamp(+(S.settings.pdfScale - 0.04).toFixed(2), 0.4, 1)); toast(`PDF text ${Math.round(S.settings.pdfScale * 100)}%`, 1200); break;
    case '=': case '+': if (S.doc === 'nb') break; setSetting('pdfScale', clamp(+(S.settings.pdfScale + 0.04).toFixed(2), 0.4, 1)); toast(`PDF text ${Math.round(S.settings.pdfScale * 100)}%`, 1200); break;
    case 'Delete': case 'Backspace': handled(); deleteSelected(); break;
    case '?': $('#help').hidden = false; break;
    default:
      if (/^[1-6]$/.test(k)) { setSetting('hlColor', HL_COLORS[+k - 1]); if (S.tool !== 'hl' && !S.sel) setTool('hl'); }
  }
}

/* ===================== wiring ===================== */
function wire() {
  $('#addBtn').addEventListener('click', () => $('#fileInput').click());
  $$('.lib-tabs button').forEach((b) => b.addEventListener('click', () => { if (!b.classList.contains('soon')) setLibTab(b.dataset.libtab); }));
  $('#newNbBtn').addEventListener('click', newNotebook);
  $('#bookTitle').addEventListener('click', () => { if (isStandalone()) renameNotebook(S.book); });
  $('#fileInput').addEventListener('change', (e) => { importFiles(e.target.files); e.target.value = ''; });
  $('#libFilter').addEventListener('input', debounce(renderLibrary, 120));
  $('#backupNotesBtn').addEventListener('click', () => backup(false));
  $('#backupAllBtn').addEventListener('click', () => backup(true));
  $('#restoreBtn').addEventListener('click', () => $('#restoreInput').click());
  $('#restoreInput').addEventListener('change', (e) => { if (e.target.files[0]) restore(e.target.files[0]); e.target.value = ''; });
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { if ($('#library').hidden || !e.dataTransfer?.types?.includes('Files')) return; dragDepth++; $('#dropHint').hidden = false; });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropHint').hidden = true; } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0; $('#dropHint').hidden = true;
    if ($('#library').hidden) return;
    const uri = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '').split(/\r?\n/).find((l) => /^https?:\/\//i.test(l.trim()));
    if (uri && !e.dataTransfer.files.length) { addLink(uri.trim()); return; }
    if (e.dataTransfer.files.length) importFiles(e.dataTransfer.files);
  });

  $('#backBtn').addEventListener('click', () => closeBook());
  $('#prevBtn').addEventListener('click', () => go(-1));
  $('#nextBtn').addEventListener('click', () => go(1));
  $('#pageInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const pi = parsePage(e.target.value); if (pi == null) toast('There’s no page with that number.'); else goToPage(pi); e.target.blur(); $('#stage').focus({ preventScroll: true }); }
    if (e.key === 'Escape') { updatePager(); e.target.blur(); }
  });
  $('#pageInput').addEventListener('focus', (e) => e.target.select());
  $('#pageInput').addEventListener('blur', updatePager);
  $$('.tool[data-tool]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.tool === 'hl' && S.tool === 'hl') setSetting('hlMode', S.settings.hlMode === 'free' ? 'snap' : 'free');
    else setTool(b.dataset.tool);
  }));
  $$('.docsw button').forEach((b) => b.addEventListener('click', () => switchDoc(b.dataset.doc === 'nb' ? 'nb' : bookDoc())));
  $('#edSetupBtn').addEventListener('click', openEditionSetup);
  $$('#edLayoutRow [data-lay]').forEach((b) => b.addEventListener('click', async () => {
    if (!S.book.edition) return;
    if (b.dataset.lay === 'ed') { if (!S.book.edition.enabled) { S.book.edition.enabled = true; await enableEdition(); } else switchDoc('ed'); }
    else { S.book.edition.enabled = false; syncEdUI(); scheduleSave(); switchDoc('book'); }
    syncEdUI();
  }));
  $('#findBtn').addEventListener('click', () => openFinder());
  $('#finderClose').addEventListener('click', closeFinder);
  $('#finder').addEventListener('click', (e) => { if (e.target.id === 'finder') closeFinder(); });
  $('#finderForm').addEventListener('submit', (e) => { e.preventDefault(); runFinder($('#finderInput').value); });
  $('#addPagesBtn').addEventListener('click', () => { addNotebookPages(2); updatePager(); toast('Added two pages at the end.'); });
  $('#snipBtn').addEventListener('click', snip);
  $('#zoomIn').addEventListener('click', () => zoomStep(1));
  $('#zoomOut').addEventListener('click', () => zoomStep(-1));
  $('#zoomReset').addEventListener('click', resetZoom);
  $('#zoomPct').addEventListener('click', resetZoom);
  $('#zoomArea').addEventListener('click', zoomToArea);
  $$('#fmtBar button').forEach((b) => {
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => applyFmt(b.dataset.cmd));
  });
  document.addEventListener('selectionchange', () => { if (fmtNote) syncFmt(); });
  if (IS_APP) {
    $('#openFolderBtn').hidden = false;
    $('#openFolderBtn').addEventListener('click', () => window.native.openFolder());
    window.native.onFlush(async () => { commitEditing(); await saveNow(); await flushPendingRemovals(); });
  }
  // Hold Space and drag to move around a zoomed page.
  document.addEventListener('keyup', (e) => { if (e.key === ' ') { S.spaceDown = false; $('#stage').classList.remove('panning'); } });
  $('#stage').addEventListener('pointerdown', (e) => {
    if (!S.spaceDown && e.button !== 1) return;
    e.preventDefault(); e.stopPropagation();
    const st = $('#stage'), start = [e.clientX, e.clientY, st.scrollLeft, st.scrollTop];
    st.setPointerCapture(e.pointerId); st.classList.add('grabbing');
    const mv = (m) => { st.scrollLeft = start[2] - (m.clientX - start[0]); st.scrollTop = start[3] - (m.clientY - start[1]); };
    const up = () => { st.removeEventListener('pointermove', mv); st.removeEventListener('pointerup', up); st.classList.remove('grabbing'); };
    st.addEventListener('pointermove', mv); st.addEventListener('pointerup', up);
  }, true);
  $('#undoBtn').addEventListener('click', undo);
  $('#redoBtn').addEventListener('click', redo);
  $('#bmBtn').addEventListener('click', () => toggleBookmark(visiblePages()[0]));
  $('#searchBtn').addEventListener('click', () => ($('#searchBox').hidden ? openSearch() : closeSearch()));
  $('#drawerBtn').addEventListener('click', toggleDrawer);
  $('#helpBtn').addEventListener('click', () => { $('#help').hidden = false; });
  $('#helpClose').addEventListener('click', () => { $('#help').hidden = true; });
  $('#help').addEventListener('click', (e) => { if (e.target.id === 'help') $('#help').hidden = true; });
  $$('#drawer .tabs button').forEach((b) => b.addEventListener('click', () => { S.drawerTab = b.dataset.tab; refreshDrawer(); }));

  const si = $('#searchInput');
  const doSearch = debounce(() => runSearch(si.value), 220);
  si.addEventListener('input', doSearch);
  si.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (normQuery(si.value) !== normQuery(S.search.q)) runSearch(si.value); else gotoResult(S.search.cur + (e.shiftKey ? -1 : 1)); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSearch(); }
  });
  $('#sPrev').addEventListener('click', () => gotoResult(S.search.cur - 1));
  $('#sNext').addEventListener('click', () => gotoResult(S.search.cur + 1));
  $('#sClose').addEventListener('click', closeSearch);

  document.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.menu')) closeMenus();
    if (!e.target.closest('#pop') && !e.target.closest('.sheet')) hidePop();
  });
  $('#stage').addEventListener('scroll', () => { hidePop(); placeFmt(); }, { passive: true });
  $('#stage').addEventListener('wheel', (e) => { if (!(e.ctrlKey || e.metaKey) || !S.settings) return; e.preventDefault(); setZoom(S.settings.zoom * Math.pow(1.0018, -e.deltaY), { x: e.clientX, y: e.clientY }); }, { passive: false });
  new ResizeObserver(debounce(() => {
    const st = $('#stage'); const size = st.clientWidth + 'x' + st.clientHeight;
    if (S.book && !$('#reader').hidden && size !== S.lastStage) relayout();
  }, 180)).observe($('#stage'));
  $('#pop').addEventListener('mousedown', (e) => e.preventDefault());
  const flush = () => { if (S.book) saveNow(); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  window.addEventListener('pagehide', flush);
  window.addEventListener('pagehide', () => { flushPendingRemovals(); });
  window.addEventListener('beforeunload', flush);
  window.addEventListener('error', (e) => console.error(e.error || e.message));
}

async function init() {
  renderShortcuts($('#shortcutList'));
  renderShortcuts($('#helpList'));
  try { await DB.open(); }
  catch (e) { $('#boot').innerHTML = '<p>Rose’s generic study app can’t save here (private browsing blocks storage).</p>'; return; }
  try { await loadPdfjs(); }
  catch (e) { console.error(e); $('#boot').innerHTML = '<p>Rose’s generic study app couldn’t start its PDF engine.</p>'; return; }
  wire(); wireMenus(); wireStudy();
  $('#boot').remove();
  $('#reader').hidden = true; $('#library').hidden = false;
  setLibTab(libTab); updateStorageInfo();
}
