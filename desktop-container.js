// Desktop container — launches native apps and hosts their windows inside the
// app (Desktop tab). Windows-only; uses koffi to call user32/kernel32.
// No VM: the real process runs locally and its top-level window is re-parented
// into a host HWND with SetParent, then kept resized/focused/synced.
'use strict';

const koffi = require('koffi');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Resolve an exe path that is actually a FOLDER whose name ends in .exe —
// common with zipped tools like Godot, where the extracted folder is named
// exactly like the binary it contains ("Godot_v4.7.2-stable_win64.exe/").
// The Windows file dialog happily lets users "pick" such a folder (its name
// matches the *.exe filter), and spawn would then fail with ENOENT. If the
// picked path is a directory, look one level inside for the same-named exe or
// any real executable.
function resolveExePath(exe) {
  let p = String(exe || '').trim();
  if (!p) return { ok: false, error: 'exe required' };
  // A bare name like "notepad.exe" (no directory part) is resolved by spawn
  // via the standard CreateProcess search order (cwd, system32, PATH). Don't
  // reject it just because statSync can't find it relative to our cwd.
  const bareName = !p.includes('\\') && !p.includes('/');
  if (!bareName) { try { p = fs.realpathSync(p); } catch {} }
  if (bareName) return { ok: true, path: p };
  let st = null;
  try { st = fs.statSync(p); } catch {}
  if (!st) return { ok: false, error: 'file not found: ' + p };
  if (!st.isDirectory()) return { ok: true, path: p };
  // It's a directory: prefer a same-named exe inside, else any sizeable exe.
  const candidates = [];
  try {
    for (const name of fs.readdirSync(p)) {
      if (!/\.exe$/i.test(name)) continue;
      const full = path.join(p, name);
      let s;
      try { s = fs.statSync(full); } catch { continue; }
      if (!s.isFile() || s.size < 1024) continue; // skip stubs/placeholders
      candidates.push({ full, name, size: s.size });
    }
  } catch {}
  if (!candidates.length) return { ok: false, error: 'picked path is a folder with no .exe inside: ' + p };
  candidates.sort((a, b) => {
    const an = a.name.toLowerCase() === path.basename(p).toLowerCase() ? 0 : 1;
    const bn = b.name.toLowerCase() === path.basename(p).toLowerCase() ? 0 : 1;
    return an - bn || b.size - a.size;
  });
  return { ok: true, path: candidates[0].full, resolvedFromFolder: true };
}

// ---- Win32 bindings --------------------------------------------------------
const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const gdi32 = koffi.load('gdi32.dll');

// HWND is an opaque handle; alias it once so prototypes can use the name.
const HANDLE = koffi.pointer('HANDLE', koffi.opaque());
const HWND = koffi.alias('HWND', HANDLE);

const RECT = koffi.struct('dc_RECT', {
  left: 'long', top: 'long', right: 'long', bottom: 'long',
});
const POINT = koffi.struct('dc_POINT', { x: 'long', y: 'long' });
const PROCESSENTRY32W = koffi.struct('dc_PROCESSENTRY32W', {
  dwSize: 'unsigned long',
  cntUsage: 'unsigned long',
  th32ProcessID: 'unsigned long',
  th32DefaultHeapID: 'uintptr_t',
  th32ModuleID: 'unsigned long',
  cntThreads: 'unsigned long',
  th32ParentProcessID: 'unsigned long',
  pcPriClassBase: 'long',
  dwFlags: 'unsigned long',
  szExeFile: 'char16_t [260]', // WCHAR[260] in the real struct; koffi → JS string
});

const WNDENUM_CB = koffi.proto('bool __stdcall dcEnumWndCb(HWND hWnd, intptr_t lParam)');
// Dedicated trampoline proto for EnumChildWindows: sharing one callback type
// between a running EnumWindows loop (the watchdog) and EnumChildWindows calls
// reenters the single static trampoline and segfaults.
const CHILDENUM_CB = koffi.proto('bool __stdcall dcChildEnumCb(HWND hWnd, intptr_t lParam)');
const BITMAPINFOHEADER = koffi.struct('dc_BMIH', {
  biSize: 'unsigned long', biWidth: 'long', biHeight: 'long', biPlanes: 'unsigned short',
  biBitCount: 'unsigned short', biCompression: 'unsigned long', biSizeImage: 'unsigned long',
  biXPelsPerMeter: 'long', biYPelsPerMeter: 'long', biClrUsed: 'unsigned long', biClrImportant: 'unsigned long',
});
const BITMAPINFO = koffi.struct('dc_BMI', {
  bmiHeader: BITMAPINFOHEADER,
  bmiColors: koffi.array('unsigned long', 1),
});

const user32Funcs = {
  EnumWindows: user32.func('EnumWindows', 'bool', [koffi.pointer(WNDENUM_CB), 'intptr_t']),
  IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(HWND hWnd)'),
  GetWindowThreadProcessId: user32.func('unsigned long __stdcall GetWindowThreadProcessId(HWND hWnd, _Out_ unsigned long *lpdwProcessId)'),
  GetWindowTextW: user32.func('int __stdcall GetWindowTextW(HWND hWnd, _Out_ char16_t *lpString, int nMaxCount)'),
  GetClassNameW: user32.func('int __stdcall GetClassNameW(HWND hWnd, _Out_ char16_t *lpClassName, int nMaxCount)'),
  GetWindowLongPtrW: user32.func('intptr_t __stdcall GetWindowLongPtrW(HWND hWnd, int nIndex)'),
  SetWindowLongPtrW: user32.func('intptr_t __stdcall SetWindowLongPtrW(HWND hWnd, int nIndex, intptr_t dwNewLong)'),
  SetParent: user32.func('HWND __stdcall SetParent(HWND hWndChild, HWND hWndNewParent)'),
  MoveWindow: user32.func('bool __stdcall MoveWindow(HWND hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint)'),
  ShowWindow: user32.func('bool __stdcall ShowWindow(HWND hWnd, int nCmdShow)'),
  SetFocus: user32.func('HWND __stdcall SetFocus(HWND hWnd)'),
  GetWindowRect: user32.func('bool __stdcall GetWindowRect(HWND hWnd, _Out_ dc_RECT *lpRect)'),
  AttachThreadInput: user32.func('bool __stdcall AttachThreadInput(unsigned long idAttach, unsigned long idAttachTo, bool fAttach)'),
  SetActiveWindow: user32.func('HWND __stdcall SetActiveWindow(HWND hWnd)'),
  GetWindow: user32.func('HWND __stdcall GetWindow(HWND hWnd, unsigned int nCmd)'),
  SetWindowPos: user32.func('bool __stdcall SetWindowPos(HWND hWnd, HWND hWndInsertAfter, int X, int Y, int cx, int cy, unsigned int uFlags)'),
  IsWindow: user32.func('bool __stdcall IsWindow(HWND hWnd)'),
  WindowFromPoint: user32.func('HWND __stdcall WindowFromPoint(dc_POINT point)'),
  GetAncestor: user32.func('intptr_t __stdcall GetAncestor(HWND hwnd, unsigned int gaFlags)'),
  PostMessageW: user32.func('bool __stdcall PostMessageW(HWND hWnd, unsigned int Msg, uintptr_t wParam, intptr_t lParam)'),
  ChildWindowFromPoint: user32.func('HWND __stdcall ChildWindowFromPoint(HWND hWndParent, dc_POINT point)'),
  GetClientRect: user32.func('bool __stdcall GetClientRect(HWND hWnd, _Out_ dc_RECT *lpRect)'),
  GetDC: user32.func('void *__stdcall GetDC(HWND hWnd)'),
  ReleaseDC: user32.func('int __stdcall ReleaseDC(HWND hWnd, void *hDC)'),
  EnumChildWindows: user32.func('EnumChildWindows', 'bool', [koffi.pointer(CHILDENUM_CB), 'intptr_t']),
};

const gdi32Funcs = {
  CreateCompatibleDC: gdi32.func('void *__stdcall CreateCompatibleDC(void *hDC)'),
  CreateCompatibleBitmap: gdi32.func('void *__stdcall CreateCompatibleBitmap(void *hDC, int nWidth, int nHeight)'),
  SelectObject: gdi32.func('void *__stdcall SelectObject(void *hDC, void *hGdiObj)'),
  GetDIBits: gdi32.func('int __stdcall GetDIBits(void *hDC, void *hbm, unsigned int start, unsigned int cLines, _Out_ void *lpvBits, _Inout_ dc_BMI *lpbmi, unsigned int usage)'),
  DeleteObject: gdi32.func('bool __stdcall DeleteObject(void *hObject)'),
  DeleteDC: gdi32.func('bool __stdcall DeleteDC(void *hDC)'),
  BitBlt: gdi32.func('bool __stdcall BitBlt(void *hdcDest, int x, int y, int cx, int cy, void *hdcSrc, int x1, int y1, unsigned long rop)'),
};
const SRCCOPY = 0x00CC0020;
const PrintWindow = user32.func('bool __stdcall PrintWindow(HWND hwnd, void *hdcBlt, unsigned int nFlags)');
const SendMessageTimeoutW = user32.func('intptr_t __stdcall SendMessageTimeoutW(HWND hWnd, unsigned int Msg, uintptr_t wParam, const char16_t *lParam, unsigned int fuFlags, unsigned int uTimeout, _Out_ uintptr_t *lpdwResult)');
const SendMessageTimeoutBuf = user32.func('intptr_t __stdcall SendMessageTimeoutW(HWND hWnd, unsigned int Msg, uintptr_t wParam, void *lParam, unsigned int fuFlags, unsigned int uTimeout, _Out_ uintptr_t *lpdwResult)');
const SMTO_ABORTIFHUNG = 0x2;
const EM_REPLACESEL = 0x00C2;
const WM_GETTEXT = 0x000D, WM_GETTEXTLENGTH = 0x000E;

// Cross-process control text: GetWindowTextW cannot read a control's text from
// another process (it only gets the caption), so send WM_GETTEXT messages.
function getControlText(hwnd) {
  try {
    const out = [0];
    if (!SendMessageTimeoutBuf(hwnd, WM_GETTEXTLENGTH, 0, null, SMTO_ABORTIFHUNG, 1000, out)) return '';
    const len = Number(out[0]);
    if (len <= 0) return '';
    const buf = Buffer.alloc((len + 1) * 2);
    const out2 = [0];
    if (!SendMessageTimeoutBuf(hwnd, WM_GETTEXT, len + 1, buf, SMTO_ABORTIFHUNG, 1000, out2)) return '';
    return koffi.decode(buf, 'char16_t', Number(out2[0]) || len) || '';
  } catch { return ''; }
}

const kernel32Funcs = {
  CreateToolhelp32Snapshot: kernel32.func('void *__stdcall CreateToolhelp32Snapshot(unsigned long dwFlags, unsigned long th32ProcessID)'),
  Process32FirstW: kernel32.func('bool __stdcall Process32FirstW(void *hSnapshot, _Inout_ dc_PROCESSENTRY32W *lppe)'),
  Process32NextW: kernel32.func('bool __stdcall Process32NextW(void *hSnapshot, _Inout_ dc_PROCESSENTRY32W *lppe)'),
  CloseHandle: kernel32.func('bool __stdcall CloseHandle(void *hObject)'),
  GetCurrentThreadId: kernel32.func('unsigned long __stdcall GetCurrentThreadId()'),
};

const INVALID_HANDLE_VALUE = BigInt(0xFFFFFFFFFFFFFFFF);
const TH32CS_SNAPPROCESS = 0x2;
const GWL_STYLE = -16;
const GWL_HWNDPARENT = -8; // the owner slot for a top-level window

function readWindowRect(hwnd) {
  const r = { left: 0, top: 0, right: 0, bottom: 0 };
  if (!user32Funcs.GetWindowRect(hwnd, r)) return null;
  return r;
}

// Read a memory DC's bitmap into a top-down BGRA buffer.
function readDibits(mem, bmp, w, h) {
  const bi = {
    bmiHeader: {
      biSize: koffi.sizeof(BITMAPINFOHEADER), biWidth: w, biHeight: -h, // top-down
      biPlanes: 1, biBitCount: 32, biCompression: 0 /* BI_RGB */, biSizeImage: w * h * 4,
      biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0,
    },
    bmiColors: [0],
  };
  const bits = Buffer.alloc(w * h * 4);
  const got = gdi32Funcs.GetDIBits(mem, bmp, 0, h, bits, bi, 0 /* DIB_RGB_COLORS */);
  if (got !== h) return null;
  return { w, h, bits };
}
// Declared once: promoteToOwnApp used to re-declare this on every promotion,
// which leaks a fresh koffi binding per call.
const SetGwlOwner = user32.func('intptr_t __stdcall SetWindowLongPtrW(HWND hWnd, int nIndex, intptr_t dwNewLong)');
const GWL_EXSTYLE = -20;
const WS_CHILD = 0x40000000;
const WS_VISIBLE = 0x10000000;
const WS_CLIPSIBLINGS = 0x04000000;
const WS_POPUP = 0x80000000;
const WS_CAPTION = 0x00C00000;
const WS_THICKFRAME = 0x00040000;
const WS_MINIMIZEBOX = 0x00020000;
const WS_MAXIMIZEBOX = 0x00010000;
const WS_SYSMENU = 0x00080000;
const WS_EX_APPWINDOW = 0x00040000;
const WS_EX_NOACTIVATE = 0x08000000;
const SW_SHOW = 5;
const GW_OWNER = 4;
const SWP_NOSIZE = 0x1;
const SWP_NOMOVE = 0x2;
const SWP_NOZORDER = 0x4;
const SWP_NOACTIVATE = 0x10;
const SWP_ASYNCWINDOWPOS = 0x4000;

