/* ===================== finding free copies online =====================
   Only legal sources: Project Gutenberg (public-domain texts, typeset here into a PDF),
   the Internet Archive (freely downloadable scans), and Open Library / Google Books for ISBN details. */
const WEB_JOBS = new Map();
if (IS_APP && window.native.onWebProgress) window.native.onWebProgress((id, got, total) => { const f = WEB_JOBS.get(id); if (f) f(got, total); });
async function webGet(url, kind = 'json', onProgress) {
  url = url.replace(/^http:\/\//i, 'https://');
  if (IS_APP) {
    const id = onProgress ? uid() : null;
    if (id) WEB_JOBS.set(id, onProgress);
    try { return await window.native.webGet(url, kind, id); } finally { if (id) WEB_JOBS.delete(id); }
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return kind === 'json' ? r.json() : kind === 'text' ? r.text() : new Uint8Array(await r.arrayBuffer());
}
const cleanIsbn = (q) => String(q || '').replace(/[\s-]/g, '').toUpperCase();
const isIsbn = (q) => /^(97[89]\d{10}|\d{9}[\dX])$/.test(cleanIsbn(q));
function parseDims(str) {
  // "19.8 x 12.9 x 1.2 centimeters" / "8 x 5 x 0.3 inches" → { w, h } in inches (ignoring thickness)
  const nums = (String(str).match(/\d+(\.\d+)?/g) || []).map(Number);
  if (nums.length < 2) return null;
  const unit = /cent|cm/i.test(str) ? 2.54 : /mm|milli/i.test(str) ? 25.4 : 1;
  const v = nums.slice(0, 3).sort((a, b) => b - a);
  const h = v[0] / unit, w = v[1] / unit;
  return h > 3 && w > 2 && h < 16 ? { w: +w.toFixed(2), h: +h.toFixed(2) } : null;
}
async function lookupIsbn(raw) {
  const isbn = cleanIsbn(raw);
  try {
    const d = await webGet(`https://openlibrary.org/isbn/${isbn}.json`);
    let author = '';
    const key = d.authors?.[0]?.key;
    if (key) { try { author = (await webGet(`https://openlibrary.org${key}.json`)).name || ''; } catch {} }
    if (!author && d.works?.[0]?.key) {
      try { const w = await webGet(`https://openlibrary.org${d.works[0].key}.json`); const ak = w.authors?.[0]?.author?.key; if (ak) author = (await webGet(`https://openlibrary.org${ak}.json`)).name || ''; } catch {}
    }
    return { isbn, title: d.title || '', author, publisher: d.publishers?.[0] || '', year: (String(d.publish_date || '').match(/\d{4}/) || [''])[0], pages: d.number_of_pages || null, trim: parseDims(d.physical_dimensions) };
  } catch {}
  try {
    const g = await webGet(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`);
    const v = g.items?.[0]?.volumeInfo;
    if (v) return { isbn, title: v.title + (v.subtitle ? ': ' + v.subtitle : ''), author: (v.authors || []).join(', '), publisher: v.publisher || '', year: (v.publishedDate || '').slice(0, 4), pages: v.pageCount || null, trim: v.dimensions ? parseDims(`${v.dimensions.height} x ${v.dimensions.width}`) : null };
  } catch {}
  return null;
}
const nameFlip = (n) => String(n || '').split(', ').reverse().join(' ');
async function searchGutenberg(q) {
  const d = await webGet('https://gutendex.com/books/?search=' + encodeURIComponent(q));
  return (d.results || []).slice(0, 8).map((b) => {
    let txt = b.formats?.['text/plain; charset=utf-8'] || b.formats?.['text/plain; charset=us-ascii'] || b.formats?.['text/plain'] || '';
    if (!txt || /\.zip$/i.test(txt)) txt = `https://www.gutenberg.org/ebooks/${b.id}.txt.utf-8`;
    return { src: 'gutenberg', id: b.id, title: b.title, author: (b.authors || []).map((a) => nameFlip(a.name)).join(', '), lang: (b.languages || []).join(', '), downloads: b.download_count, txt };
  });
}
async function searchArchive(q) {
  const terms = q.replace(/[():"\[\]{}^~*?\\/!]/g, ' ').trim();
  const base = 'AND mediatype:texts AND NOT collection:(inlibrary OR printdisabled OR lendinglibrary)';
  const run = async (query) => {
    const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=year&fl[]=downloads&rows=10&sort[]=downloads+desc&output=json`;
    return (await webGet(url)).response?.docs || [];
  };
  let docs = await run(`title:(${terms}) ${base}`);
  if (!docs.length) docs = await run(`(${terms}) ${base}`);
  return docs.map((d) => ({ src: 'archive', id: d.identifier, title: [].concat(d.title || d.identifier)[0], author: [].concat(d.creator || [])[0] || '', year: d.year || '', downloads: d.downloads }));
}
async function archivePdf(id) {
  const m = await webGet(`https://archive.org/metadata/${encodeURIComponent(id)}`);
  if (String(m.metadata?.['access-restricted-item']) === 'true') throw new Error('This copy can only be borrowed, not downloaded.');
  const pdfs = (m.files || []).filter((f) => /\.pdf$/i.test(f.name));
  const pick = pdfs.find((f) => f.format === 'Text PDF') || pdfs.find((f) => /text/i.test(f.format || '')) || pdfs[0];
  if (!pick) throw new Error('This item has no PDF.');
  return { url: `https://archive.org/download/${encodeURIComponent(id)}/${pick.name.split('/').map(encodeURIComponent).join('/')}`, size: +pick.size || 0, title: [].concat(m.metadata?.title || id)[0], author: [].concat(m.metadata?.creator || [])[0] || '' };
}

/* ---------- Gutenberg plain text → structured blocks ---------- */
function bookTypography(s) {
  return s.replace(/--/g, '—').replace(/\.\.\./g, '…')
    .replace(/(^|[\s(\[{——-])"/g, '$1“').replace(/"/g, '”')
    .replace(/(^|[\s(\[{——-])'/g, '$1‘').replace(/'/g, '’');
}
function parseGutenberg(raw) {
  let t = String(raw).replace(/\r\n?/g, '\n');
  const st = t.search(/\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG[^\n]*/i);
  if (st >= 0) t = t.slice(t.indexOf('\n', st) + 1);
  const en = t.search(/\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG/i);
  if (en >= 0) t = t.slice(0, en);
  t = t.replace(/^\s*(Produced by|E-text prepared by|Transcribed from|This etext was)[^\n]*(\n[^\n]+)*\n\n/i, '');
  const blocks = [];
  for (const b of t.split(/\n[ \t]*\n+/)) {
    if (!b.trim() || /^\s*\[(illustration|frontispiece)/i.test(b)) continue;
    const lines = b.replace(/\s+$/, '').split('\n');
    const verse = lines.length > 1 && lines.every((l) => /^\s{2,}\S/.test(l) || !l.trim());
    const text = verse ? lines.map((l) => l.trim()).join('\n') : lines.map((l) => l.trim()).join(' ').replace(/\s+/g, ' ');
    const one = lines.length === 1 ? lines[0].trim() : '';
    const heading = !!one && one.length < 60 && (/^(chapter|book|part|volume|act|scene|letter|stave|section|canto|epilogue|prologue|preface)\b/i.test(one) || /^[IVXLC]+\.?$/.test(one) || (/[A-Z]/.test(one) && one === one.toUpperCase() && !/[.,;:]$/.test(one)));
    blocks.push({ kind: heading ? 'h' : verse ? 'v' : 'p', text: bookTypography(text) });
  }
  return blocks;
}

/* ---------- typeset blocks into a clean paperback-style PDF ---------- */
async function loadPdfLib() {
  if (window.PDFLib) return window.PDFLib;
  const src = await unpack('lib-pdflib');
  await new Promise((res, rej) => { const s = document.createElement('script'); s.src = URL.createObjectURL(new Blob([src], { type: 'text/javascript' })); s.onload = res; s.onerror = rej; document.head.append(s); });
  return window.PDFLib;
}
async function typesetBook({ title, author, blocks, subject }) {
  const P = await loadPdfLib();
  const doc = await P.PDFDocument.create();
  doc.setTitle(title); if (author) doc.setAuthor(author); doc.setCreator("Rose's generic study app"); if (subject) doc.setSubject(subject);
  const F = { r: await doc.embedFont(P.StandardFonts.TimesRoman), i: await doc.embedFont(P.StandardFonts.TimesRomanItalic), b: await doc.embedFont(P.StandardFonts.TimesRomanBold) };
  const W = 396, H = 612, ML = 54, MR = 54, MT = 66, MB = 64, FS = 11, LEAD = 15.2, IND = 15;
  const TW = W - ML - MR;
  const okChar = new Map();
  const safe = (s) => [...s].map((ch) => {
    if (!okChar.has(ch)) { let ok = true; try { F.r.encodeText(ch); } catch { ok = false; } okChar.set(ch, ok ? ch : (ch.normalize('NFKD').replace(/[^\x20-\x7e]/g, '') || (ch === '\n' ? ch : '?'))); }
    return okChar.get(ch);
  }).join('');
  let page = null, y = 0, pageNo = 0;
  const pages = [];
  const newPage = () => { page = doc.addPage([W, H]); pages.push(page); pageNo++; y = H - MT; };
  const runsOf = (text) => { // _italic_ → runs
    const runs = []; let it = false;
    for (const part of text.split(/(_)/)) { if (part === '_') { it = !it; continue; } if (part) runs.push({ t: safe(part), f: it ? F.i : F.r }); }
    return runs;
  };
  const wordsOf = (runs) => { // words made of one or more runs, separated by spaces
    const words = []; let cur = [];
    for (const r of runs) {
      const parts = r.t.split(/( +)/);
      for (const p of parts) {
        if (/^ +$/.test(p)) { if (cur.length) words.push(cur); cur = []; }
        else if (p) cur.push({ t: p, f: r.f });
      }
    }
    if (cur.length) words.push(cur);
    return words;
  };
  const wWidth = (w, size) => w.reduce((s, seg) => s + seg.f.widthOfTextAtSize(seg.t, size), 0);
  const ensure = (need) => { if (!page || y - need < MB) newPage(); };
  const drawLine = (words, x0, width, size, justify) => {
    const space = F.r.widthOfTextAtSize(' ', size);
    const natural = words.reduce((s, w) => s + wWidth(w, size), 0) + space * (words.length - 1);
    const extra = justify && words.length > 1 ? (width - natural) / (words.length - 1) : 0;
    let x = x0;
    words.forEach((w, i) => {
      for (const seg of w) { page.drawText(seg.t + (i < words.length - 1 && seg === w[w.length - 1] ? ' ' : ''), { x, y, size, font: seg.f }); x += seg.f.widthOfTextAtSize(seg.t, size); }
      x += space + extra;
    });
  };
  const paragraph = (text, { size = FS, indent = IND, align = 'justify', lead = LEAD } = {}) => {
    const words = wordsOf(runsOf(text));
    const space = F.r.widthOfTextAtSize(' ', size);
    let line = [], width = 0, first = true;
    const avail = () => TW - (first ? indent : 0);
    const flushLine = (last) => {
      ensure(lead);
      const x0 = ML + (first ? indent : 0);
      if (align === 'center') { const nat = line.reduce((s, w) => s + wWidth(w, size), 0) + space * (line.length - 1); drawLine(line, ML + (TW - nat) / 2, nat, size, false); }
      else drawLine(line, x0, avail(), size, align === 'justify' && !last);
      y -= lead; first = false; line = []; width = 0;
    };
    for (const w of words) {
      const ww = wWidth(w, size);
      if (line.length && width + space + ww > avail()) flushLine(false);
      width += (line.length ? space : 0) + ww; line.push(w);
    }
    if (line.length) flushLine(true);
  };
  let started = false, sawChapter = false;
  blocks.forEach((b, bi) => {
    if (b.kind === 'h') {
      const isTitle = !started && bi < 3;
      if (started && (sawChapter || y < H - MT - 1)) newPage();
      if (!page) newPage();
      y -= isTitle ? 120 : 70;
      paragraph(b.text.replace(/_/g, ''), { size: isTitle ? 22 : 15, indent: 0, align: 'center', lead: isTitle ? 30 : 22 });
      y -= isTitle ? 10 : 26;
      if (!isTitle) sawChapter = true;
      started = true; return;
    }
    started = true;
    if (b.kind === 'v') { for (const l of b.text.split('\n')) paragraph(l, { indent: 24, align: 'left' }); y -= LEAD * 0.4; return; }
    const short = b.text.length < 70 && !/[.!?”’]$/.test(b.text) && bi < 6;
    paragraph(b.text, short ? { indent: 0, align: 'center' } : {});
  });
  pages.forEach((p, i) => { if (i > 0) { const s = String(i + 1); p.drawText(s, { x: W / 2 - F.r.widthOfTextAtSize(s, 9) / 2, y: 34, size: 9, font: F.r }); } });
  return doc.save();
}

/* ---------- the "Find a free copy" window ---------- */
function openFinder(prefill = '') {
  const card = $('#finderCard'); $('#finder').hidden = false;
  const inp = $('#finderInput'); inp.value = prefill || inp.value; inp.focus(); inp.select();
  if (prefill) runFinder(prefill);
  card.scrollTop = 0;
}
function closeFinder() { $('#finder').hidden = true; }
let finderSeq = 0;
async function runFinder(q) {
  q = q.trim(); if (!q) return;
  const seq = ++finderSeq;
  const out = $('#finderResults'); out.textContent = '';
  const status = el('p', { class: 'muted', text: 'Searching free libraries…' }); out.append(status);
  let query = q, isbnInfo = null;
  if (isIsbn(q)) {
    status.textContent = 'Looking up that ISBN…';
    isbnInfo = await lookupIsbn(q);
    if (seq !== finderSeq) return;
    if (isbnInfo?.title) query = `${isbnInfo.title} ${isbnInfo.author.split(/[ ,]/).pop() || ''}`.trim();
  }
  const [gut, arc] = await Promise.allSettled([searchGutenberg(query), searchArchive(isbnInfo?.title || query)]);
  if (seq !== finderSeq) return;
  out.textContent = '';
  if (isbnInfo) out.append(el('div', { class: 'isbn-card' }, el('strong', { text: isbnInfo.title || 'Unknown title' }), isbnInfo.author ? ` by ${isbnInfo.author}` : '', el('div', { class: 'muted', text: [isbnInfo.publisher, isbnInfo.year, isbnInfo.pages && `${isbnInfo.pages} pages`].filter(Boolean).join(' · ') + ' — free copies of this work are listed below. Any free copy will be a different edition; use “Match my printed edition” once it’s on your shelf.' })));
  else if (isIsbn(q)) out.append(el('div', { class: 'isbn-card' }, el('strong', { text: 'That ISBN isn’t in the public book databases' }), el('div', { class: 'muted', text: 'Self-published and print-on-demand editions often aren’t listed. Search by the title and author instead.' })));
  const section = (title, blurb, items, render) => {
    out.append(el('h3', { text: title }), el('p', { class: 'muted small', text: blurb }));
    if (items.status === 'rejected') { out.append(el('p', { class: 'muted', text: 'Couldn’t reach this library right now. Check your internet connection and try again.' })); return; }
    if (!items.value.length) { out.append(el('p', { class: 'muted', text: 'Nothing found here.' })); return; }
    const list = el('div', { class: 'fresults' }); items.value.forEach((it) => list.append(render(it))); out.append(list);
  };
  section('Project Gutenberg', 'Clean, proofread texts of out-of-copyright books. Rose’s generic study app lays them out as a book-style PDF for you.', gut, (it) => resultRow(it, `${it.author || 'Unknown author'}${it.lang && it.lang !== 'en' ? ' · ' + it.lang : ''}`, () => addFromGutenberg(it)));
  section('Internet Archive', 'Scans of real printed editions, free to download. Older scans can be less tidy.', arc, (it) => resultRow(it, [it.author, it.year].filter(Boolean).join(' · ') || 'Unknown author', () => addFromArchive(it)));
  const enc = encodeURIComponent(isbnInfo?.title || query);
  out.append(el('h3', { text: 'Still in copyright?' }), el('p', { class: 'muted small', text: 'Newer books aren’t free to download, but your university library often has them as e-books you can read for free.' }),
    el('div', { class: 'row-btns' },
      el('button', { class: 'btn', type: 'button', text: 'Search Warwick Library', onclick: () => openExternal(`https://warwick.summon.serialssolutions.com/#!/search?q=${enc}`) }),
      el('button', { class: 'btn', type: 'button', text: 'Search Open Library', onclick: () => openExternal(`https://openlibrary.org/search?q=${enc}`) }),
      el('button', { class: 'btn', type: 'button', text: 'Search Standard Ebooks', onclick: () => openExternal(`https://standardebooks.org/ebooks?query=${enc}`) })));
}
function openExternal(url) { if (IS_APP) window.native.openExternal(url); else window.open(url, '_blank', 'noopener'); }
function resultRow(it, meta, onAdd) {
  const btn = el('button', { class: 'btn primary', type: 'button', text: 'Add to shelf' });
  btn.addEventListener('click', async () => {
    btn.disabled = true; btn.textContent = 'Adding…';
    try { await onAdd((pct) => { btn.textContent = pct == null ? 'Adding…' : `Downloading ${pct}%`; }); btn.textContent = 'On your shelf'; }
    catch (e) { console.error(e); btn.disabled = false; btn.textContent = 'Try again'; toast(e.message && e.message.length < 120 ? e.message : 'Couldn’t add that book.', 5000); }
  });
  return el('div', { class: 'frow' }, el('div', { class: 'fmeta' }, el('div', { class: 'ftitle', text: it.title }), el('div', { class: 'muted small', text: meta })), btn);
}
async function addFromGutenberg(it, progress) {
  const raw = await webGet(it.txt, 'text');
  const blocks = parseGutenberg(raw);
  if (blocks.length < 5) throw new Error('That text couldn’t be read.');
  const title = it.title.split(/[:;]/)[0].trim();
  const bytes = await typesetBook({ title, author: it.author, blocks, subject: `Project Gutenberg #${it.id}` });
  await importFiles([new File([bytes], `${title}.pdf`, { type: 'application/pdf' })]);
}
async function addFromArchive(it, progress) {
  const info = await archivePdf(it.id);
  if (info.size > 300e6) throw new Error('That scan is too large to download.');
  const bytes = await webGet(info.url, 'bytes', (got, total) => progress(Math.round(got / (total || info.size || got) * 100)));
  await importFiles([new File([bytes], `${(info.title || it.title).slice(0, 80)}.pdf`, { type: 'application/pdf' })]);
}
