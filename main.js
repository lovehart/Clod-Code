// Clod Code main process — host privilege boundary.
// Renderer has no Node access.
const { app, BrowserWindow, ipcMain, shell, dialog, Notification, webContents, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');

// ---- Native workspace folder bridge ----
// The File System Access API (showDirectoryPicker + FileSystemDirectoryHandle)
// does NOT persist its permission grants across app restarts in Electron
// (electron/electron#41957): queryPermission() returns 'prompt' on the next
// launch, so a handle stored in the previous session can never re-attach. For
// the desktop app we therefore manage the workspace folder in the main process
// with Node's fs, remembering the folder by its path instead of a
// permission-gated handle. The renderer never sees the raw path — it passes
// workspace-relative paths (e.g. /src/app.js) and we resolve them inside the
// chosen root, rejecting any escape.
// Cap on a whole-file read over IPC (workspace:read, and workspace:readRaw
// which fs_move uses to relocate binaries). 1000 MB by default — deliberately
// far above the web_download cap (Settings → Agent Tools → Web downloader,
// default 25 MB / max 100 MB) so a file the agent downloaded can always be read
// or moved afterwards. A read cap BELOW the download cap made downloaded files
// unusable, which the tool descriptions never mentioned.
//
// Note this is not the only limit: the bytes cross IPC as ONE JavaScript
// string, which V8 caps at buffer.constants.MAX_STRING_LENGTH (512 MB), so
// base64 (4/3 expansion) tops out near 384 MB. encodeWholeFile() below reports
// that precisely instead of letting a bare "Invalid string length" surface.
const WORKSPACE_READ_MAX = 1000 * 1024 * 1024;
const MAX_IPC_STRING = (() => {
  try { return require('buffer').constants.MAX_STRING_LENGTH; } catch { return 512 * 1024 * 1024; }
})();

// The Desktop tab re-parents native app windows into this window as children.
// Chromium normally presents through DirectComposition, which composites ABOVE
// every re-parented child regardless of z-order — the guest then never shows
// (the stage stays grey). Disabling the DirectComposition path makes Chromium
// present via normal GDI, which respects child z-order, so hosted apps show
// through. Must be set before app ready.
if (process.platform === 'win32') {
  const wantDcOff = process.argv.includes('--allow-direct-composition');
  if (!wantDcOff) {
    app.commandLine.appendSwitch('disable-direct-composition');
    app.commandLine.appendSwitch('disable-gpu-compositing');
  }
}

// Last-resort guard. An error thrown from an asynchronous callback — a
// child-process 'error', a WinEvent hook, a stray timer — otherwise becomes an
// unhandled exception, and Electron's default response is a modal "A JavaScript
// error occurred in the main process" box. That box blocks the main process
// until a human dismisses it, so a single bad call left the whole app frozen
// (the renderer stops answering and IPC hangs). Log it loudly and keep the app
// usable; the stack is still printed so nothing is hidden.
process.on('uncaughtException', (err) => {
  console.error('[main] uncaught exception:', (err && err.stack) || err);
});

function isWithin(base, target) {
  if (target === base) return true;
  // NTFS is case-insensitive: compare lowercased on Windows so a path-escape
  // attempt cannot bypass the check with casing tricks.
  const b = process.platform === 'win32' ? base.toLowerCase() : base;
  const t = process.platform === 'win32' ? target.toLowerCase() : target;
  return t.startsWith(b + path.sep);
}

function resolveWithin(root, rel) {
  let base = path.resolve(String(root || ''));
  let relNorm = String(rel || '/');
  try { relNorm = decodeURIComponent(relNorm); } catch {}
  relNorm = relNorm.replace(/\\/g, '/');
  const target = path.resolve(base, '.' + (relNorm.startsWith('/') ? relNorm : '/' + relNorm));
  if (target !== base && !isWithin(base, target)) return null; // path escape
  // Resolve symlinks so a link inside the workspace cannot point outside it.
  try {
    base = fs.realpathSync(base);
    const tReal = fs.realpathSync(target);
    if (tReal !== base && !isWithin(base, tReal)) return null;
    return tReal;
  } catch { return null; }
}

// Existence-tolerant variant of resolveWithin for operations that CREATE
// files or directories (workspace:write, workspace:writeBinary, workspace:mkdir).
// realpathSync on a not-yet-existing target throws ENOENT, which would reject
// every legitimate new file as a "path escape". Instead: resolve the deepest
// ancestor that exists, verify it sits inside the workspace, then re-append the
// missing trailing segments textually (they contain no symlinks because they
// don't exist yet, so nothing can be smuggled through them).
function resolveWithinForCreate(root, rel) {
  const base = path.resolve(String(root || ''));
  let relNorm = String(rel || '/');
  try { relNorm = decodeURIComponent(relNorm); } catch {}
  relNorm = relNorm.replace(/\\/g, '/');
  // Belt-and-braces mirror of the renderer's normalizeAgentPath: drive-letter
  // and UNC forms never come from the renderer, and path.resolve on Windows
  // treats them oddly — reject them outright.
  if (/^[a-zA-Z]:/.test(relNorm) || relNorm.startsWith('//')) return null;
  const target = path.resolve(base, '.' + (relNorm.startsWith('/') ? relNorm : '/' + relNorm));
  if (target !== base && !isWithin(base, target)) return null; // path escape
  let baseReal;
  try { baseReal = fs.realpathSync(base); } catch { return null; }
  // Walk up from the target to the first existing ancestor and realpath it.
  let anchor = target;
  const missing = [];
  for (;;) {
    try { fs.statSync(anchor); break; } catch (e) {
      if (e && e.code === 'ENOENT') {
        missing.push(path.basename(anchor));
        const parent = path.dirname(anchor);
        if (parent === anchor) return null; // hit the filesystem root
        anchor = parent;
        continue;
      }
      return null; // other stat errors: be conservative
    }
  }
  let anchorReal;
  try { anchorReal = fs.realpathSync(anchor); } catch { return null; }
  if (!isWithin(baseReal, anchorReal)) return null; // existing ancestor escaped
  // Re-append the not-yet-existing segments (textual, already validated above).
  let out = anchorReal;
  for (let i = missing.length - 1; i >= 0; i--) out = path.join(out, missing[i]);
  return out;
}

// Serialize file writes inside the main process so concurrent renderer calls
// (parallel tool calls, several subagents) never interleave: writeFile is not
// atomic, and two simultaneous writes to one path can interleave at the OS
// level. Each handler chains onto a per-target-path queue; the queue lives for
// the lifetime of the root so renames that swap directories also serialize.
const workspaceWriteQueues = new Map(); // resolved target -> Promise
function enqueueWorkspaceWrite(target, fn) {
  const key = path.resolve(target);
  const prev = workspaceWriteQueues.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  workspaceWriteQueues.set(key, next);
  // Trim the queue map when the tail settles so it cannot grow unbounded.
  next.then(() => {
    if (workspaceWriteQueues.get(key) === next) workspaceWriteQueues.delete(key);
  }).catch(() => {});
  return next;
}

// Atomic write: write to a unique temp file in the same directory (same
// volume, so rename cannot fall back to a cross-device copy), fsync, then
// rename over the destination. Readers therefore see either the old or the
// new full content — never a torn mix.
async function atomicWriteFile(target, data) {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  const handle = await fsp.open(tmp, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally { await handle.close().catch(() => {}); }
  // Windows: rename over a file with an open handle (webapp server streaming
  // it, an editor, an AV scanner) transiently fails with EPERM/EBUSY. Retry
  // with backoff — the handle is virtually always released within ms.
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await fsp.rename(tmp, target);
      return;
    } catch (e) {
      lastErr = e;
      const code = e && e.code;
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') break;
      await new Promise(r => setTimeout(r, 20 * (attempt + 1)));
    }
  }
  try { await fsp.unlink(tmp); } catch {}
  throw lastErr;
}

function workspaceErr(msg) { return { ok: false, error: String(msg || 'workspace error') }; }

// Encode a whole file for the trip over IPC, where it has to fit in a single
// JavaScript string. base64 inflates by exactly 4/3, so its length is known up
// front and can be checked without building the string (which would itself
// throw); text length depends on the encoded bytes, so it falls back to the
// try/catch. Either way the caller gets the real reason — a file under the read
// cap that still cannot be transferred — rather than a V8 RangeError.
function encodeWholeFile(buf, encoding) {
  if (encoding === 'base64' && Math.ceil(buf.length / 3) * 4 > MAX_IPC_STRING) {
    return { ok: false, error: `${buf.length} bytes cannot be transferred: base64 needs ${Math.ceil(buf.length / 3) * 4} characters but a single JavaScript string is capped at ${MAX_IPC_STRING} (about 384 MB of file data; the ${WORKSPACE_READ_MAX}-byte read cap is higher than what one IPC string can carry). Use fs_delete instead of moving it.` };
  }
  try { return { ok: true, value: buf.toString(encoding) }; }
  catch {
    return { ok: false, error: `${buf.length} bytes cannot be transferred as ${encoding}: a single JavaScript string is capped at ${MAX_IPC_STRING} characters.` };
  }
}

// Binary sniff for workspace reads. A NUL byte almost always means a binary
// file, but NUL-free binaries (and the stray C0 controls of UTF-16) would
// still decode as mojibake, so also flag data whose first bytes are ≥10%
// control characters. Printable text — including UTF-8 accents, tabs, CR/LF —
// never trips this. Mirrors the renderer's looksLikeBinaryBytes for the
// File System Access path.
function looksLikeBinaryBytes(buf) {
  const n = Math.min(buf.length, 8192);
  if (!n) return false;
  let suspicious = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true;
    if (b < 7 || (b > 13 && b < 27)) suspicious++;
  }
  return suspicious * 100 >= n * 10;
}

ipcMain.handle('workspace:pick', async () => {
  try {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose the agent workspace folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: true, path: null };
    const p = r.filePaths[0];
    return { ok: true, path: p, name: path.basename(p) || p };
  } catch (e) { return workspaceErr(e.message); }
});