// ---- Small helpers -----------------------------------------------------------
// HWND values arrive as opaque pointer values (BigInt or number depending on
// koffi version). Convert to a plain number for comparisons/storage.
function hwndNum(h) {
  if (h == null) return 0;
  if (typeof h === 'bigint') return Number(h);
  if (typeof h === 'number') return h;
  return 0;
}

// ---- State -----------------------------------------------------------------
// appId -> { id, exe, args, pid, child, hwnd, styleBackup, exStyleBackup, hostHwnd, title, cls, startedAt }
const apps = new Map();
let nextAppId = 1;
let hostHwndProvider = () => null; // set by main.js: returns the host HWND value
// Where a background-launched guest sits until it is shown on the Desktop tab:
// remembered as its stage rect; the window itself is PARKED beyond the host
// client's right edge (clipped to nothing — geometrically incapable of covering
// the UI) until the Desktop tab or a screenshot temp-show brings it back.
const DEFAULT_GUEST_RECT = { x: 40, y: 40, w: 1024, h: 640 };

function setHostHwndProvider(fn) {
  hostHwndProvider = fn || (() => null);
}

// ---- Process tree (descendants of a PID) ------------------------------------
function listProcesses() {
  const h = kernel32Funcs.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (!h || h === INVALID_HANDLE_VALUE) return [];
  const out = [];
  try {
    let entry = { dwSize: koffi.sizeof(PROCESSENTRY32W) };
    if (kernel32Funcs.Process32FirstW(h, entry)) {
      for (;;) {
        out.push({ pid: entry.th32ProcessID, ppid: entry.th32ParentProcessID, exe: entry.szExeFile });
        entry = { dwSize: koffi.sizeof(PROCESSENTRY32W) };
        if (!kernel32Funcs.Process32NextW(h, entry)) break;
      }
    }
  } finally {
    try { kernel32Funcs.CloseHandle(h); } catch {}
  }
  return out;
}

// `procs` is optional: one snapshot can answer this for every hosted app, so
// callers that loop over apps pass theirs in instead of paying for a fresh
// process snapshot each time.
function treePids(rootPid, procs) {
  const processes = procs || listProcesses();
  const children = new Map();
  for (const p of processes) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p.pid);
  }
  const seen = new Set();
  const stack = [Number(rootPid)];
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const c of children.get(pid) || []) stack.push(c);
  }
  return seen;
}

// ---- Window discovery -------------------------------------------------------
// EnumWindows needs a C callback; koffi registers JS functions for that. Each
// enumeration registers a fresh callback and unregisters it afterwards.
// Like findTopLevelWindowsForPids but INCLUDES owned windows (dialogs) —
// the watchdog must see those too, or they'd escape onto the desktop.
function findOwnedWindowsForPids(pids) {
  const pidSet = new Set([...pids].map(Number));
  const found = [];
  enumerateTopLevelWindows((hwnd) => {
    const pid = windowPid(hwnd);
    if (!pidSet.has(pid)) return true;
    if (!isCandidateWindow(hwnd)) return true;
    const owner = hwndNum(user32Funcs.GetWindow(hwnd, GW_OWNER));
    found.push({ hwnd, pid, owner, title: windowTitle(hwnd), cls: windowClass(hwnd) });
    return true;
  });
  return found;
}

function enumerateTopLevelWindows(collect) {
  const cb = koffi.register((hwnd, lp) => {
    let keep = true;
    try { keep = collect(hwnd) !== false; } catch { keep = true; }
    return keep; // must be a real boolean: false stops EnumWindows
  }, 'dcEnumWndCb *');
  try {
    user32Funcs.EnumWindows(cb, 0);
  } finally {
    try { koffi.unregister(cb); } catch {}
  }
}

function windowPid(hwnd) {
  const out = [0];
  user32Funcs.GetWindowThreadProcessId(hwnd, out);
  return Number(out[0]) || 0;
}

function windowTitle(hwnd) {
  try {
    const buf = Buffer.alloc(1024); // 512 UTF-16 chars, zero-filled → NUL-terminated
    const len = user32Funcs.GetWindowTextW(hwnd, buf, 512);
    return len > 0 ? (koffi.decode(buf, 'char16_t', len) || '') : '';
  } catch { return ''; }
}

function windowClass(hwnd) {
  try {
    const buf = Buffer.alloc(1024);
    const len = user32Funcs.GetClassNameW(hwnd, buf, 512);
    return len > 0 ? (koffi.decode(buf, 'char16_t', len) || '') : '';
  } catch { return ''; }
}

// dwmapi, loaded only for cloaked-window detection. Windows "cloaks" a window
// that is not really on screen — a suspended UWP/Store app, a window living on
// another virtual desktop, or an app whose window is hosted by the shell. Such
// a window is still enumerable, still reports IsWindowVisible() === true, and
// yet paints nothing; hosting one yields an empty (grey) tab slot, and the app
// strip lists windows the user cannot see.
const DWMWA_CLOAKED = 14;
const dwmGetWindowAttribute = (() => {
  try {
    const dwmapi = koffi.load('dwmapi.dll');
    const fn = dwmapi.func('long __stdcall DwmGetWindowAttribute(HWND hwnd, unsigned long dwAttribute, _Out_ unsigned long *pvAttribute, unsigned long cbAttribute)');
    return (hwnd) => {
      const out = [0];
      const hr = fn(hwnd, DWMWA_CLOAKED, out, 4);
      // Not every system/attribute combination is supported: fail OPEN (treat
      // an error as "not cloaked") rather than refusing to host real windows.
      return hr === 0 ? Number(out[0]) || 0 : 0;
    };
  } catch { return () => 0; }
})();

function isCandidateWindow(hwnd) {
  if (!user32Funcs.IsWindowVisible(hwnd)) return false;
  const exStyle = Number(user32Funcs.GetWindowLongPtrW(hwnd, GWL_EXSTYLE)) >>> 0;
  if (exStyle & WS_EX_NOACTIVATE) return false; // cloaked/tool windows
  if (dwmGetWindowAttribute(hwnd)) return false; // cloaked → not really on screen
  return true;
}

function findTopLevelWindowsForPids(pids) {
  const pidSet = new Set([...pids].map(Number));
  const found = [];
  enumerateTopLevelWindows((hwnd) => {
    const pid = windowPid(hwnd);
    if (!pidSet.has(pid)) return true;
    if (!isCandidateWindow(hwnd)) return true;
    // Skip owned windows (dialogs owned by another top-level window); a later
    // watchdog tick catches and re-homes those.
    if (hwndNum(user32Funcs.GetWindow(hwnd, GW_OWNER))) return true;
    found.push({ hwnd, pid, title: windowTitle(hwnd), cls: windowClass(hwnd) });
    return true;
  });
  return found;
}

// Wait (bounded) for visible top-level windows belonging to a pid tree.
// `shouldStop` lets the caller abandon the wait as soon as the process is known
// to have failed to start, instead of sitting out the whole window timeout.
async function waitForWindow(pid, timeoutMs, pollMs, shouldStop) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (shouldStop && shouldStop()) return [];
    const wins = findTopLevelWindowsForPids(treePids(pid));
    if (wins.length) return wins;
    if (Date.now() > deadline) return [];
    await new Promise(r => setTimeout(r, pollMs));
  }
}

// ---- Style surgery + reparent ------------------------------------------------
function stripWindowChrome(hwnd) {
  const style = Number(user32Funcs.GetWindowLongPtrW(hwnd, GWL_STYLE));
  const exStyle = Number(user32Funcs.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
  let newStyle = style;
  newStyle &= ~(WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU);
  // WS_CLIPSIBLINGS: without it Chromium's child windows (which sit above the
  // guest in the host's z-order) paint straight over the guest.
  newStyle |= WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS;
  user32Funcs.SetWindowLongPtrW(hwnd, GWL_STYLE, newStyle);
  user32Funcs.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, exStyle & ~WS_EX_APPWINDOW);
  return { style, exStyle };
}

function restoreWindowChrome(hwnd, backup) {
  try {
    user32Funcs.SetWindowLongPtrW(hwnd, GWL_STYLE, backup.style);
    user32Funcs.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, backup.exStyle);
  } catch {}
}

function resizeIntoHost(hwnd, hostHwnd) {
  const r = { left: 0, top: 0, right: 0, bottom: 0 };
  user32Funcs.GetWindowRect(hostHwnd, r);
  const w = Math.max(1, r.right - r.left);
  const h = Math.max(1, r.bottom - r.top);
  user32Funcs.MoveWindow(hwnd, 0, 0, w, h, true);
}

// Place the guest at an exact screen-space rectangle (physical pixels). This is
// how the guest is aligned over the Desktop tab's stage div: main converts the
// renderer's CSS-pixel div rect to a physical screen rect and calls this.
// Move a TOP-LEVEL guest without ever waiting on the guest's process.
//
// MoveWindow — and any SetWindowPos WITHOUT SWP_ASYNCWINDOWPOS — sends the move
// to the thread that owns the window and blocks until it processes it. Re-glue
// runs inside the host's own drag (its modal move loop) while the guest is a
// game busy rendering frames, so that wait stalled CLOD'S drag: the app window
// itself stuttered and the guest still looked like it was trailing.
// SWP_ASYNCWINDOWPOS posts the request to the guest's queue instead, so we
// return immediately and the guest applies it on its next pump — for a game,
// the next frame. Use this on every path driven by user motion; the one-shot
// moveGuestToRect below is fine where a single deliberate action is expected.
function moveGuestAsync(hwnd, rect) {
  const x = Math.round(Number(rect && rect.x) || 0);
  const y = Math.round(Number(rect && rect.y) || 0);
  const w = Math.max(1, Math.round(Number(rect && rect.w) || 1));
  const h = Math.max(1, Math.round(Number(rect && rect.h) || 1));
  try {
    user32Funcs.SetWindowPos(hwnd, null, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS);
  } catch {}
}

function moveGuestToRect(hwnd, rect, raise = true) {
  const x = Math.round(Number(rect.x) || 0);
  const y = Math.round(Number(rect.y) || 0);
  const w = Math.max(1, Math.round(Number(rect.w) || 1));
  const h = Math.max(1, Math.round(Number(rect.h) || 1));
  user32Funcs.MoveWindow(hwnd, x, y, w, h, true);
  // Raising is for CHILD guests (they must beat Chromium's render surface,
  // which repaints above them). For TOP-LEVEL guests (owned game popups) a
  // raise is HWND_TOP — the top of EVERY window on the desktop — so callers
  // that merely re-anchor a popup on a sync/watchdog tick pass raise=false:
  // otherwise the game window keeps jumping above other apps while this app
  // sits in the background. Ownership already keeps a popup over the stage.
  if (raise) raiseGuestOverChromium(hwnd);
}

