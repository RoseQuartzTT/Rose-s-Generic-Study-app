/* ===================== library tabs and standalone notebooks =====================
   A standalone notebook is the same lined A4 notebook as a book's, but not tied to any book.
   It's stored in the "notebooks" store: { id, title, color, createdAt, openedAt, updatedAt, lastPage, settings, content }. */
const NB_COVERS = ['#2f5d8a', '#a3282c', '#2c6a5a', '#6b3fa0', '#c77a1e', '#3c4a5c', '#b8577a', '#4f7a2a'];
const isStandalone = () => S.book?.kind === 'notebook';
let libTab = LS.get('libTab', 'books');

const LIB_TABS = {
  books: { find: 'Find a book', label: 'Your books' },
  notebooks: { find: 'Find a notebook', label: 'Your notebooks' },
  links: { find: 'Find a link', label: 'Your links' },
  cards: { find: 'Find a stack or card', label: 'Your flashcard stacks' },
  games: { find: '', label: 'Flashcard games' },
};
function setLibTab(t) {
  if (!LIB_TABS[t]) t = 'books';
  if (t === 'games' && !GD.status?.running) t = 'cards';
  if (t !== libTab) $('#libFilter').value = '';
  libTab = t; if (t !== 'games') LS.set('libTab', libTab);
  $$('.lib-tabs button').forEach((b) => { const on = b.dataset.libtab === libTab; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
  $$('[data-tabonly]').forEach((x) => { x.hidden = !x.dataset.tabonly.split(' ').includes(libTab); });
  $('#libFilter').hidden = t === 'games';
  $('#libFilter').placeholder = LIB_TABS[t].find;
  $('#libFilter').setAttribute('aria-label', LIB_TABS[t].find);
  $('#shelf').setAttribute('aria-label', LIB_TABS[t].label);
  $('#library').dataset.tab = t;
  renderLibrary();
}

/* ---------- "has this been edited?" ---------- */
const hasContent = (a) => !!a && ((a.notes?.length || 0) + (a.hls?.length || 0) + (a.arrows?.length || 0) + (a.bms?.length || 0)) > 0;
function nbStats(c) {
  const n = normalizeNb(c), texts = n.notes.filter((x) => !x.img && htmlToText(x.html)).length, imgs = n.notes.filter((x) => x.img).length;
  return { pages: n.pages, texts, imgs, hls: n.hls.length, edited: hasContent(n) || n.pages > 2 };
}
async function bookStats(id) {
  const rec = await DB.get('annots', id);
  const book = normalizeAnn(rec, id), nb = normalizeNb(rec?.nb), ed = normalizeAnn(rec?.ed, id);
  return {
    hls: book.hls.length + ed.hls.length, notes: book.notes.length + ed.notes.length, bms: book.bms.length + ed.bms.length,
    nb: nb.notes.length + nb.hls.length, edited: hasContent(book) || hasContent(nb) || hasContent(ed) || nb.pages > 2,
  };
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
function listBits(bits) { bits = bits.filter(Boolean); return bits.length < 2 ? bits.join('') : bits.slice(0, -1).join(', ') + ' and ' + bits[bits.length - 1]; }

/* ---------- removing, with an "are you sure?" whenever there's work to lose ---------- */
// Unedited items vanish straight away but can be brought back for a few seconds; nothing is deleted until then.
const pendingRemovals = new Map();
function scheduleRemoval(key, label, commit) {
  const t = setTimeout(async () => { pendingRemovals.delete(key); await commit(); updateStorageInfo(); }, 7000);
  pendingRemovals.set(key, { t, commit });
  renderLibrary();
  toastAction(`${label} removed.`, 'Undo', () => { const p = pendingRemovals.get(key); if (p) { clearTimeout(p.t); pendingRemovals.delete(key); renderLibrary(); toast(`${label} is back.`); } }, 7000);
}
async function flushPendingRemovals() {
  for (const [key, p] of [...pendingRemovals]) { clearTimeout(p.t); pendingRemovals.delete(key); try { await p.commit(); } catch (e) { console.error(e); } }
}
const isPending = (key) => pendingRemovals.has(key);

async function removeBookFlow(b) {
  const st = await bookStats(b.id);
  const commit = async () => { for (const s of ['books', 'files', 'annots', 'text']) await DB.del(s, b.id); await DB.del('text', b.id + '#flow'); };
  if (!st.edited) { scheduleRemoval('book:' + b.id, `“${b.title}”`, commit); return; }
  const lose = listBits([st.hls && plural(st.hls, 'highlight'), st.notes && plural(st.notes, 'note'), st.bms && plural(st.bms, 'bookmark'), st.nb && 'everything in its notebook', b.edition?.anchors?.length && 'its edition matching']);
  const ok = await ask({ title: `Remove “${b.title}”?`, body: `You’ve worked on this book. Removing it permanently deletes the PDF along with ${lose || 'your changes'}. This can’t be undone. Use “Back up notes” first if you might want them later.`, ok: 'Remove book', danger: true });
  if (!ok) return;
  await commit(); toast('Book removed.'); renderLibrary(); updateStorageInfo();
}
async function removeNotebookFlow(nb) {
  const st = nbStats(nb.content);
  const commit = () => DB.del('notebooks', nb.id);
  if (!st.edited) { scheduleRemoval('nb:' + nb.id, `“${nb.title}”`, commit); return; }
  const lose = listBits([st.texts && plural(st.texts, 'piece') + ' of writing', st.imgs && plural(st.imgs, 'image'), st.hls && plural(st.hls, 'highlight')]);
  const ok = await ask({ title: `Delete “${nb.title}”?`, body: `This notebook has ${plural(st.pages, 'page')}${lose ? ' with ' + lose : ''}. Deleting it can’t be undone. Use “Back up notes” first if you might want it later.`, ok: 'Delete notebook', danger: true });
  if (!ok) return;
  await commit(); toast('Notebook deleted.'); renderLibrary(); updateStorageInfo();
}

/* ---------- the Notebooks tab ---------- */
async function renderNotebookShelf(shelf, q) {
  const all = (await DB.all('notebooks')).filter((n) => !isPending('nb:' + n.id)).sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  const list = all.filter((n) => !q || n.title.toLowerCase().includes(q) || nbSearchText(n).includes(q));
  const grid = el('div', { class: 'shelf-grid' });
  if (!q) grid.append(el('button', { class: 'nb-new', type: 'button', onclick: newNotebook }, el('span', { class: 'plus', text: '+' }), el('span', { text: 'New notebook' })));
  for (const n of list) grid.append(notebookCard(n));
  if (q && !list.length) grid.append(el('div', { class: 'empty' }, el('p', { text: `No notebooks match “${q}”.` })));
  shelf.append(grid);
  if (!all.length && !q) shelf.append(el('p', { class: 'nb-hint muted', text: 'Notebooks here aren’t tied to any one book — use them for themes, lectures, essay plans or anything that spans several texts. Snips from any book can be pasted in, and keep a link back to their page.' }));
  // Notebooks that belong to a book, so everything you've written is reachable from one place.
  const books = S.books.filter((b) => b.counts?.nb && !isPending('book:' + b.id) && (!q || b.title.toLowerCase().includes(q)));
  if (books.length) {
    shelf.append(el('h2', { class: 'shelf-head', text: 'Notebooks inside your books' }));
    const g2 = el('div', { class: 'shelf-grid' });
    for (const b of books) {
      const card = el('div', { class: 'book nbook in-book', tabindex: 0, role: 'button', 'aria-label': `Open the notebook for ${b.title}` },
        el('div', { class: 'cover-wrap' }, el('div', { class: 'nb-cover', style: { '--cov': '#4a3423' } }, el('div', { class: 'nb-label' }, el('span', { class: 'nb-name', text: b.title }), el('span', { class: 'nb-sub', text: 'Book notebook' })))),
        el('div', { class: 'cap' }, el('h3', { text: b.title }), el('div', { class: 'meta', text: 'Opens with the book' })));
      const open = async () => { await openBook(b.id); await switchDoc('nb'); };
      card.addEventListener('click', open);
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      g2.append(card);
    }
    shelf.append(g2);
  }
}
function nbSearchText(n) { return normalizeNb(n.content).notes.map((x) => htmlToText(x.html)).join(' ').toLowerCase(); }
function shortDate(t) {
  if (!t) return '';
  const d = new Date(t), now = new Date();
  if (d.toDateString() === now.toDateString()) return 'today';
  const y = new Date(now); y.setDate(now.getDate() - 1); if (d.toDateString() === y.toDateString()) return 'yesterday';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}
function notebookCard(n) {
  const st = nbStats(n.content);
  const bits = [plural(st.pages, 'page')];
  if (st.edited) bits.push('edited ' + shortDate(n.updatedAt));
  const card = el('div', { class: 'book nbook', tabindex: 0, role: 'button', 'aria-label': `Open notebook ${n.title}` },
    el('div', { class: 'bk-menu' },
      el('button', { type: 'button', text: 'Rename', onclick: (e) => { e.stopPropagation(); renameNotebook(n); } }),
      el('button', { type: 'button', text: 'Colour', title: 'Change the cover colour', onclick: (e) => { e.stopPropagation(); recolourNotebook(n); } }),
      el('button', { type: 'button', text: 'Delete', onclick: (e) => { e.stopPropagation(); removeNotebookFlow(n); } })),
    el('div', { class: 'cover-wrap' }, el('div', { class: 'nb-cover', style: { '--cov': n.color || NB_COVERS[0] } },
      el('div', { class: 'nb-label' }, el('span', { class: 'nb-name', text: n.title }), el('span', { class: 'nb-sub', text: 'Notebook' })))),
    el('div', { class: 'cap' }, el('h3', { text: n.title, title: n.title }), el('div', { class: 'meta', text: bits.join(' · ') })));
  card.addEventListener('click', () => openNotebook(n.id));
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openNotebook(n.id); } if (e.key === 'Delete') removeNotebookFlow(n); if (e.key === 'F2') renameNotebook(n); });
  return card;
}
async function newNotebook() {
  const name = await ask({ title: 'New notebook', body: 'Give it a name — a theme, a module, a lecture series. You can rename it any time.', input: '', ok: 'Create notebook' });
  if (name == null) return;
  const count = (await DB.all('notebooks')).length;
  const title = name.trim() || `Notebook ${count + 1}`;
  const now = Date.now();
  const nb = { id: 'nb-' + uid(), kind: 'notebook', title, color: NB_COVERS[count % NB_COVERS.length], createdAt: now, updatedAt: now, openedAt: 0, lastPage: 0, settings: { ...DEFAULTS, ...LS.get('defaults', {}) }, content: normalizeNb(null) };
  await DB.put('notebooks', nb);
  await openNotebook(nb.id);
  toast('Click on any line to start writing.');
}
async function renameNotebook(n) {
  const v = await ask({ title: 'Rename notebook', input: n.title, ok: 'Rename' });
  if (v == null || !v.trim()) return;
  const rec = await DB.get('notebooks', n.id); if (!rec) return;
  rec.title = v.trim(); await DB.put('notebooks', rec);
  if (S.book?.id === n.id) { S.book.title = rec.title; $('#bookTitle').textContent = rec.title; document.title = rec.title + " — Rose's generic study app"; }
  renderLibrary();
}
async function recolourNotebook(n) {
  const rec = await DB.get('notebooks', n.id); if (!rec) return;
  const i = NB_COVERS.indexOf(rec.color);
  rec.color = NB_COVERS[(i + 1) % NB_COVERS.length]; await DB.put('notebooks', rec); renderLibrary();
}