ipcMain.handle('workspace:exists', (_e, p = {}) => {
  return fsp.stat(String(p.root || '')).then(
    (st) => ({ ok: true, exists: st.isDirectory() }),
    () => ({ ok: true, exists: false })
  );
});

ipcMain.handle('workspace:read', async (_e, p = {}) => {
  const target = resolveWithin(p.root, p.rel);
  if (!target) return workspaceErr('path escapes the workspace');
  try {
    const st = await fsp.stat(target);
    if (st.size > WORKSPACE_READ_MAX) {
      return workspaceErr(`${String(p.rel || 'file')} is too large (${st.size} bytes; max ${WORKSPACE_READ_MAX} bytes).`);
    }
    const buf = await fsp.readFile(target);
    // Binary guard: decoding a binary file as UTF-8 would return mojibake.
    // Matches the in-memory workspace, which refuses to hand binary entries
    // to fs_read.
    if (looksLikeBinaryBytes(buf)) {
      return workspaceErr(`${String(p.rel || 'file')} is a binary file (${buf.length} bytes) — it cannot be read as text. You can delete or move it, or overwrite it with fs_write.`);
    }
    const enc = encodeWholeFile(buf, 'utf8');
    if (!enc.ok) return workspaceErr(`${String(p.rel || 'file')}: ${enc.error}`);
    return { ok: true, text: enc.value };
  } catch (e) { return workspaceErr(e.message); }
});

// Raw read for agent-side file moves (fs_move of a downloaded binary): the
// bytes come back base64-encoded so they survive the structured-clone IPC
// boundary. Same size cap and workspace containment as workspace:read.
ipcMain.handle('workspace:readRaw', async (_e, p = {}) => {
  const target = resolveWithin(p.root, p.rel);
  if (!target) return workspaceErr('path escapes the workspace');
  try {
    const st = await fsp.stat(target);
    if (st.size > WORKSPACE_READ_MAX) {
      return workspaceErr(`${String(p.rel || 'file')} is too large (${st.size} bytes; max ${WORKSPACE_READ_MAX} bytes).`);
    }
    const buf = await fsp.readFile(target);
    const enc = encodeWholeFile(buf, 'base64');
    if (!enc.ok) return workspaceErr(`${String(p.rel || 'file')}: ${enc.error}`);
    return { ok: true, base64: enc.value, size: buf.length };
  } catch (e) { return workspaceErr(e.message); }
});

ipcMain.handle('workspace:write', async (_e, p = {}) => {
  const target = resolveWithinForCreate(p.root, p.rel);
  if (!target) return workspaceErr('path escapes the workspace');
  return enqueueWorkspaceWrite(target, async () => {
    try {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await atomicWriteFile(target, Buffer.from(String(p.text == null ? '' : p.text), 'utf8'));
      return { ok: true };
    } catch (e) { return workspaceErr(e.message); }
  });
});

ipcMain.handle('workspace:writeBinary', async (_e, p = {}) => {
  const target = resolveWithinForCreate(p.root, p.rel);
  if (!target) return workspaceErr('path escapes the workspace');
  return enqueueWorkspaceWrite(target, async () => {
    try {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await atomicWriteFile(target, Buffer.from(String(p.base64 || ''), 'base64'));
      return { ok: true };
    } catch (e) { return workspaceErr(e.message); }
  });
});

ipcMain.handle('workspace:list', async (_e, p = {}) => {
  const target = resolveWithin(p.root, p.rel);
  if (!target) return workspaceErr('path escapes the workspace');
  try {
    const dirents = await fsp.readdir(target, { withFileTypes: true });
    const entries = [];
    for (const d of dirents) {
      if (d.isDirectory()) { entries.push({ name: d.name, kind: 'directory', size: null }); continue; }
      let size = null;
      try { const st = await fsp.stat(path.join(target, d.name)); size = st.size; } catch {}
      entries.push({ name: d.name, kind: 'file', size });
    }
    return { ok: true, entries };
  } catch (e) { return workspaceErr(e.message); }
});

ipcMain.handle('workspace:stat', async (_e, p = {}) => {
  const target = resolveWithin(p.root, p.rel);
  if (!target) return { ok: false, error: 'path escapes the workspace' };
  try {
    const st = await fsp.stat(target);
    return { ok: true, entry: { name: path.basename(target), kind: st.isDirectory() ? 'directory' : 'file', size: st.isFile() ? st.size : null } };
  } catch (e) { return { ok: false, error: e.message };
  }
});

// Resolve a workspace-relative path to its real on-disk path. The renderer's
// fs tools deliberately never expose absolute host paths, but launching a
// workspace binary in the Desktop tab needs the real one — this is the narrow
// bridge for that (desktop_launch resolving /godot.exe).
ipcMain.handle('workspace:resolve', async (_e, p = {}) => {
  const target = resolveWithin(p.root, p.rel);
  if (!target) return { ok: false, error: 'path escapes the workspace' };
  try {
    const st = await fsp.stat(target);
    // Directories are allowed too (allowDir): headless engine runners need the
    // real path of a project DIRECTORY (godot --path <dir>), not only files.
    if (!st.isFile() && !p.allowDir) return { ok: false, error: 'not a file' };
    return { ok: true, path: target, isDirectory: st.isDirectory() };
  } catch (e) { return { ok: false, error: e.message };
  }
});

// ---- Godot headless scripting -----------------------------------------------
// Locate an installed Godot: PATH plus the common install roots. The primary
// route is a portable godot*.exe inside the workspace (resolved by the
// renderer), this scan only covers users who installed Godot system-wide.
function findGodotExe() {
  // The hit is cached for the life of the process, so revalidate it before
  // trusting it: a Godot that is moved or uninstalled mid-session would
  // otherwise keep resolving to a dead path, and every godot_run would fail
  // with a spawn error that no retry could clear. A stat is far cheaper than
  // the disk walk below.
  if (findGodotExe._cache) {
    try { if (fs.statSync(findGodotExe._cache).isFile()) return findGodotExe._cache; } catch {}
    findGodotExe._cache = null;
  }
  const candidates = [];
  // App-managed installs first (godot:updateInstall writes each release into
  // its own <userData>/godot/<version> directory rather than overwriting), so
  // the copy this app provisioned deliberately beats an arbitrary PATH hit.
  // Newest version first, because an update adds a directory instead of
  // replacing one.
  try {
    const root = godotManagedRoot();
    const versions = fs.readdirSync(root)
      .filter((n) => /^\d/.test(n))
      .sort((a, b) => {
        const ka = parseGodotVersion(a) || [0, 0, 0];
        const kb = parseGodotVersion(b) || [0, 0, 0];
        for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i];
        return 0;
      });
    for (const v of versions) {
      const dir = path.join(root, v);
      for (const name of fs.readdirSync(dir)) {
        if (/^godot.*\.exe$/i.test(name) && !/console/i.test(name)) candidates.push(path.join(dir, name));
      }
    }
  } catch {}
  try {
    const fromPath = require('child_process').execSync('where godot.exe 2>nul', { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    candidates.push(...fromPath);
  } catch {}
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  for (const root of [path.join(pf, 'Godot'), path.join(pf86, 'Godot'), pf, path.join(pf, 'Godot Engine')]) {
    try {
      for (const name of fs.readdirSync(root)) {
        if (/^godot.*\.exe$/i.test(name) && !/console/i.test(name)) candidates.push(path.join(root, name));
      }
    } catch {}
  }
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) { findGodotExe._cache = c; return c; } } catch {}
  }
  return null;
}

// Run a process and capture its stdout/stderr with a hard timeout. Shared by
// blender_run (via runBlenderScript) and godot_run: same lifecycle — spawn,
// collect bounded output, kill on timeout, report exit plus captured text.
async function runCapturedProcess(exe, args, timeoutMs, opts = {}) {
  const timeout = Math.min(1200000, Math.max(5000, Number(timeoutMs) || 120000));
  return await new Promise((resolve) => {
    let child;
    try {
      // opts.env is merged over process.env, never replacing it: a software
      // renderer needs PATH (the loader/ICD directories) plus its own switches,
      // and must keep SystemRoot/PATH so the child can start at all.
      child = spawn(exe, args, {
        windowsHide: true,
        cwd: opts.cwd || undefined,
        env: opts.env ? { ...process.env, ...opts.env } : undefined,
      });
    } catch (e) {
      resolve({ ok: false, error: 'spawn failed: ' + e.message, log: '', err: '' });
      return;
    }
    let out = '', err = '';
    const to = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve({ ok: false, timedOut: true, exitCode: null, log: out, err,
        error: `timed out after ${Math.round(timeout / 1000)}s` });
    }, timeout);
    child.stdout.on('data', (d) => { out += d; if (out.length > 300000) out = out.slice(-200000); });
    child.stderr.on('data', (d) => { err += d; if (err.length > 300000) err = err.slice(-200000); });
    child.on('error', (e) => { clearTimeout(to); resolve({ ok: false, error: 'spawn failed: ' + e.message, log: out, err }); });
    child.on('exit', (code) => {
      clearTimeout(to);
      // Blender (and other embedded-script hosts) may catch exceptions and
      // still exit 0 after printing a traceback — the exit code alone lies.
      const combined = out + err;
      const hasPyError = opts.pyErrorDetection && ( /Traceback \(most recent call last\):/.test(err)
        || /(^|\r?\n)\s*[A-Za-z_]*(Error|Exception):/.test(err)
        || /Error: Python script failed/.test(combined));
      resolve({ ok: code === 0 && !hasPyError, exitCode: code, log: out, err });
    });
  });
}

// Locate a system-installed Godot on demand — the fallback the renderer uses
// when the workspace has no portable godot*.exe. Mirrors blender:find: resolve
// the exe via findGodotExe(), then best-effort probe its version. A missing
// version string is not a failure (the Windows GUI build may print nothing
// through a pipe), so only a missing exe reports ok:false.
// Read the engine version from a Godot binary. The Windows GUI build has no
// console attached, so `--version` written to stdout goes nowhere when the
// process is spawned with pipes — the official zip ships a *_console.exe twin
// that does print, so try it first and fall back to the binary itself (a
// console build or a system install passes either way).
async function probeGodotVersion(exe) {
  const dir = path.dirname(String(exe || ''));
  const base = path.basename(String(exe || ''), '.exe');
  const candidates = [];
  const sibling = path.join(dir, base + '_console.exe');
  try { if (fs.statSync(sibling).isFile()) candidates.push(sibling); } catch {}
  candidates.push(exe);
  for (const c of candidates) {
    const res = await runCapturedProcess(c, ['--version'], 60000);
    const m = String((res && (res.log || res.err)) || '').match(/(\d+\.\d+(?:\.\d+)*[^\s]*)/);
    if (m) return { version: m[1].trim(), probed: c };
  }
  return { version: '', probed: '' };
}