// Chromium keeps its own child windows ("Chrome_RenderWidgetHostHWND",
// "Intermediate D3D Window") at the top of the host's z-order and re-raises
// them on every repaint. A re-parented guest then ends up UNDER that surface
// and the user sees only the page background (a grey stage). Call this after
// every (re)show/move of a guest — and periodically from the watchdog — to
// put the guest back on top. HWND_TOP == null hWndInsertAfter.
function raiseGuestOverChromium(hwnd) {
  try {
    user32Funcs.SetWindowPos(hwnd, null, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  } catch {}
}

// BACKGROUND parking: sinking the guest beneath Chromium's render surface
// (z-order) proved unreliable in the field — some GPU apps re-assert themselves,
// and z-order shuffles on move/focus let them back over the UI. This model is
// geometric instead and cannot be defeated: a CHILD window is CLIPPED to its
// parent's client area, so parking it beyond the client's right edge means it
// is never composited over the interface — no matter its z-order. The window
// stays shown, so the app keeps running and rendering normally; Windows just
// clips every pixel. On show, the guest is moved back to its stage rect.
const PARK_X_OFFSET = 12000; // host-client px; far right of any real display
function parkGuestRect(hwnd) {
  try {
    // Size kept (SWP_NOSIZE): the app keeps laying out at its stage size, so
    // returning to the stage later needs no resize dance. 40px down keeps any
    // window-shadow quirks from straddling the client edge.
    user32Funcs.SetWindowPos(hwnd, null, PARK_X_OFFSET, 40, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS);
  } catch {}
}

// Park the guest off-screen but alive (used when the Desktop tab is hidden).
function parkGuest(hwnd) {
  user32Funcs.ShowWindow(hwnd, 0 /* SW_HIDE */);
}

function unparkGuest(hwnd, rect) {
  if (rect) moveGuestToRect(hwnd, rect);
  user32Funcs.ShowWindow(hwnd, SW_SHOW);
  raiseGuestOverChromium(hwnd);
}

// Focus handshake: attach our thread's input queue to the guest's so SetFocus
// can move keyboard focus to the re-parented (cross-thread) window.
//
// SetFocus alone is NOT enough for games (Luanti, Godot, Minecraft…): they
// capture/release the mouse on WM_ACTIVATE / WM_ACTIVATEAPP / focus events.
// A re-parented child window never receives WM_ACTIVATE (Windows only sends
// activation to top-level windows), so after the user tabs out and clicks
// back the game still believes it is deactivated — no mouse capture, no
// camera. We therefore post the activation messages the guest would have
// gotten from a real activation cycle. Games listen to different subsets
// (Luanti: WM_ACTIVATE's LOWORD wParam; others: WM_ACTIVATEAPP or focus),
// so deliver the full sequence.
const WM_ACTIVATE = 0x0006, WM_ACTIVATEAPP = 0x001C, WM_NCACTIVATE = 0x0086;
const WM_SETFOCUS = 0x0007, WM_KILLFOCUS = 0x0008, WM_QUERYNEWPALETTE = 0x030F;
const WA_ACTIVE = 1;
function focusGuest(guestHwnd, hostHwnd) {
  try {
    raiseGuestOverChromium(guestHwnd);
    const ourTid = kernel32Funcs.GetCurrentThreadId();
    const guestTid = Number(user32Funcs.GetWindowThreadProcessId(guestHwnd, [0])) || 0;
    const hostTid = Number(user32Funcs.GetWindowThreadProcessId(hostHwnd, [0])) || 0;
    user32Funcs.AttachThreadInput(ourTid, guestTid, true);
    user32Funcs.AttachThreadInput(ourTid, hostTid, true);
    try {
      user32Funcs.SetFocus(guestHwnd);
      // Keep the threads attached through SetActiveWindow: it delivers
      // WM_ACTIVATE(wParam=WA_ACTIVE) to the guest and moves the input
      // queue's "active window" — which is what games key their
      // mouse-capture logic off. Detaching first swallows the message.
      user32Funcs.SetActiveWindow(guestHwnd);
    } finally {
      user32Funcs.AttachThreadInput(ourTid, guestTid, false);
      user32Funcs.AttachThreadInput(ourTid, hostTid, false);
    }
    // Activation notifications, posted (async) so a hung guest can't block us.
    // Do NOT post WM_KILLFOCUS/WM_SETFOCUS: the game processes the kill and
    // tears down its own focus/input state (verified: focus reads back 0).
    user32Funcs.PostMessageW(guestHwnd, WM_ACTIVATEAPP, 1, 0);      // activating, our process
    user32Funcs.PostMessageW(guestHwnd, WM_NCACTIVATE, 1, 0);
    user32Funcs.PostMessageW(guestHwnd, WM_ACTIVATE, WA_ACTIVE, 0); // LOWORD(wParam)=WA_ACTIVE
  } catch {}
}

// ---- Watchdog: catch windows that try to escape the container ----------------
// Pop-up dialogs (file pickers, confirmers, error boxes) are owned top-level
// windows: if left alone they'd appear on the user's desktop. The watchdog
// polls the process trees of every hosted app and:
//   • owned dialogs  → SetParent into the host + centered over the owner
//   • unowned windows → SetParent into the host + parked off-screen (hidden)
// so NOTHING launched by the container can land on the desktop.
const watchdog = {
  timer: null,
  // The poll is a SAFETY NET now: the WinEvent hooks below fire a tick the
  // instant a window appears, so this only has to catch what the hook path
  // cannot (no message pump available, hook registration refused, a window
  // that becomes a candidate without any event — e.g. a style change).
  intervalMs: (() => {
    const v = Number(process.env.CLOD_DESKTOP_WATCH_INTERVAL_MS);
    return Number.isFinite(v) && v >= 20 ? v : 700;
  })(),
  // appId -> { seen:Set<hwndNum>, captured:Map<hwndNum, {hwnd, owner, backup, mode, parked}> }
};

function getWatchState(appId) {
  let st = watchdog.states.get(appId);
  if (!st) { st = { seen: new Set(), captured: new Map() }; watchdog.states.set(appId, st); }
  return st;
}
watchdog.states = new Map();

// Capture a window: strip chrome, SetParent into host, keep a record so we can
// restore it (chrome + owner chain) when the app detaches or shuts down.
function captureWindow(app, st, hwnd, mode, owner) {
  const backup = stripWindowChrome(hwnd);
  user32Funcs.SetParent(hwnd, app.hostHwnd);
  let dlgW = 0, dlgH = 0; // placed dialog size, remembered for relayoutCapturedDialogs
  let dlgParked = false;  // captured while the guest was backgrounded
  if (mode === 'dialog') {
    // Center over the main guest window, clamped to host bounds.
    const gr = { left: 0, top: 0, right: 0, bottom: 0 };
    const dr = { left: 0, top: 0, right: 0, bottom: 0 };
    user32Funcs.GetWindowRect(app.hwnd, gr);
    user32Funcs.GetWindowRect(app.hostHwnd, dr);
    const dw = Math.max(1, dr.right - dr.left), dh = Math.max(1, dr.bottom - dr.top);
    const gw = Math.max(1, gr.right - gr.left), gh = Math.max(1, gr.bottom - gr.top);
    const dlgR = { left: 0, top: 0, right: 0, bottom: 0 };
    user32Funcs.GetWindowRect(hwnd, dlgR);
    const dWidth = Math.max(80, Math.min(dlgR.right - dlgR.left, dw - 40));
    const dHeight = Math.max(60, Math.min(dlgR.bottom - dlgR.top, dh - 40));
    const cx = Math.max(0, gr.left - dr.left + (gw - dWidth) / 2);
    const cy = Math.max(0, gr.top - dr.top + (gh - dHeight) / 2);
    dlgW = dWidth; dlgH = dHeight;
    user32Funcs.SetWindowPos(hwnd, null, Math.round(cx), Math.round(cy), Math.round(dWidth), Math.round(dHeight), SWP_NOZORDER | SWP_NOACTIVATE);
    if (app.background || app.visible === false) {
      // The guest is backgrounded (user is chatting): park the dialog with it —
      // showing it here would pop a game dialog over the interface. It is
      // shown by setAppVisible's dialog sync when the app comes back.
      user32Funcs.ShowWindow(hwnd, 0 /* SW_HIDE */);
      dlgParked = true;
    } else {
      user32Funcs.ShowWindow(hwnd, SW_SHOW);
      raiseGuestOverChromium(hwnd);
    }
  } else {
    // Park hidden at the host origin; unhide only via focusApp.
    user32Funcs.ShowWindow(hwnd, 0 /* SW_HIDE */);
  }
  const rec = { hwnd, owner: hwndNum(owner), backup, mode, parked: mode !== 'dialog' || dlgParked, lastW: dlgW || undefined, lastH: dlgH || undefined };
  st.captured.set(hwndNum(hwnd), rec);
  return rec;
}

// Undo a capture: styles back, detach from the host, then re-point the OWNER.
//
// Detaching is not enough. SetParent only assigns an owner as a side effect of
// attaching a top-level window; SetParent(hwnd, NULL) does NOT clear or change
// an owner the window already has (measured), and SetParent(hwnd, owner) does
// not re-point one either. So the owner must be written explicitly through
// GWL_HWNDPARENT — otherwise a released window keeps the HOST as its owner even
// when the real owner is something else (a promoted game popup's dialog, a
// dialog owned by a secondary window), which costs it the owner's z-order and
// owner-relative centering. Fall back to leaving it ownerless when the window
// it belonged to no longer exists.
function restoreCapturedParenting(rec) {
  try {
    restoreWindowChrome(rec.hwnd, rec.backup);
    user32Funcs.SetParent(rec.hwnd, null);
    const owner = rec.owner && user32Funcs.IsWindow(rec.owner) ? Number(rec.owner) : 0;
    if (owner) SetGwlOwner(rec.hwnd, GWL_HWNDPARENT, owner);
  } catch {}
}

function releaseCapturedWindow(hwnd) {
  // Find which app owns this captured window and restore it.
  for (const st of watchdog.states.values()) {
    const rec = st.captured.get(hwndNum(hwnd));
    if (!rec) continue;
    restoreCapturedParenting(rec);
    st.captured.delete(hwndNum(hwnd));
    return true;
  }
  return false;
}

function releaseAllCaptured(appId) {
  const st = watchdog.states.get(appId);
  if (!st) return;
  for (const rec of [...st.captured.values()]) restoreCapturedParenting(rec);
  st.captured.clear();
}

// Re-center/resize captured dialogs when the guest or stage changes size.
function relayoutCapturedDialogs(app) {
  const st = watchdog.states.get(app.id);
  if (!st) return;
  for (const rec of st.captured.values()) {
    if (rec.mode !== 'dialog' || rec.parked) continue;
    const gr = { left: 0, top: 0, right: 0, bottom: 0 };
    const dr = { left: 0, top: 0, right: 0, bottom: 0 };
    user32Funcs.GetWindowRect(app.hwnd, gr);
    user32Funcs.GetWindowRect(app.hostHwnd, dr);
    if (!rec.lastW || !rec.lastH) continue; // size unknown: leave the dialog's own size alone
    const cx = Math.max(0, gr.left - dr.left + (gr.right - gr.left - rec.lastW) / 2);
    const cy = Math.max(0, gr.top - dr.top + (gr.bottom - gr.top - rec.lastH) / 2);
    user32Funcs.SetWindowPos(rec.hwnd, null, Math.round(cx), Math.round(cy), rec.lastW, rec.lastH, SWP_NOZORDER | SWP_NOACTIVATE);
  }
}

// Promote an unowned same-exe window (e.g. a game window the Godot editor
// spawns with F5) to its own hosted app slot: it becomes a full guest the user
// can switch to from the app strip, instead of a hidden "secondary".
//
// Game windows must stay TOP-LEVEL (owned by the host, not parented into it):
// they reposition themselves with screen-coordinate logic, and as a child
// window that produces a runaway feedback loop (parent-relative pos read back
// as screen pos, re-corrected, drifting off to infinity). As an owned popup we
// clip its owner-relative position to the host window's on-screen rect and
// keep it glued over the stage; Godot's own moves stay consistent because it
// sees a normal top-level window with a normal screen position.
function promoteToOwnApp(parentApp, hwnd, wpid, title, cls) {
  const backup = stripWindowChrome(hwnd);
  // stripWindowChrome left the window styled WS_CHILD; a top-level window must
  // NOT keep WS_CHILD once its parent is removed — Windows then mis-handles
  // activation/hit-testing for it (the promoted game window refuses focus and
  // mouse capture). Re-style as a popup BEFORE unparenting.
  try {  const style = Number(user32Funcs.GetWindowLongPtrW(hwnd, GWL_STYLE));
  user32Funcs.SetWindowLongPtrW(hwnd, GWL_STYLE, (style & ~WS_CHILD) | WS_POPUP | WS_CLIPSIBLINGS);
  } catch {}
  // Owned by the host window (NOT parented into it): ownership keeps the popup
  // permanently above the host — so it shows over the stage — while it keeps a
  // normal top-level coordinate system that games don't fight with.
  user32Funcs.SetParent(hwnd, null);
  // Take ownership (GWL_HWNDPARENT = -8): ownership keeps the popup above its
  // owner (the host window) so it paints over the stage, and keeps it glued to
  // the host in z/minimize. NOTE: this MUST be -8 — a wrong index silently
  // does nothing (observed: owner stayed 0 and the game popup ended up UNDER
  // the app window — "can't see the second Godot window").
  SetGwlOwner(hwnd, GWL_HWNDPARENT, Number(parentApp.hostHwnd));
  // Setting GWL_HWNDPARENT doesn't reorder an existing window — explicitly
  // insert the popup directly ABOVE the host so it paints over the stage.
  user32Funcs.SetWindowPos(hwnd, parentApp.hostHwnd, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  const rect = glueRectFor(parentApp);
  moveGuestToRect(hwnd, rect);
  const screenRect = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
  // A promotion while the user is on another tab (game run via F5 mid-chat)
  // starts PARKED hidden: a top-level popup cannot be parked geometrically, and
  // showing it here would flash the game over the chat. The renderer's fresh-id
  // sync shows it only when the Desktop tab is actually in front.
  const startBackground = !!parentApp.background || parentApp.visible === false;
  if (startBackground) parkGuest(hwnd);
  else user32Funcs.ShowWindow(hwnd, SW_SHOW);
  const app = {
    id: 'app' + (nextAppId++),
    exe: parentApp.exe, args: parentApp.args,
    pid: wpid, child: null, // shares the parent's process tree; no child handle
    hwnd,
    title: title || ('Window ' + hwndNum(hwnd)),
    cls,
    backup,
    hostHwnd: parentApp.hostHwnd,
    parentSlotId: parentApp.id, // slot whose tree spawned this window (stage offset source)
    lastRect: screenRect, // SCREEN coordinates (top-level guest)
    visible: !startBackground,
    background: startBackground,
    startedAt: Date.now(),
    sharedTree: true,
    topLevelGuest: true, // owned popup glued over the stage, not a child
  };
  apps.set(app.id, app);
  app.windowsAtLaunch = new Set();
  enumerateTopLevelWindows((h) => { app.windowsAtLaunch.add(hwndNum(h)); return true; });
  startWatchdog();
  if (!startBackground) setTimeout(() => { if (apps.has(app.id)) focusGuest(app.hwnd, app.hostHwnd); }, 150);
  return app;
}

// Screen-space rect for a top-level guest glued over its parent app's stage:
// the host's CURRENT client origin (so the glue follows the app window when it
// moves) PLUS the stage's offset inside the window. The stage offset and size
// come from the PARENT SLOT's lastRect — the renderer-reported stage rect in
// host-client physical px. (Anchoring to the bare host origin glued the popup
// over the app's toolbar instead of over the stage.) When the promoted app
// itself is passed (parent slot gone), its lastRect is already SCREEN coords
// — use it verbatim.
function glueRectFor(app) {
  const pt = { x: 0, y: 0 };
  ClientToScreen(app.hostHwnd, pt);
  const r = app.lastRect || null;
  let x, y;
  if (app.topLevelGuest) {
    x = r && Number.isFinite(Number(r.x)) ? Number(r.x) : pt.x;
    y = r && Number.isFinite(Number(r.y)) ? Number(r.y) : pt.y;
  } else {
    x = pt.x + ((r && Number(r.x)) || 0);
    y = pt.y + ((r && Number(r.y)) || 0);
  }
  const w = (r && Number(r.w)) || 800, h = (r && Number(r.h)) || 600;
  // Keep the popup inside the VIRTUAL DESKTOP (all displays), not the work area
  // of the one display the host window happens to be on. That narrower clamp
  // yanked a game window back toward its original monitor — off the tab it is
  // supposed to be glued to — as soon as the app window neared an edge or was
  // dragged onto a second display.
  const vs = virtualScreenBounds();
  x = Math.max(vs.x + 8, Math.min(x, vs.x + vs.w - 320));
  y = Math.max(vs.y + 8, Math.min(y, vs.y + vs.h - 240));
  return { x, y, w, h };
}

// Find the app slot a promoted (shared-tree) guest was spawned from.
function parentSlotIdOf(app) {
  if (app.parentSlotId && apps.has(app.parentSlotId)) return app.parentSlotId;
  for (const other of apps.values()) {
    if (other.id !== app.id && !other.sharedTree && other.hostHwnd === app.hostHwnd) return other.id;
  }
  return app.id;
}

// Live screen-space target for a promoted top-level guest: position from the
// host's CURRENT client origin plus the stage offset (the parent slot's
// renderer-reported rect), size from the popup's own current size — the
// container owns a promoted game's POSITION, not its size.
function topLevelGlueTarget(app) {
  const t = glueRectFor(apps.get(parentSlotIdOf(app)) || app);
  const wr = { left: 0, top: 0, right: 0, bottom: 0 };
  if (!user32Funcs.GetWindowRect(app.hwnd, wr)) return t;
  return { x: t.x, y: t.y, w: Math.max(1, wr.right - wr.left), h: Math.max(1, wr.bottom - wr.top) };
}

const GetForegroundWindow = user32.func('HWND __stdcall GetForegroundWindow()');
const GetAncestor = user32.func('HWND __stdcall GetAncestor(HWND hWnd, unsigned int gaFlags)');
const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Inout_ dc_POINT *lpPoint)');
const ClientToScreen = user32.func('bool __stdcall ClientToScreen(HWND hWnd, _Inout_ dc_POINT *lpPoint)');
const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int nIndex)');
const SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77, SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79;

