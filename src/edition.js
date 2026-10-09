/* ===================== matching a printed edition =====================
   The PDF's text is rebuilt into paragraphs (the "flow"), then laid out again into pages
   whose breaks follow the reader's printed copy. The reader gives a few anchors
   ("page 3 ends with ‘…gloom, brooding’"); between anchors the page breaks are estimated
   with a line-by-line model of the edition, so every anchor lands exactly and the pages in
   between are spread out the way a typesetter would have. */
const TRIMS = {
  '5x8': { w: 5, h: 8, label: '5 × 8 in — most self-published paperbacks' },
  '5.25x8': { w: 5.25, h: 8, label: '5.25 × 8 in' },
  '5.5x8.5': { w: 5.5, h: 8.5, label: '5.5 × 8.5 in' },
  '6x9': { w: 6, h: 9, label: '6 × 9 in' },
  b: { w: 5.08, h: 7.8, label: 'B-format paperback, 129 × 198 mm (Penguin, Vintage)' },
  a: { w: 4.37, h: 7.01, label: 'A-format paperback, 111 × 178 mm (small)' },
  owc: { w: 5.04, h: 7.72, label: 'Oxford World’s Classics, 128 × 196 mm' },
  a5: { w: 5.83, h: 8.27, label: 'A5, 148 × 210 mm' },
};
const GLYPH_CHARS = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~‘’“”—–…éèàâêîôûçëïüöäßæœÉÀ';
const GLYPH_W = [250,333,408,500,500,833,778,180,333,333,500,564,250,333,250,278,500,500,500,500,500,500,500,500,500,500,278,278,564,564,564,444,921,722,667,667,722,611,556,722,722,333,389,722,611,889,722,722,556,722,667,556,611,722,722,944,722,722,611,333,278,333,469,500,333,444,500,444,500,444,333,500,500,278,278,500,278,778,500,500,500,500,333,389,278,500,500,722,500,500,444,480,200,480,541,333,333,444,444,1000,500,1000,444,444,444,444,444,278,500,500,444,444,278,500,500,444,500,667,722,611,722];
const GLYPH = new Map([...GLYPH_CHARS].map((c, i) => [c, GLYPH_W[i] / 1000]));
const wordEm = (t, a, b) => { let w = 0; for (let i = a; i < b; i++) w += GLYPH.get(t[i]) ?? 0.5; return w; };
const SPACE_EM = 0.25, INDENT_EM = 1.3;
const HEAD_UNITS = 6; // lines a chapter heading takes up, including the space around it
const edDefaults = () => ({ enabled: false, isbn: '', info: '', trim: '5x8', startPage: 1, startOffset: 0, startPhrase: '', anchors: [], chapterNewPage: true });