ipcMain.handle('godot:find', async () => {
  const exe = findGodotExe();
  if (!exe) return { ok: false, error: 'No installed Godot found on PATH, in the app-managed Godot folder, or in the standard install folders. Put godot.exe in the workspace, or install Godot normally.' };
  let version = '';
  try { version = (await probeGodotVersion(exe)).version; } catch {}
  return { ok: true, exe, version };
});

ipcMain.handle('godot:run', async (_e, p = {}) => {
  try {
    const exe = String(p.exe || '');
    if (!exe) return { ok: false, error: 'exe required' };
    let args = Array.isArray(p.args) ? p.args.map(String) : [];
    let env;
    let viaRenderer = '';
    if (p.renderer) {
      const plan = godotRendererPlan(String(p.renderer), exe);
      if (!plan.ok) return { ok: false, error: plan.error };
      // The backend's renderer selection goes FIRST so an explicit
      // --rendering-driver from the caller still wins: Godot's parser takes the
      // last occurrence of a repeated option. The 'gpu' backend contributes
      // neither args nor env, so asking for it is simply the default behaviour.
      args = plan.args.concat(args);
      env = plan.env;
      viaRenderer = plan.id;
      if (plan.env) console.log(`[godot] renderer: ${plan.note} for ${exe}`);
    }
    const r = await runCapturedProcess(exe, args, p.timeoutMs, { cwd: p.cwd, env });
    // Godot prints script errors (SCRIPT ERROR:) and keeps running; surface
    // them so a green exit code with failing tests still reads as a failure.
    const scriptErrors = /SCRIPT ERROR:|USER ERROR:|USER FATAL:/.test(r.log + r.err);
    const ok = r.ok && !scriptErrors;
    // driverError = "this run did not render, and the reason looks like graphics
    // initialization", which is what advances the backend walk. It is gated on
    // the run having FAILED: Godot warns about Vulkan and then succeeds on
    // Direct3D 12, and that is a working run, not an error to route around.
    const driverError = !ok && GODOT_DRIVER_ERROR_RE.test(r.log + r.err);
    return { ...r, ok, scriptErrors, driverError, viaRenderer, renderer: parseGodotRenderer(r.log) };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) };
  }
});

// ---- Godot rendering backends (windowless runs) ------------------------------
// The point of this path is that NOTHING APPEARS ON SCREEN. Godot's own
// --headless mode achieves that but cannot render at all: the headless display
// server offers exactly one rendering driver, "dummy", and installs
// RasterizerDummy on creation (servers/display_server_headless.h — unchanged
// from 4.0 through 4.5), so a viewport capture there is empty no matter how
// long the script waits. Godot on Windows also has no windowless rendering
// path, so a run that needs pixels creates a real window and parks it far
// off-screen (--position) instead: invisible, and it closes with the run.
//
// Rendering itself is normally the GPU — it is faster, and it is what the
// default backend uses. The backends are tried in this order:
//
//   gpu         — no overrides at all: Godot picks for itself, exactly as it
//                 would for a player. Godot 4.7 also falls back on its own
//                 (Vulkan -> Direct3D 12) when a driver is unusable, which is
//                 why a run that FAILED is what advances this list, not a
//                 warning in the log.
//   swiftshader — Google's CPU Vulkan ICD, already on disk. Chromium (and so
//                 Electron, and so this app) ships vk_swiftshader.dll,
//                 vk_swiftshader_icd.json and a Vulkan loader next to the app
//                 binary, so this costs nothing to use.
//   llvmpipe    — Mesa's CPU OpenGL, which has to be supplied as a drop-in
//                 opengl32.dll (Mesa publishes no installer for it). Used when
//                 present — next to the Godot binary or in <userData>/godot/
//                 mesa — and reported as unavailable otherwise rather than
//                 fetched, so no update path rewrites the GDK unannounced.
//
// Whichever ran, the device that actually rendered is parsed out of Godot's
// startup banner and reported back, so "did this render, and on what?" is
// answered by evidence rather than by assumption.
//
// The renderer names a backend; the environment is built here. Nothing lets the
// renderer hand arbitrary environment variables to a spawned process.
//
// Deliberately narrow, and matched ONLY against a run that failed (see
// godot:run): Godot prints "switching to Direct3D 12" and "your video card
// drivers seem not to support Vulkan" while still succeeding on another device,
// and treating those as errors would throw away a perfectly good run.
const GODOT_DRIVER_ERROR_RE = /Unable to initialize (?:video driver|Vulkan|OpenGL|graphics)|Your video card drivers? (?:do|does) not support|Required Vulkan instance extension|Could not (?:initialize|find) (?:Vulkan|OpenGL|D3D12)|Can'?t create (?:an )?OpenGL|Failed to (?:initialize|create) (?:Vulkan|OpenGL|D3D12)|Can'?t load vulkan-1\.dll|Vulkan: (?:Loader|Can'?t)|(?:Direct3D 12|OpenGL|Vulkan) initialization failed/i;

// Godot announces its choice in the first lines, e.g.
//   Vulkan 1.4.356 - Forward+ - Using Device #0: Intel - Intel(R) Arc(TM) A750 Graphics
//   Vulkan 1.3.0 - Forward Mobile - Using Device #0: Unknown - SwiftShader Device (Subzero)
//   D3D12 12_0 - Forward Mobile - Using Device #0: Intel - Intel(R) Arc(TM) A750 Graphics
// This banner is the only ground truth for which renderer really produced the
// pixels, so it is parsed rather than assumed from the backend that was asked for.
function parseGodotRenderer(log) {
  const text = String(log || '');
  const device = text.match(/Using Device #\d+:\s*(.+?)\s*$/m);
  if (!device) return null;
  const api = text.match(/^\s*(Vulkan|D3D12|OpenGL ES|OpenGL|Metal)\s+[\d.]+[^\n]*Using Device/m);
  const name = device[1].trim();
  return { api: api ? api[1] : '', device: name, software: /swiftshader|lavapipe|llvmpipe|warp/i.test(name) };
}

// Where godot:updateInstall puts each release: userData/godot/<version>/. The
// app owns this tree so an update is independent of whichever workspace is
// attached, and findGodotExe() scans it first.
function godotManagedRoot() {
  return path.join(app.getPath('userData'), 'godot');
}

// '4.6-stable' or '4.6.1.stable.official.dev' -> [4,6,1].
function parseGodotVersion(s) {
  const m = String(s || '').match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] || 0)];
}

function compareGodotVersions(a, b) {
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  return 0;
}

// The directory the OS actually runs from: next to the Electron binary in
// development, and next to the packaged app's executable in a built app.
// Electron's whole runtime — SwiftShader ICD included — sits there.
function electronRuntimeDir() {
  return path.dirname(process.execPath);
}

function findSwiftShader() {
  if (process.platform !== 'win32') return null;
  const dir = electronRuntimeDir();
  const icd = path.join(dir, 'vk_swiftshader_icd.json');
  for (const f of [icd, path.join(dir, 'vk_swiftshader.dll')]) {
    try { if (!fs.statSync(f).isFile()) return null; } catch { return null; }
  }
  // The Vulkan loader is NOT required to live here — a GPU driver normally
  // installs vulkan-1.dll into System32 — so its absence must not disqualify
  // the ICD. When Chromium's own copy is present it is the one Godot's dlopen
  // should find, which is what the PATH prepend in the plan is for.
  let loader = '';
  try { if (fs.statSync(path.join(dir, 'vulkan-1.dll')).isFile()) loader = path.join(dir, 'vulkan-1.dll'); } catch {}
  return { dir, icd, loader };
}

function findLLVMpipe(godotExe) {
  if (process.platform !== 'win32') return null;
  const dirs = [];
  if (godotExe) dirs.push(path.dirname(String(godotExe)));
  dirs.push(path.join(godotManagedRoot(), 'mesa'));
  for (const dir of dirs) {
    try { if (fs.statSync(path.join(dir, 'opengl32.dll')).isFile()) return { dir }; } catch {}
  }
  return null;
}

// Env + renderer args for one software backend, or an actionable reason why it
// cannot be used. Godot dlopens "vulkan-1.dll" by name, so the loader the app
// already ships must be reachable on PATH; the ICD manifest then selects the
// CPU implementation. VK_DRIVER_FILES is the modern spelling (loader
// 1.3.207+) and VK_ICD_FILENAMES is the one older loaders still read — setting
// both keeps every Godot build working.
function godotRendererPlan(backend, godotExe) {
  if (backend === 'gpu') {
    // The default: add nothing, let Godot choose. "Available" is not knowable
    // without running, and it does not need to be — a GPU run that fails is
    // what moves the walk on to the CPU backends.
    return { ok: true, id: 'gpu', note: "Godot's own default renderer (the GPU when there is one)", env: undefined, args: [] };
  }
  if (backend === 'swiftshader') {
    const ss = findSwiftShader();
    if (!ss) return { ok: false, error: 'SwiftShader is unavailable: vk_swiftshader.dll and vk_swiftshader_icd.json are missing next to the app binary (a broken or trimmed install).' };
    return {
      ok: true, id: 'swiftshader', note: 'SwiftShader (CPU Vulkan)',
      env: { PATH: ss.dir + path.delimiter + (process.env.PATH || ''), VK_DRIVER_FILES: ss.icd, VK_ICD_FILENAMES: ss.icd },
      args: ['--rendering-driver', 'vulkan', '--rendering-method', 'mobile'],
    };
  }
  if (backend === 'llvmpipe') {
    const m = findLLVMpipe(godotExe);
    if (!m) return { ok: false, error: 'Mesa llvmpipe is unavailable: no opengl32.dll next to the Godot executable or in the app-managed godot/mesa folder.' };
    return {
      ok: true, id: 'llvmpipe', note: 'Mesa llvmpipe (CPU OpenGL)',
      env: { PATH: m.dir + path.delimiter + (process.env.PATH || ''), GALLIUM_DRIVER: 'llvmpipe', LIBGL_ALWAYS_SOFTWARE: '1', MESA_LOADER_DRIVER_OVERRIDE: 'llvmpipe' },
      args: ['--rendering-method', 'gl_compatibility', '--rendering-driver', 'opengl3'],
    };
  }
  return { ok: false, error: 'Unknown rendering backend: ' + backend };
}