// Bounds of the whole virtual desktop (every display, incl. negative origins).
function virtualScreenBounds() {
  try {
    const x = GetSystemMetrics(SM_XVIRTUALSCREEN), y = GetSystemMetrics(SM_YVIRTUALSCREEN);
    const w = GetSystemMetrics(SM_CXVIRTUALSCREEN), h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    if (w > 0 && h > 0) return { x, y, w, h };
  } catch {}
  return { x: -1000000, y: -1000000, w: 2000000, h: 2000000 }; // effectively unbounded
}

// Games (Luanti, Godot, …) capture the mouse on WM_ACTIVATE, but a re-parented
// child guest never receives activation from Windows. After the user tabs out
// and clicks back into the app, the HOST owns activation while the guest sits
// without focus — the game stays in its "deactivated" state and mouse-look is
// dead. On the host-gains-foreground transition, if the cursor is over the
// guest (i.e. the user clicked back INTO the game), re-run the focus
// handshake. Transition-gated so we never fight the user for focus while they
// use the app's own UI. Top-level guests (owned game popups) get real
// activation from Windows and don't need this.
function focusRecoveryTick() {
  const GA_ROOT = 2;
  let fg = null;
  try { fg = GetForegroundWindow(); } catch { return; }
  const hostFg = fg ? GetAncestor(fg, GA_ROOT) : null;
  for (const app of [...apps.values()]) {
    if (!app.visible || app.topLevelGuest) { app.hostWasFg = false; continue; }
    const isHostFg = !!(hostFg && hwndNum(hostFg) === hwndNum(app.hostHwnd));
    if (isHostFg && !app.hostWasFg) {
      // Host just became foreground: was the click over the guest's area?
      try {
        const pt = { x: 0, y: 0 };
        const gr = { left: 0, top: 0, right: 0, bottom: 0 };
        if (GetCursorPos(pt) && user32Funcs.GetWindowRect(app.hwnd, gr)
            && pt.x >= gr.left && pt.x < gr.right && pt.y >= gr.top && pt.y < gr.bottom) {
          focusGuest(app.hwnd, app.hostHwnd);
        }
      } catch {}
    }
    app.hostWasFg = isHostFg;
  }
}

// ---- WinEvent hooks: rescue escaping windows the moment they appear ---------
// Polling alone means a window the guest opens sits UN-PARENTED on the user's
// desktop until the next tick (up to intervalMs — 700 ms by default) before the
// watchdog re-homes it: a visible flash of a stray window over the app, and a
// modal dialog you can click at before it is captured. Windows already tells us
// when a window appears, so subscribe to that and run the same tick eagerly.
//
// WINEVENT_OUTOFCONTEXT delivers the callback on whichever thread pumps
// messages (Chromium's UI thread in the app, a harness's pump in the tests).
// It must therefore do nothing but decide: no Win32 work beyond one pid lookup,
// no allocation. The real scan happens in the scheduled tick.
const EVENT_OBJECT_CREATE = 0x8000, EVENT_OBJECT_HIDE = 0x8003; // contiguous range: create, destroy, show, hide
const EVENT_OBJECT_LOCATIONCHANGE = 0x800B;
const WINEVENT_OUTOFCONTEXT = 0x0000;
const OBJID_WINDOW = 0, CHILDID_SELF = 0;
// Own trampoline type: sharing one with the EnumWindows callback used by every
// scan re-enters the same static trampoline and crashes (see CHILDENUM_CB note).
const WINEVENT_CB = koffi.proto('void __stdcall dcWinEventProc(HWND hWinEventHook, unsigned long event, HWND hwnd, int idObject, int idChild, unsigned long idEventThread, unsigned long dwmsEventTime)');
const SetWinEventHook = user32.func('void *__stdcall SetWinEventHook(unsigned int eventMin, unsigned int eventMax, void *hmodWinEventProc, dcWinEventProc *pfnWinEventProc, unsigned long idProcess, unsigned long idThread, unsigned int dwFlags)');
const UnhookWinEvent = user32.func('bool __stdcall UnhookWinEvent(void *hWinEventHook)');

// Pids of every hosted app tree, and the HWNDs of the windows hosting them,
// refreshed once per tick. The hook callbacks check membership so unrelated
// desktop activity — every window created or moved anywhere on the machine
// fires these events — never schedules work.
const watchPids = new Set();
const hostHwnds = new Set();
const winEvents = { hook: null, hostHook: null, cb: null, timer: null, inCallback: false, lastTickAt: 0, lastFollowAt: 0 };

// The HOST WINDOW moved: put the promoted guests back on the tab, RIGHT HERE.
//
// Deliberately not deferred to a setTimeout: a window drag is a Win32 modal move
// loop, and Node's timer callbacks do not get to run while it is running — a
// deferred follow would only happen once the drag ended, which is exactly the
// "game window trails the app window the whole time you are dragging" symptom.
// Running inline is safe now that the move itself is a non-blocking post
// (moveGuestAsync): no cross-process wait, so the drag stays smooth.
//
// Rate-limited to roughly a frame because a drag emits these events at pointer
// rate and there is nothing to gain from re-posting the same geometry faster.
function followHostMove(hostHwnd) {
  const now = Date.now();
  if (now - winEvents.lastFollowAt < 8) return;
  winEvents.lastFollowAt = now;
  try { syncHostResize(hostHwnd == null ? null : hostHwnd); } catch {}
}

function scheduleWatchTick() {
  // A tick is already queued: coalesce.
  if (winEvents.timer) return;
  const since = Date.now() - winEvents.lastTickAt;
  const delay = since >= 25 ? 0 : 25 - since; // rate-limit event storms
  winEvents.timer = setTimeout(() => {
    winEvents.timer = null;
    winEvents.lastTickAt = Date.now();
    try { watchTick(); } catch {}
  }, delay);
  // Never hold the process open just for a pending scan.
  if (winEvents.timer && typeof winEvents.timer.unref === 'function') winEvents.timer.unref();
}

function winEventProc(hook, event, hwnd, idObject, idChild, thread, time) {
  if (winEvents.inCallback) return; // re-entered from inside our own dispatch
  winEvents.inCallback = true;
  try {
    // Window-level events only: caret/name/selection notifications from every
    // text box on the desktop would otherwise schedule ticks continuously.
    if (idObject !== OBJID_WINDOW || idChild !== CHILDID_SELF) return;
    if (!apps.size) return;
    if (event === EVENT_OBJECT_LOCATIONCHANGE) {
      // The host window itself moved: re-glue the promoted guests now. This is
      // what keeps a hosted game window attached to the tab while the app window
      // is dragged, instead of it catching up on the next poll.
      if (hostHwnds.has(hwndNum(hwnd))) followHostMove(hwnd);
      return;
    }
    if (!watchPids.size) return;
    if (!watchPids.has(windowPid(hwnd))) return;
    scheduleWatchTick();
  } catch {} finally {
    winEvents.inCallback = false;
  }
}

function startWinEventHook() {
  if (winEvents.hook || process.env.CLOD_DESKTOP_NO_WINEVENT) return;
  try {
    winEvents.cb = koffi.register(winEventProc, 'dcWinEventProc *');
    const hook = SetWinEventHook(EVENT_OBJECT_CREATE, EVENT_OBJECT_HIDE, null, winEvents.cb, 0, 0, WINEVENT_OUTOFCONTEXT);
    if (!hook) {
      // Registration refused (e.g. no message queue on this thread): the poll
      // below still covers every case, just less promptly.
      try { koffi.unregister(winEvents.cb); } catch {}
      winEvents.cb = null;
      return;
    }
    winEvents.hook = hook;
    // Second hook, narrow range: only the location changes that mean "a window
    // moved", used to keep promoted guests glued to a moving host window.
    winEvents.hostHook = SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE, null, winEvents.cb, 0, 0, WINEVENT_OUTOFCONTEXT) || null;
  } catch {
    winEvents.hook = null;
    try { if (winEvents.cb) koffi.unregister(winEvents.cb); } catch {}
    winEvents.cb = null;
  }
}

function stopWinEventHook() {
  if (winEvents.timer) { clearTimeout(winEvents.timer); winEvents.timer = null; }
  try { if (winEvents.hostHook) UnhookWinEvent(winEvents.hostHook); } catch {}
  winEvents.hostHook = null;
  try { if (winEvents.hook) UnhookWinEvent(winEvents.hook); } catch {}
  winEvents.hook = null;
  // Free the trampoline only after the hook is gone: a queued event would
  // otherwise call into freed code.
  try { if (winEvents.cb) koffi.unregister(winEvents.cb); } catch {}
  winEvents.cb = null;
}

function watchTick() {
  // Recover game focus after the user tabs back in (host regains foreground
  // with the cursor over the guest): re-parented guests never get WM_ACTIVATE
  // from Windows, so without this the game stays "deactivated" — dead
  // mouse-look in Godot/Luanti/Minecraft until the strip tab is re-clicked.
  try { focusRecoveryTick(); } catch {}
  // ONE process snapshot per tick, shared by every app: this used to take two
  // full snapshots per hosted app per tick, which is what made the 700 ms poll
  // expensive enough to be the only escape-detection path.
  let procs = [];
  try { procs = listProcesses(); } catch {}
  const pidToExe = new Map(procs.map(p => [p.pid, String(p.exe || '').toLowerCase()]));
  const trees = new Map();
  watchPids.clear();
  hostHwnds.clear();
  for (const app of apps.values()) {
    let pids = null;
    try { pids = treePids(app.pid, procs); } catch {}
    trees.set(app.id, pids);
    if (pids) for (const pid of pids) watchPids.add(pid);
    if (app.hostHwnd) hostHwnds.add(hwndNum(app.hostHwnd));
  }
  for (const app of [...apps.values()]) {
    // Promoted slots share another process's tree (no child handle): when their
    // window dies, drop the record so the strip stays truthful.
    if (app.sharedTree && !user32Funcs.IsWindow(app.hwnd)) {
      releaseAllCaptured(app.id);
      watchdog.states.delete(app.id);
      apps.delete(app.id);
      continue;
    }
    // Top-level guests (owned popups) can wander — their process moves them in
    // screen space, and the host window itself moves too. Re-glue visible ones
    // over the parent app's stage when they drift, recomputing the target from
    // the host's CURRENT screen position (cheap: two rect reads per tick).
    if (app.visible && app.topLevelGuest) {
      const target = glueRectFor(apps.get(parentSlotIdOf(app)) || app);
      const wr = { left: 0, top: 0, right: 0, bottom: 0 };
      user32Funcs.GetWindowRect(app.hwnd, wr);
      // Tight threshold: the host's own move events keep a dragged window in
      // sync, so this poll is only here for drift the events missed (a guest
      // that moved itself, or a host move made while no hook was installed).
      if (Math.abs(wr.left - target.x) > 2 || Math.abs(wr.top - target.y) > 2) {
        // Position-only re-glue (the game keeps its own size). NO raise: an
        // owned popup already paints above its owner (the host), while HWND_TOP
        // here lifted it above EVERY window on the desktop — each tick the app
        // sat in the background, the game popup visibly escaped the tab.
        const rect = topLevelGlueTarget(app);
        moveGuestToRect(app.hwnd, rect, false);
        app.lastRect = rect;
      }
    }
    // Keep a foreground guest above Chromium's render surface, which re-raises
    // itself on repaint and would otherwise occlude it (grey Desktop tab).
    // Background (parked off-client) guests are never raised: geometry already
    // keeps them invisible, and a raise is exactly the old "Godot over the UI"
    // bug. Parked guests are clipped anyway, but do not even touch them.
    if (app.visible && !app.background && !app.topLevelGuest) raiseGuestOverChromium(app.hwnd);
    const st = getWatchState(app.id);
    const pids = trees.get(app.id);
    if (!pids) continue; // this app's process tree could not be read this tick
    for (const w of findOwnedWindowsForPids(pids)) {
      const key = hwndNum(w.hwnd);
      if (key === hwndNum(app.hwnd)) continue;
      // Skip windows that belong to other hosted app slots already.
      let ownedByOther = false;
      for (const other of apps.values()) {
        if (other.id !== app.id && hwndNum(other.hwnd) === key) { ownedByOther = true; break; }
      }
      if (ownedByOther) continue;
      if (st.captured.has(key)) continue;
      if (st.seen.has(key)) continue;
      st.seen.add(key);
      if (!user32Funcs.IsWindow(w.hwnd)) continue;
      if (!w.owner) {
        // An unowned main-style window in this tree: if it runs the same exe
        // as the app (editor → game run), give it its own slot. Otherwise
        // (launchers, helpers) park it hidden as before.
        const wpid = windowPid(w.hwnd);
        const exeBase = path.basename(app.exe).toLowerCase();
        if (pidToExe.get(wpid) === exeBase) {
          promoteToOwnApp(app, w.hwnd, wpid, w.title, w.cls);
          continue;
        }
      }
      captureWindow(app, st, w.hwnd, w.owner ? 'dialog' : 'secondary', w.owner);
    }
  }
}

