'use strict';
/* Flashcard breaks for Geometry Dash.
   - Notices when Geometry Dash is running (a cheap process check every few seconds).
   - Counts attempts (from the "Rose's Flashcard Gate" Geode mod, which writes a small file) or minutes played.
   - When a break is due: minimises and freezes Geometry Dash, brings Rose's generic study app to the front
     full-screen, and unfreezes the game once every card has been flipped.
   On Windows a small PowerShell helper does the freezing. If Rose's generic study app closes or crashes, the helper
   notices its input closing and unfreezes the game, so Geometry Dash can never be left frozen. */
const { ipcMain, dialog } = require('electron');
const { spawn, execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;

const IS_WIN = process.platform === 'win32';
const TEST = process.env.RA_TEST_GD === '1'; // lets the whole flow be exercised on Linux with a stand-in process
const MOD_ID = 'rose.flashcard-gate';
const ATTEMPTS_FILE = process.env.RA_GD_ATTEMPTS_FILE
  || path.join(process.env.LOCALAPPDATA || path.join(require('node:os').homedir(), '.local', 'share'), 'RosesAnnotationsGD', 'attempts.txt');
const DEFAULTS = { enabled: true, mode: 'attempts', every: 10, minutes: 10, cards: 5, source: 'all', stackId: null };

const HELPER_PS1 = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class RAGate {
  [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h);
  [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  public static uint ForegroundPid() { uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid); return pid; }
}
"@
$script:frozen = @()
function GDProcs { @(Get-Process -Name GeometryDash -ErrorAction SilentlyContinue) }
function Say($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
function Thaw {
  foreach ($id in $script:frozen) {
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($p) { [void][RAGate]::NtResumeProcess($p.Handle) }
  }
}
Say @{ ready = $true }
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  if ($line -eq 'status') {
    $p = GDProcs | Select-Object -First 1
    if ($p) { Say @{ running = $true; pid = $p.Id; path = $p.Path; fg = ([RAGate]::ForegroundPid() -eq [uint32]$p.Id) } } else { Say @{ running = $false } }
  } elseif ($line -eq 'lock') {
    $ps = GDProcs
    foreach ($p in $ps) {
      if ($p.MainWindowHandle -ne [IntPtr]::Zero) { [void][RAGate]::ShowWindow($p.MainWindowHandle, 6) }
      Start-Sleep -Milliseconds 120
      [void][RAGate]::NtSuspendProcess($p.Handle)
      $script:frozen += $p.Id
    }
    Say @{ locked = $ps.Count }
  } elseif ($line -eq 'unlock') {
    Thaw
    foreach ($id in $script:frozen) {
      $p = Get-Process -Id $id -ErrorAction SilentlyContinue
      if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) {
        [void][RAGate]::ShowWindow($p.MainWindowHandle, 9)
        [RAGate]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [RAGate]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
        [void][RAGate]::SetForegroundWindow($p.MainWindowHandle)
      }
    }
    $script:frozen = @()
    Say @{ unlocked = $true }
  }
}
Thaw
`;

function createGate({ getWin, prefsFile, appResources }) {
  let cfg = { ...DEFAULTS };
  try { cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(prefsFile, 'utf8')) }; } catch {}
  const st = {
    running: false, pid: null, exe: null, fg: false, helper: false, locked: false, lockedAt: 0,
    attempts: 0, seconds: 0, modSeen: false, modLast: 0, cardsAvailable: 0, lastNotice: '',
  };
  let helper = null, helperBuf = '', waiters = [], pollTimer = null, tickTimer = null, missing = 0;
  let base = null; // { pid, count } from the attempts file

  const send = () => { const w = getWin(); if (w && !w.isDestroyed()) w.webContents.send('gd:status', status()); };
  const status = () => ({
    running: st.running, locked: st.locked, attempts: st.attempts, seconds: Math.floor(st.seconds), exe: st.exe,
    modSeen: st.modSeen, cfg, notice: st.lastNotice, platformOk: IS_WIN || TEST,
    due: cfg.mode === 'attempts' ? `${st.attempts}/${cfg.every}` : `${Math.floor(st.seconds / 60)}/${cfg.minutes}`,
  });

  /* ----- the helper process (Windows) or a stand-in (tests on Linux) ----- */
  function startHelper() {
    if (helper || !(IS_WIN || TEST)) return;
    if (IS_WIN) {
      const file = path.join(path.dirname(prefsFile), 'gd-helper.ps1');
      fs.writeFileSync(file, HELPER_PS1, 'utf8');
      helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      helper.stdout.setEncoding('utf8');
      helper.stdout.on('data', (d) => {
        helperBuf += d; let i;
        while ((i = helperBuf.indexOf('\n')) >= 0) {
          const line = helperBuf.slice(0, i).trim(); helperBuf = helperBuf.slice(i + 1);
          if (!line) continue;
          let msg; try { msg = JSON.parse(line); } catch { continue; }
          if (msg.ready) { st.helper = true; continue; }
          const w = waiters.shift(); if (w) w(msg);
        }
      });
      helper.on('exit', () => { helper = null; st.helper = false; for (const w of waiters.splice(0)) w(null); });
    } else {
      helper = { test: true }; st.helper = true;
    }
  }
  function stopHelper() {
    if (!helper) return;
    if (helper.test) { if (st.locked) testSignal('CONT'); helper = null; st.helper = false; return; }
    try { helper.stdin.end(); } catch {}
    helper = null; st.helper = false;
  }
  function ask(cmd) {
    if (!helper) return Promise.resolve(null);
    if (helper.test) return Promise.resolve(testAsk(cmd));
    return new Promise((res) => {
      const t = setTimeout(() => { const i = waiters.indexOf(done); if (i >= 0) waiters.splice(i, 1); res(null); }, 8000);
      const done = (m) => { clearTimeout(t); res(m); };
      waiters.push(done);
      try { helper.stdin.write(cmd + '\n'); } catch { clearTimeout(t); res(null); }
    });
  }
  // --- Linux test stand-in: a process whose command line starts with "GeometryDash" ---
  function testPid() {
    try { return require('node:child_process').execFileSync('pgrep', ['-f', '^GeometryDash'], { encoding: 'utf8' }).trim().split('\n')[0] || null; } catch { return null; }
  }
  function testSignal(sig) { const pid = st.pid || testPid(); if (pid) try { process.kill(+pid, 'SIG' + sig); } catch {} }
  function testAsk(cmd) {
    if (cmd === 'status') { const pid = testPid(); return pid ? { running: true, pid: +pid, path: '/fake/Geometry Dash/GeometryDash.exe', fg: true } : { running: false }; }
    if (cmd === 'lock') { testSignal('STOP'); return { locked: 1 }; }
    if (cmd === 'unlock') { testSignal('CONT'); return { unlocked: true }; }
    return null;
  }

  /* ----- is Geometry Dash running? ----- */
  function quickCheck() {
    return new Promise((res) => {
      if (TEST) return res(!!testPid());
      if (!IS_WIN) return res(false);
      execFile('tasklist', ['/FI', 'IMAGENAME eq GeometryDash.exe', '/FO', 'CSV', '/NH'], { windowsHide: true }, (err, out) => res(!err && /GeometryDash\.exe/i.test(out || '')));
    });
  }
  async function poll() {
    const up = await quickCheck();
    if (up) {
      missing = 0;
      if (!st.running) { st.running = true; st.attempts = 0; st.seconds = 0; base = null; startHelper(); startTick(); }
      if (st.helper && !st.locked) {
        const s = await ask('status');
        if (s && s.running) { st.pid = s.pid; st.exe = s.path || st.exe; st.fg = !!s.fg; }
      }
    } else if (st.running && ++missing >= 2) {
      st.running = false; st.pid = null; st.fg = false;
      if (st.locked) endLock(false);
      stopHelper(); stopTick();
    }
    send();
  }

  /* ----- counting attempts and minutes ----- */
  function readAttempts() {
    let txt; try { txt = fs.readFileSync(ATTEMPTS_FILE, 'utf8').trim(); } catch { return; }
    const [pidS, countS] = txt.split(/\s+/); const pid = pidS, count = +countS;
    if (!Number.isFinite(count)) return;
    if (!base || base.pid !== pid || count < base.count) { base = { pid, count }; return; }
    let mtime = 0; try { mtime = fs.statSync(ATTEMPTS_FILE).mtimeMs; } catch {}
    if (mtime && mtime !== st.modLast) { st.modLast = mtime; st.modSeen = true; }
    const delta = count - base.count; base.count = count;
    if (delta > 0 && !st.locked) { st.attempts += delta; send(); maybeBreak(); }
  }
  function startTick() {
    stopTick();
    try { fs.watchFile(ATTEMPTS_FILE, { interval: 700 }, readAttempts); } catch {}
    readAttempts();
    let last = Date.now();
    tickTimer = setInterval(() => {
      const now = Date.now(), dt = (now - last) / 1000; last = now;
      if (st.running && !st.locked && st.fg) {
        st.seconds += dt;
        if (cfg.mode === 'minutes') maybeBreak();
      }
    }, 2000);
  }
  function stopTick() { try { fs.unwatchFile(ATTEMPTS_FILE, readAttempts); } catch {} clearInterval(tickTimer); tickTimer = null; }

  function maybeBreak() {
    if (!cfg.enabled || st.locked || !st.running) return;
    const due = cfg.mode === 'attempts' ? st.attempts >= cfg.every : st.seconds >= cfg.minutes * 60;
    if (due) startLock('auto');
  }

  /* ----- locking ----- */
  async function startLock(why) {
    if (st.locked) return { ok: false, reason: 'already' };
    if (st.cardsAvailable < 1) { st.lastNotice = 'A flashcard break was due, but there are no flashcards to show yet.'; st.attempts = 0; st.seconds = 0; send(); return { ok: false, reason: 'nocards' }; }
    if (!st.helper) startHelper();
    st.locked = true; st.lockedAt = Date.now(); st.lastNotice = '';
    if (st.running) await ask('lock');
    const w = getWin();
    if (w && !w.isDestroyed()) {
      if (w.isMinimized()) w.restore();
      w.show(); w.setAlwaysOnTop(true, 'screen-saver'); w.setFullScreen(true); w.focus(); w.moveTop();
      w.webContents.send('gate:start', { cards: cfg.cards, source: cfg.source, stackId: cfg.stackId, why });
    }
    send();
    return { ok: true };
  }
  async function endLock(refocusGame = true) {
    if (!st.locked) return;
    st.locked = false; st.attempts = 0; st.seconds = 0;
    const w = getWin();
    if (w && !w.isDestroyed()) { w.setAlwaysOnTop(false); w.setFullScreen(false); }
    await ask('unlock');
    if (refocusGame && st.running && w && !w.isDestroyed()) setTimeout(() => { try { w.minimize(); } catch {} }, 250);
    send();
  }

  /* ----- installing the helper mod into Geometry Dash ----- */
  function gdFolder() { return st.exe ? path.dirname(st.exe) : null; }
  async function modInfo() {
    const dir = gdFolder();
    if (!dir) return { known: false };
    const geode = fs.existsSync(path.join(dir, 'geode')) || fs.existsSync(path.join(dir, 'Geode.dll'));
    let installed = false; try { installed = (await fsp.readdir(path.join(dir, 'geode', 'mods'))).some((f) => f.startsWith(MOD_ID)); } catch {}
    const bundled = bundledMod();
    return { known: true, dir, geode, installed, bundled: !!bundled };
  }
  function bundledMod() {
    for (const d of [path.join(appResources, 'gd-helper'), path.join(__dirname, '..', 'gd-helper', 'dist')]) {
      try { const f = fs.readdirSync(d).find((x) => x.endsWith('.geode')); if (f) return path.join(d, f); } catch {}
    }
    return null;
  }
  async function installMod(fromDialog) {
    const info = await modInfo();
    if (!info.known) return { ok: false, msg: 'Open Geometry Dash first, so I can find where it’s installed.' };
    if (!info.geode) return { ok: false, msg: 'Geode isn’t installed in Geometry Dash yet. Install it from geode-sdk.org, open Geometry Dash once, then try again.' };
    let src = fromDialog ? null : bundledMod();
    if (!src) {
      const r = await dialog.showOpenDialog(getWin(), { title: 'Choose the helper mod (.geode file)', filters: [{ name: 'Geode mod', extensions: ['geode'] }], properties: ['openFile'] });
      if (r.canceled || !r.filePaths[0]) return { ok: false, msg: '' };
      src = r.filePaths[0];
    }
    const dest = path.join(info.dir, 'geode', 'mods', MOD_ID + '.geode');
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(src, dest);
    return { ok: true, msg: 'Helper mod installed. Restart Geometry Dash to switch it on.' };
  }

  /* ----- IPC ----- */
  ipcMain.handle('gd:status', () => status());
  ipcMain.handle('gd:config', async (_e, next) => {
    const n = next || {};
    const int = (v, lo, hi, d) => { v = Math.round(+v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
    cfg = {
      enabled: n.enabled ?? cfg.enabled, mode: n.mode === 'minutes' ? 'minutes' : n.mode === 'attempts' ? 'attempts' : cfg.mode,
      every: int(n.every ?? cfg.every, 1, 10, 10), minutes: int(n.minutes ?? cfg.minutes, 1, 60, 10), cards: int(n.cards ?? cfg.cards, 1, 10, 5),
      source: n.source === 'stack' ? 'stack' : n.source === 'all' ? 'all' : cfg.source, stackId: n.stackId !== undefined ? n.stackId : cfg.stackId,
    };
    if (typeof n.cardsAvailable === 'number') st.cardsAvailable = n.cardsAvailable;
    try { await fsp.mkdir(path.dirname(prefsFile), { recursive: true }); await fsp.writeFile(prefsFile, JSON.stringify(cfg)); } catch {}
    send(); maybeBreak();
    return status();
  });
  ipcMain.handle('gd:cardsAvailable', (_e, n) => { st.cardsAvailable = +n || 0; return true; });
  ipcMain.handle('gd:breakNow', () => startLock('manual'));
  ipcMain.handle('gd:done', () => endLock(true));
  ipcMain.handle('gd:modInfo', () => modInfo());
  ipcMain.handle('gd:installMod', (_e, fromDialog) => installMod(!!fromDialog));

  pollTimer = setInterval(poll, 4000); poll();
  return {
    shutdown() { clearInterval(pollTimer); stopTick(); if (st.locked && st.running) { if (helper && !helper.test) { try { helper.stdin.write('unlock\n'); } catch {} } else testSignal('CONT'); } stopHelper(); },
    isLocked: () => st.locked,
  };
}
module.exports = { createGate };