// Which rendering backends this machine can offer, in the order they should be
// tried (GPU first, then CPU). The renderer asks once and walks the list.
ipcMain.handle('godot:renderers', async (_e, p = {}) => {
  const godotExe = String((p && p.exe) || '');
  const backends = [];
  for (const id of ['gpu', 'swiftshader', 'llvmpipe']) {
    const plan = godotRendererPlan(id, godotExe);
    backends.push(plan.ok
      ? { id, available: true, label: plan.note, args: plan.args }
      : { id, available: false, error: plan.error });
  }
  return { ok: true, backends, anyAvailable: backends.some((b) => b.available) };
});

// Every Godot this app can see, newest version first — the single source of
// truth for "which engine should run this project". The renderer supplies the
// binaries it discovered in the workspace (already resolved to real paths);
// main adds the app-managed installs, PATH and the standard install folders.
// Versions are probed here, not there, because the Windows GUI build prints
// nothing to a pipe and the console twin has to be preferred.
ipcMain.handle('godot:installs', async (_e, p = {}) => {
  const found = [];
  const seen = new Set();
  const add = (exe, source) => {
    const s = String(exe || '');
    if (!s) return;
    let key;
    try { key = fs.realpathSync(s).toLowerCase(); } catch { key = path.resolve(s).toLowerCase(); }
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ exe: s, source });
  };
  for (const e of (Array.isArray(p.exes) ? p.exes : []).slice(0, 8)) add(e, 'workspace');
  // App-managed installs live in their own version directory each.
  try {
    const root = godotManagedRoot();
    for (const v of fs.readdirSync(root)) {
      const dir = path.join(root, v);
      try {
        for (const name of fs.readdirSync(dir)) {
          if (/^godot.*\.exe$/i.test(name) && !/console/i.test(name)) add(path.join(dir, name), 'app');
        }
      } catch {}
    }
  } catch {}
  add(findGodotExe(), 'installed');
  // Probing spawns the engine, so the list is bounded: beyond a handful of
  // candidates the extra seconds cost more than the ordering is worth.
  const installs = [];
  for (const c of found.slice(0, 10)) {
    let version = '';
    try { version = (await probeGodotVersion(c.exe)).version; } catch {}
    installs.push({ ...c, version, parsed: parseGodotVersion(version) });
  }
  // Newest first. A workspace binary wins a tie because it is the one the
  // project ships alongside itself, and an unreadable version sorts last
  // rather than winning the comparison by accident.
  const rank = (s) => (s === 'workspace' ? 0 : s === 'app' ? 1 : 2);
  installs.sort((a, b) => {
    const ka = a.parsed || [0, 0, 0];
    const kb = b.parsed || [0, 0, 0];
    for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i];
    return rank(a.source) - rank(b.source);
  });
  return { ok: true, installs, newest: installs.find((i) => i.version) || installs[0] || null, count: installs.length };
});

// ---- Godot version check and update -----------------------------------------
// GitHub's /releases/latest skips drafts and pre-releases, which is exactly the
// stable-only filter wanted here; the tag is still re-checked for rc/beta text
// because a mis-tagged build would otherwise be installed silently.
const GODOT_RELEASES_API = 'https://api.github.com/repos/godotengine/godot/releases/latest';
const GODOT_ASSET_RE = /^Godot_v[\d.]+-stable_win64\.exe\.zip$/i;
const GODOT_UPDATE_MAX_BYTES = 400 * 1024 * 1024; // the win64 editor zip is ~60 MB

ipcMain.handle('godot:updateCheck', async (_e, p = {}) => {
  // The comparison needs the LOCAL build's version. The renderer passes it when
  // it already knows it, or passes the path of a portable exe the host has
  // never launched (a Godot in the workspace) for probing here.
  let currentText = String(p.current || '');
  if (!currentText && p.exe) {
    try { currentText = (await probeGodotVersion(String(p.exe))).version || ''; } catch {}
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const resp = await fetch(GODOT_RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ClodCode' },
      signal: ctrl.signal,
    });
    if (!resp.ok) return { ok: false, error: `GitHub returned HTTP ${resp.status} for the Godot releases feed${resp.status === 403 ? ' (rate limited — try again later)' : ''}.` };
    const rel = await resp.json();
    const tag = String((rel && rel.tag_name) || '');
    if (!tag) return { ok: false, error: 'The Godot release feed had no tag_name.' };
    if (/alpha|beta|rc|dev/i.test(tag)) return { ok: false, error: `Latest Godot release ${tag} is not a stable build — skipping.` };
    const asset = (Array.isArray(rel.assets) ? rel.assets : []).find((a) => GODOT_ASSET_RE.test(String(a && a.name)) && !/mono/i.test(String(a.name)));
    const latest = parseGodotVersion(tag);
    const current = parseGodotVersion(currentText);
    return {
      ok: true, tag, latestVersion: (tag.match(/^[\d.]+/) || [''])[0],
      asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size } : null,
      current: currentText, currentParsed: !!current,
      // "Available" covers both cases the caller acts on: a newer release than
      // the local build, and no local build at all (a fresh install). An install
      // is only offered when there is an asset to fetch, so a release whose zip
      // is missing cannot produce a button that can only fail.
      updateAvailable: !!(latest && asset && (!current || compareGodotVersions(latest, current) > 0)),
      noLocal: !currentText,
    };
  } catch (e) {
    return { ok: false, error: /abort/i.test(String((e && e.message) || '')) ? 'The Godot release check timed out.' : String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
});

// Download a stable Windows editor zip and unpack it into
// <userData>/godot/<version>/. The zip is read with the renderer's inlined
// fflate (it is a CommonJS module, so main can require it directly) rather than
// a subprocess or a new dependency.
ipcMain.handle('godot:updateInstall', async (_e, p = {}) => {
  const url = String((p && p.url) || '');
  if (!/^https:\/\/github\.com\/godotengine\/godot\/releases\/download\//i.test(url)) {
    return { ok: false, error: 'Only Godot release downloads from github.com are allowed.' };
  }
  const version = String((p && p.version) || '').replace(/[^0-9A-Za-z._-]/g, '');
  if (!version) return { ok: false, error: 'version required' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 600000);
  let buf;
  try {
    const resp = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': 'ClodCode' } });
    if (!resp.ok) return { ok: false, error: `Download failed: HTTP ${resp.status}.` };
    const declared = parseInt(resp.headers.get('content-length') || '', 10);
    if (Number.isFinite(declared) && declared > GODOT_UPDATE_MAX_BYTES) {
      return { ok: false, error: `Refusing a ${declared}-byte archive (max ${GODOT_UPDATE_MAX_BYTES}).` };
    }
    buf = Buffer.from(await resp.arrayBuffer());
  } catch (e) {
    return { ok: false, error: /abort/i.test(String((e && e.message) || '')) ? 'The Godot download timed out.' : String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
  if (buf.length > GODOT_UPDATE_MAX_BYTES) return { ok: false, error: `Refusing a ${buf.length}-byte archive (max ${GODOT_UPDATE_MAX_BYTES}).` };
  let entries;
  try {
    const fflate = require('./app/fflate.js');
    entries = fflate.unzipSync(new Uint8Array(buf));
  } catch (e) {
    return { ok: false, error: `The download is not a readable zip archive: ${(e && e.message) || e}` };
  }
  // Unpack beside the target and move it into place only once it is verified.
  // Writing straight into <godot>/<version> would leave a half-written engine
  // there if anything failed partway — and every later launch and probe would
  // find that broken exe first — while also destroying a good install of the
  // same version before knowing the new one works.
  const finalTarget = path.join(godotManagedRoot(), version);
  const target = finalTarget + '.part-' + Date.now().toString(36);
  const discard = async () => { try { await fsp.rm(target, { recursive: true, force: true }); } catch {} };
  const written = [];
  try {
    await fsp.mkdir(target, { recursive: true });
    for (const [name, bytes] of Object.entries(entries)) {
      const base = path.basename(String(name));
      // The editor zip carries exactly the editor and its console twin; nothing
      // else is expected to be executable, and writing a stray .exe from an
      // archive would be the one way to turn a download into a launch surface.
      if (!/\.exe$/i.test(base) || !/^godot/i.test(base)) continue;
      await atomicWriteFile(path.join(target, base), Buffer.from(bytes));
      written.push(base);
    }
  } catch (e) {
    await discard();
    return { ok: false, error: `Could not write the update into ${finalTarget}: ${(e && e.message) || e}` };
  }
  if (!written.length) { await discard(); return { ok: false, error: 'The archive contained no Godot executable.' }; }
  // Verify before trusting it: a truncated or mislabelled binary is worse than
  // no update at all, since every later godot_run would use it.
  const unpackedExe = path.join(target, written.find((n) => !/console/i.test(n)) || written[0]);
  const probe = await probeGodotVersion(unpackedExe);
  if (!probe.version) {
    await discard();
    return { ok: false, error: `The download unpacked, but its Godot did not answer --version, so nothing was installed (a truncated or blocked binary would break every later run).` };
  }
  try {
    await fsp.rm(finalTarget, { recursive: true, force: true });
    await fsp.rename(target, finalTarget);
  } catch (e) {
    await discard();
    return { ok: false, error: `Could not move the verified update into ${finalTarget}: ${(e && e.message) || e}` };
  }
  findGodotExe._cache = null; // the cached hit may be the build this supersedes
  const mainExe = path.join(finalTarget, written.find((n) => !/console/i.test(n)) || written[0]);
  return { ok: true, version: probe.version, dir: finalTarget, exe: mainExe, files: written };
});

// ---- Blender headless scripting --------------------------------------------
// Locate a usable Blender executable: PATH and the standard Windows install
// roots, newest version directory first ("Blender Foundation\\Blender <ver>\").
// Cached so repeated blender_run calls do not re-probe the disk, but
// revalidated on every use for the same reason as findGodotExe: a Blender that
// is moved or uninstalled mid-session must not keep returning a dead path.
function findBlenderExe() {
  if (findBlenderExe._cache) {
    try { if (fs.statSync(findBlenderExe._cache).isFile()) return findBlenderExe._cache; } catch {}
    findBlenderExe._cache = null;
  }
  const candidates = [];
  try {
    const fromPath = require('child_process').execSync('where blender.exe 2>nul', { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    candidates.push(...fromPath);
  } catch {}
  const roots = [
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Blender Foundation'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Blender Foundation'),
  ];
  for (const root of roots) {
    try {
      const vers = fs.readdirSync(root)
        .filter((n) => /^blender/i.test(n))
        .map((n) => {
          const m = n.match(/(\d+(?:\.\d+)*)/);
          const key = m ? m[1].split('.').map(Number) : [0];
          return { name: n, key };
        })
        .sort((a, b) => { for (let i = 0; i < Math.max(a.key.length, b.key.length); i++) { const x = (a.key[i] || 0) - (b.key[i] || 0); if (x) return -x; } return 0; });
      for (const v of vers) candidates.push(path.join(root, v.name, 'blender.exe'));
    } catch {}
  }
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) { findBlenderExe._cache = c; return c; } } catch {}
  }
  return null;
}