// ---- Successor handoff (manager→editor relaunch) ----------------------------
// Some apps "relaunch" themselves: Godot's project manager spawns a NEW editor
// process and exits, taking its hosted window with it. Without special care the
// app record would be dropped here and the editor would pop loose onto the
// desktop. Instead, when the original process exits we keep the record and
// briefly watch for a NEW unowned top-level window; the first one to appear is
// adopted into the same tab slot (same app id, same stage rect).
function watchForSuccessor(app) {
  // Successors can appear BEFORE the manager exits (Godot spawns the editor,
  // then quits), so the "already exists" snapshot must come from LAUNCH time —
  // stored on the app record when it was hosted — not from manager-exit time.
  let preExisting = app.windowsAtLaunch;
  if (!preExisting) {
    preExisting = new Set();
    enumerateTopLevelWindows((hwnd) => { preExisting.add(hwndNum(hwnd)); return true; });
    app.windowsAtLaunch = preExisting;
  }
  const deadlineMs = 45000;
  const deadline = Date.now() + deadlineMs;
  // Only adopt a successor running the SAME executable image as the app we
  // launched (Godot's editor is the same exe as its manager). Anything else
  // (the user opening unrelated apps during the wait) is ignored.
  const exeBase = path.basename(app.exe).toLowerCase();
  const timer = setInterval(() => {
    if (!apps.has(app.id)) { clearInterval(timer); return; } // detached/killed meanwhile
    const procs = listProcesses();
    const pidToExe = new Map(procs.map(p => [p.pid, String(p.exe || '').toLowerCase()]));

    // Case 1: the successor window appeared while the manager was still alive;
    // the watchdog then captured it as a "secondary" and parked it hidden.
    // Promote such a window to the main guest instead of hunting for a new one.
    const st = getWatchState(app.id);
    for (const [key, rec] of [...st.captured.entries()]) {
      if (rec.mode !== 'secondary' || rec.parked) continue;
      const wPid = windowPid(rec.hwnd);
      if (pidToExe.get(wPid) !== exeBase) continue;
      // Found a same-exe captured window: make it the main guest.
      clearInterval(timer);
      try {
        // Preserve show AND park state across the swap (a background child
        // stays shown in the new model, so "visible" alone is not enough).
        const wasVisible = app.visible !== false;
        const wasBackground = !!app.background;
        app.backup = rec.backup;
        app.hwnd = rec.hwnd;
        app.pid = wPid;
        app.title = windowTitle(rec.hwnd);
        app.cls = windowClass(rec.hwnd);
        app.visible = wasVisible;
        app.background = wasBackground;
        moveGuestToRect(rec.hwnd, app.lastRect || { x: 0, y: 0, w: 800, h: 600 });
        if (wasVisible && !wasBackground) {
          user32Funcs.ShowWindow(rec.hwnd, SW_SHOW);
          raiseGuestOverChromium(rec.hwnd);
        } else if (!wasVisible && app.topLevelGuest) {
          parkGuest(rec.hwnd);
        } else {
          // Background child: park beyond the client edge before showing —
          // geometric clipping cannot be defeated by z-order shuffles.
          parkGuestRect(rec.hwnd);
          user32Funcs.ShowWindow(rec.hwnd, SW_SHOW);
        }
        st.captured.delete(key);
        st.seen.clear();
        if (wasVisible && !wasBackground) setTimeout(() => { if (apps.has(app.id)) focusGuest(app.hwnd, app.hostHwnd); }, 150);
      } catch {}
      return;
    }
    const candidates = [];
    enumerateTopLevelWindows((hwnd) => {
      const key = hwndNum(hwnd);
      if (preExisting.has(key)) return true;
      if (!isCandidateWindow(hwnd)) return true;
      // Main windows only: dialogs belonging to the successor are picked up by
      // the normal watchdog once the successor is hosted.
      if (hwndNum(user32Funcs.GetWindow(hwnd, GW_OWNER))) return true;
      const wPid = windowPid(hwnd);
      if (pidToExe.get(wPid) !== exeBase) return true;
      candidates.push(hwnd);
      return true;
    });
    if (candidates.length) {
      clearInterval(timer);
      const hwnd = candidates[0];
      try {
      // Preserve show AND park state across the swap (a background child
      // stays shown in the new model, so "visible" alone is not enough).
      const wasVisible = app.visible !== false;
      const wasBackground = !!app.background;
      const out = [0];
      user32Funcs.GetWindowThreadProcessId(hwnd, out);
      const newPid = Number(out[0]) || app.pid;
      app.backup = stripWindowChrome(hwnd);
      user32Funcs.SetParent(hwnd, app.hostHwnd);
      app.hwnd = hwnd;
      app.pid = newPid;
      app.title = windowTitle(hwnd);
      app.cls = windowClass(hwnd);
      app.visible = wasVisible;
      app.background = wasBackground;
      moveGuestToRect(hwnd, app.lastRect || { x: 0, y: 0, w: 800, h: 600 });
      if (wasVisible && !wasBackground) {
        user32Funcs.ShowWindow(hwnd, SW_SHOW);
        raiseGuestOverChromium(hwnd);
      } else if (!wasVisible && app.topLevelGuest) {
        parkGuest(hwnd);
      } else {
        // Background child: park before showing (see the dialog path).
        parkGuestRect(hwnd);
        user32Funcs.ShowWindow(hwnd, SW_SHOW);
      }
      // The old tree's watchdog state is stale (its windows died with the
      // manager) — reset so the new editor tree is tracked cleanly.
      const st2 = getWatchState(app.id);
      st2.seen.clear();
      st2.captured.clear();
      // The editor needs the same focus nudge a fresh launch gets — but only
      // when it will actually be in front; a background successor must not
      // steal the keyboard from the chat the user is typing in.
      if (wasVisible && !wasBackground) setTimeout(() => { if (apps.has(app.id)) focusGuest(app.hwnd, app.hostHwnd); }, 150);
      } catch {}
      return;
    }
    if (Date.now() > deadline) {
      // No successor showed up — the app is really gone.
      clearInterval(timer);
      releaseAllCaptured(app.id);
      watchdog.states.delete(app.id);
      apps.delete(app.id);
    }
  }, 500);
}

function startWatchdog() {
  startWinEventHook();
  if (watchdog.timer) return; // already running (incl. a call from inside a tick)
  // Prime watchPids with a first scan, otherwise the hooks would ignore every
  // event until the poll's first interval elapsed (700ms by default, but an
  // operator-set interval can be much longer) and windows opened in that window
  // would sit un-parented on the desktop.
  try { watchTick(); } catch {}
  watchdog.timer = setInterval(watchTick, watchdog.intervalMs);
}

function stopWatchdog() {
  stopWinEventHook();
  if (watchdog.timer) { clearInterval(watchdog.timer); watchdog.timer = null; }
  watchPids.clear();
  hostHwnds.clear();
}
// Turn a child-process 'error' event into something actionable. Neither the
// code nor the path is normally enough on its own: Windows reports a *missing
// working directory* as ENOENT too, which is indistinguishable from a missing
// executable unless the file is probed.
function describeSpawnError(err, exe, cwd) {
  const code = (err && err.code) || '';
  if (code === 'ENOENT') {
    let exists = false;
    try { exists = fs.existsSync(exe); } catch {}
    return exists
      ? `could not start ${exe}: ENOENT (the file exists, so the working directory "${cwd || process.cwd()}" is the likely cause — Windows reports a missing cwd as ENOENT too)`
      : `could not start ${exe}: ENOENT (no such file — the path is wrong, or the file was removed after it was chosen)`;
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return `could not start ${exe}: ${code} (Windows refused to run it — permissions or a security policy)`;
  }
  return `could not start ${exe}: ${code || (err && err.message) || 'spawn failed'}`;
}

async function launchApp(opts) {
  let exe = String(opts.exe || '');
  const args = Array.isArray(opts.args) ? opts.args.map(String) : [];
  const cwd = opts.cwd ? String(opts.cwd) : undefined;
  if (!exe) return { ok: false, error: 'exe required' };

  // A picked path can be a folder named "*.exe" (zipped tools) — resolve to
  // the real binary inside before spawning, or the launch dies with ENOENT.
  const resolved = resolveExePath(exe);
  if (!resolved.ok) return resolved;
  exe = resolved.path;

  const host = hostHwndProvider();
  if (!host) return { ok: false, error: 'host window not ready' };

  // env is merged over process.env (never replacing it): a software-rendered
  // guest needs PATH plus its own renderer switches, and must keep SystemRoot
  // and friends or Windows will not start it at all.
  const env = opts.env ? { ...process.env, ...opts.env } : undefined;

  let child;
  try {
    child = spawn(exe, args, { cwd, detached: false, stdio: 'ignore', windowsHide: false, env });
  } catch (e) {
    return { ok: false, error: 'spawn failed: ' + e.message };
  }
  // spawn() does NOT throw when the process cannot be started: ENOENT, EACCES,
  // EPERM and EMFILE all arrive asynchronously on the child's 'error' event, so
  // the try/catch above cannot see any of them. With no listener attached, Node
  // treats it as an unhandled 'error' event, and Electron renders that as a
  // modal "A JavaScript error occurred in the main process" box which BLOCKS the
  // main process until a human dismisses it — one bad path froze the whole app.
  // The listener is kept for the child's whole life (a late error must not
  // become uncaught either) and is what makes the failure reportable. It has to
  // be attached BEFORE the pid check below, or a failed start is reported as a
  // bare "no pid" and the reason is lost.
  let spawnErr = null;
  child.on('error', (err) => {
    spawnErr = err || new Error('spawn failed');
    console.error('[desktop] ' + describeSpawnError(spawnErr, exe, cwd) + ' ' + JSON.stringify({
      code: spawnErr.code, syscall: spawnErr.syscall, errPath: spawnErr.path,
      cwd: cwd || process.cwd(),
    }));
  });

  const pid = child.pid;
  if (!pid) {
    // Node sets .pid synchronously, so a missing pid means the process never
    // started and the reason is still in flight on 'error'. Wait a beat for it
    // instead of returning something that says nothing about the cause.
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      child.once('error', finish);
      setTimeout(finish, 2000);
    });
    return { ok: false, reason: 'spawn-error', error: spawnErr ? describeSpawnError(spawnErr, exe, cwd) : 'spawn failed (no pid)' };
  }

  const timeoutMs = Math.min(60000, Math.max(2000, Number(opts.waitMs) || 20000));
  const wins = await waitForWindow(pid, timeoutMs, 250, () => !!spawnErr);
  if (spawnErr) return { ok: false, pid, reason: 'spawn-error', error: describeSpawnError(spawnErr, exe, cwd) };
  if (!wins.length) {
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    try { child.kill(); } catch {}
    // `reason` separates the two no-window outcomes, which look identical to a
    // caller that only reads `ok`: the process is GONE ('exited' — the console-
    // less GUI-app crash the renderer's conhost retry is designed to repair) vs
    // the process is STILL RUNNING but simply has not shown a window yet
    // ('no-window' — a slow starter, or a console/background app). Retrying the
    // latter would start a SECOND instance of an app that is already up, so
    // only 'exited' is retryable (app.js gates the conhost retry on this value).
    return {
      ok: false, pid,
      reason: alive ? 'no-window' : 'exited',
      error: alive
        ? 'the process is still running but has not shown a window yet (slow starter, or a console/background app)'
        : 'process exited before creating a window',
    };
  }

  // Reparent the first candidate window. When the renderer could not supply a
  // stage rect (another tab in front — apps launch in the background while the
  // user chats), the guest starts PARKED beyond the client's right edge: alive
  // and running, invisible by geometry (a child is clipped to its parent), and
  // with a default stage rect remembered for its first show. With a rect it
  // snaps straight onto the stage.
  const win = wins[0];
  const backup = stripWindowChrome(win.hwnd);
  // Hide FIRST: the freshly spawned window is visible on the desktop at its
  // spawn position — without this it flashes there between creation and the
  // re-parent, and with a background launch it would then ALSO sit on the UI
  // until parked. Hide → re-parent → position → show leaves no flash at all.
  try { user32Funcs.ShowWindow(win.hwnd, 0 /* SW_HIDE */); } catch {}
  user32Funcs.SetParent(win.hwnd, host);
  const initialRect = opts.rect || null;
  const startVisible = !!initialRect;
  if (initialRect) {
    moveGuestToRect(win.hwnd, initialRect);
    user32Funcs.ShowWindow(win.hwnd, SW_SHOW);
    raiseGuestOverChromium(win.hwnd);
  } else {
    // Park BEFORE showing: SetParent places a new child at the top of the
    // z-order at whatever position Windows gave it — straight over the UI.
    // Moving it off-client while still hidden, then showing it, means it is
    // never composited over the interface for even one frame.
    parkGuestRect(win.hwnd);
    user32Funcs.ShowWindow(win.hwnd, SW_SHOW);
  }

  const app = {
    id: 'app' + (nextAppId++),
    exe, args, pid,
    child,
    hwnd: win.hwnd,
    title: win.title,
    cls: win.cls,
    backup,
    hostHwnd: host,
    // Background launches remember the DEFAULT stage rect so opening the
    // Desktop tab later has somewhere to put the (still parked) window.
    lastRect: initialRect || DEFAULT_GUEST_RECT,
    visible: startVisible,
    background: !startVisible,
    startedAt: Date.now(),
  };
  apps.set(app.id, app);
  // Snapshot every existing top-level window so the successor watcher can tell
  // a genuinely-new editor window from one that already existed at launch.
  app.windowsAtLaunch = new Set();
  enumerateTopLevelWindows((hwnd) => { app.windowsAtLaunch.add(hwndNum(hwnd)); return true; });
  startWatchdog();

  // When the process exits, don't drop the record immediately: launchers like
  // Godot's project manager spawn a successor process (the editor) and exit.
  // watchForSuccessor re-hosts that successor into the same tab slot, and only
  // removes the record if no successor ever appears. Deliberate kills/detaches
  // delete the record first, which makes the watcher bail out.
  child.on('exit', () => {
    if (!apps.has(app.id)) return;
    watchForSuccessor(app);
  });

  // Some apps need a nudge before they accept focus in their new parent.
  // Background launches must NOT focus: the user is typing in another tab and
  // a stolen keyboard is exactly the interruption background mode avoids.
  if (startVisible) setTimeout(() => { if (apps.has(app.id)) focusGuest(app.hwnd, app.hostHwnd); }, 150);

  return {
    ok: true,
    app: { id: app.id, exe: app.exe, pid: app.pid, title: app.title, cls: app.cls, ...guestDpiInfo(app.hwnd) },
  };
}