/* ---------- opening a standalone notebook ---------- */
async function openNotebook(id) {
  const meta = await DB.get('notebooks', id);
  if (!meta) { toast('That notebook couldn’t be found.'); return; }
  meta.kind = 'notebook';
  S.pdf = null; S.book = meta; S.settings = { ...DEFAULTS, ...(meta.settings || {}) };
  S.nbAnn = normalizeNb(meta.content);
  S.bookAnn = normalizeAnn(null, id); S.edAnn = normalizeAnn(null, id);
  S.flow = null; S.flowNorm = null; S.ed = null; S.edIndex = null; S.edPick = null;
  S.doc = 'nb'; S.ann = S.nbAnn;
  S.stacks = { book: { undo: [], redo: [] }, nb: { undo: [], redo: [] }, ed: { undo: [], redo: [] } };
  S.pos = { book: 0, nb: 0, ed: 0 };
  S.labels = null; S.outline = null; S.index = null; S.indexing = null; S.search = { q: '', results: [], cur: -1 };
  S.undo = S.stacks.nb.undo; S.redo = S.stacks.nb.redo; S.cache.clear(); S.textCache.clear(); S.sel = null; S.pendingArrow = null;
  meta.openedAt = Date.now(); DB.put('notebooks', meta);
  $('#library').hidden = true; $('#reader').hidden = false;
  $('#bookTitle').textContent = meta.title; $('#bookTitle').title = 'Click to rename'; document.title = meta.title + " — Rose's generic study app";
  $('#searchInput').value = ''; $('#searchResults').textContent = ''; $('#searchCount').textContent = ''; $('#searchBox').hidden = true;
  closeDrawer(); syncControls(); setTool('select'); updateUndoBtns(); setSaved(''); updateDocUI(); syncEdUI();
  S.spreads = computeSpreads();
  await showSpread(spreadOf(clamp(meta.lastPage || 0, 0, numPages() - 1)), 0);
  $('#stage').focus({ preventScroll: true });
}
async function saveNotebookNow() {
  S.book.settings = S.settings;
  S.book.content = S.nbAnn;
  S.book.updatedAt = Date.now();
  await DB.put('notebooks', S.book);
}