// Run a bpy script headlessly via the shared captured-process runner. The code
// is written to a temp .py (deleted afterwards) and executed with
// --factory-startup so user add-ons and prefs cannot distort automation.
async function runBlenderScript(code, timeoutMs) {
  const exe = findBlenderExe();
  if (!exe) return { ok: false, error: 'Blender not found. Install Blender from blender.org (standard install location or PATH), then try again.' };
  const tmp = path.join(os.tmpdir(), 'freebuff-bpy-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.py');
  await fsp.writeFile(tmp, String(code || ''), 'utf8');
  try {
    const r = await runCapturedProcess(exe, ['--background', '--factory-startup', '--python', tmp], timeoutMs, { pyErrorDetection: true });
    if (r.timedOut) r.error = `blender_run timed out after ${Math.round(Math.min(1200000, Math.max(5000, Number(timeoutMs) || 120000)) / 1000)}s (long render or simulation? lower samples/resolution or raise timeoutMs)`;
    return r;
  } finally {
    try { await fsp.unlink(tmp); } catch {}
  }
}

ipcMain.handle('blender:find', async () => {
  const exe = findBlenderExe();
  if (!exe) return { ok: false, error: 'Blender not found. Install Blender from blender.org (standard install location or PATH), then try again.' };
  try {
    const res = await runBlenderScript('import bpy\nprint("BLENDER_PROBE:" + bpy.app.version_string)\n', 60000);
    const m = String((res && res.log) || '').match(/BLENDER_PROBE:([^\r\n]+)/);
    return { ok: true, exe, version: m ? m[1].trim() : '' };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('blender:run', async (_e, p = {}) => {
  try {
    return await runBlenderScript(p && p.code, p && p.timeoutMs);
  } catch (e) { return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('export:chatWithImages', async (_e, p = {}) => {
  const base = String((p && p.baseName) || 'chat').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120) || 'chat';
  const defaultPath = path.join(app.getPath('downloads'), `${base}.md`);
  const r = await dialog.showSaveDialog(mainWindow, {
    title: 'Export chat as Markdown (images are saved next to it)',
    defaultPath,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (r.canceled || !r.filePath) return { ok: true, canceled: true };
  const mdPath = r.filePath;
  const dir = `${mdPath.replace(/\.md$/i, '')}_images`;
  const files = Array.isArray(p && p.files) ? p.files : [];
  const hasImages = files.some((f) => f && !String(f.name || '').toLowerCase().endsWith('.md'));
  if (hasImages) await fsp.mkdir(dir, { recursive: true });
  let savedImages = 0;
  const dirBase = path.basename(dir);
  for (const f of files) {
    const rel = String((f && f.name) || '');
    const base64 = String((f && f.base64) || '');
    if (!base64) continue;
    // md stays beside the chosen file; images go inside the _images folder.
    const target = rel.toLowerCase().endsWith('.md') ? mdPath : path.join(dir, rel.slice(rel.indexOf('/') + 1));
    const safe = path.resolve(target);
    if (safe !== mdPath && !safe.startsWith(path.resolve(dir) + path.sep)) continue;
    if (safe === mdPath) {
      // The builder references `images/<file>`; the folder next to the chosen
      // file is named after it, so rewrite the refs to match before writing.
      const text = Buffer.from(base64, 'base64').toString('utf8');
      await fsp.writeFile(safe, text.split('](images/').join(`](${dirBase}/`), 'utf8');
      continue;
    }
    await fsp.writeFile(safe, Buffer.from(base64, 'base64'));
    savedImages++;
  }
  return { ok: true, mdName: path.basename(mdPath), dir, savedImages };
});

ipcMain.handle('workspace:delete', async (_e, p = {}) => {
  const relNorm = String(p.rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!relNorm || relNorm === '.') return workspaceErr('Cannot delete the workspace root');
  const target = resolveWithin(p.root, p.rel);
  if (!target) return workspaceErr('path escapes the workspace');
  // Serialize with writes to the same path so a delete cannot race a write.
  // recursive: directories are removed with all their contents (fs_delete
  // passes recursive=true); without it a non-empty directory is refused so a
  // plain "delete this file" call can never wipe a folder by accident.
  return enqueueWorkspaceWrite(target, async () => {
    try {
      let isDir = false, empty = true;
      try {
        const st = await fsp.stat(target);
        isDir = st.isDirectory();
        if (isDir) empty = (await fsp.readdir(target)).length === 0;
      } catch {} // vanished between resolve and stat: rm below is a no-op
      if (isDir && !empty && !p.recursive) {
        return workspaceErr(`${String(p.rel)} is a non-empty directory — pass recursive=true to delete it with its contents.`);
      }
      await fsp.rm(target, { recursive: !!p.recursive, force: true });
      return { ok: true };
    } catch (e) { return workspaceErr(e.message); }
  });
});

ipcMain.handle('workspace:mkdir', async (_e, p = {}) => {
  const target = resolveWithinForCreate(p.root, p.rel);
  if (!target) return workspaceErr('path escapes the workspace');
  try {
    await fsp.mkdir(target, { recursive: true });
    return { ok: true };
  } catch (e) { return workspaceErr(e.message); }
});


let mainWindow;
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500, height: 950, minWidth: 900, minHeight: 600,
    backgroundColor: '#0d1117', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, webviewTag: true }
  });
  // Keep promoted guests (game windows) glued to the Desktop tab while the
  // window is dragged or resized. Without this the only re-glue was the 700 ms
  // watchdog poll plus the renderer's 3 s sync, so a game window visibly
  // trailed behind the window it lives in. (Child guests need nothing: Windows
  // moves a child window with its parent.)
  const followGuests = () => {
    if (!desktopContainer || !mainWindow || mainWindow.isDestroyed()) return;
    try {
      desktopContainer.syncHostResize(desktopContainer.hwndFromBuffer(mainWindow.getNativeWindowHandle()));
    } catch {}
  };
  mainWindow.on('move', followGuests);
  mainWindow.on('resize', followGuests);

  mainWindow.loadFile(path.join(__dirname, 'app', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(({ url }) =>
    /^https?:\/\//i.test(url) ? (shell.openExternal(url), { action: 'deny' }) : { action: 'deny' });
  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools();
}

// Agent-browser <webview> guests: keep target=_blank / window.open inside the
// guest that opened them (so the agent keeps control of the new page) instead
// of bouncing the user to the host browser. Everything else stays denied.
app.on('web-contents-created', (_e, wc) => {
  if (wc.getType() !== 'webview') return;
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) wc.loadURL(url).catch(() => {});
    return { action: 'deny' };
  });
  // Record the guest's console output (logs, warnings, errors, uncaught
  // exceptions) in a bounded ring buffer so the agent's webapp_console tool
  // can read the running app's logs on demand. Bounded both ways: entries per
  // guest are capped, and stale guests are evicted LRU-style.
  wc.on('console-message', (_ev, level, message, line, sourceId) => {
    try { webappPushConsole(wc.id, level, message, sourceId, line); } catch {}
  });
  wc.on('destroyed', () => { browserConsoleBuffers.delete(wc.id); });
});

// Read a guest's captured console entries. noClear: keep the buffer (default
// clears after read so each call returns only new output since the last read).
ipcMain.handle('browser:console', async (_e, p = {}) => {
  try {
    const buf = browserConsoleBuffers.get(Number(p.wcId) || 0);
    if (!buf) return { ok: true, entries: [], remaining: 0 };
    let entries = buf.entries;
    if (p.since != null) entries = entries.filter(e => e.seq > (Number(p.since) || 0));
    const out = entries.slice(-WEBAPP_CONSOLE_MAX_ENTRIES);
    if (!p.noClear) {
      const keepSeq = out.length ? out[out.length - 1].seq : 0;
      buf.entries = buf.entries.filter(e => e.seq > keepSeq);
    }
    return { ok: true, entries: out, remaining: buf.entries.length };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

// ---- Desktop container (Desktop tab) ----
// Launches native exes and re-parents their windows into this window so apps
// run inside the Desktop tab instead of loose on the desktop. Windows-only.
let desktopContainer = null;
if (process.platform === 'win32') {
  try {
    desktopContainer = require('./desktop-container');
  } catch (e) {
    console.error('desktop-container unavailable:', e.message);
  }
}

function desktopGuestRectFromCss(cssRect) {
  // Renderer reports CSS-pixel rects relative to the window's content area.
  // Child-window coords (after SetParent) are relative to the parent's client
  // area, in physical pixels: scale by the display's scale factor. Keep the
  // fractional result unrounded — the guest rect is re-applied every sync tick
  // and rounding would make it jitter ±1 physical pixel (visible as a shimmer
  // on high-DPI displays); MoveWindow rounds once, at the boundary.
  if (!mainWindow || !cssRect) return null;
  const b = mainWindow.getContentBounds();
  const disp = screen.getDisplayMatching(b);
  const s = (disp && disp.scaleFactor) || 1;
  return {
    x: (Number(cssRect.x) || 0) * s,
    y: (Number(cssRect.y) || 0) * s,
    w: Math.max(1, (Number(cssRect.w) || 1) * s),
    h: Math.max(1, (Number(cssRect.h) || 1) * s),
  };
}ipcMain.handle('desktop:launch', async (_e, p = {}) => {
  if (!desktopContainer) return { ok: false, error: 'Desktop container is Windows-only.' };
  // renderer: a Godot backend id ('gpu', 'swiftshader', 'llvmpipe'). A hosted
  // GPU game window is exactly the case where desktop_screenshot has to fall
  // back to reading the composited screen, so a CPU-rendered window is also the
  // more capturable one — which is why softwareRender exists on the tool.
  let env;
  if (p.renderer) {
    const plan = godotRendererPlan(String(p.renderer), String(p.exe || ''));
    if (!plan.ok) return { ok: false, error: plan.error };
    env = plan.env;
  }
  try {
    return await desktopContainer.launchApp({
      exe: p.exe, args: p.args, cwd: p.cwd, waitMs: p.waitMs, env,
      rect: desktopGuestRectFromCss(p.rect),
    });
  } catch (e) { return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('desktop:list', async () => {
  if (!desktopContainer) return { ok: true, apps: [] };
  return { ok: true, apps: desktopContainer.listApps() };
});

ipcMain.handle('desktop:resize', async (_e, p = {}) => {
  if (!desktopContainer) return { ok: false, error: 'Desktop container is Windows-only.' };
  return desktopContainer.resizeApp(p.id, desktopGuestRectFromCss(p.rect));
});

// Whether the Desktop tab is currently in front (renderer notifies on every
// tab switch). Needed to restore hosted-app visibility correctly after a
// screenshot temporarily shows a parked app.
let desktopTabActive = false;
ipcMain.on('desktop:tabActive', (_e, active) => { desktopTabActive = !!active; });

ipcMain.handle('desktop:visible', async (_e, p = {}) => {
  if (!desktopContainer) return { ok: false, error: 'Desktop container is Windows-only.' };
  return desktopContainer.setAppVisible(p.id, !!p.visible);
});

ipcMain.handle('desktop:focus', async (_e, p = {}) => {
  if (!desktopContainer) return { ok: false, error: 'Desktop container is Windows-only.' };
  return desktopContainer.focusApp(p.id);
});

ipcMain.handle('desktop:detach', async (_e, p = {}) => {
  if (!desktopContainer) return { ok: false, error: 'Desktop container is Windows-only.' };
  return desktopContainer.detachApp(p.id);
});

ipcMain.handle('desktop:kill', async (_e, p = {}) => {
  if (!desktopContainer) return { ok: false, error: 'Desktop container is Windows-only.' };
  return desktopContainer.killApp(p.id);
});

ipcMain.handle('desktop:screenshot', async (_e, p = {}) => {
  if (!desktopContainer) return { ok: false, error: 'Desktop container is Windows-only.' };
  // Compositor capture first, but only for a promoted TOP-LEVEL guest (a game
  // window): Chromium's window enumeration cannot see a guest that has been
  // re-parented into this window as a child, so enumerating the desktop for one
  // would only burn time. Those guests fall through to the GDI path, which has
  // its own on-screen fallback for GPU surfaces.
  try {
    const rec = desktopContainer.getApp(p.id);
    if (rec && rec.topLevelGuest) {
      const live = await desktopContainer.screenshotAppLive(p.id);
      if (live && live.ok) {
        return { ok: true, w: live.w, h: live.h, size: live.size, base64: live.png.toString('base64'), via: live.via };
      }
    }
  } catch { /* fall back to the GDI path below */ }
  try {
    let r = desktopContainer.screenshotApp(p.id);
    let resumed = false;
    if (!r.ok && (r.hidden || r.background)) {
      // GPU-surface guest parked off-client or backgrounded (user is on another
      // tab): reading the compositor where it sits would capture the UI, so
      // briefly move it back onto the stage, raise it, capture, then restore
      // its background state. Chromium's surface re-raises itself on repaint,
      // so each attempt re-raises first and a few attempts race the re-raise.
      try {
        if (mainWindow.isMinimized()) {
          // Restoring the guest now would draw it onto the desktop over whatever
          // the user is doing — an honest failure beats that surprise.
          return { ok: false, error: 'the app window is parked and the Clod window is minimized, so it cannot be captured right now — restore the window or open the Desktop tab and retry' };
        }
        for (let attempt = 0; attempt < 6 && !r.ok; attempt++) {
          desktopContainer.setAppVisible(p.id, true); // back to stage + raise
          await new Promise((res) => setTimeout(res, attempt === 0 ? 250 : 120)); // let the GPU surface present a frame
          r = desktopContainer.screenshotApp(p.id);
        }
        resumed = r.ok;
      } finally {
        try { desktopContainer.setAppVisible(p.id, desktopTabActive); } catch { /* leave shown rather than hiding an app the user may be looking at */ }
      }
    }
    if (!r.ok) return r;
    // `via` is 'printWindow' normally, or 'screen' when a GPU guest returned a
    // flat frame and the pixels had to be read off the composited desktop.
    return { ok: true, w: r.w, h: r.h, size: r.png.length, base64: r.png.toString('base64'), via: r.via || 'printWindow', resumed };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) };
  }
});

// `real: true` routes through SendInput instead of posted messages — the only
// thing games and raw-input apps react to. The container refuses it unless the
// app is already in front, so it can never type into another window.
ipcMain.handle('desktop:click', async (_e, p = {}) => {
  if (!desktopContainer) return { ok: false, error: 'Desktop container is Windows-only.' };
  return desktopContainer.sendClick(p.id, p.x, p.y, { double: !!p.double, right: !!p.right, real: !!p.real });
});

ipcMain.handle('desktop:type', async (_e, p = {}) => {
  if (!desktopContainer) return { ok: false, error: 'Desktop container is Windows-only.' };
  return desktopContainer.sendType(p.id, p.text, { real: !!p.real });
});

ipcMain.handle('desktop:key', async (_e, p = {}) => {
  if (!desktopContainer) return { ok: false, error: 'Desktop container is Windows-only.' };
  return desktopContainer.sendKey(p.id, p.key, { count: p.count, real: !!p.real });
});

ipcMain.handle('desktop:readUi', async (_e, p = {}) => {
  if (!desktopContainer) return { ok: false, error: 'Desktop container is Windows-only.' };
  return desktopContainer.listUIElements(p.id);
});

ipcMain.handle('desktop:pickExe', async () => {
  try {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose an application to open in the Desktop tab',
      properties: ['openFile'],
      filters: [{ name: 'Applications', extensions: ['exe', 'bat', 'cmd', 'lnk'] }, { name: 'All files', extensions: ['*'] }],
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: true, path: null };
    return { ok: true, path: r.filePaths[0] };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) };
  }
});

// App shutdown: detach hosted windows (chrome restored, back on the desktop)
// instead of orphaning them inside a dead parent window.
app.on('before-quit', () => {
  if (desktopContainer) {
    try { desktopContainer.shutdownAll(); } catch {}
  }
});

app.whenReady().then(() => {
  createWindow();
  if (desktopContainer) {
    desktopContainer.setHostHwndProvider(() => {
      try { return desktopContainer.hwndFromBuffer(mainWindow.getNativeWindowHandle()); } catch { return null; }
    });
  }
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// Only the narrowly scoped workspace bridge crosses this boundary.
// There is no host shell, screenshot, or virtual-input IPC.
ipcMain.handle('notify:show', (_e, p = {}) => {
  const title = String(p.title || '').slice(0, 200);
  if (!title || !Notification.isSupported()) return { ok: false };
  new Notification({ title, body: String(p.body || '').slice(0, 1000), silent: true }).show();
  return { ok: true };
});

// CORS-free outbound HTTP for the agent's web_search tool.
// http(s) only, no cookies/credentials, timeout 1–60s (default 30s), response ≤1MB.
ipcMain.handle('net:fetch', async (_e, p = {}) => {
  const url = String(p.url || '');
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'Only http(s) URLs are allowed.' };
  const method = String(p.method || 'GET').toUpperCase();
  const headers = (p.headers && typeof p.headers === 'object') ? p.headers : {};
  const body = (p.body != null) ? String(p.body) : undefined;
  const timeout = Math.min(60000, Math.max(1000, Number(p.timeout) || 30000));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const resp = await fetch(url, { method, headers, body, signal: ctrl.signal });
    clearTimeout(timer);
    return { ok: resp.ok, status: resp.status, text: (await resp.text()).slice(0, 1000000) };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: String((e && e.message) || e) };
  }
});

// ---- Agent browser (Web Browser tab) ----
// The <webview> guest runs in its own Chromium renderer process, isolated from
// this app by the same process boundary as a cross-origin iframe. The agent
// controls it only through these narrowly scoped handlers: navigation, JS eval
// in the GUEST page, screenshots, synthetic input, and text extraction.
// No host filesystem, shell, or OS-input access is exposed here.
const BROWSER_MAX_TEXT = 200000; // cap extracted page text crossing IPC
const BROWSER_EVAL_TIMEOUT = 20000;

function browserWc(id) {
  const wc = webContents.fromId(Number(id) || 0);
  if (!wc || wc.isDestroyed()) throw new Error('Browser page not found (it may have been closed).');
  return wc;
}

ipcMain.handle('browser:navigate', async (_e, p = {}) => {
  try {
    const wc = browserWc(p.wcId);
    const url = String(p.url || '').trim();
    if (!/^(https?|about):/i.test(url)) return { ok: false, error: 'Only http(s) and about: URLs are allowed.' };
    try { await wc.loadURL(url); }
    catch (err) {
      // loadURL rejects with ERR_ABORTED when the site itself redirects or the
      // load is superseded — the guest still ends up on a real page, so don't
      // report the navigation as failed.
      if (!/ERR_ABORTED/i.test(String((err && err.message) || err))) throw err;
    }
    return { ok: true, url: wc.getURL(), title: wc.getTitle() };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

// Promise.race with a timeout; the timer is always cleared, otherwise its
// rejection stays pending after a successful call and fires later.
function raceWithTimeout(promise, ms, message) {
  let timer;
  let timedOut = false;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => { timedOut = true; rej(new Error(message)); }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => { if (!timedOut) clearTimeout(timer); });
}

ipcMain.handle('browser:eval', async (_e, p = {}) => {
  try {
    const wc = browserWc(p.wcId);
    const result = await raceWithTimeout(wc.executeJavaScript(String(p.code || ''), true), BROWSER_EVAL_TIMEOUT, 'Page script timed out');
    return { ok: true, result: result === undefined ? null : result };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

// Interactive-element snapshot: labeled, ref-numbered map of links, buttons,
// inputs and headings — the token-efficient representation Playwright MCP
// popularized over raw screenshots. Injected once via executeJavaScript.
const BROWSER_SNAPSHOT_SCRIPT = String.raw`
(function() {
  var n = 0, out = [];
  var VISIBLE = function(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    return true;
  };
  var SEL = 'a[href], button, input, textarea, select, [role=button], [role=link], [role=tab], [role=checkbox], [role=radio], [role=switch], [contenteditable=true], [onclick], summary, h1, h2, h3';
  var els = document.querySelectorAll(SEL);
  for (var i = 0; i < els.length && out.length < 150; i++) {
    var el = els[i];
    if (!VISIBLE(el)) continue;
    if (el.closest('[aria-hidden=true]')) continue;
    var tag = el.tagName.toLowerCase();
    var role = el.getAttribute('role') || '';
    var text = (el.innerText || el.value || el.getAttribute('aria-label') || el.placeholder || el.title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (el.type === 'password') text = '••••••••'; // never leak credentials into the snapshot
    if (!text && !/^(input|textarea|select)$/i.test(tag)) continue;
    if (!text && tag === 'input' && !/text|search|email|password|number|tel|url/i.test(el.type || 'text')) continue;
    var ref = 'e' + (++n);
    el.setAttribute('data-agent-ref', ref);
    var extra = '';
    if (tag === 'input' || tag === 'textarea' || role === 'textbox' || el.isContentEditable) extra = ' [editable]';
    if (tag === 'select') extra = ' [select]';
    var href = (tag === 'a' && el.href) ? ' href=' + el.href.slice(0, 100) : '';
    out.push('[' + ref + '] <' + (role || tag) + extra + '>' + (text ? ' "' + text + '"' : '') + href);
  }
  return { url: location.href, title: document.title, elements: out.join('\n'), count: n };
})()`;

ipcMain.handle('browser:snapshot', async (_e, p = {}) => {
  try {
    const wc = browserWc(p.wcId);
    const result = await raceWithTimeout(wc.executeJavaScript(BROWSER_SNAPSHOT_SCRIPT, false), BROWSER_EVAL_TIMEOUT, 'Page snapshot timed out');
    return { ok: true, ...result };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

// Readable page text: prefer <article>/<main>, strip script/style/nav noise,
// cap the size before it crosses IPC.
const BROWSER_TEXT_SCRIPT = String.raw`
(function() {
  var main = document.querySelector('article') || document.querySelector('main') || document.body;
  var clone = main.cloneNode(true);
  var kill = clone.querySelectorAll('script,style,noscript,nav,header,footer,aside,iframe,svg,form');
  for (var i = 0; i < kill.length; i++) kill[i].remove();
  return clone.innerText || clone.textContent || '';
})()`;

ipcMain.handle('browser:text', async (_e, p = {}) => {
  try {
    const wc = browserWc(p.wcId);
    const text = await raceWithTimeout(wc.executeJavaScript(BROWSER_TEXT_SCRIPT, false), BROWSER_EVAL_TIMEOUT, 'Page text extraction timed out');
    return { ok: true, text: String(text || '').replace(/\n{3,}/g, '\n\n').slice(0, BROWSER_MAX_TEXT) };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

ipcMain.handle('browser:screenshot', async (_e, p = {}) => {
  try {
    const wc = browserWc(p.wcId);
    const img = await wc.capturePage({ stayHidden: true });
    const buf = img.toPNG();
    return { ok: true, base64: buf.toString('base64'), size: buf.length };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

ipcMain.handle('browser:input', async (_e, p = {}) => {
  try {
    const wc = browserWc(p.wcId);
    const kind = String(p.kind || '');
    if (kind === 'click') {
      const x = Math.round(Number(p.x) || 0), y = Math.round(Number(p.y) || 0);
      await wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      await wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    } else if (kind === 'scroll') {
      await wc.sendInputEvent({ type: 'mouseWheel', x: Number(p.x) || 0, y: Number(p.y) || 0, deltaX: Number(p.deltaX) || 0, deltaY: Number(p.deltaY) || 0 });
    } else if (kind === 'type') {
      const sel = p.selector ? String(p.selector) : '[data-agent-ref="' + String(p.ref || '') + '"]';
      const focused = await wc.executeJavaScript('(function(){var el=document.querySelector(' + JSON.stringify(sel) + ');if(!el)return false;el.focus();return true;})()', false);
      if (!focused) return { ok: false, error: 'Element not found (page may have changed — take a new snapshot): ' + sel };
      await wc.insertText(String(p.text == null ? '' : p.text));
    } else if (kind === 'key') {
      const key = String(p.key || '');
      const keyCodes = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34 };
      if (!(key in keyCodes)) return { ok: false, error: 'Unknown key: ' + key };
      const ev = { type: 'keyDown', key, keyCode: keyCodes[key] || 0 };
      await wc.sendInputEvent(ev);
      await wc.sendInputEvent({ type: 'keyUp', key, keyCode: keyCodes[key] || 0 });
    } else {
      return { ok: false, error: 'Unknown input kind: ' + kind };
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

ipcMain.handle('browser:history', async (_e, p = {}) => {
  try {
    const wc = browserWc(p.wcId);
    const action = String(p.action || 'state');
    if (action === 'back') wc.goBack();
    else if (action === 'forward') wc.goForward();
    else if (action === 'reload') wc.reload();
    else if (action === 'stop') wc.stop();
    const nav = wc.navigationHistory;
    const all = nav.getAllEntries();
    const start = Math.max(0, all.length - 20);
    // n is the entry's absolute (1-based) position so the renderer can label
    // lines correctly even when the history is longer than the 20 returned.
    return { ok: true, canGoBack: nav.canGoBack(), canGoForward: nav.canGoForward(), index: nav.getActiveIndex(),
      entries: all.slice(start).map((en, i) => ({ n: start + i + 1, url: en.url, title: en.title })) };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

ipcMain.handle('browser:session', async (_e, p = {}) => {
  try {
    const wc = browserWc(p.wcId);
    if (p.action === 'clearData') {
      // The guests share the default session: clearing storage without an
      // origin would also wipe the app UI's own localStorage (settings +
      // chats). Scope the wipe to whatever site the guest page is on.
      let origin = '';
      try { origin = new URL(wc.getURL()).origin; } catch {}
      if (!origin || origin === 'null') return { ok: true }; // about:blank / data: — nothing to clear
      await wc.session.clearCache();
      await wc.session.clearStorageData({ origin });
      return { ok: true };
    }
    if (p.action === 'setUserAgent') { wc.setUserAgent(String(p.userAgent || '')); return { ok: true }; }
    return { ok: false, error: 'Unknown session action' };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

// ---- Webapp preview server (run_webapp tool + manual preview loading) ----
// A single localhost-only static file server. The renderer points it at either
// a real folder on disk (attached workspace / user-picked folder) or a temp dir
// materialised from the in-memory workspace, then loads it in the preview
// iframe via http://127.0.0.1:<port>/... — so multi-file web apps, ES modules,
// fetch() of local assets and WebGL/three.js games all work unmodified.
const WEBAPP_MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.svg': 'image/svg+xml',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
};
let webappServer = null, webappPort = 0, webappRoot = '', webappTempDir = '';
let webappLastStart = null; // { root, rel } of the last webapp:start (for webapp:reload)

// Files-changed watcher for the served webapp root. fs.watch is kernel-based
// (inotify / ReadDirectoryChangesW), so watching is near-zero cost while idle.
// Events are debounced and batched here, then pushed once to the renderer,
// which reloads the live app — so the agent's file edits show up without it
// having to call run_webapp again after every change.
let webappWatcher = null, webappWatchRoot = '', webappWatchTimer = null;
const webappWatchPending = new Set();

function webappStopWatcher() {
  if (webappWatcher) { try { webappWatcher.close(); } catch {} webappWatcher = null; }
  webappWatchRoot = '';
  if (webappWatchTimer) { clearTimeout(webappWatchTimer); webappWatchTimer = null; }
  webappWatchPending.clear();
}

function webappStartWatcher(root) {
  if (webappWatcher && webappWatchRoot === root) return;
  webappStopWatcher();
  webappWatchRoot = root;
  const flush = () => {
    webappWatchTimer = null;
    if (!webappWatchPending.size) return;
    const changed = webappWatchPending.size > 500 ? ['*'] : [...webappWatchPending];
    webappWatchPending.clear();
    if (mainWindow && !mainWindow.isDestroyed()) {
      // `root` is the exact directory this watcher is on (the served target,
      // NOT the renderer's mount path). The renderer keeps it as
      // webappLive.servedRoot and ignores pushes from any other root, so a
      // watcher left over from an earlier root — or from a workspace that has
      // since been re-mounted — cannot reload a preview it no longer matches.
      mainWindow.webContents.send('webapp:filesChanged', { changed, root });
    }
  };
  try {
    webappWatcher = fs.watch(root, { recursive: true }, (_ev, filename) => {
      const rel = String(filename || '').replace(/\\/g, '/').replace(/^\/+/, '');
      webappWatchPending.add('/' + rel);
      if (!webappWatchTimer) webappWatchTimer = setTimeout(flush, 300);
    });
    webappWatcher.on('error', () => webappStopWatcher());
  } catch { webappWatcher = null; } // watch is best-effort; manual reload still works
}

// Console ring buffers for browser <webview> guests (run_webapp apps). Main
// records console-message events per guest so the agent can read the running
// app's logs/errors on demand (webapp_console tool) instead of them being lost
// between tool calls. Capped: 500 entries per guest, at most 8 guests (LRU).
const WEBAPP_CONSOLE_MAX_ENTRIES = 500;
const WEBAPP_CONSOLE_MAX_GUESTS = 8;
const browserConsoleBuffers = new Map(); // wcId -> { seq, entries: [{ seq, level, text, source, line }] }

function webappPushConsole(wcId, level, text, source, line) {
  let buf = browserConsoleBuffers.get(wcId);
  if (!buf) {
    buf = { seq: 0, entries: [] };
    if (browserConsoleBuffers.size >= WEBAPP_CONSOLE_MAX_GUESTS) {
      const oldest = browserConsoleBuffers.keys().next().value;
      browserConsoleBuffers.delete(oldest);
    }
    browserConsoleBuffers.set(wcId, buf);
  }
  buf.entries.push({ seq: ++buf.seq, level, text: String(text || ''), source: String(source || ''), line: Number(line) || 0 });
  if (buf.entries.length > WEBAPP_CONSOLE_MAX_ENTRIES) {
    buf.entries.splice(0, buf.entries.length - WEBAPP_CONSOLE_MAX_ENTRIES);
  }
}

function webappListDirHtml(rel, entries) {
  const rows = entries.map(e =>
    `<li><a href="${rel === '/' ? '' : rel}/${e.name}${e.kind === 'directory' ? '/' : ''}">${e.name}${e.kind === 'directory' ? '/' : ''}</a></li>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>Index of ${rel}</title>
<body style="font-family:system-ui;background:#0d1117;color:#e6edf3;padding:24px;">
<h3>Index of ${rel}</h3><ul>${rows || '<li><em>(empty)</em></li>'}</ul></body>`;
}

// Capture shim injected into served HTML so the renderer's screenshot tool
// (requestPreviewSnapshot → outerHTML postMessage) also works for URL-served
// apps, not just inline srcdoc pages. Mirrors PREVIEW_CAPTURE_SHIM in app.js.
const WEBAPP_CAPTURE_SHIM = '<script>(function(){function sz(){var d=document.documentElement,b=document.body;' +
  'return {w:Math.max(d.scrollWidth,d.clientWidth,b?b.scrollWidth:0),h:Math.max(d.scrollHeight,d.clientHeight,b?b.scrollHeight:0)};}' +
  'window.addEventListener("message",function(ev){if(!ev.data||ev.data.__pcap!==1)return;' +
  'try{var s=sz(),out={__pcap:2,html:document.documentElement.outerHTML,w:s.w,h:s.h};' +
  'var t=(ev.source&&ev.source.postMessage)?ev.source:window.parent;t.postMessage(out,"*");}catch(e){}});})();<' + '/script>';

function webappHandle(req, res) {
  try {
    const rel = '/' + decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '');
    let target = resolveWithin(webappRoot, rel);
    if (!webappRoot || !target) { res.writeHead(403); res.end('Forbidden'); return; }
    let st;
    try { st = fs.statSync(target); } catch { res.writeHead(404); res.end('Not found: ' + rel); return; }
    if (st.isDirectory()) {
      if (!rel.endsWith('/')) { res.writeHead(301, { Location: rel + '/' }); res.end(); return; }
      const idx = path.join(target, 'index.html');
      if (fs.existsSync(idx)) { target = idx; }
      else {
        const entries = fs.readdirSync(target, { withFileTypes: true })
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(d => ({ name: d.name, kind: d.isDirectory() ? 'directory' : 'file' }));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(webappListDirHtml(rel, entries));
        return;
      }
    }
    const mime = WEBAPP_MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
    if (/^text\/html/i.test(mime)) {
      // Inject the capture shim so the preview screenshot tool can rasterise
      // URL-served apps too (it only reaches srcdoc pages otherwise).
      let html = fs.readFileSync(target, 'utf8');
      if (/<\/body>/i.test(html)) html = html.replace(/<\/body>/i, WEBAPP_CAPTURE_SHIM + '</body>');
      else html += WEBAPP_CAPTURE_SHIM;
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(target).pipe(res);
  } catch (e) {
    try { res.writeHead(500); res.end(String((e && e.message) || e)); } catch {}
  }
}

function webappEnsureServer() {
  if (webappServer) return Promise.resolve();
  webappServer = http.createServer(webappHandle);
  return new Promise((resolve, reject) => {
    webappServer.once('listening', () => { webappPort = webappServer.address().port; resolve(); });
    webappServer.once('error', (e) => { webappServer = null; reject(e); });
    webappServer.listen(0, '127.0.0.1');
  });
}

ipcMain.handle('webapp:start', async (_e, p = {}) => {
  const target = resolveWithin(p.root, p.rel || '/');
  if (!target) return { ok: false, error: 'path escapes the workspace' };
  try {
    if (!fs.statSync(target).isDirectory()) return { ok: false, error: 'not a directory' };
    await webappEnsureServer();
    webappRoot = target;
    webappLastStart = { root: p.root, rel: p.rel || '/' }; // remembered for webapp:reload
    webappStartWatcher(target); // auto-reload support: push edits to the renderer
    // The renderer stores `root` to tell this app's watcher apart from any other.
    return { ok: true, url: `http://127.0.0.1:${webappPort}/`, root: target };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) };
  }
});

// Re-serve the last webapp:start root (the "⟳ App" button in the Web Browser
// tab) so edits made to files on disk show up on reload.
ipcMain.handle('webapp:reload', async () => {
  try {
    if (!webappLastStart) return { ok: false, error: 'No web app is currently served from disk.' };
    const target = resolveWithin(webappLastStart.root, webappLastStart.rel);
    if (!target) return { ok: false, error: 'path escapes the workspace' };
    await webappEnsureServer();
    webappRoot = target;
    webappStartWatcher(target);
    return { ok: true, url: `http://127.0.0.1:${webappPort}/`, root: target };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

// Materialise an in-memory workspace snapshot into a temp dir and serve it.
// files: { 'rel/path': '<text>' | { b64 } }; keys have no leading slash.
const WEBAPP_FILES_MAX = 200 * 1024 * 1024;
ipcMain.handle('webapp:serveFiles', async (_e, p = {}) => {
  try {
    const files = p.files && typeof p.files === 'object' ? p.files : {};
    let total = 0;
    for (const k of Object.keys(files)) total += typeof files[k] === 'string' ? files[k].length : (files[k] && files[k].b64 ? files[k].b64.length : 0);
    if (total > WEBAPP_FILES_MAX) return { ok: false, error: `Web app snapshot too large (${total} bytes; max ${WEBAPP_FILES_MAX}).` };
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'webapp-'));
    for (const k of Object.keys(files)) {
      const rel = String(k).replace(/^\/+/, '');
      const safe = resolveWithin(dir, '/' + rel);
      if (!safe) continue;
      await fsp.mkdir(path.dirname(safe), { recursive: true });
      const v = files[k];
      if (v && typeof v === 'object' && typeof v.b64 === 'string') await fsp.writeFile(safe, Buffer.from(v.b64, 'base64'));
      else await fsp.writeFile(safe, String(v == null ? '' : v), 'utf8');
    }
    await webappEnsureServer();
    const old = webappTempDir;
    webappTempDir = dir;
    webappRoot = dir;
    if (old) fsp.rm(old, { recursive: true, force: true }).catch(() => {});
    webappStartWatcher(dir); // agent edits to the in-memory snapshot are re-materialised, so watch the temp dir too
    return { ok: true, url: `http://127.0.0.1:${webappPort}/`, root: dir };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

// Manual "Open…" flow: the user picks any HTML file or folder on disk (outside
// the workspace too) and it is served read-only from its own location.
ipcMain.handle('webapp:pick', async () => {
  try {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Open a web app (HTML file or folder) in the preview',
      properties: ['openFile', 'openDirectory'],
      filters: [{ name: 'Web app', extensions: ['html', 'htm'] }, { name: 'All files', extensions: ['*'] }],
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: true, path: null };
    const p = r.filePaths[0];
    const kind = fs.statSync(p).isDirectory() ? 'directory' : 'file';
    return { ok: true, path: p, kind };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

// Binary download for the web_download agent tool. http(s) only, follows
// redirects, no cookies/credentials, clamped timeout and response size cap,
// returned as base64 so it can cross the IPC boundary without touching the
// host filesystem. The renderer writes it to the agent workspace.
ipcMain.handle('net:download', async (_e, p = {}) => {
  const url = String(p.url || '');
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'Only http(s) URLs are allowed.' };
  const timeout = Math.min(300000, Math.max(5000, Number(p.timeout) || 60000));
  const maxBytes = Math.min(100 * 1024 * 1024, Math.max(1024 * 1024, Number(p.maxBytes) || 25 * 1024 * 1024));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const resp = await fetch(url, { redirect: 'follow', signal: ctrl.signal });
    const declared = parseInt(resp.headers.get('content-length') || '', 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      clearTimeout(timer);
      return { ok: false, status: resp.status, error: `File too large (${declared} bytes; max ${maxBytes} bytes).` };
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    clearTimeout(timer);
    if (buf.length > maxBytes) return { ok: false, status: resp.status, error: `File too large (${buf.length} bytes; max ${maxBytes} bytes).` };
    return {
      ok: true,
      status: resp.status,
      size: buf.length,
      mime: String(resp.headers.get('content-type') || '').split(';')[0].trim(),
      base64: buf.toString('base64'),
    };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: String((e && e.message) || e) };
  }
});