// ---- Public API ---------------------------------------------------------------
// DPI awareness of a guest, reported (not "fixed") here. This is the diagnosis
// for the scaling class of bugs: a guest that is NOT per-monitor aware has its
// coordinates virtualized by Windows, so on a scaled display it can end up the
// wrong size or offset inside the tab. Changing that means hosting the child
// with DPI_HOSTING_BEHAVIOR_MIXED and computing its rect in the GUEST's DPI
// space (technique from Microsoft's DPIAwarenessPerWindow sample) — a
// coordinate-semantics change that needs a scaled display to validate, so it is
// surfaced instead of guessed at.
const GetWindowDpiAwarenessContext = user32.func('void *__stdcall GetWindowDpiAwarenessContext(HWND hwnd)');
const GetAwarenessFromDpiAwarenessContext = user32.func('int __stdcall GetAwarenessFromDpiAwarenessContext(const void *value)');
const GetDpiForWindow = user32.func('unsigned int __stdcall GetDpiForWindow(HWND hwnd)');
const DPI_AWARENESS_NAMES = { 0: 'unaware', 1: 'system', 2: 'per-monitor' };

function guestDpiInfo(hwnd) {
  const info = { dpiAware: 'unknown', dpi: 0 };
  try {
    const aware = GetAwarenessFromDpiAwarenessContext(GetWindowDpiAwarenessContext(hwnd));
    info.dpiAware = DPI_AWARENESS_NAMES[aware] || 'unknown';
  } catch {}
  try { info.dpi = Number(GetDpiForWindow(hwnd)) || 0; } catch {}
  return info;
}

function listApps() {
  const out = [];
  for (const app of apps.values()) {
    let alive = true;
    try { process.kill(app.pid, 0); } catch { alive = false; }
    // args is part of the listing because it is what tells two windows of the
    // same exe apart (the Godot editor's -e --path … vs a launched game's
    // --path …, both "Godot_v…exe", both with the same title when a game
    // inherits the project name).
    out.push({ id: app.id, exe: app.exe, pid: app.pid, title: app.title, cls: app.cls, args: Array.isArray(app.args) ? app.args : [], alive, ...guestDpiInfo(app.hwnd) });
  }
  return out;
}

function getApp(appId) {
  return apps.get(String(appId || '')) || null;
}

function resizeApp(appId, rect) {
  const app = apps.get(String(appId || ''));
  if (!app) return { ok: false, error: 'unknown app id' };
  if (!rect) return { ok: false, error: 'rect required' };
  if (app.topLevelGuest) {
    // The renderer reports the stage rect in HOST-CLIENT coordinates, but a
    // top-level guest (owned game popup) lives in SCREEN coordinates. Applying
    // the client rect verbatim teleports the game window to the screen's
    // top-left corner (negative offsets on multi-monitor). Anchor to the host's
    // live client origin (glueRectFor) and take only the size from the rect.
    const glue = glueRectFor(apps.get(parentSlotIdOf(app)) || app);
    const screenRect = { x: glue.x, y: glue.y, w: Math.max(1, Number(rect.w) || 800), h: Math.max(1, Number(rect.h) || 600) };
    app.lastRect = screenRect;
    // No raise: re-applying the stage rect on every renderer sync tick must
    // not lift the popup above other apps' windows (see note in watchTick).
    if (app.visible) moveGuestToRect(app.hwnd, screenRect, false);
  } else {
    app.lastRect = rect;
    // A background guest is parked off-client on purpose: store the rect for
    // its next show, but never move it onto the stage while it stays parked.
    if (app.visible && !app.background) moveGuestToRect(app.hwnd, rect);
  }
  relayoutCapturedDialogs(app);
  return { ok: true };
}

// Show/hide a guest (Desktop tab active vs. another tab in front). Captured
// dialogs follow the guest; parked secondaries stay hidden.
//
// CHILD guests never hide: "background" means SHOWN but parked beyond the
// host client's right edge — child windows are clipped to their parent, so the
// app keeps running and rendering while no pixel of it can composite over the
// UI. Geometry beats z-order: nothing the guest does can defeat the clip.
// TOP-LEVEL popups (screen-space game windows) are really hidden instead —
// showing one "under" anything would put it on the user's desktop.
function setAppVisible(appId, visible) {
  const app = apps.get(String(appId || ''));
  if (!app) return { ok: false, error: 'unknown app id' };
  const want = !!visible;
  const st = watchdog.states.get(app.id);
  const showDialogs = (show) => {
    if (!st) return;
    for (const rec of st.captured.values()) {
      if (rec.mode !== 'dialog') continue;
      if (show) {
        rec.parked = false;
      } else {
        rec.parked = true;
        user32Funcs.ShowWindow(rec.hwnd, 0);
      }
    }
    if (show) {
      // Re-place first (the guest may have moved while backgrounded), then
      // raise each dialog above the re-shown guest.
      relayoutCapturedDialogs(app);
      for (const rec of st.captured.values()) {
        if (rec.mode === 'dialog' && !rec.parked) {
          user32Funcs.ShowWindow(rec.hwnd, SW_SHOW);
          raiseGuestOverChromium(rec.hwnd);
        }
      }
    }
  };

  if (app.topLevelGuest) {
    const changed = app.visible !== want;
    app.visible = want;
    app.background = !want;
    if (changed) {
      // Re-showing a promoted popup: recompute the live glue target (its
      // stored screen rect may predate a host window move).
      if (want) unparkGuest(app.hwnd, glueRectFor(apps.get(parentSlotIdOf(app)) || app));
      else parkGuest(app.hwnd);
      showDialogs(want);
    } else if (want && app.lastRect) {
      // Already visible (the renderer re-syncs every few seconds): re-anchor a
      // drifted popup — position only, no raise (see the note in watchTick).
      const rect = topLevelGlueTarget(app);
      const wr = { left: 0, top: 0, right: 0, bottom: 0 };
      if (user32Funcs.GetWindowRect(app.hwnd, wr)
          && (Math.abs(wr.left - rect.x) > 1 || Math.abs(wr.top - rect.y) > 1)) {
        moveGuestToRect(app.hwnd, rect, false);
        app.lastRect = rect;
      }
    }
    return { ok: true };
  }

  // Child guest: background = parked off-client but SHOWN (keeps rendering).
  if (want) {
    const wasBackground = !!app.background;
    app.visible = true;
    app.background = false;
    const rect = app.lastRect || DEFAULT_GUEST_RECT;
    if (wasBackground) {
      // Back from the park: onto the stage, raised over the render surface.
      // MoveWindow and the raise are both NOACTIVATE — no focus is stolen.
      moveGuestToRect(app.hwnd, rect);
      user32Funcs.ShowWindow(app.hwnd, SW_SHOW); // in case anything hid it
      showDialogs(true);
    } else {
      // Already foreground (the renderer re-syncs every few seconds): re-anchor
      // so a moved/resized host re-glues the guest — without ShowWindow, which
      // re-activates the guest and visibly steals focus on every sync tick.
      moveGuestToRect(app.hwnd, rect);
    }
  } else {
    app.visible = true;      // stays shown the whole time
    app.background = true;   // parked beyond the client edge
    parkGuestRect(app.hwnd);
    showDialogs(false);
  }
  return { ok: true };
}

function focusApp(appId) {
  const app = apps.get(String(appId || ''));
  if (!app) return { ok: false, error: 'unknown app id' };
  // A backgrounded guest must come back to the stage before it can take focus
  // (focusApp is also the real-input click path — it needs the app in front).
  if (!app.visible || app.background) setAppVisible(app.id, true);
  focusGuest(app.hwnd, app.hostHwnd);
  return { ok: true };
}

// Detach: put the window back on the desktop as it was.
function detachApp(appId) {
  const app = apps.get(String(appId || ''));
  if (!app) return { ok: false, error: 'unknown app id' };
  releaseAllCaptured(app.id);
  watchdog.states.delete(app.id);
  try {
    const r = { left: 0, top: 0, right: 0, bottom: 0 };
    user32Funcs.GetWindowRect(app.hostHwnd, r);
    restoreWindowChrome(app.hwnd, app.backup);
    user32Funcs.SetParent(app.hwnd, null);
    user32Funcs.MoveWindow(app.hwnd, 80, 80,
      Math.max(320, r.right - r.left), Math.max(240, r.bottom - r.top), true);
  } catch {}
  apps.delete(app.id);
  return { ok: true };
}

function killApp(appId) {
  const app = apps.get(String(appId || ''));
  if (!app) return { ok: false, error: 'unknown app id' };
  releaseAllCaptured(app.id);
  watchdog.states.delete(app.id);
  try { app.child.kill(); } catch {}
  try { process.kill(app.pid); } catch {}
  apps.delete(app.id);
  return { ok: true };
}

// Re-anchor the promoted TOP-LEVEL guests (game windows) to the host's CURRENT
// position. This is what makes a game window look attached to the tab instead of
// trailing behind it while the app window is dragged.
//
// Child guests deliberately need nothing here: Windows moves a child window with
// its parent, atomically, so a re-parented guest physically cannot lag. Only an
// owned popup keeps its own screen coordinates and therefore has to be re-glued
// — and it has to be re-glued now, not on the next poll tick, which is why the
// caller runs this from the host's move/resize events and its WinEvent
// location-change hook.
//
// Note this is position-only and never raises: an owned popup already paints
// above its owner (the host), and raising it here would lift the game above
// every other window on the desktop (see the note in watchTick).
function syncHostResize(hostHwnd) {
  for (const app of apps.values()) {
    if (!app.visible || !app.topLevelGuest) continue;
    if (hostHwnd != null && hwndNum(app.hostHwnd) !== hwndNum(hostHwnd)) continue;
    const target = topLevelGlueTarget(app);
    const wr = readWindowRect(app.hwnd);
    // Sub-pixel deltas are not worth a repaint; MoveWindow rounds anyway.
    if (wr && Math.abs(wr.left - target.x) <= 1 && Math.abs(wr.top - target.y) <= 1) continue;
    moveGuestAsync(app.hwnd, target);
    app.lastRect = target;
  }
}

// Detach everything (app shutdown safety — never leave windows re-parented).
function shutdownAll() {
  stopWatchdog();
  for (const appId of [...watchdog.states.keys()]) {
    releaseAllCaptured(appId);
  }
  watchdog.states.clear();
  for (const app of [...apps.values()]) {
    try {
      restoreWindowChrome(app.hwnd, app.backup);
      user32Funcs.SetParent(app.hwnd, null);
    } catch {}
    try { app.child.kill(); } catch {}
  }
  apps.clear();
}

// Extract the numeric HWND from Electron's getNativeWindowHandle() buffer.
function hwndFromBuffer(buf) {
  if (!buf || !buf.length) return null;
  return buf.length >= 8 ? buf.readBigUInt64LE(0) : buf.readUInt32LE(0);
}

// ---- Agent-tool primitives: screenshot / input / UI reading -----------------
// All input goes through posted window messages rather than the global cursor,
// so the agent never moves the user's real mouse or steals focus.

// GDI capture of the guest window → BGRA pixel buffer.
function captureWindowPixels(hwnd) {
  const cr = { left: 0, top: 0, right: 0, bottom: 0 };
  user32Funcs.GetClientRect(hwnd, cr);
  const w = cr.right - cr.left, h = cr.bottom - cr.top;
  if (w <= 0 || h <= 0 || w > 8192 || h > 8192) return null;
  const hdc = user32Funcs.GetDC(hwnd);
  if (!hdc) return null;
  let mem = null, bmp = null, old = null;
  try {
    mem = gdi32Funcs.CreateCompatibleDC(hdc);
    bmp = gdi32Funcs.CreateCompatibleBitmap(hdc, w, h);
    old = gdi32Funcs.SelectObject(mem, bmp);
    // Win32 PrintWindow-equivalent: render the window into our bitmap.
    if (!PrintWindow(hwnd, mem, 2 /* PW_RENDERFULLCONTENT */)) {
      const WM_PRINT = 0x317;
      const PRF_CLIENT = 0x4, PRF_ERASEBKGND = 0x8;
      user32Funcs.PostMessageW(hwnd, WM_PRINT, mem, (PRF_CLIENT | PRF_ERASEBKGND));
      user32Funcs.PostMessageW(hwnd, 0x000F /* WM_PAINT */, 0, 0);
    }
    return readDibits(mem, bmp, w, h);
  } finally {
    if (old) try { gdi32Funcs.SelectObject(mem, old); } catch {}
    if (bmp) try { gdi32Funcs.DeleteObject(bmp); } catch {}
    if (mem) try { gdi32Funcs.DeleteDC(mem); } catch {}
    if (hdc) try { user32Funcs.ReleaseDC(hwnd, hdc); } catch {}
  }
}