/* ---------- jumping from a snip to a page of a different book ---------- */
async function openBookAt(bookId, pi, doc) {
  const b = await DB.get('books', bookId);
  if (!b) { toast('The book this snip came from isn’t on your shelf any more.'); return; }
  await closeBook(true);
  await openBook(bookId);
  const target = doc === 'ed' && S.ed ? 'ed' : 'book';
  if (S.doc !== target) await switchDoc(target, pi); else await goToPage(pi);
}
function exportNotebook() {
  const nb = S.nbAnn, lines = [S.book.title, `Exported from Rose's generic study app on ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`, ''];
  const blocks = nb.notes.slice().sort((x, y) => x.page - y.page || x.y - y.y || x.x - y.x);
  if (!blocks.length) { toast('This notebook is empty.'); return; }
  let pg = -1;
  for (const n of blocks) {
    if (n.page !== pg) { if (pg >= 0) lines.push(''); pg = n.page; lines.push(`Page ${pg + 1}`); }
    lines.push('  ' + (n.img ? '[image' + (n.srcPage != null ? ` from ${n.srcTitle || 'a book'}, p. ${n.srcLabel ?? n.srcPage + 1}` : '') + ']' : htmlToText(n.html).replace(/\n/g, '\n  ')));
  }
  const safe = S.book.title.replace(/[\\/:*?"<>|]+/g, '').slice(0, 60) || 'Notebook';
  download(`${safe}.txt`, new Blob(['﻿' + lines.join('\n').replace(/\r?\n/g, '\r\n')], { type: 'text/plain;charset=utf-8' }));
  toast('Notebook exported.');
}