/* ---------- 1. rebuild paragraphs from the PDF ---------- */
function median(a) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; }
function pct(a, p) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; }
function textLines(items) {
  const its = [];
  for (const it of items) {
    if (typeof it.str !== 'string' || !it.str.trim()) continue;
    const t = it.transform; if (Math.abs(t[1]) > 0.01 && Math.abs(t[2]) > 0.01) continue; // rotated text
    const fs = Math.hypot(t[2], t[3]) || Math.abs(t[3]) || 10;
    its.push({ s: it.str, x: t[4], y: t[5], w: it.width, fs });
  }
  its.sort((a, b) => (b.y - a.y) || (a.x - b.x));
  const lines = [];
  for (const it of its) {
    let ln = lines.find((l) => Math.abs(l.y - it.y) <= Math.max(l.fs, it.fs) * 0.45);
    if (!ln) { ln = { y: it.y, fs: it.fs, items: [] }; lines.push(ln); }
    ln.items.push(it); ln.fs = Math.max(ln.fs, it.fs);
  }
  lines.sort((a, b) => b.y - a.y);
  return lines.map((l) => {
    l.items.sort((a, b) => a.x - b.x);
    let text = '', end = null;
    for (const it of l.items) {
      if (end != null && it.x - end > l.fs * 0.12 && !/\s$/.test(text) && !/^\s/.test(it.s)) text += ' ';
      text += it.s; end = it.x + it.w;
    }
    return { text: text.replace(/\s+/g, ' ').trim(), x0: l.items[0].x, x1: end, y: l.y, fs: l.fs };
  }).filter((l) => l.text);
}
async function buildFlow(pdf, progress) {
  const n = pdf.numPages, pages = [];
  for (let i = 0; i < n; i++) {
    const page = await pdf.getPage(i + 1);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    pages.push({ H: vp.height, lines: textLines(tc.items) });
    if (progress && i % 5 === 0) progress(i / n);
  }
  // running headers, footers and page numbers
  const zone = (l, H) => l.y > H * 0.91 || l.y < H * 0.085;
  const keyOf = (t) => t.toLowerCase().replace(/[\divxlc]+/gi, '#').replace(/\s+/g, ' ');
  const counts = new Map();
  for (const p of pages) for (const l of p.lines) if (zone(l, p.H)) counts.set(keyOf(l.text), (counts.get(keyOf(l.text)) || 0) + 1);
  const furniture = (l, p) => zone(l, p.H) && (/^[\W\d]*$/.test(l.text) || /^[\W]*[ivxlc]+[\W]*$/i.test(l.text) || (counts.get(keyOf(l.text)) || 0) >= Math.max(3, n * 0.2));
  const allFs = pages.flatMap((p) => p.lines.filter((l) => l.text.length > 25).map((l) => l.fs));
  const bodyFs = median(allFs) || 10;
  let text = ''; const paras = []; const pdfPageStart = [];
  let cur = null, prev = null;
  const curStart = () => text.length + (text ? 1 : 0);
  const flush = () => {
    if (cur && cur.text) { if (text) text += '\n'; paras.push({ start: text.length, end: text.length + cur.text.length, kind: cur.kind }); text += cur.text; }
    cur = null;
  };
  pages.forEach((p, pi) => {
    const lines = p.lines.filter((l) => !furniture(l, p));
    const body = lines.filter((l) => l.text.length > 25 && Math.abs(l.fs - bodyFs) < bodyFs * 0.15);
    const left = body.length ? pct(body.map((l) => l.x0), 0.15) : 0;
    const right = body.length ? pct(body.map((l) => l.x1), 0.85) : 0;
    const gaps = []; for (let i = 1; i < body.length; i++) { const g = body[i - 1].y - body[i].y; if (g > 0 && g < bodyFs * 3) gaps.push(g); }
    const lineGap = median(gaps) || bodyFs * 1.25;
    const justified = body.length > 4 && body.filter((l) => right - l.x1 < bodyFs * 1.2).length / body.length > 0.6;
    pdfPageStart[pi] = null;
    let prevOnPage = null;
    for (const l of lines) {
      const colW = Math.max(1, right - left);
      const centred = l.text.length < 40 && l.x0 > left + colW * 0.2 && Math.abs((l.x0 + l.x1) / 2 - (left + right) / 2) < colW * 0.12;
      const heading = l.text.length < 90 && (l.fs > bodyFs * 1.18 || centred);
      let startNew;
      if (heading) startNew = !(cur && cur.kind === 'h' && prevOnPage && Math.abs(cur.fs - l.fs) < 0.5);
      else if (!cur || cur.kind === 'h') startNew = true;
      else {
        const indent = l.x0 > left + bodyFs * 0.8 && l.x0 < left + colW * 0.35;
        const gap = prevOnPage && prevOnPage.y - l.y > lineGap * 1.6;
        const prevShort = prev && justified && prev.x1 < right - bodyFs * 2.5 && /[.!?:;”"’')\]—]$/.test(prev.text);
        startNew = indent || gap || prevShort;
      }
      if (startNew) flush();
      if (pdfPageStart[pi] == null) pdfPageStart[pi] = cur ? curStart() + cur.text.length + 1 : curStart();
      if (!cur) cur = { kind: heading ? 'h' : 'p', text: l.text, fs: l.fs };
      else if (/\p{L}-$/u.test(cur.text) && /^\p{Ll}/u.test(l.text)) cur.text = cur.text.slice(0, -1) + l.text;
      else cur.text += ' ' + l.text;
      prev = l; prevOnPage = l;
    }
    if (pdfPageStart[pi] == null) pdfPageStart[pi] = cur ? curStart() + cur.text.length : curStart();
  });
  flush();
  for (let i = 0; i < pdfPageStart.length; i++) pdfPageStart[i] = Math.min(pdfPageStart[i], text.length);
  return { v: 3, text, paras, pdfPageStart };
}
async function ensureFlow(progress) {
  if (S.flow) return S.flow;
  const key = S.book.id + '#flow';
  const cached = await DB.get('text', key);
  if (cached && cached.v === 3 && cached.n === S.pdf.numPages) { S.flow = cached; }
  else {
    const f = await buildFlow(S.pdf, progress);
    S.flow = { id: key, n: S.pdf.numPages, ...f };
    DB.put('text', S.flow).catch(() => {});
  }
  S.flowNorm = null;
  return S.flow;
}
function paraAt(off) { // index of the paragraph containing (or following) an offset
  const ps = S.flow.paras; let lo = 0, hi = ps.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (ps[mid].end < off) lo = mid + 1; else hi = mid; }
  return lo;
}