// Minimal single-frame PNG encoder (no deps): BGRA → RGBA → PNG (no filtering).
function encodePNG(w, h, bgra) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4, di = row + 1 + x * 4;
      raw[di] = bgra[si + 2];     // R
      raw[di + 1] = bgra[si + 1]; // G
      raw[di + 2] = bgra[si];     // B
      raw[di + 3] = 255;          // A (GDI alpha is garbage; opaque it)
    }
  }
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  const zlib = require('zlib');
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Is this frame effectively blank? A window that presents through a GPU
// swapchain (game, Electron app, UWP/WinUI) often answers PrintWindow with a
// single flat fill — all black on most drivers, all white on some — so the
// agent's screenshot came back empty for exactly the apps this tab hosts.
// Sampling a couple of thousand pixels is enough to tell a real UI from a flat
// fill without decoding anything.
function isFlatFrame(px) {
  if (!px || !px.bits || !px.bits.length) return true;
  const pixels = px.bits.length >> 2;
  const stride = Math.max(1, Math.floor(pixels / 2000));
  let min = Infinity, max = -Infinity;
  for (let p = 0; p < pixels; p += stride) {
    const i = p << 2;
    const v = px.bits[i] + px.bits[i + 1] + px.bits[i + 2]; // B, G, R
    if (v < min) min = v;
    if (v > max) max = v;
    if (max - min > 6) return false; // early out: real content
  }
  return (max - min) <= 6; // one flat colour (slack for dithering)
}

// Grab what the compositor has ALREADY drawn on screen for a rectangle. The
// desktop contains the guest's presented pixels — GPU surface included — so a
// plain BitBlt sees them, where PrintWindow (which asks the window to repaint
// itself) does not. Only meaningful while the window is visible and unobscured.
function captureScreenRegion(rect) {
  const x = Math.round(Number(rect && rect.x) || 0);
  const y = Math.round(Number(rect && rect.y) || 0);
  const w = Math.max(1, Math.round(Number(rect && rect.w) || 1));
  const h = Math.max(1, Math.round(Number(rect && rect.h) || 1));
  if (w > 8192 || h > 8192) return null;
  const screenDc = user32Funcs.GetDC(null); // NULL → the screen DC
  if (!screenDc) return null;
  let mem = null, bmp = null, old = null;
  try {
    mem = gdi32Funcs.CreateCompatibleDC(screenDc);
    bmp = gdi32Funcs.CreateCompatibleBitmap(screenDc, w, h);
    old = gdi32Funcs.SelectObject(mem, bmp);
    if (!gdi32Funcs.BitBlt(mem, 0, 0, w, h, screenDc, x, y, SRCCOPY)) return null;
    return readDibits(mem, bmp, w, h);
  } catch { return null; } finally {
    if (old) try { gdi32Funcs.SelectObject(mem, old); } catch {}
    if (bmp) try { gdi32Funcs.DeleteObject(bmp); } catch {}
    if (mem) try { gdi32Funcs.DeleteDC(mem); } catch {}
    if (screenDc) try { user32Funcs.ReleaseDC(null, screenDc); } catch {}
  }
}

// Is the screen area where the guest sits actually showing the guest (or its
// host)? IsWindowVisible alone cannot tell: it stays true when the HOST window
// is behind another app. Reading the compositor while another app is in front
// would capture THAT app's pixels instead of the guest's. Five sample points
// (center + inset corners) catch a window covering part of the guest too.
// `guestOnTop` additionally requires the hit window to be INSIDE the guest's
// subtree: the guest and Chromium's render surface are both host children, and
// a plain root check cannot tell "guest painting above the surface" from
// "guest underneath it" — only the former is safe to screen-capture.
function guestVisibleOnScreen(app) {
  let onScreen = false;
  try { onScreen = !!user32Funcs.IsWindowVisible(app.hwnd); } catch { onScreen = false; }
  if (!onScreen) return { onScreen: false, ours: false, guestOnTop: false };
  const wr = readWindowRect(app.hwnd);
  if (!wr) return { onScreen: true, ours: false, guestOnTop: false };
  const w = wr.right - wr.left, h = wr.bottom - wr.top;
  const inset = 8; // avoid landing on borders / rounded corners
  const pts = [
    { x: wr.left + Math.floor(w / 2), y: wr.top + Math.floor(h / 2) },
    { x: wr.left + inset, y: wr.top + inset },
    { x: wr.right - inset, y: wr.top + inset },
    { x: wr.left + inset, y: wr.bottom - inset },
    { x: wr.right - inset, y: wr.bottom - inset },
  ];
  const guestN = hwndNum(app.hwnd), hostN = hwndNum(app.hostHwnd);
  // Walk parents from the hit window: reaching the guest means the point shows
  // guest content; reaching the host first means a sibling subtree (Chromium's
  // surface) is in front of the guest there.
  const inGuestSubtree = (at) => {
    let cur = at, guard = 0;
    while (cur && guard++ < 16) {
      const n = hwndNum(cur);
      if (n === guestN) return true;
      if (n === hostN) return false;
      try { cur = user32Funcs.GetAncestor(cur, 1 /* GA_PARENT */); } catch { return false; }
    }
    return false;
  };
  const rootIsOurs = (pt) => {
    try {
      const at = user32Funcs.WindowFromPoint(pt);
      if (!at) return { ours: false, onTop: false };
      const root = user32Funcs.GetAncestor(at, 2 /* GA_ROOT */);
      const ours = !!root && (hwndNum(root) === hostN || hwndNum(root) === guestN);
      return { ours, onTop: inGuestSubtree(at) };
    } catch { return { ours: false, onTop: false }; }
  };
  let ours = true, guestOnTop = true;
  for (const pt of pts) {
    const r = rootIsOurs(pt);
    ours = ours && r.ours;
    guestOnTop = guestOnTop && r.onTop;
  }
  return { onScreen: true, ours, guestOnTop };
}

function screenshotApp(appId) {
  const app = apps.get(String(appId || ''));
  if (!app) return { ok: false, error: 'unknown app id' };
  // A dead-and-replaced guest (games recreate their window) leaves a stale HWND
  // here; capturing through it prints nonsense or captures the wrong surface.
  let hwndValid = true;
  try { hwndValid = !!user32Funcs.IsWindow(app.hwnd); } catch { hwndValid = false; }
  if (!hwndValid) return { ok: false, error: 'the app window is gone (the process may have recreated it) — call desktop_list and relaunch if needed' };
  const vis = guestVisibleOnScreen(app);
  let px = captureWindowPixels(app.hwnd);
  let via = 'printWindow';
  const printWindowFlat = !!px && isFlatFrame(px);
  // The window asked to render itself came back flat/empty (GPU surface). It IS
  // being drawn on screen though, so read those pixels instead — but ONLY while
  // the guest actually owns that screen area. While parked or covered, the
  // compositor shows whatever the user switched to, so the screen fallback used
  // to return the chat UI instead of the hosted app. Top-level guests are still
  // excluded: the host owns them, and their on-screen rect is the host's.
  // `guestOnTop` is strict on purpose: a host-rooted hit that is NOT inside the
  // guest's subtree means Chromium's render surface is in front of the guest,
  // and capturing then would return that surface (the chat UI) — the exact bug
  // this gate exists to prevent. The temp-show flow in main.js re-shows the
  // guest raised above the surface, so `guestOnTop` is true when it recaptures.
  const mayUseScreen = vis.onScreen && vis.guestOnTop && !app.topLevelGuest;
  if (printWindowFlat && mayUseScreen) {
    const wr = readWindowRect(app.hwnd);
    const fromScreen = wr
      ? captureScreenRegion({ x: wr.left, y: wr.top, w: wr.right - wr.left, h: wr.bottom - wr.top })
      : null;
    if (fromScreen && !isFlatFrame(fromScreen)) { px = fromScreen; via = 'screen'; }
  }
  // Never hand back a flat GPU fill as if it were the app's picture: the agent
  // would describe a blank window as the app's UI. Parked guests (hidden) get
  // `hidden` so main.js can briefly show and retry; covered guests cannot be
  // captured without stealing the user's focus.
  if (via === 'printWindow' && isFlatFrame(px)) {
    if (!vis.onScreen) return { ok: false, hidden: true, error: 'the app window is hidden (another tab is in front) and it renders through a GPU surface, so it could not be captured' };
    // A parked (background) child's rect sits beyond the host client, so its
    // screen sample points mean nothing — check the flag BEFORE the occlusion
    // verdict or the parked guest would always read as "covered" and the
    // temp-show retry in main.js would never trigger.
    if (app.background) return { ok: false, background: true, error: 'the app is running in the background (parked while you chat) and its GPU render could not be read — retrying will briefly raise it' };
    // A foreign (non-host-rooted) window owns the screen points: genuinely
    // covered, nothing safe to do.
    if (!vis.ours) return { ok: false, covered: true, error: 'the app window is covered by another window and it renders through a GPU surface, so it could not be captured' };
    return { ok: false, error: 'the app renders through a GPU surface that could not be captured — retry while its window is in front' };
  }
  if (!px) return { ok: false, error: 'capture failed (zero-size or unsupported window)' };
  return { ok: true, w: px.w, h: px.h, png: encodePNG(px.w, px.h, px.bits), via };
}

// Window capture through the OS compositor (Chromium's desktopCapturer), for the
// promoted TOP-LEVEL guests.
//
// Chromium's window enumeration only sees top-level windows, and a guest
// re-parented into the host is a child of it — so this cannot match the normal
// hosted guests at all (measured: the hosted window never appears in
// getSources). It exists for the promoted guest slots — game windows, which are
// owned top-level popups of the host — where the window genuinely is top-level
// and its content is a GPU surface that GDI may not reproduce.
//
// Returns null when the guest cannot be identified or captured, so the caller
// can fall back to the GDI path.
async function screenshotAppLive(appId) {
  const app = apps.get(String(appId || ''));
  if (!app || !user32Funcs.IsWindow(app.hwnd)) return null;
  const { desktopCapturer } = require('electron');
  if (!desktopCapturer) return null;
  const target = hwndNum(app.hwnd);
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    // Generous box: thumbnails are scaled to fit it, so this caps the payload
    // without cropping a large guest.
    thumbnailSize: { width: 1920, height: 1080 },
    fetchWindowIcons: false,
  });
  // Source ids look like window:<native id>:<index>, and on Windows the native
  // id is the HWND. Fall back to the title, but never guess: capturing a
  // same-titled stranger's pixels would be worse than the GDI fallback.
  const byId = sources.find((s) => {
    const m = /^window:(\d+)/i.exec(String(s.id || ''));
    return m && Number(m[1]) === target;
  });
  const source = byId || (app.title ? sources.find((s) => String(s.name || '') === String(app.title)) : null);
  if (!source) return null;
  const image = source.thumbnail;
  if (!image || image.isEmpty()) return null;
  const png = image.toPNG();
  if (!png || !png.length) return null;
  const size = image.getSize();
  return { ok: true, w: size.width, h: size.height, size: png.length, png, via: 'desktopCapturer', matchedBy: byId ? 'hwnd' : 'title' };
}

// ---- Real (SendInput) input: the path that reaches games ---------------------
//
// Posted messages above are enough for classic Win32 controls, but anything that
// reads input through the OS — games on raw input/DirectInput, UWP, several
// modern frameworks — never sees a posted WM_LBUTTONDOWN, so the agent could
// describe a running game but not play it. SendInput injects at the same layer
// the real mouse and keyboard do, so those apps see it. (Technique as used by
// nut.js's libnut and pywinauto; SendInput is a documented Win32 API.)
//
// Two rules are enforced HERE rather than left to callers:
//   • the target must already be the foreground window (or live inside it), so
//     an agent can never type into whatever window the user is working in;
//   • the user's cursor is saved and put back afterwards.
const INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
const MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
const KEYEVENTF_EXTENDEDKEY = 0x0001, KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;
const MAPVK_VK_TO_VSC = 0;
// VK_* values whose keyboard messages carry the extended-key flag (games and
// DirectInput care about the difference between the two arrow clusters).
const EXTENDED_VKS = new Set([0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x5B, 0x5C, 0x5D]);

const MOUSEINPUT = koffi.struct('dc_MOUSEINPUT', {
  dx: 'long', dy: 'long', mouseData: 'unsigned long', dwFlags: 'unsigned long',
  time: 'unsigned long', dwExtraInfo: 'uintptr_t',
});
const KEYBDINPUT = koffi.struct('dc_KEYBDINPUT', {
  wVk: 'unsigned short', wScan: 'unsigned short', dwFlags: 'unsigned long',
  time: 'unsigned long', dwExtraInfo: 'uintptr_t',
});
const HARDWAREINPUT = koffi.struct('dc_HARDWAREINPUT', {
  uMsg: 'unsigned long', wParamL: 'unsigned short', wParamH: 'unsigned short',
});
const INPUTUNION = koffi.union('dc_INPUTUNION', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT });
const INPUT = koffi.struct('dc_INPUT', { type: 'unsigned long', u: INPUTUNION });
const INPUT_SIZE = koffi.sizeof(INPUT); // must be 40 on x64 — asserted on first use
const SendInput = user32.func('unsigned int __stdcall SendInput(unsigned int cInputs, _In_ dc_INPUT *pInputs, int cbSize)');
const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int X, int Y)');
const MapVirtualKeyW = user32.func('unsigned int __stdcall MapVirtualKeyW(unsigned int uCode, unsigned int uMapType)');
const GA_ROOT = 2;

