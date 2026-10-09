'use strict';
// Rose's generic study app — desktop shell. Stores everything as plain files in the app's own data
// folder (%APPDATA%\Rose's generic study app\Library), independent of any web browser.
const { app, BrowserWindow, ipcMain, protocol, net, shell, clipboard, ClipboardItem, Menu, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

protocol.registerSchemesAsPrivileged([
  { scheme: 'ra', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);
// The app used to be called "Rose's Annotations". Move its saved library across to the new name, once.
(function moveOldLibrary() {
  try {
    const appData = app.getPath('appData');
    const oldDir = path.join(appData, "Rose's Annotations");
    const newDir = path.join(appData, app.getName());
    if (oldDir === newDir || !fs.existsSync(path.join(oldDir, 'Library'))) { app.setPath('userData', newDir); return; }
    if (!fs.existsSync(path.join(newDir, 'Library'))) {
      fs.mkdirSync(newDir, { recursive: true });
      try {
        fs.renameSync(path.join(oldDir, 'Library'), path.join(newDir, 'Library'));
        for (const f of ['window.json', 'gd-breaks.json']) { try { if (!fs.existsSync(path.join(newDir, f))) fs.copyFileSync(path.join(oldDir, f), path.join(newDir, f)); } catch {} }
      } catch { app.setPath('userData', oldDir); return; } // couldn't move it (e.g. in use): keep using it where it is
    }
    app.setPath('userData', newDir);
  } catch {}
})();
if (!app.requestSingleInstanceLock()) { app.quit(); }

const APP_DIR = path.join(__dirname, '..', 'app');
const DATA = () => path.join(app.getPath('userData'), 'Library');
const DIRS = { books: 'books', files: 'pdfs', annots: 'notes', text: 'search-index', assets: 'images', notebooks: 'notebooks', links: 'links', stacks: 'flashcards' };
const safeName = (id) => encodeURIComponent(String(id)).replace(/\*/g, '%2A').replace(/\.+$/, '_');
function fileFor(store, id) {
  if (!DIRS[store]) throw new Error('unknown store ' + store);
  const ext = store === 'files' ? '.pdf' : store === 'assets' ? '' : '.json';
  return path.join(DATA(), DIRS[store], safeName(id) + ext);
}
async function writeAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, data);
  for (let i = 0; ; i++) {
    try { await fsp.rename(tmp, file); return; }
    catch (e) { if (i >= 5) throw e; await new Promise((r) => setTimeout(r, 60 * (i + 1))); }
  }
}
// One copy of each book's notes per day, kept for two weeks, in case something is deleted by mistake.
const snapped = new Set();
async function dailyCopy(id) {
  const day = new Date().toISOString().slice(0, 10);
  const key = day + id; if (snapped.has(key)) return; snapped.add(key);
  const src = fileFor('annots', id);
  try {
    await fsp.access(src);
    const dir = path.join(DATA(), 'history', day);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.copyFile(src, path.join(dir, path.basename(src)));
    const days = (await fsp.readdir(path.join(DATA(), 'history'))).sort();
    for (const old of days.slice(0, Math.max(0, days.length - 14))) await fsp.rm(path.join(DATA(), 'history', old), { recursive: true, force: true });
  } catch {}
}

ipcMain.handle('db:get', async (_e, store, id) => {
  try {
    const buf = await fsp.readFile(fileFor(store, id));
    return store === 'files' ? new Uint8Array(buf) : JSON.parse(buf.toString('utf8'));
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
});
ipcMain.handle('db:put', async (_e, store, value) => {
  if (store === 'files') return writeAtomic(fileFor('files', value.id), Buffer.from(value.data));
  if (store === 'annots') await dailyCopy(value.id);
  return writeAtomic(fileFor(store, value.id), JSON.stringify(value));
});
ipcMain.handle('db:all', async (_e, store) => {
  const dir = path.join(DATA(), DIRS[store]);
  let names = [];
  try { names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const n of names) { try { out.push(JSON.parse(await fsp.readFile(path.join(dir, n), 'utf8'))); } catch {} }
  return out;
});
ipcMain.handle('db:del', async (_e, store, id) => { await fsp.rm(fileFor(store, id), { force: true }); });
ipcMain.handle('asset:put', async (_e, bytes, ext) => {
  ext = String(ext || 'png').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'png';
  const buf = Buffer.from(bytes);
  const id = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20) + '.' + ext;
  const file = fileFor('assets', id);
  try { await fsp.access(file); } catch { await writeAtomic(file, buf); }
  return id;
});
ipcMain.handle('asset:get', async (_e, id) => {
  try { return new Uint8Array(await fsp.readFile(fileFor('assets', id))); } catch { return null; }
});
ipcMain.handle('snip', async (e, r) => {
  const wc = e.sender;
  const rect = { x: Math.round(r.x), y: Math.round(r.y), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) };
  const img = await wc.capturePage(rect);
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([img.toPNG()], { type: 'image/png' }) })]);
  const s = img.getSize();
  return { width: s.width, height: s.height };
});
// ---------- online book search (only free, legal sources) ----------
const WEB_HOSTS = ['openlibrary.org', 'gutendex.com', 'gutenberg.org', 'archive.org', 'googleapis.com', 'gutenberg.pglaf.org'];
const hostOk = (u) => { try { const h = new URL(u).hostname; return new URL(u).protocol === 'https:' && WEB_HOSTS.some((d) => h === d || h.endsWith('.' + d)); } catch { return false; } };
ipcMain.handle('web:get', async (e, url, kind, jobId) => {
  if (!hostOk(url)) throw new Error('Not an allowed book source: ' + url);
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), kind === 'bytes' ? 600000 : 30000);
  try {
    const res = await net.fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': "RosesStudyApp/1.4 (personal study app)", Accept: kind === 'json' ? 'application/json' : '*/*' } });
    if (!hostOk(res.url || url)) throw new Error('Redirected away from the book source');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    if (kind === 'json') return await res.json();
    if (kind === 'text') return await res.text();
    const total = +res.headers.get('content-length') || 0;
    if (total > 400e6) throw new Error('File too large');
    const reader = res.body.getReader(); const chunks = []; let got = 0, last = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      chunks.push(value); got += value.length;
      if (got > 400e6) throw new Error('File too large');
      if (jobId && Date.now() - last > 250) { last = Date.now(); e.sender.send('web:progress', jobId, got, total); }
    }
    return new Uint8Array(Buffer.concat(chunks.map((c) => Buffer.from(c))));
  } finally { clearTimeout(timer); }
});
// ---------- page titles for saved links (any https page; only the <title> is read) ----------
ipcMain.handle('web:title', async (_e, url) => {
  let u; try { u = new URL(String(url)); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await net.fetch(u.href, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) RosesStudyApp/1.4', Accept: 'text/html' } });
    if (!res.ok || !/html/i.test(res.headers.get('content-type') || '')) return null;
    const reader = res.body.getReader(); let html = '', got = 0;
    while (got < 300000) { const { done, value } = await reader.read(); if (done) break; got += value.length; html += Buffer.from(value).toString('utf8'); if (/<\/head>/i.test(html)) break; }
    try { reader.cancel(); } catch {}
    const pick = (re) => { const m = html.match(re); return m ? m[1] : null; };
    const raw = pick(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)/i) || pick(/<title[^>]*>([^<]{1,300})<\/title>/i);
    if (!raw) return null;
    return raw.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(+n)).replace(/\s+/g, ' ').trim();
  } catch { return null; } finally { clearTimeout(timer); }
});
ipcMain.handle('open-folder', async () => { await fsp.mkdir(DATA(), { recursive: true }); return shell.openPath(DATA()); });
ipcMain.handle('open-external', async (_e, url) => { if (/^(https?:|mailto:)/i.test(String(url))) await shell.openExternal(String(url)); });
ipcMain.handle('info', async () => ({ dataDir: DATA(), version: app.getVersion() }));

// ---------- window ----------
const stateFile = () => path.join(app.getPath('userData'), 'window.json');
function loadState() { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return { width: 1400, height: 900, maximized: true }; } }
let win = null, gate = null;
function createWindow() {
  const st = loadState();
  win = new BrowserWindow({
    width: st.width || 1400, height: st.height || 900, x: st.x, y: st.y, minWidth: 900, minHeight: 600,
    backgroundColor: '#1e3832', title: "Rose's generic study app", show: false, autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
  });
  if (st.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.loadURL('ra://app/index.html');
  win.webContents.setVisualZoomLevelLimits(1, 1);
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^(https?:|mailto:)/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (ev, url) => { if (!url.startsWith('ra://app/')) { ev.preventDefault(); if (/^(https?:|mailto:)/i.test(url)) shell.openExternal(url); } });
  win.webContents.on('before-input-event', (ev, input) => {
    // Block reload / dev shortcuts so a stray key can't lose unsaved typing.
    if ((input.control || input.meta) && ['r', 'R'].includes(input.key)) ev.preventDefault();
    if (input.key === 'F5') ev.preventDefault();
  });
  win.webContents.on('context-menu', (_ev, p) => {
    const items = [];
    for (const s of p.dictionarySuggestions || []) items.push({ label: s, click: () => win.webContents.replaceMisspelling(s) });
    if (p.misspelledWord) items.push({ label: 'Add to dictionary', click: () => win.webContents.session.addWordToSpellCheckerDictionary(p.misspelledWord) }, { type: 'separator' });
    if (p.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' }, { role: 'selectAll' });
    else if (p.selectionText) items.push({ role: 'copy' });
    if (p.linkURL && /^https?:/i.test(p.linkURL)) items.push({ label: 'Open link in browser', click: () => shell.openExternal(p.linkURL) }, { label: 'Copy link', click: () => clipboard.writeText(p.linkURL) });
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
  let flushed = false;
  win.on('close', (ev) => {
    try {
      const b = win.getNormalBounds();
      fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
    } catch {}
    if (flushed) return;
    ev.preventDefault();
    const done = () => { if (flushed) return; flushed = true; win.close(); };
    ipcMain.once('flushed', done);
    setTimeout(done, 2500);
    win.webContents.send('flush');
  });
  win.on('closed', () => { win = null; });
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(() => {
  protocol.handle('ra', (req) => {
    const u = new URL(req.url);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    let file;
    if (u.host === 'app') file = path.join(APP_DIR, rel || 'index.html');
    else if (u.host === 'asset') file = fileFor('assets', rel);
    else return new Response('Not found', { status: 404 });
    const base = u.host === 'app' ? APP_DIR : path.join(DATA(), DIRS.assets);
    if (!path.resolve(file).startsWith(path.resolve(base))) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  try { session.defaultSession.setSpellCheckerLanguages(['en-GB']); } catch {}
  if (process.platform === 'darwin') Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
  else Menu.setApplicationMenu(null);
  createWindow();
  // Flashcard games (Geometry Dash breaks) are switched off for now; flip this to true to turn them back on.
  const GAMES_ENABLED = false;
  if (GAMES_ENABLED) gate = require('./gd').createGate({ getWin: () => win, prefsFile: path.join(app.getPath('userData'), 'gd-breaks.json'), appResources: process.resourcesPath || '' });
});
app.on('window-all-closed', () => app.quit());
// Never leave Geometry Dash frozen.
app.on('will-quit', () => { try { gate?.shutdown(); } catch {} });
process.on('exit', () => { try { gate?.shutdown(); } catch {} });