/* ---------- 2. finding the reader's phrases in the text ---------- */
function flowNorm() {
  if (!S.flowNorm) { const { low, map } = normPieces([S.flow.text], true); S.flowNorm = { low, map: map.map((m) => (m ? m[1] : -1)) }; }
  return S.flowNorm;
}
function findPhrase(phrase, expect = 0, minOff = 0) {
  const q = normQuery(phrase || ''); if (!q) return null;
  const { low, map } = flowNorm();
  const cands = [];
  for (let i = low.indexOf(q); i !== -1; i = low.indexOf(q, i + 1)) cands.push({ s: map[i], e: map[i + q.length - 1] + 1, exact: true });
  if (!cands.length) {
    // Loose match: the same words close together, in any order ("brooding gloom" ↔ "gloom, brooding").
    const words = q.split(/[^\p{L}\p{N}']+/u).filter((w) => w.length > 1);
    if (!words.length) return null;
    const rare = words.reduce((a, b) => (b.length > a.length ? b : a));
    for (let i = low.indexOf(rare); i !== -1; i = low.indexOf(rare, i + 1)) {
      const win = low.slice(Math.max(0, i - 90), i + 90 + rare.length);
      if (words.every((w) => win.includes(w))) {
        const base = Math.max(0, i - 90);
        const pos = words.map((w) => { let best = -1; for (let j = win.indexOf(w); j !== -1; j = win.indexOf(w, j + 1)) if (best < 0 || Math.abs(j - 90) < Math.abs(best - 90)) best = j; return [base + best, base + best + w.length]; });
        const s = Math.min(...pos.map((p) => p[0])), e = Math.max(...pos.map((p) => p[1]));
        if (e - s < 120) cands.push({ s: map[s], e: map[e - 1] + 1, exact: false });
      }
    }
  }
  const ok = cands.filter((c) => c.s >= minOff && c.s >= 0);
  if (!ok.length) return null;
  ok.sort((a, b) => Math.abs(a.s - expect) - Math.abs(b.s - expect));
  return { ...ok[0], count: ok.length };
}
function endAfter(off) { // a page that ends with a word also ends with the punctuation glued to it
  const t = S.flow.text; while (off < t.length && /[^\s]/.test(t[off]) && /[\p{P}\p{S}]/u.test(t[off])) off++;
  while (off < t.length && /\s/.test(t[off])) off++;
  return off;
}
// Rough position of a page in the text, used to choose between repeated phrases.
function estimateOffset(ed, page, startOffset) {
  const perPage = (defaultL(ed) / 0.43) * defaultC(ed) * 0.93;
  return (startOffset || 0) + Math.max(0, page - (ed.startPage || 1)) * perPage;
}
function contextAround(s, e) { const t = S.flow.text; return { before: t.slice(Math.max(0, s - 40), s), hit: t.slice(s, e), after: t.slice(e, e + 40) }; }

/* ---------- 3. page breaks ---------- */
const trimOf = (ed) => TRIMS[ed.trim] || TRIMS['5x8'];
// Line length is measured in ems of a typical book serif, so proportional letter widths are respected.
const defaultL = (ed) => +((trimOf(ed).w - 1.3) * 72 / 11).toFixed(1);
const defaultC = (ed) => Math.round(trimOf(ed).h * 72 * 0.8 / 14.8);
function unitsFor(from, to, L, ed) {
  const t = S.flow.text, ps = S.flow.paras, units = [];
  for (let k = paraAt(from); k < ps.length && ps[k].start < to; k++) {
    const p = ps[k], s = Math.max(p.start, from), e = Math.min(p.end, to);
    if (e <= s) continue;
    if (p.kind === 'h') { if (s === p.start) units.push({ off: s, h: HEAD_UNITS + Math.ceil(wordEm(t, p.start, p.end) * 1.3 / L) - 1, brk: ed.chapterNewPage }); continue; }
    let col = s === p.start && !(k > 0 && ps[k - 1].kind === 'h') ? INDENT_EM : 0, first = true;
    const re = /\S+/g; re.lastIndex = s;
    for (let m = re.exec(t); m && m.index < e; m = re.exec(t)) {
      const w = wordEm(t, m.index, m.index + m[0].length);
      if (first) { units.push({ off: m.index, h: 1 }); col += w; first = false; continue; }
      if (col + SPACE_EM + w > L) { units.push({ off: m.index, h: 1 }); col = w; } else col += SPACE_EM + w;
    }
  }
  return units;
}
// Pages hold C lines on average; fractions carry over so the stretch between two anchors fills evenly.
function layoutUnits(units, C) {
  const starts = []; let cum = 0, base = 0, n = 0, used = 0;
  for (const u of units) {
    if (!starts.length) { starts.push(u.off); cum = u.h; used = u.h; continue; }
    if (u.brk && used > 0) { starts.push(u.off); base = cum; n = 0; used = 0; }
    else if (cum + u.h - base > (n + 1) * C + 1e-9 && used > 0) { starts.push(u.off); n++; used = 0; }
    cum += u.h; used += u.h;
  }
  return starts;
}
function solveC(units, k) {
  if (!units.length) return { C: 30, starts: [] };
  let lo = 1, hi = 400;
  if (layoutUnits(units, hi).length > k) return { C: hi, starts: layoutUnits(units, hi) };
  for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (layoutUnits(units, mid).length <= k) hi = mid; else lo = mid; }
  return { C: hi, starts: layoutUnits(units, hi) };
}
function isHeadingAt(off) {
  const t = S.flow.text; while (off < t.length && /\s/.test(t[off])) off++;
  const p = S.flow.paras[paraAt(off)]; return !!p && p.kind === 'h' && p.start === off;
}
function anchorList(ed) {
  const out = [{ page: ed.startPage, off: ed.startOffset || 0 }];
  // An anchor that begins a chapter, or marks the end of the story, follows a page that is only partly full.
  for (const a of ed.anchors || []) if (a.offset != null) out.push({ page: a.edge === 'end' ? a.page + 1 : a.page, off: a.offset, ragged: a.role === 'end' || isHeadingAt(a.offset) });
  out.sort((a, b) => a.page - b.page || a.off - b.off);
  const clean = [];
  for (const a of out) { const last = clean[clean.length - 1]; if (last && (a.page <= last.page || a.off <= last.off)) continue; clean.push(a); }
  return clean;
}
function paginate(ed) {
  const total = S.flow.text.length;
  const anchors = anchorList(ed).filter((a) => a.off < total);
  const segs = []; for (let i = 1; i < anchors.length; i++) segs.push([anchors[i - 1], anchors[i]]);
  // Line length: if there are enough anchors, pick the one that makes the edition's page capacity most consistent.
  let L = defaultL(ed);
  const usable = segs.filter(([a, b]) => b.page - a.page >= 2);
  if (usable.length >= 4) {
    let best = Infinity;
    for (let cand = 16; cand <= 40; cand += 0.5) {
      const cs = usable.filter(([, b]) => !b.ragged).map(([a, b]) => solveC(unitsFor(a.off, b.off, cand, ed), b.page - a.page).C);
      if (cs.length < 3) { L = defaultL(ed); break; }
      const mean = cs.reduce((x, y) => x + y, 0) / cs.length;
      const sd = Math.sqrt(cs.reduce((x, y) => x + (y - mean) ** 2, 0) / cs.length);
      const score = sd / mean + Math.abs(cand - defaultL(ed)) / 150;
      if (score < best) { best = score; L = cand; }
    }
  }
  // Clean stretches (ending mid-text) tell us how many lines a full page holds.
  const solved = segs.map(([a, b]) => { const units = unitsFor(a.off, b.off, L, ed); return { a, b, units, k: b.page - a.page, ...(b.ragged ? {} : solveC(units, b.page - a.page)) }; });
  let wsum = 0, csum = 0;
  for (const g of solved) if (!g.b.ragged) { wsum += g.k; csum += g.C * g.k; }
  const cleanC = wsum ? csum / wsum : null;
  // Stretches ending at a chapter (or the end) fit k pages for any capacity in a range. Every chapter of a book
  // shares one capacity, so where the ranges overlap pins it down; a single stretch is left about half full.
  const ragged = solved.filter((g) => g.b.ragged);
  for (const g of ragged) {
    g.cmin = solveC(g.units, g.k).C; g.cmax = g.cmin;
    for (let lo = g.cmin, hi = 400, i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (layoutUnits(g.units, mid).length >= g.k) { g.cmax = mid; lo = mid; } else hi = mid; }
  }
  let shared = cleanC;
  if (shared == null && ragged.length >= 2) {
    const lo = Math.max(...ragged.map((g) => g.cmin)), hi = Math.min(...ragged.map((g) => g.cmax));
    shared = lo <= hi ? (lo + hi) / 2 : median(ragged.map((g) => (g.cmin + g.cmax) / 2));
  }
  for (const g of ragged) {
    const total = g.units.reduce((x, u) => x + u.h, 0);
    const half = clamp(total / Math.max(1, g.k - 0.5), g.cmin, g.cmax);
    g.C = shared != null && shared >= g.cmin && shared <= g.cmax ? shared : half;
    g.starts = layoutUnits(g.units, g.C);
  }
  const starts = [], caps = [];
  for (const g of solved) {
    for (let i = 0; i < g.k; i++) { starts.push(g.starts[i] ?? g.starts[g.starts.length - 1] ?? g.a.off); caps.push(g.C); }
    if (cleanC == null) { wsum += g.k; csum += g.C * g.k; }
  }
  const last = anchors[anchors.length - 1];
  const C = wsum ? (csum + defaultC(ed) * 2) / (wsum + 2) : defaultC(ed);
  const tail = layoutUnits(unitsFor(last.off, total, L, ed), C);
  for (const s of tail) { starts.push(s); caps.push(C); }
  if (!starts.length) { starts.push(last.off); caps.push(C); }
  return { first: anchors[0].page, starts, caps, L, C };
}
const edPageOf = (off) => { const st = S.ed.starts; let lo = 0, hi = st.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (st[mid] <= off) lo = mid; else hi = mid - 1; } return lo; };
const edRange = (pi) => [S.ed.starts[pi], S.ed.starts[pi + 1] ?? S.flow.text.length];