function inputMouse(flags) {
  return { type: INPUT_MOUSE, u: { mi: { dx: 0, dy: 0, mouseData: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } };
}
function inputUnicode(unit, up) {
  return { type: INPUT_KEYBOARD, u: { ki: { wVk: 0, wScan: unit & 0xFFFF, dwFlags: KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0), time: 0, dwExtraInfo: 0 } } };
}
function inputVk(vk, up) {
  const flags = (up ? KEYEVENTF_KEYUP : 0) | (EXTENDED_VKS.has(vk) ? KEYEVENTF_EXTENDEDKEY : 0);
  return { type: INPUT_KEYBOARD, u: { ki: { wVk: vk, wScan: Number(MapVirtualKeyW(vk, MAPVK_VK_TO_VSC)) || 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } };
}

// Inject only when the app is already in front. Returning an error instead of
// focusing it ourselves is deliberate: silently raising a window and firing the
// user's keyboard at it is exactly the behaviour this app avoids elsewhere.
function realInputTarget(app) {
  let fg = 0;
  try { fg = hwndNum(GetForegroundWindow()); } catch {}
  if (!fg) return { ok: false, error: 'no foreground window' };
  const root = hwndNum(GetAncestor(fg, GA_ROOT));
  const host = hwndNum(app.hostHwnd);
  const guest = hwndNum(app.hwnd);
  const owned = hwndNum(user32Funcs.GetWindow(root, GW_OWNER));
  if (root === host || root === guest || owned === host) return { ok: true };
  return {
    ok: false,
    error: 'the Clod window is not in front, so real input was not sent (it would have landed in whatever window you are using). Real input only works while the user has the app in front; use the posted-message path, or ask the user to click the app window and retry.',
  };
}

function guestClientOrigin(hwnd) {
  const pt = { x: 0, y: 0 };
  return ClientToScreen(hwnd, pt) ? pt : null;
}

function sendClickReal(app, x, y, opts) {
  const gate = realInputTarget(app);
  if (!gate.ok) return gate;
  if (INPUT_SIZE !== 40) return { ok: false, error: `unexpected SendInput layout (sizeof INPUT = ${INPUT_SIZE})` };
  const origin = guestClientOrigin(app.hwnd);
  if (!origin) return { ok: false, error: 'could not resolve the guest position' };
  const cx = Math.max(0, Math.round(Number(x) || 0));
  const cy = Math.max(0, Math.round(Number(y) || 0));
  const right = !!opts.right;
  const down = right ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN;
  const upFlag = right ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP;
  const seq = opts.double ? [down, upFlag, down, upFlag] : [down, upFlag];
  const saved = { x: 0, y: 0 };
  const hadCursor = !!GetCursorPos(saved);
  let sent = 0;
  try {
    SetCursorPos(origin.x + cx, origin.y + cy);
    for (const flags of seq) sent += Number(SendInput(1, inputMouse(flags), INPUT_SIZE)) || 0;
  } finally {
    if (hadCursor) SetCursorPos(saved.x, saved.y);
  }
  return { ok: sent === seq.length, sent, x: cx, y: cy, double: !!opts.double, right, via: 'sendInput' };
}

function sendTypeReal(app, text) {
  const gate = realInputTarget(app);
  if (!gate.ok) return gate;
  if (INPUT_SIZE !== 40) return { ok: false, error: `unexpected SendInput layout (sizeof INPUT = ${INPUT_SIZE})` };
  const str = String(text == null ? '' : text);
  let sent = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0);
    // Astral characters are sent as their two UTF-16 units, which is what a
    // keyboard sends for them.
    for (const unit of code > 0xFFFF
      ? [0xD800 + ((code - 0x10000) >> 10), 0xDC00 + ((code - 0x10000) & 0x3FF)]
      : [code]) {
      sent += Number(SendInput(1, inputUnicode(unit, false), INPUT_SIZE)) || 0;
      sent += Number(SendInput(1, inputUnicode(unit, true), INPUT_SIZE)) || 0;
    }
  }
  return { ok: sent > 0, sent: sent / 2, mode: 'sendInput' };
}

function sendKeyReal(app, key, opts) {
  const gate = realInputTarget(app);
  if (!gate.ok) return gate;
  if (INPUT_SIZE !== 40) return { ok: false, error: `unexpected SendInput layout (sizeof INPUT = ${INPUT_SIZE})` };
  const name = String(key || '');
  let vk = VK_MAP[name];
  if (vk == null && /^[a-zA-Z0-9]$/.test(name)) vk = name.toUpperCase().charCodeAt(0);
  if (vk == null) return { ok: false, error: `unsupported key "${name}"` };
  const n = opts.count ? Math.max(1, Math.min(200, Math.floor(Number(opts.count)))) : 1;
  let sent = 0;
  for (let i = 0; i < n; i++) {
    sent += Number(SendInput(1, inputVk(vk, false), INPUT_SIZE)) || 0;
    sent += Number(SendInput(1, inputVk(vk, true), INPUT_SIZE)) || 0;
  }
  return { ok: sent > 0, key: name, count: n, mode: 'sendInput' };
}

// ---- Posted-message input (never touches the real cursor) --------------------
const WM_MOUSEMOVE = 0x200, WM_LBUTTONDOWN = 0x201, WM_LBUTTONUP = 0x202;
const WM_CHAR = 0x102, WM_KEYDOWN = 0x100, WM_KEYUP = 0x101;
const MK_LBUTTON = 0x1;
const VK_MAP = {
  Enter: 0x0D, Tab: 0x09, Escape: 0x1B, Backspace: 0x08, Delete: 0x2E,
  ArrowUp: 0x26, ArrowDown: 0x28, ArrowLeft: 0x25, ArrowRight: 0x27,
  Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22, space: 0x20,
  F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73, F5: 0x74, F6: 0x75, F7: 0x76,
  F8: 0x77, F9: 0x78, F10: 0x79, F11: 0x7A, F12: 0x7B,
};
function lpParam(x, y) { return (y << 16) | (x & 0xFFFF); }

function sendClick(appId, x, y, opts = {}) {
  const app = apps.get(String(appId || ''));
  if (!app) return { ok: false, error: 'unknown app id' };
  if (opts && opts.real) return sendClickReal(app, x, y, opts);
  x = Math.max(0, Math.round(Number(x) || 0));
  y = Math.max(0, Math.round(Number(y) || 0));
  const dbl = !!opts.double;
  const right = !!opts.right;
  // Resolve the child control under the click point so subsequent type/key
  // calls reach the control that now has focus (top-level windows don't
  // forward keyboard messages to their children themselves).
  try {
    const pt = { x, y };
    const child = user32Funcs.ChildWindowFromPoint(app.hwnd, pt);
    if (child && hwndNum(child) && hwndNum(child) !== hwndNum(app.hwnd)) app.lastFocusHwnd = child;
    else app.lastFocusHwnd = null;
  } catch { app.lastFocusHwnd = null; }
  const target = app.lastFocusHwnd || app.hwnd;
  const BM = right ? [0x204, 0x205] : [WM_LBUTTONDOWN, WM_LBUTTONUP]; // WM_R*
  const mk = right ? 0 : MK_LBUTTON;
  const seq = dbl ? [BM[0], BM[1], BM[0], BM[1]] : [BM[0], BM[1]];
  user32Funcs.PostMessageW(app.hwnd, WM_MOUSEMOVE, mk, lpParam(x, y));
  for (const m of seq) user32Funcs.PostMessageW(target, m, mk, lpParam(x, y));
  return { ok: true, x, y, double: dbl, right };
}

function sendType(appId, text, opts = {}) {
  const app = apps.get(String(appId || ''));
  if (!app) return { ok: false, error: 'unknown app id' };
  if (opts && opts.real) return sendTypeReal(app, text);
  const target = app.lastFocusHwnd || app.hwnd;
  const str = String(text == null ? '' : text);
  // Standard text controls (Edit/RichEdit/ComboBox): EM_REPLACESEL inserts at
  // the caret deterministically. Posting WM_CHAR cross-process only works for
  // apps whose message loop applies it (classic Win32 loops do; some modern
  // frameworks silently ignore it).
  const cls = windowClass(target);
  if (/Edit|ComboBox|RichEdit/i.test(cls)) {
    const out = [0];
    const r = SendMessageTimeoutW(target, EM_REPLACESEL, 1, str, SMTO_ABORTIFHUNG, 2000, out);
    if (r) return { ok: true, sent: str.length, mode: 'EM_REPLACESEL' };
    // fall through to WM_CHAR if the control hung/refused.
  }
  let sent = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (code >= 0x10000) continue; // surrogates: skip astral chars (rare in UIs)
    user32Funcs.PostMessageW(target, WM_CHAR, code, 0);
    sent++;
  }
  return { ok: true, sent, mode: 'WM_CHAR' };
}

function sendKey(appId, key, opts = {}) {
  const app = apps.get(String(appId || ''));
  if (!app) return { ok: false, error: 'unknown app id' };
  if (opts && opts.real) return sendKeyReal(app, key, opts);
  const name = String(key || '');
  let vk = VK_MAP[name];
  if (vk == null && /^[a-zA-Z0-9]$/.test(name)) vk = name.toUpperCase().charCodeAt(0);
  if (vk == null) return { ok: false, error: `unsupported key "${name}" (use Enter, Tab, Escape, Backspace, Delete, arrows, Home/End/PageUp/PageDown, space or a single letter/digit)` };
  const target = app.lastFocusHwnd || app.hwnd;
  const n = opts.count ? Math.max(1, Math.min(200, Math.floor(Number(opts.count)))) : 1;
  for (let i = 0; i < n; i++) {
    user32Funcs.PostMessageW(target, WM_KEYDOWN, vk, 0);
    user32Funcs.PostMessageW(target, WM_KEYUP, vk, 0xC0000000);
  }
  return { ok: true, key: name, count: n };
}

// ---- UI reading: child-window tree of the guest -------------------------------
const GetDlgCtrlID = user32.func('intptr_t __stdcall GetDlgCtrlID(HWND hWnd)');

function listUIElements(appId) {
  const app = apps.get(String(appId || ''));
  if (!app) return { ok: false, error: 'unknown app id' };
  const elements = [];
  const collect = koffi.register((hwnd) => {
    try {
      if (!user32Funcs.IsWindowVisible(hwnd)) return true;
      const cr = { left: 0, top: 0, right: 0, bottom: 0 };
      user32Funcs.GetClientRect(hwnd, cr);
      const w = cr.right - cr.left, h = cr.bottom - cr.top;
      if (w < 2 || h < 2) return true;
      const pt = { x: cr.left, y: cr.top };
      user32Funcs_mapPoints(hwnd, app.hwnd, pt);
      elements.push({
        cls: windowClass(hwnd),
        title: getControlText(hwnd).slice(0, 100),
        x: pt.x, y: pt.y, w, h,
        ctrlId: Number(GetDlgCtrlID(hwnd)) & 0xFFFF,
      });
    } catch {}
    return true;
  }, 'dcChildEnumCb *');
  try {
    user32Funcs.EnumChildWindows(app.hwnd, collect, 0);
  } finally {
    try { koffi.unregister(collect); } catch {}
  }
  return { ok: true, elements };
}

// MapWindowPoints helper (declared here to keep the Win32 table tidy).
const user32Funcs_mapPoints = (() => {
  const MapWindowPoints = user32.func('int __stdcall MapWindowPoints(HWND hWndFrom, HWND hWndTo, _Inout_ dc_POINT *lppt, unsigned int cPoints)');
  return (from, to, pt) => { try { MapWindowPoints(from, to, pt, 1); } catch {} };
})();

module.exports = {
  setHostHwndProvider,
  launchApp,
  listApps,
  getApp,
  resizeApp,
  setAppVisible,
  focusApp,
  detachApp,
  killApp,
  syncHostResize,
  shutdownAll,
  hwndFromBuffer,
  screenshotApp, screenshotAppLive, sendClick, sendType, sendKey, listUIElements,
  // exported for tests
  _internal: {
    listProcesses, treePids, findTopLevelWindowsForPids, findOwnedWindowsForPids, waitForWindow,
    stripWindowChrome, restoreWindowChrome, focusGuest, resizeIntoHost,
    moveGuestToRect, parkGuest, unparkGuest, raiseGuestOverChromium,
    windowPid, windowTitle, windowClass, hwndNum, isCandidateWindow,
    startWatchdog, stopWatchdog, watchTick, getWatchState, captureWindow, watchForSuccessor,
    releaseAllCaptured, releaseCapturedWindow, restoreCapturedParenting, watchdog,
    captureWindowPixels, captureScreenRegion, isFlatFrame, readWindowRect, encodePNG,
    // event-driven capture
    startWinEventHook, stopWinEventHook, scheduleWatchTick, followHostMove, moveGuestAsync,
    winEvents, watchPids, hostHwnds, virtualScreenBounds, glueRectFor, topLevelGlueTarget,
    // real input
    sendClickReal, sendTypeReal, sendKeyReal, realInputTarget, guestDpiInfo, INPUT_SIZE,
    apps,
    // test-only: inject a synthetic app record so harnesses can drive the
    // watchdog without spawning a real exe through launchApp
    _testInjectApp(app) { apps.set(app.id, app); startWatchdog(); },
  },
};
