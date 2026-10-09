/* ===================== Links, Flashcards and Flashcard games ===================== */

/* ---------- a small multi-field dialog ---------- */
function formDialog({ title, intro, fields, ok = 'Save', danger, extra }) {
  return new Promise((res) => {
    const card = $('#dialogCard'); card.textContent = '';
    const inputs = {};
    const form = el('form', { class: 'fdlg' });
    for (const f of fields) {
      const inp = f.multiline
        ? el('textarea', { rows: 3, placeholder: f.placeholder || '' })
        : el('input', { type: 'text', placeholder: f.placeholder || '', list: f.list ? 'dl-' + f.key : null, spellcheck: f.key === 'url' ? 'false' : null });
      inp.value = f.value || '';
      inputs[f.key] = inp;
      form.append(el('label', {}, f.label, inp, f.hint ? el('span', { class: 'fhint', text: f.hint }) : null,
        f.list ? el('datalist', { id: 'dl-' + f.key }, ...f.list.map((v) => el('option', { value: v }))) : null));
    }
    const close = (v) => { $('#dialog').hidden = true; document.removeEventListener('keydown', onKey, true); res(v); };
    const okBtn = el('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), type: 'submit', text: ok });
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
    form.addEventListener('submit', (e) => { e.preventDefault(); const out = {}; for (const [k, i] of Object.entries(inputs)) out[k] = i.value.trim(); close(out); });
    form.append(el('div', { class: 'dlg-btns' }, extra || null, el('span', { style: { flex: 1 } }), el('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => close(null) }), okBtn));
    card.append(...[el('h2', { text: title }), intro ? el('p', { class: 'muted', text: intro }) : null, form].filter(Boolean));
    $('#dialog').hidden = false; document.addEventListener('keydown', onKey, true);
    const first = fields.find((f) => !f.value) || fields[0];
    inputs[first.key].focus(); inputs[first.key].select?.();
    if (fields.some((f) => f.onReady)) fields.forEach((f) => f.onReady?.(inputs));
  });
}
const hashHue = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; };

/* =============================== LINKS =============================== */
function normaliseUrl(u) {
  u = String(u || '').trim(); if (!u) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u.replace(/^\/+/, '');
  try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; }
}
const domainOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
async function fetchTitle(url) { if (!IS_APP || !window.native.webTitle) return null; try { return await window.native.webTitle(url); } catch { return null; } }

async function renderLinks(root, q) {
  const all = (await DB.all('links')).filter((l) => !isPending('link:' + l.id));
  const list = all.filter((l) => !q || [l.title, l.url, l.note, l.group].join(' ').toLowerCase().includes(q));
  const wrap = el('div', { class: 'links-wrap' });
  root.append(wrap);
  if (!all.length) {
    wrap.append(el('div', { class: 'empty' },
      el('h2', { text: 'Keep your useful pages here' }),
      el('p', { text: 'Reading lists, Moodle pages, articles, JSTOR searches, lecture recordings — save them once and open them with one click.' }),
      el('button', { class: 'btn primary', type: 'button', text: 'Add a link', onclick: () => addLink() }),
      el('p', { class: 'small', style: { marginTop: '14px', marginBottom: 0 }, text: 'You can also paste a web address here with Ctrl+V, or drag a link in from your browser.' })));
    return;
  }
  if (!list.length) { wrap.append(el('div', { class: 'empty' }, el('p', { text: `No links match “${q}”.` }))); return; }
  const groups = new Map();
  for (const l of list.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'en-GB'))) {
    const g = l.group || ''; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(l);
  }
  const names = [...groups.keys()].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b, 'en-GB'));
  for (const g of names) {
    const sec = el('section', { class: 'lgroup' }, el('h2', { class: 'shelf-head', text: g || (names.length > 1 ? 'Other links' : 'Your links') }));
    const grid = el('div', { class: 'lgrid' });
    for (const l of groups.get(g)) grid.append(linkCard(l));
    sec.append(grid); wrap.append(sec);
  }
}
function linkCard(l) {
  const d = domainOf(l.url);
  const open = () => { openExternal(l.url); l.openedAt = Date.now(); DB.put('links', l); };
  const card = el('div', { class: 'lcard', tabindex: 0, role: 'link', title: l.url },
    el('span', { class: 'ltile', style: { '--h': hashHue(d) }, text: (d.match(/[a-z0-9]/i) || ['?'])[0].toUpperCase() }),
    el('div', { class: 'lmeta' }, el('div', { class: 'ltitle', text: l.title || d }), el('div', { class: 'ldom', text: d }), l.note ? el('div', { class: 'lnote', text: l.note }) : null),
    el('div', { class: 'lact' },
      el('button', { type: 'button', class: 'ibtn sm', title: 'Edit', html: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>', onclick: (e) => { e.stopPropagation(); editLink(l); } }),
      el('button', { type: 'button', class: 'ibtn sm', title: 'Copy address', html: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3"/></svg>', onclick: async (e) => { e.stopPropagation(); try { await navigator.clipboard.writeText(l.url); toast('Address copied.'); } catch {} } }),
      el('button', { type: 'button', class: 'ibtn sm', title: 'Remove', html: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>', onclick: (e) => { e.stopPropagation(); removeLink(l); } })));
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); if (e.key === 'Delete') removeLink(l); });
  return card;
}
async function linkGroups() { return [...new Set((await DB.all('links')).map((l) => l.group).filter(Boolean))].sort(); }
async function addLink(prefill = '') {
  const groups = await linkGroups();
  let titleTouched = false;
  const v = await formDialog({
    title: 'Add a link', ok: 'Add link',
    fields: [
      { key: 'url', label: 'Web address', value: prefill, placeholder: 'https://…', onReady: (inp) => {
        const fill = async () => {
          const u = normaliseUrl(inp.url.value); if (!u || titleTouched || inp.title.value) return;
          inp.title.placeholder = 'Fetching the page title…';
          const t = await fetchTitle(u);
          if (t && !titleTouched && !inp.title.value) inp.title.value = t;
          inp.title.placeholder = 'Name for this link';
        };
        inp.url.addEventListener('change', fill); inp.url.addEventListener('blur', fill);
        inp.title.addEventListener('input', () => { titleTouched = true; });
        if (prefill) fill();
      } },
      { key: 'title', label: 'Name', placeholder: 'Name for this link' },
      { key: 'group', label: 'Group (optional)', placeholder: 'e.g. Modernism module, Essay 1', list: groups },
      { key: 'note', label: 'Note (optional)', placeholder: 'Why it’s useful', multiline: true },
    ],
  });
  if (!v) return;
  const url = normaliseUrl(v.url);
  if (!url) { toast('That doesn’t look like a web address.'); return; }
  let title = v.title;
  if (!title) title = (await fetchTitle(url)) || domainOf(url);
  await DB.put('links', { id: 'ln-' + uid(), url, title, group: v.group, note: v.note, createdAt: Date.now() });
  toast('Link saved.');
  if (libTab !== 'links') setLibTab('links'); else renderLibrary();
}
async function editLink(l) {
  const v = await formDialog({
    title: 'Edit link', ok: 'Save',
    fields: [
      { key: 'url', label: 'Web address', value: l.url },
      { key: 'title', label: 'Name', value: l.title },
      { key: 'group', label: 'Group (optional)', value: l.group, list: await linkGroups() },
      { key: 'note', label: 'Note (optional)', value: l.note, multiline: true },
    ],
  });
  if (!v) return;
  const url = normaliseUrl(v.url); if (!url) { toast('That doesn’t look like a web address.'); return; }
  Object.assign(l, { url, title: v.title || domainOf(url), group: v.group, note: v.note });
  await DB.put('links', l); renderLibrary();
}
function removeLink(l) { scheduleRemoval('link:' + l.id, `“${l.title || domainOf(l.url)}”`, () => DB.del('links', l.id)); }

/* ============================ FLASHCARDS ============================ */
const STACK_COLOURS = ['#2c6a5a', '#2f5d8a', '#a3282c', '#6b3fa0', '#c77a1e', '#b8577a', '#3c4a5c', '#4f7a2a'];
const normStack = (s) => ({ ...s, cards: (s.cards || []).filter(Boolean) });
const cardText = (html) => htmlToText(html).replace(/\s+/g, ' ').trim();
const cardHas = (c) => !!(cardText(c.front) || cardText(c.back) || /data-asset/.test((c.front || '') + (c.back || '')));
const cardsOf = (s) => (s.cards || []).filter(cardHas);

// Card faces allow bold/italic/underline, line breaks, simple lists and pasted images.
function cleanCardHTML(html) {
  const t = document.createElement('template'); t.innerHTML = html || '';
  const OK = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'BR', 'DIV', 'P', 'UL', 'OL', 'LI', 'IMG', 'SPAN']);
  const walk = (node) => {
    for (const c of [...node.childNodes]) {
      if (c.nodeType === 3) continue;
      if (c.nodeType !== 1) { c.remove(); continue; }
      walk(c);
      if (!OK.has(c.tagName)) { c.replaceWith(...c.childNodes); continue; }
      const asset = c.tagName === 'IMG' ? c.getAttribute('data-asset') : null;
      const bg = c.tagName === 'SPAN' ? c.style.getPropertyValue('background-color') : '';
      for (const a of [...c.attributes]) c.removeAttribute(a.name);
      if (c.tagName === 'IMG') { if (asset && /^[\w.-]+$/.test(asset)) c.setAttribute('data-asset', asset); else c.remove(); }
      if (c.tagName === 'SPAN') { if (bg && !/url\(/i.test(bg)) c.style.backgroundColor = bg; else c.replaceWith(...c.childNodes); }
    }
  };
  walk(t.content);
  return t.innerHTML;
}
async function hydrateImgs(root) { for (const img of root.querySelectorAll('img[data-asset]')) if (!img.src) img.src = await Assets.url(img.dataset.asset); }
function setFace(elm, html) { elm.innerHTML = cleanCardHTML(html); hydrateImgs(elm); }

async function renderStacks(root, q) {
  const all = (await DB.all('stacks')).map(normStack).filter((s) => !isPending('stack:' + s.id)).sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  const list = all.filter((s) => !q || s.title.toLowerCase().includes(q) || s.cards.some((c) => (cardText(c.front) + ' ' + cardText(c.back)).toLowerCase().includes(q)));
  const grid = el('div', { class: 'shelf-grid' });
  if (!q) grid.append(el('button', { class: 'nb-new', type: 'button', onclick: newStack }, el('span', { class: 'plus', text: '+' }), el('span', { text: 'New stack' })));
  for (const s of list) grid.append(stackCard(s));
  if (q && !list.length) grid.append(el('div', { class: 'empty' }, el('p', { text: `No stacks match “${q}”.` })));
  root.append(grid);
  if (!all.length && !q) root.append(el('p', { class: 'nb-hint muted', text: 'Make a stack for each module, text or topic — quotations on one side and who said them on the other, terms and definitions, dates and events. Click a stack to study it in a random order.' }));
}
function stackCard(s) {
  const n = cardsOf(s).length;
  const first = s.cards.find(cardHas);
  const card = el('div', { class: 'book stack', tabindex: 0, role: 'button', 'aria-label': `Study ${s.title}` },
    el('div', { class: 'bk-menu' },
      el('button', { type: 'button', text: 'Edit cards', onclick: (e) => { e.stopPropagation(); openStackEditor(s.id); } }),
      el('button', { type: 'button', text: 'Rename', onclick: (e) => { e.stopPropagation(); renameStack(s); } }),
      el('button', { type: 'button', text: 'Delete', onclick: (e) => { e.stopPropagation(); removeStack(s); } })),
    el('div', { class: 'cover-wrap' }, el('div', { class: 'stack-cover', style: { '--cov': s.color || STACK_COLOURS[0] } },
      el('i', { class: 'sc3' }), el('i', { class: 'sc2' }),
      el('div', { class: 'sc1' }, el('span', { class: 'sc-name', text: s.title }), el('span', { class: 'sc-peek', text: first ? cardText(first.front).slice(0, 70) : 'No cards yet' })))),
    el('div', { class: 'cap' }, el('h3', { text: s.title, title: s.title }), el('div', { class: 'meta', text: plural(n, 'card') + (s.studiedAt ? ' · studied ' + shortDate(s.studiedAt) : '') })));
  const go = () => (n ? startStudy(s.id) : openStackEditor(s.id));
  card.addEventListener('click', go);
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } if (e.key === 'Delete') removeStack(s); if (e.key === 'F2') renameStack(s); });
  return card;
}
async function newStack() {
  const name = await ask({ title: 'New flashcard stack', body: 'Name it after a text, module or topic. You can rename it any time.', input: '', ok: 'Create stack' });
  if (name == null) return;
  const count = (await DB.all('stacks')).length;
  const s = { id: 'st-' + uid(), title: name.trim() || `Stack ${count + 1}`, color: STACK_COLOURS[count % STACK_COLOURS.length], createdAt: Date.now(), updatedAt: Date.now(), cards: [] };
  await DB.put('stacks', s);
  await openStackEditor(s.id);
}
async function renameStack(s) {
  const v = await ask({ title: 'Rename stack', input: s.title, ok: 'Rename' });
  if (v == null || !v.trim()) return;
  const rec = await DB.get('stacks', s.id); if (!rec) return;
  rec.title = v.trim(); await DB.put('stacks', rec);
  if (ED.stack?.id === s.id) { ED.stack.title = rec.title; $('#stackTitle').textContent = rec.title; }
  renderLibrary(); reportCardsAvailable();
}
async function removeStack(s) {
  const n = cardsOf(s).length;
  const commit = async () => { await DB.del('stacks', s.id); reportCardsAvailable(); };
  if (!n) { scheduleRemoval('stack:' + s.id, `“${s.title}”`, commit); return; }
  const ok = await ask({ title: `Delete “${s.title}”?`, body: `This stack has ${plural(n, 'card')}. Deleting it can’t be undone. Use “Back up notes” first if you might want it later.`, ok: 'Delete stack', danger: true });
  if (!ok) return;
  await commit(); toast('Stack deleted.'); renderLibrary();
}

/* ---------- stack editor ---------- */
const ED = { stack: null, saveT: null };
function showMainView(id) {
  for (const v of ['library', 'reader', 'stackView']) $('#' + v).hidden = v !== id;
}
async function openStackEditor(id, focusNew) {
  const s = await DB.get('stacks', id); if (!s) { toast('That stack couldn’t be found.'); return; }
  ED.stack = normStack(s);
  showMainView('stackView');
  $('#stackTitle').textContent = s.title;
  document.title = s.title + " — Rose's generic study app";
  renderEditor();
  if (!ED.stack.cards.length || focusNew) addCardRow();
  else $('#cardList .face')?.focus();
}
function closeStackEditor() { flushStackSave(); ED.stack = null; showLibrary('cards'); }
function editorCount() { const n = cardsOf(ED.stack).length; $('#stackCount').textContent = plural(n, 'card'); $('#studyStackBtn').disabled = !n; }
function renderEditor() {
  const list = $('#cardList'); list.textContent = '';
  ED.stack.cards.forEach((c, i) => list.append(cardRow(c, i)));
  editorCount();
}
function cardRow(c, i) {
  const mk = (side) => {
    const f = el('div', { class: 'face', contenteditable: 'true', spellcheck: 'true', 'data-side': side, 'aria-label': side === 'front' ? 'Front of card' : 'Back of card' });
    setFace(f, c[side]);
    f.addEventListener('input', () => { c[side] = cleanCardHTML(f.innerHTML); queueStackSave(); editorCount(); });
    f.addEventListener('paste', (e) => cardPaste(e, f, c, side));
    f.addEventListener('keydown', (e) => cardKeys(e, f));
    return f;
  };
  const del = el('button', { type: 'button', class: 'ibtn sm cdel', title: 'Delete card', html: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>' });
  del.addEventListener('click', () => deleteCard(c));
  return el('div', { class: 'crow', 'data-id': c.id },
    el('span', { class: 'cnum', text: i + 1 }),
    el('div', { class: 'cside' }, el('span', { class: 'clab', text: 'Front' }), mk('front')),
    el('div', { class: 'cside' }, el('span', { class: 'clab', text: 'Back' }), mk('back')),
    del);
}
function addCardRow() {
  const c = { id: uid(), front: '', back: '', created: Date.now() };
  ED.stack.cards.push(c);
  const row = cardRow(c, ED.stack.cards.length - 1);
  $('#cardList').append(row);
  row.querySelector('.face').focus();
  row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  queueStackSave();
}
function deleteCard(c) {
  const i = ED.stack.cards.indexOf(c); if (i < 0) return;
  ED.stack.cards.splice(i, 1); renderEditor(); queueStackSave();
  if (cardHas(c)) toastAction('Card deleted.', 'Undo', () => { if (!ED.stack) return; ED.stack.cards.splice(i, 0, c); renderEditor(); queueStackSave(); }, 7000);
}
function cardKeys(e, f) {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === 'Enter') { e.preventDefault(); addCardRow(); return; }
  if (e.key === 'Tab') {
    const faces = $$('#cardList .face'); const i = faces.indexOf(f);
    if (!e.shiftKey && i === faces.length - 1) { e.preventDefault(); addCardRow(); return; }
    const next = faces[i + (e.shiftKey ? -1 : 1)];
    if (next) { e.preventDefault(); next.focus(); placeCaretEnd(next); }
  }
}
async function cardPaste(e, f, c, side) {
  const items = [...(e.clipboardData?.items || [])];
  const img = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'));
  e.preventDefault(); e.stopPropagation();
  if (img) {
    const id = await Assets.put(img.getAsFile());
    f.focus();
    document.execCommand('insertHTML', false, `<img data-asset="${id}">`);
    await hydrateImgs(f);
  } else document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  c[side] = cleanCardHTML(f.innerHTML); queueStackSave(); editorCount();
}
function queueStackSave() { clearTimeout(ED.saveT); $('#stackSaved').textContent = 'Saving…'; ED.saveT = setTimeout(flushStackSave, 400); }
async function flushStackSave() {
  clearTimeout(ED.saveT); if (!ED.stack) return;
  ED.stack.updatedAt = Date.now();
  // Empty cards are kept while you're editing, but never saved.
  await DB.put('stacks', { ...ED.stack, cards: ED.stack.cards.filter(cardHas) });
  $('#stackSaved').textContent = 'Saved';
  reportCardsAvailable();
}

/* ---------- studying (and Geometry Dash breaks) ---------- */
const SV = { mode: 'study', cards: [], i: 0, flipped: false, seen: new Set(), stack: null, backFirst: false, prevView: null };
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
async function startStudy(id) {
  if (ED.stack?.id === id) await flushStackSave();
  const s = normStack(await DB.get('stacks', id));
  const cards = cardsOf(s);
  if (!cards.length) { toast('This stack has no cards yet.'); openStackEditor(id); return; }
  Object.assign(SV, { mode: 'study', stack: s, cards: shuffle(cards), i: 0, flipped: false, seen: new Set() });
  openStudyView();
  s.studiedAt = Date.now(); DB.put('stacks', s);
}
function openStudyView() {
  SV.prevView = ['library', 'reader', 'stackView'].find((v) => !$('#' + v).hidden) || 'library';
  commitEditing?.(); hidePop?.(); hideFmt?.();
  $('#studyView').hidden = false;
  $('#studyView').classList.toggle('gate', SV.mode === 'gate');
  $('#svTitle').textContent = SV.mode === 'gate' ? 'Study break' : SV.stack.title;
  $('#svSub').textContent = SV.mode === 'gate' ? `Flip all ${plural(SV.cards.length, 'card')} to get back to Geometry Dash.` : 'Click the card or press Space to turn it over.';
  $('#svBackFirst').checked = SV.backFirst;
  drawStudy();
  $('#svCard').focus({ preventScroll: true });
}
function closeStudyView() {
  if (SV.mode === 'gate') return;
  $('#studyView').hidden = true;
  if (SV.prevView === 'stackView' && ED.stack) openStackEditor(ED.stack.id); else if (SV.prevView === 'library') renderLibrary();
}
function drawStudy() {
  const done = SV.i >= SV.cards.length;
  $('#svEnd').hidden = !done; $('#svDeck').hidden = done;
  const allFlipped = SV.seen.size >= SV.cards.length;
  $('#svDots').textContent = '';
  SV.cards.forEach((c, k) => $('#svDots').append(el('i', { class: (SV.seen.has(c.id) ? 'seen' : '') + (k === SV.i ? ' cur' : '') })));
  if (done) {
    $('#svEndTitle').textContent = SV.mode === 'gate' ? (allFlipped ? 'Break complete' : 'Nearly there') : `You’ve been through all ${plural(SV.cards.length, 'card')}`;
    $('#svEndText').textContent = SV.mode === 'gate' ? (allFlipped ? 'Geometry Dash is waiting for you.' : 'Some cards haven’t been turned over yet — go back and flip them.') : 'Shuffle and go again, or head back to your stacks.';
    $('#svAgain').hidden = SV.mode === 'gate'; $('#svLeave').hidden = SV.mode === 'gate';
    $('#svGateDone').hidden = !(SV.mode === 'gate' && allFlipped);
    $('#svGateBack').hidden = !(SV.mode === 'gate' && !allFlipped);
    $('#svProgress').textContent = '';
    if (SV.mode === 'gate' && allFlipped) $('#svGateDone').focus(); else $('#svAgain').focus();
    return;
  }
  const c = SV.cards[SV.i];
  const front = SV.backFirst ? c.back : c.front, back = SV.backFirst ? c.front : c.back;
  setFace($('#svFront .fbody'), front); setFace($('#svBack .fbody'), back);
  $('#svFront .flab').textContent = SV.backFirst ? 'Back' : 'Front'; $('#svBack .flab').textContent = SV.backFirst ? 'Front' : 'Back';
  $('#svCard').classList.toggle('flipped', SV.flipped);
  $('#svProgress').textContent = `Card ${SV.i + 1} of ${SV.cards.length}`;
  $('#svPrev').disabled = SV.i === 0;
  $('#svNext').textContent = SV.i === SV.cards.length - 1 ? 'Finish' : 'Next';
  $('#svGateDone').hidden = true;
  if (SV.mode === 'gate' && allFlipped) { $('#svGateInline').hidden = false; } else $('#svGateInline').hidden = true;
}
function flipCard() {
  if (SV.i >= SV.cards.length) return;
  SV.flipped = !SV.flipped;
  if (SV.flipped) SV.seen.add(SV.cards[SV.i].id);
  drawStudy();
}
function nextCard(d) {
  const n = clamp(SV.i + d, 0, SV.cards.length);
  if (n === SV.i) return;
  SV.i = n; SV.flipped = false; drawStudy();
  const card = $('#svCard'); if (!card.hidden && !matchMedia('(prefers-reduced-motion: reduce)').matches) card.animate([{ transform: `translateX(${d * 40}px)`, opacity: 0.3 }, { transform: 'none', opacity: 1 }], { duration: 160, easing: 'ease-out' });
}
function studyKeys(e) {
  if ($('#studyView').hidden) return;
  if (!$('#dialog').hidden) return;
  e.stopPropagation();
  const k = e.key;
  if (k === ' ' || k === 'ArrowUp' || k === 'ArrowDown' || k === 'Enter' && e.target.id === 'svCard') { e.preventDefault(); flipCard(); }
  else if (k === 'ArrowRight') { e.preventDefault(); nextCard(1); }
  else if (k === 'ArrowLeft') { e.preventDefault(); nextCard(-1); }
  else if (k === 'Escape') { e.preventDefault(); closeStudyView(); }
  else if (SV.mode === 'gate' && (e.ctrlKey || e.altKey || e.metaKey || /^F\d+$/.test(k))) e.preventDefault();
}

/* ---------- Geometry Dash breaks ----------
   Switched off for now ("Coming soon"). Everything below is kept intact: set GAMES_ENABLED to true here
   and in electron/main.js to turn the feature back on. */
const GAMES_ENABLED = false;
const GD = { status: null, cfg: null, info: null, stacks: [] };
async function poolFor(cfg) {
  const stacks = (await DB.all('stacks')).map(normStack);
  if (cfg?.source === 'stack') { const s = stacks.find((x) => x.id === cfg.stackId); if (s && cardsOf(s).length) return cardsOf(s); }
  return stacks.flatMap(cardsOf);
}
async function reportCardsAvailable() {
  if (!GAMES_ENABLED || !IS_APP || !window.native.gd) return;
  const cfg = GD.cfg || (await window.native.gd.status()).cfg;
  window.native.gd.cardsAvailable((await poolFor(cfg)).length);
}
async function startGate(info) {
  const pool = await poolFor(info);
  const cards = shuffle(pool).slice(0, clamp(info.cards || 5, 1, 10));
  if (!cards.length) { window.native.gd.done(); return; }
  if (S.book) { commitEditing(); await saveNow(); }
  if (ED.stack) await flushStackSave();
  Object.assign(SV, { mode: 'gate', stack: null, cards, i: 0, flipped: false, seen: new Set() });
  openStudyView();
}
async function finishGate() {
  if (SV.mode !== 'gate') return;
  if (SV.seen.size < SV.cards.length) return;
  SV.mode = 'study';
  $('#studyView').hidden = true; $('#studyView').classList.remove('gate');
  await window.native.gd.done();
  if (SV.prevView === 'library') renderLibrary();
}
function gdTabState(s) {
  const t = $('[data-libtab="games"]'); if (!t) return;
  const on = !!s?.running;
  t.disabled = !on;
  t.title = on ? 'Flashcard breaks while you play Geometry Dash' : 'Open Geometry Dash to use this';
  t.classList.toggle('live', on);
  if (!on && libTab === 'games' && !$('#library').hidden) { setLibTab('cards'); toast('Geometry Dash was closed, so flashcard games are paused.'); }
}
async function renderGames(root) {
  const s = GD.status = await window.native.gd.status();
  const cfg = GD.cfg = s.cfg;
  GD.stacks = (await DB.all('stacks')).map(normStack).filter((x) => cardsOf(x).length);
  GD.info = await window.native.gd.modInfo();
  const save = async (patch) => { GD.cfg = await window.native.gd.config({ ...patch, cardsAvailable: (await poolFor({ ...cfg, ...patch })).length }).then((r) => r.cfg); renderLibrary(); };
  const stepper = (val, lo, hi, onSet, label) => el('span', { class: 'stepper', role: 'group', 'aria-label': label },
    el('button', { type: 'button', text: '−', disabled: val <= lo, 'aria-label': 'Fewer', onclick: () => onSet(val - 1) }),
    el('output', { text: val }),
    el('button', { type: 'button', text: '+', disabled: val >= hi, 'aria-label': 'More', onclick: () => onSet(val + 1) }));
  const wrap = el('div', { class: 'games' }); root.append(wrap);
  const usingAttempts = cfg.mode === 'attempts';
  const target = usingAttempts ? cfg.every : cfg.minutes, now = usingAttempts ? s.attempts : Math.floor(s.seconds / 60);
  const pct = Math.min(100, Math.round(now / target * 100));
  wrap.append(el('section', { class: 'gcard hero' },
    el('div', { class: 'gstatus' }, el('span', { class: 'gdot' }), 'Geometry Dash is open'),
    el('h2', { text: cfg.enabled ? (usingAttempts ? `${now} of ${target} attempts until your next break` : `${now} of ${target} minutes until your next break`) : 'Study breaks are switched off' }),
    el('div', { class: 'gbar' }, el('i', { style: { width: (cfg.enabled ? pct : 0) + '%' } })),
    usingAttempts && !s.modSeen ? el('p', { class: 'gwarn', text: 'Attempts aren’t being counted yet — that needs the helper mod (see below). Until then, switch to “minutes played”.' }) : null,
    s.notice ? el('p', { class: 'gwarn', text: s.notice }) : null,
    el('div', { class: 'row-btns' },
      el('label', { class: 'switch' }, el('input', { type: 'checkbox', checked: cfg.enabled, onchange: (e) => save({ enabled: e.target.checked }) }), el('span', { text: 'Study breaks on' })),
      el('button', { class: 'btn', type: 'button', text: 'Take a break now', onclick: async () => { const r = await window.native.gd.breakNow(); if (!r?.ok && r?.reason === 'nocards') toast('Make some flashcards first.'); } }))));
  const count = el('section', { class: 'gcard' }, el('h3', { text: 'When to take a break' }),
    el('div', { class: 'seg' },
      el('button', { type: 'button', class: usingAttempts ? 'on' : '', text: 'After attempts', onclick: () => save({ mode: 'attempts' }) }),
      el('button', { type: 'button', class: !usingAttempts ? 'on' : '', text: 'After minutes played', onclick: () => save({ mode: 'minutes' }) })),
    usingAttempts
      ? el('div', { class: 'grow' }, el('span', { text: 'Every' }), stepper(cfg.every, 1, 10, (v) => save({ every: v }), 'Attempts'), el('span', { text: cfg.every === 1 ? 'attempt, on any level' : 'attempts, on any level' }))
      : el('div', { class: 'grow' }, el('span', { text: 'Every' }), stepper(cfg.minutes, 1, 60, (v) => save({ minutes: v }), 'Minutes'), el('span', { text: cfg.minutes === 1 ? 'minute of play' : 'minutes of play' })));
  const cards = el('section', { class: 'gcard' }, el('h3', { text: 'Flashcards in each break' }),
    el('div', { class: 'grow' }, stepper(cfg.cards, 1, 10, (v) => save({ cards: v }), 'Cards'), el('span', { text: cfg.cards === 1 ? 'card to flip' : 'cards to flip' })),
    el('label', { class: 'radio' }, el('input', { type: 'radio', name: 'gsrc', checked: cfg.source !== 'stack', onchange: () => save({ source: 'all' }) }), ' A random mix from all my stacks'),
    el('label', { class: 'radio' }, el('input', { type: 'radio', name: 'gsrc', checked: cfg.source === 'stack', disabled: !GD.stacks.length, onchange: () => save({ source: 'stack', stackId: cfg.stackId || GD.stacks[0]?.id }) }), ' Random cards from one stack: ',
      el('select', { disabled: cfg.source !== 'stack', onchange: (e) => save({ source: 'stack', stackId: e.target.value }) },
        ...GD.stacks.map((x) => el('option', { value: x.id, selected: x.id === cfg.stackId, text: `${x.title} (${cardsOf(x).length})` })))),
    !GD.stacks.length ? el('p', { class: 'gwarn', text: 'You don’t have any flashcards yet — make a stack in the Flashcards tab first.' }) : null);
  const i = GD.info;
  const mod = el('section', { class: 'gcard' }, el('h3', { text: 'Counting attempts (helper mod)' }),
    el('p', { class: 'muted', text: 'Geometry Dash doesn’t share attempt counts with other programs, so a tiny Geode mod tells Rose’s generic study app each time you start an attempt. It changes nothing in the game.' }),
    el('ul', { class: 'checks' },
      el('li', { class: i.geode ? 'ok' : 'no', text: i.geode ? 'Geode is installed' : 'Geode isn’t installed yet' }),
      el('li', { class: i.installed ? 'ok' : 'no', text: i.installed ? 'Helper mod is installed' : 'Helper mod isn’t installed' }),
      el('li', { class: s.modSeen ? 'ok' : 'no', text: s.modSeen ? 'Attempts are being counted' : 'No attempts counted yet this session' })),
    el('div', { class: 'row-btns' },
      !i.geode ? el('button', { class: 'btn', type: 'button', text: 'Get Geode (geode-sdk.org)', onclick: () => openExternal('https://geode-sdk.org/install') }) : null,
      el('button', { class: 'btn', type: 'button', text: i.bundled ? 'Install helper mod' : 'Install helper mod from a file…', onclick: async () => { const r = await window.native.gd.installMod(!i.bundled); if (r.msg) toast(r.msg, 6000); renderLibrary(); } })));
  wrap.append(el('div', { class: 'gcols' }, count, cards), mod);
}
async function initGames() {
  if (!GAMES_ENABLED) {
    const t = $('[data-libtab="games"]');
    if (t) { t.disabled = false; t.classList.add('soon'); t.setAttribute('aria-disabled', 'true'); t.removeAttribute('title'); t.dataset.tip = 'Coming soon'; t.setAttribute('aria-label', 'Flashcard games — coming soon'); }
    return;
  }
  if (!IS_APP || !window.native.gd) { $('[data-libtab="games"]')?.remove(); return; }
  window.native.gd.onStatus((s) => {
    const was = GD.status; GD.status = s; gdTabState(s);
    if (libTab === 'games' && !$('#library').hidden && s.running && (!was || was.attempts !== s.attempts || Math.floor(was.seconds / 60) !== Math.floor(s.seconds / 60) || was.modSeen !== s.modSeen || was.notice !== s.notice)) renderLibrary();
  });
  window.native.gd.onGate((info) => startGate(info));
  const s = await window.native.gd.status(); GD.status = s; GD.cfg = s.cfg; gdTabState(s);
  reportCardsAvailable();
}

/* ---------- wiring ---------- */
function wireStudy() {
  $('#addLinkBtn').addEventListener('click', () => addLink());
  $('#newStackBtn').addEventListener('click', newStack);
  $('#stackBack').addEventListener('click', closeStackEditor);
  $('#stackTitle').addEventListener('click', () => ED.stack && renameStack(ED.stack));
  $('#addCardBtn').addEventListener('click', addCardRow);
  $('#studyStackBtn').addEventListener('click', async () => { if (ED.stack) { await flushStackSave(); startStudy(ED.stack.id); } });
  $('#svCard').addEventListener('click', (e) => { if (!e.target.closest('a')) flipCard(); });
  $('#svFlip').addEventListener('click', flipCard);
  $('#svNext').addEventListener('click', () => nextCard(1));
  $('#svPrev').addEventListener('click', () => nextCard(-1));
  $('#svClose').addEventListener('click', closeStudyView);
  $('#svLeave').addEventListener('click', closeStudyView);
  $('#svAgain').addEventListener('click', () => { Object.assign(SV, { cards: shuffle(SV.cards), i: 0, flipped: false, seen: new Set() }); drawStudy(); $('#svCard').focus(); });
  $('#svGateBack').addEventListener('click', () => { const k = SV.cards.findIndex((c) => !SV.seen.has(c.id)); SV.i = Math.max(0, k); SV.flipped = false; drawStudy(); });
  $('#svGateDone').addEventListener('click', finishGate);
  $('#svGateInline').addEventListener('click', finishGate);
  $('#svEditStack').addEventListener('click', () => { if (SV.stack) { $('#studyView').hidden = true; openStackEditor(SV.stack.id); } });
  $('#svBackFirst').addEventListener('change', (e) => { SV.backFirst = e.target.checked; SV.flipped = false; drawStudy(); });
  document.addEventListener('keydown', studyKeys, true);
  document.addEventListener('keydown', (e) => {
    if ($('#stackView').hidden || !$('#dialog').hidden) return;
    if (e.key === 'Escape' && !e.target.closest('.face')) closeStackEditor();
    if (e.key === 'Escape' && e.target.closest('.face')) e.target.blur();
  });
  document.addEventListener('paste', (e) => {
    if ($('#library').hidden || libTab !== 'links' || /^(INPUT|TEXTAREA)$/.test(e.target.tagName) || !$('#dialog').hidden) return;
    const t = (e.clipboardData?.getData('text/plain') || '').trim();
    if (/^(https?:\/\/|www\.)\S+$/i.test(t)) { e.preventDefault(); addLink(t); }
  });
  initGames();
}