/* ---------- 4. drawing an edition page ---------- */
function renderEdSheet(sh) {
  // One type size for the whole book (from the typical page), so pages look like the same edition.
  const [s, e] = edRange(sh.pi), C = Math.max(S.ed.C, 12);
  const t = S.flow.text, ps = S.flow.paras;
  const box = el('div', { class: 'edtext', lang: 'en-GB' });
  for (let k = paraAt(s); k < ps.length && ps[k].start < e; k++) {
    const p = ps[k], a = Math.max(p.start, s), b = Math.min(p.end, e);
    if (b <= a) continue;
    const span = el('span', { 'data-o': a, text: t.slice(a, b) });
    if (p.kind === 'h') { box.append(el('h3', { class: 'edh' }, span, el('i', { class: 'pe' }))); continue; }
    const cls = [a > p.start ? 'cont' : '', b < p.end ? 'brk' : '', k > 0 && ps[k - 1].kind === 'h' && a === p.start ? 'first' : ''].filter(Boolean).join(' ');
    box.append(el('p', { class: cls || null }, span, el('i', { class: 'pe' })));
  }
  const lh = 1.36, fs0 = (sh.ch * 0.88) / (C * lh);
  const width = clamp(S.ed.L * fs0 * 1.04, sh.cw * 0.6, sh.cw * 0.94);
  Object.assign(box.style, { left: (sh.cw - width) / 2 + 'px', top: sh.ch * 0.06 + 'px', width: width + 'px', height: sh.ch * 0.88 + 'px', fontSize: fs0 + 'px', lineHeight: lh });
  sh.content.querySelector('.loading')?.remove();
  sh.content.append(box);
  let fs = fs0;
  for (let i = 0; i < 14 && box.scrollHeight > box.clientHeight + 1; i++) { fs *= 0.97; box.style.fontSize = fs + 'px'; }
  sh.textLayer = box;
  if (S.edPick != null) box.classList.add('picking');
  const fix = el('button', { class: 'edfix', type: 'button', title: 'If your printed page ends somewhere else, click here, then click the last word on your page' }, 'Page ends differently in your book?');
  fix.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  fix.addEventListener('click', (ev) => { ev.stopPropagation(); startPick(sh.pi); });
  sh.el.append(fix);
}
function domToOffset(node, off) {
  const span = (node.nodeType === 3 ? node.parentElement : node)?.closest?.('span[data-o]');
  if (!span) return null;
  return +span.dataset.o + (node.nodeType === 3 ? off : 0);
}
function offsetToDom(sh, off) {
  for (const span of sh.textLayer.querySelectorAll('span[data-o]')) {
    const o = +span.dataset.o, n = span.firstChild; if (!n) continue;
    if (off >= o && off <= o + n.length) return { node: n, off: off - o };
  }
  return null;
}
function spanRects(sh, hl) {
  if (!sh.textLayer || !S.ed) return [];
  const [ps, pe] = edRange(sh.pi);
  const a = Math.max(hl.start, ps), b = Math.min(hl.end, pe);
  if (a >= b) return [];
  const da = offsetToDom(sh, a), db = offsetToDom(sh, b); if (!da || !db) return [];
  const r = document.createRange();
  try { r.setStart(da.node, da.off); r.setEnd(db.node, db.off); } catch { return []; }
  const sr = sh.el.getBoundingClientRect(), z = sr.width / sh.W || 1;
  const lines = [];
  for (const c of r.getClientRects()) {
    if (c.width < 0.5) continue;
    const cy = c.top + c.height / 2;
    const ln = lines.find((l) => Math.abs(l.cy - cy) < c.height * 0.5);
    if (ln) { ln.l = Math.min(ln.l, c.left); ln.r = Math.max(ln.r, c.right); } else lines.push({ cy, l: c.left, r: c.right, t: c.top, b: c.bottom });
  }
  return lines.map((l) => [(l.l - sr.left) / z, (l.t - sr.top) / z, (l.r - l.l) / z, (l.b - l.t) / z]);
}

/* ---------- 5. correcting a page by clicking where it really ends ---------- */
function startPick(pi) {
  S.edPick = pi;
  $$('.edtext').forEach((b) => b.classList.add('picking'));
  toast(`Click the last word on page ${pageName(pi)} of your book. It may be on the next page here. Esc to cancel.`, 8000);
}
function stopPick() { S.edPick = null; $$('.edtext').forEach((b) => b.classList.remove('picking')); }
async function pickAt(sh, e) {
  const c = caretAt(sh.textLayer, e.clientX, e.clientY); if (!c) return;
  let off = domToOffset(c.node, c.off); if (off == null) return;
  const t = S.flow.text;
  while (off < t.length && /[\p{L}\p{N}'’]/u.test(t[off])) off++; // to the end of the clicked word
  const pi = S.edPick; stopPick();
  const page = S.ed.first + pi;
  const ed = S.book.edition;
  ed.anchors = (ed.anchors || []).filter((a) => !((a.edge === 'end' && a.page === page) || (a.edge === 'start' && a.page === page + 1)));
  ed.anchors.push({ page, edge: 'end', offset: endAfter(off), phrase: t.slice(Math.max(0, off - 24), off).trim() });
  repaginate(`Page ${page} now ends with “…${t.slice(Math.max(0, off - 30), off).trim()}”. Pages around it have been adjusted.`);
}
function repaginate(msg) {
  const keep = visiblePages()[0] ?? 0;
  const keepOff = S.ed ? S.ed.starts[keep] : 0;
  S.ed = paginate(S.book.edition); S.edIndex = null;
  reattachEdAnnotations();
  scheduleSave();
  if (S.doc === 'ed') { S.spreads = computeSpreads(); showSpread(spreadOf(edPageOf(keepOff)), 0); }
  if (msg) toast(msg, 5000);
}
// Highlights are tied to the text itself, so after re-pagination notes and arrows follow them to their new page.
function reattachEdAnnotations() {
  const a = S.edAnn; if (!a || !S.ed) return;
  for (const h of a.hls) if (h.type === 'span') h.page = edPageOf(h.start);
  for (const ar of a.arrows) {
    const h = a.hls.find((x) => x.id === ar.from.ref || x.id === ar.to.ref);
    if (h && h.type === 'span') { ar.page = h.page; for (const end of [ar.from, ar.to]) { const n = a.notes.find((x) => x.id === end.ref); if (n) n.page = h.page; } }
  }
}

/* ---------- 6. bringing existing PDF annotations across ---------- */
function migrateToEdition() {
  const src = S.bookAnn, dst = S.edAnn, f = S.flow;
  if (dst.hls.length || dst.notes.length) return null;
  const pageLen = (pi) => (f.pdfPageStart[pi + 1] ?? f.text.length) - f.pdfPageStart[pi];
  let hls = 0, notes = 0, skipped = 0;
  const { low, map } = flowNorm();
  for (const h of src.hls) {
    if (h.type !== 'text' || !h.text) { skipped++; continue; }
    const q = normQuery(h.text);
    const lo = Math.max(0, f.pdfPageStart[h.page] - 300);
    let found = -1;
    for (let i = low.indexOf(q); i !== -1; i = low.indexOf(q, i + 1)) { if (map[i] >= lo) { found = i; break; } }
    if (found < 0) { skipped++; continue; }
    const start = map[found], end = map[found + q.length - 1] + 1;
    dst.hls.push({ id: h.id, type: 'span', start, end, page: edPageOf(start), color: h.color, style: h.style, text: f.text.slice(start, end), created: h.created });
    hls++;
  }
  for (const n of src.notes) {
    const link = src.arrows.find((ar) => ar.from.ref === n.id || ar.to.ref === n.id);
    const other = link && dst.hls.find((h) => h.id === (link.from.ref === n.id ? link.to.ref : link.from.ref));
    const page = other ? other.page : edPageOf(f.pdfPageStart[n.page] + Math.round(clamp(n.y, 0, 1) * pageLen(n.page)));
    dst.notes.push({ ...n, page }); notes++;
  }
  for (const ar of src.arrows) {
    const ends = [ar.from, ar.to];
    if (ends.some((x) => x.ref && !dst.hls.some((h) => h.id === x.ref) && !dst.notes.some((m) => m.id === x.ref))) continue;
    const refPages = ends.filter((x) => x.ref).map((x) => (dst.hls.find((h) => h.id === x.ref) || dst.notes.find((m) => m.id === x.ref)).page);
    if (new Set(refPages).size > 1) continue;
    dst.arrows.push({ ...ar, page: refPages[0] ?? edPageOf(f.pdfPageStart[ar.page]) });
  }
  for (const b of src.bms) if (!dst.bms.some((x) => x.page === edPageOf(f.pdfPageStart[b.page]))) dst.bms.push({ ...b, page: edPageOf(f.pdfPageStart[b.page]) });
  return { hls, notes, skipped };
}

/* ---------- 7. the setup window ---------- */
async function openEditionSetup() {
  if (!S.book) return;
  closeMenus(); commitEditing();
  const modal = $('#edModal'), body = $('#edBody');
  modal.hidden = false; body.textContent = '';
  body.append(el('p', { class: 'muted', text: 'Reading the text of this PDF…' }));
  try { await ensureFlow((p) => { body.firstChild.textContent = `Reading the text of this PDF… ${Math.round(p * 100)}%`; }); }
  catch (e) { console.error(e); body.textContent = 'This PDF’s text couldn’t be read.'; return; }
  if (S.flow.text.length < 500) { body.textContent = ''; body.append(el('p', { text: 'This PDF has almost no readable text — it’s probably a scan without a text layer, so it can’t be re-laid out. Try a different copy from “Find a free copy”.' })); return; }
  const ed = { ...edDefaults(), ...(S.book.edition || {}) };
  ed.anchors = (ed.anchors || []).map((a) => ({ ...a }));
  if (!ed.startPhrase) {
    // Skip title pages: start at the first real paragraph of prose, or the chapter heading just before it.
    const ps = S.flow.paras; let k = ps.findIndex((p) => p.kind === 'p' && p.end - p.start > 120);
    if (k < 0) k = 0; if (k > 0 && ps[k - 1].kind === 'h') k--;
    ed.startPhrase = firstWords(S.flow.text, ps[k]?.start ?? 0, 7);
  }
  body.textContent = '';
  const isbnIn = el('input', { type: 'text', value: ed.isbn || '', placeholder: 'e.g. 9780141441672', 'aria-label': 'ISBN' });
  const isbnOut = el('div', { class: 'muted small', text: ed.info || '' });
  const lookBtn = el('button', { class: 'btn', type: 'button', text: 'Look up' });
  const trimSel = el('select', {}, ...Object.entries(TRIMS).map(([k, v]) => el('option', { value: k, text: v.label, selected: k === ed.trim })));
  const startPage = el('input', { type: 'number', min: 1, value: ed.startPage, class: 'pg-in', 'aria-label': 'Page the text starts on' });
  const startPhrase = el('input', { type: 'text', value: ed.startPhrase, 'aria-label': 'First words of the text' });
  const startStatus = el('div', { class: 'astatus' });
  const chap = el('input', { type: 'checkbox', checked: ed.chapterNewPage });
  const rows = el('div', { class: 'anchors' });
  lookBtn.addEventListener('click', async () => {
    if (!isIsbn(isbnIn.value)) { isbnOut.textContent = 'That doesn’t look like an ISBN (10 or 13 digits).'; return; }
    isbnOut.textContent = 'Looking it up…';
    const info = await lookupIsbn(isbnIn.value);
    if (!info) { isbnOut.textContent = 'Not found in the public book databases (common for self-published and print-on-demand editions). That’s fine — just choose the size below.'; return; }
    ed.info = [info.title, info.author && 'by ' + info.author, info.publisher, info.year, info.pages && `${info.pages} pages`].filter(Boolean).join(' · ');
    isbnOut.textContent = ed.info;
    if (info.trim) {
      const near = Object.entries(TRIMS).sort((x, y) => (Math.abs(x[1].w - info.trim.w) + Math.abs(x[1].h - info.trim.h)) - (Math.abs(y[1].w - info.trim.w) + Math.abs(y[1].h - info.trim.h)))[0];
      trimSel.value = near[0];
    }
  });
  const estimate = (page) => estimateOffset({ ...ed, trim: trimSel.value, startPage: +startPage.value || 1 }, page, findPhrase(startPhrase.value, 0)?.s ?? 0);
  const showMatch = (target, m, label) => {
    target.textContent = '';
    if (!m) { target.className = 'astatus bad'; target.append('Not found in the text — check the spelling, or try a few different words from that line.'); return; }
    const c = contextAround(m.s, m.e);
    target.className = 'astatus ok';
    target.append(m.exact ? '✓ ' : '≈ ', label, ' “…' + c.before.slice(-28), el('mark', { text: c.hit }), c.after.slice(0, 28) + '…”');
    if (m.count > 1) target.append(el('div', { class: 'warn', text: `These words appear ${m.count} times; I’ve picked the likeliest. If it’s the wrong place, type a few more words.` }));
  };
  const checkStart = () => showMatch(startStatus, findPhrase(startPhrase.value, 0), 'starts at');
  startPhrase.addEventListener('input', debounce(checkStart, 250)); checkStart();
  const addRow = (a = { page: '', edge: 'end', phrase: '' }) => {
    const pg = el('input', { type: 'number', min: 1, value: a.page, class: 'pg-in', 'aria-label': 'Page number' });
    const edge = el('select', {}, el('option', { value: 'end', text: 'ends with', selected: a.edge !== 'start' }), el('option', { value: 'start', text: 'starts with', selected: a.edge === 'start' }));
    const ph = el('input', { type: 'text', value: a.phrase || '', placeholder: 'the last few words on that page' });
    const st = el('div', { class: 'astatus' });
    const row = el('div', { class: 'arow' }, el('span', { text: 'Page' }), pg, edge, ph,
      el('button', { class: 'x', type: 'button', title: 'Remove', text: '×', onclick: () => row.remove() }), st);
    const check = () => { const m = ph.value.trim() && pg.value ? findPhrase(ph.value, estimate(+pg.value)) : null; if (ph.value.trim() && pg.value) showMatch(st, m, edge.value === 'end' ? 'page ends after' : 'page starts at'); else st.textContent = ''; row._m = m; };
    for (const x of [pg, edge, ph]) x.addEventListener('input', debounce(check, 250));
    rows.append(row); check();
    return row;
  };
  const endRow = addRow(ed.anchors.find((a) => a.role === 'end') || { page: '', edge: 'end', phrase: '' });
  endRow.classList.add('endrow');
  endRow.querySelector('span').textContent = 'Last page';
  endRow.querySelector('.x').remove();
  endRow.querySelector('select').disabled = true;
  endRow.querySelector('input[type=text]').placeholder = 'the last few words of the story';
  const endWrap = el('div', {}, endRow);
  // Chapter openings, copied from the contents page of the reader's book, are the easiest anchors to give.
  const so0 = findPhrase(ed.startPhrase, 0)?.s ?? 0;
  const heads = S.flow.paras.filter((p) => p.kind === 'h' && p.start > so0 + 50).slice(0, 80);
  const chapWrap = el('div', { class: 'chaps' });
  for (const h of heads) {
    const prev = ed.anchors.find((a) => a.role === 'chapter' && a.offset === h.start);
    const inp = el('input', { type: 'number', min: 1, class: 'pg-in', value: prev?.page ?? '', 'aria-label': 'Page number' });
    inp.dataset.off = h.start;
    chapWrap.append(el('label', { class: 'chap' }, el('span', { class: 'ctitle', text: S.flow.text.slice(h.start, Math.min(h.end, h.start + 60)) }), el('span', { class: 'muted', text: 'starts on page' }), inp));
  }
  for (const a of ed.anchors.filter((a) => !a.role)) addRow(a);
  if (!ed.anchors.filter((a) => !a.role).length) addRow();
  body.append(
    el('p', { class: 'lede', text: 'Your PDF breaks its pages in different places from the copy you use in class. Tell me where a few of your book’s pages end, and I’ll lay the text out again so its pages match yours, page numbers included.' }),
    el('div', { class: 'fgrid' },
      el('label', {}, 'ISBN of your copy (optional)', el('span', { class: 'inline' }, isbnIn, lookBtn), isbnOut),
      el('label', {}, 'Size of your book', trimSel)),
    el('h4', { text: 'Where the text starts' }),
    el('div', { class: 'arow' }, el('span', { text: 'Page' }), startPage, el('span', { text: 'starts with' }), startPhrase, startStatus),
    el('h4', { text: 'Where the text ends' }),
    el('p', { class: 'muted small', text: 'Flip to the last page of the story and type its page number and final few words. This matters most: it tells me how much text your pages hold.' }),
    endWrap,
    heads.length ? el('h4', { text: 'Where each chapter starts' }) : null,
    heads.length ? el('p', { class: 'muted small', text: 'Copy these from the contents page of your book. Leave any blank you’re not sure of.' }) : null,
    heads.length ? chapWrap : null,
    el('h4', { text: 'Where some pages end' }),
    el('p', { class: 'muted small', text: 'Optional, but each one helps: type the last two or three words of a page. One every 20 pages or so gets almost every page within a line. You can also fix any page later by clicking where it really ends.' }),
    rows,
    el('button', { class: 'btn', type: 'button', text: 'Add another page', onclick: () => addRow() }),
    el('label', { class: 'check' }, chap, ' Each chapter starts on a new page in my book'),
  );
  const foot = $('#edFoot'); foot.textContent = '';
  if (S.book.edition?.enabled) foot.append(el('button', { class: 'btn', type: 'button', text: 'Turn off — show the PDF’s own pages', onclick: () => { S.book.edition.enabled = false; modal.hidden = true; scheduleSave(); syncEdUI(); switchDoc('book'); } }));
  foot.append(el('span', { style: { flex: 1 } }), el('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => { modal.hidden = true; } }),
    el('button', { class: 'btn primary', type: 'button', text: 'Lay out like my book', onclick: () => {
      const sm = findPhrase(startPhrase.value, 0);
      const anchors = [];
      for (const row of [endRow, ...rows.children]) {
        const [pg, edge, ph] = row.querySelectorAll('input, select');
        if (!ph.value.trim() || !pg.value) continue;
        const m = findPhrase(ph.value, estimate(+pg.value), sm?.s ?? 0);
        if (!m) { toast(`Couldn’t find “${ph.value}” — fix or remove that line.`, 5000); return; }
        anchors.push({ page: +pg.value, edge: edge.value, phrase: ph.value.trim(), offset: edge.value === 'end' ? endAfter(m.e) : m.s, role: row === endRow ? 'end' : undefined });
      }
      for (const inp of chapWrap.querySelectorAll('input')) if (+inp.value > 0) anchors.push({ page: +inp.value, edge: 'start', offset: +inp.dataset.off, role: 'chapter' });
      if (!anchors.some((a) => a.role === 'end')) toast('Tip: add the last page and its final words for much closer matching.', 6000);
      S.book.edition = { ...ed, enabled: true, isbn: cleanIsbn(isbnIn.value), trim: trimSel.value, startPage: Math.max(1, +startPage.value || 1), startPhrase: startPhrase.value, startOffset: sm ? sm.s : 0, anchors, chapterNewPage: chap.checked };
      modal.hidden = true;
      enableEdition();
    } }));
}
function firstWords(t, off, n) { return (t.slice(off, off + 400).match(/\S+/g) || []).slice(0, n).join(' '); }
async function enableEdition() {
  S.book.edition.enabled = true;
  await ensureFlow();
  S.ed = paginate(S.book.edition); S.edIndex = null;
  const res = migrateToEdition();
  reattachEdAnnotations();
  syncEdUI(); scheduleSave();
  await switchDoc('ed', 0);
  if (res && (res.hls || res.notes)) toast(`Laid out like your book. Brought across ${res.hls} highlight${res.hls === 1 ? '' : 's'} and ${res.notes} note${res.notes === 1 ? '' : 's'}${res.skipped ? `; ${res.skipped} freehand mark${res.skipped === 1 ? '' : 's'} stayed on the PDF pages` : ''}.`, 7000);
  else toast('Laid out like your book. If a page ends in a different place, use “Page ends differently in your book?” under it.', 7000);
}
function syncEdUI() {
  const has = !!S.book?.edition?.anchors, on = !!S.book?.edition?.enabled;
  $('#edLayoutRow').hidden = !has && !on;
  $$('#edLayoutRow [data-lay]').forEach((b) => b.classList.toggle('on', (b.dataset.lay === 'ed') === on));
  $('#edSetupBtn').textContent = on ? 'Edit how it matches my edition…' : 'Match my printed edition…';
}
