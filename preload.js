// Minimal, audited renderer API. No host command/file/input bridge is exposed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAgent', {
  notify: (opts = {}) => ipcRenderer.invoke('notify:show', opts),
  // Agent browser (Web Browser tab). All handlers are scoped to the <webview>
  // guest page identified by its webContents id; nothing here touches the host.
  browserNavigate: (wcId, url) => ipcRenderer.invoke('browser:navigate', { wcId, url }),
  browserEval: (wcId, code) => ipcRenderer.invoke('browser:eval', { wcId, code }),
  browserSnapshot: (wcId) => ipcRenderer.invoke('browser:snapshot', { wcId }),
  browserText: (wcId) => ipcRenderer.invoke('browser:text', { wcId }),
  browserScreenshot: (wcId) => ipcRenderer.invoke('browser:screenshot', { wcId }),
  browserInput: (wcId, kind, opts = {}) => ipcRenderer.invoke('browser:input', { wcId, kind, ...opts }),
  browserHistory: (wcId, action) => ipcRenderer.invoke('browser:history', { wcId, action }),
  browserSession: (wcId, action, opts = {}) => ipcRenderer.invoke('browser:session', { wcId, action, ...opts }),
  // Console ring buffer of a browser guest (run_webapp apps): read the running
  // app's logs/errors. since: only entries newer than this seq (0 = all).
  browserConsole: (wcId, opts = {}) => ipcRenderer.invoke('browser:console', {
    wcId, since: Number(opts.since) || 0, noClear: !!opts.noClear,
  }),
  // CORS-free fetch through main (used by the web_search agent tool).
  // timeout is in ms (clamped 1–60s server-side; default 30s).
  netFetch: (url, opts = {}) => ipcRenderer.invoke('net:fetch', {
    url, method: opts.method || 'GET', headers: opts.headers || {},
    body: opts.body != null ? opts.body : null, timeout: opts.timeout || 30000,
  }),
  // Binary download through main (web_download agent tool). Returns base64 +
  // size/mime; timeout ms (clamped 5–300s server-side, default 60s) and
  // maxBytes (clamped 1–100 MB, default 25 MB).
  netDownload: (url, opts = {}) => ipcRenderer.invoke('net:download', {
    url, timeout: opts.timeout || 60000, maxBytes: opts.maxBytes || 25 * 1024 * 1024,
  }),
  // Webapp preview server (run_webapp tool + manual preview loading).
  // The renderer never sees a raw path except the one the user just picked.
  webappStart: (root, rel) => ipcRenderer.invoke('webapp:start', { root, rel }),
  webappServeFiles: (files) => ipcRenderer.invoke('webapp:serveFiles', { files }),
  webappPick: () => ipcRenderer.invoke('webapp:pick'),
  webappReload: () => ipcRenderer.invoke('webapp:reload'),
  // Push channel: main notifies when files under the served webapp root
  // change (fs.watch, debounced in main) so the preview can auto-reload.
  // Returns an unsubscribe function.
  webappOnFilesChanged: (fn) => {
    const handler = (_e, payload) => { try { fn(payload || { changed: [] }); } catch {} };
    ipcRenderer.on('webapp:filesChanged', handler);
    return () => ipcRenderer.removeListener('webapp:filesChanged', handler);
  },
  // Native workspace folder bridge. The renderer only ever passes
  // workspace-relative paths (rel, e.g. '/src/app.js'); the main process
  // resolves them inside the chosen root and rejects any escape. This replaces
  // the File System Access API in the desktop app, whose permission grants do
  // not survive an app restart in Electron, so a folder can be re-attached
  // automatically by path on the next launch.
  workspacePick: () => ipcRenderer.invoke('workspace:pick'),
  workspaceExists: (root) => ipcRenderer.invoke('workspace:exists', { root }),
  workspaceRead: (root, rel) => ipcRenderer.invoke('workspace:read', { root, rel }),
  workspaceWrite: (root, rel, text) => ipcRenderer.invoke('workspace:write', { root, rel, text }),
  workspaceWriteBinary: (root, rel, base64) => ipcRenderer.invoke('workspace:writeBinary', { root, rel, base64 }),
  workspaceList: (root, rel) => ipcRenderer.invoke('workspace:list', { root, rel }),
  workspaceStat: (root, rel) => ipcRenderer.invoke('workspace:stat', { root, rel }),
  // opts.allowDir: the headless engine runners need the real path of a DIRECTORY
  // (godot --path <dir>), not only of files, so the flag has to reach main —
  // forwarding only { root, rel } silently made it "not a file" for every dir.
  workspaceResolve: (root, rel, opts = {}) => ipcRenderer.invoke('workspace:resolve', { root, rel, allowDir: !!opts.allowDir }),
  workspaceDelete: (root, rel, opts = {}) => ipcRenderer.invoke('workspace:delete', { root, rel, recursive: !!opts.recursive }),
  workspaceReadRaw: (root, rel) => ipcRenderer.invoke('workspace:readRaw', { root, rel }),
  workspaceMkdir: (root, rel) => ipcRenderer.invoke('workspace:mkdir', { root, rel }),
  // Multi-file chat export: renderer sends base64 payloads, main shows the
  // save dialog and writes the .md + <name>_images/ folder. Nothing here
  // exposes host paths back to the agent tools — the renderer only gets the
  // user-visible result summary.
  exportChatWithImages: (opts = {}) => ipcRenderer.invoke('export:chatWithImages', opts),
  // Desktop container (Desktop tab): launch exes and host their windows in-tab.
  // rect is CSS pixels relative to the window content area ({x,y,w,h}); main
  // converts to physical child-window coordinates.
  // opts.renderer: run a hosted Godot window on a specific backend (id from
  // godotRenderers) — e.g. a CPU renderer, whose window is software-painted and
  // therefore capturable even when a GPU surface is not.
  desktopLaunch: (opts = {}) => ipcRenderer.invoke('desktop:launch', opts),
  desktopList: () => ipcRenderer.invoke('desktop:list'),
  // One-way ping so main knows whether the Desktop tab is in front (used to
  // restore hosted-app visibility after a screenshot temporarily shows it).
  desktopTabActive: (active) => ipcRenderer.send('desktop:tabActive', !!active),
  desktopResize: (id, rect) => ipcRenderer.invoke('desktop:resize', { id, rect }),
  desktopVisible: (id, visible) => ipcRenderer.invoke('desktop:visible', { id, visible }),
  desktopFocus: (id) => ipcRenderer.invoke('desktop:focus', { id }),
  desktopDetach: (id) => ipcRenderer.invoke('desktop:detach', { id }),
  desktopKill: (id) => ipcRenderer.invoke('desktop:kill', { id }),
  blenderFind: () => ipcRenderer.invoke('blender:find', {}),
  blenderRun: (opts = {}) => ipcRenderer.invoke('blender:run', opts),
  godotFind: () => ipcRenderer.invoke('godot:find', {}),
  godotRun: (opts = {}) => ipcRenderer.invoke('godot:run', opts),
  // Rendering backends this machine can offer, in the order to try them: the
  // GPU (Godot's own default) first, then CPU fallbacks (SwiftShader's CPU
  // Vulkan, Mesa llvmpipe's CPU OpenGL). Needed because Godot's --headless mode
  // renders nothing at all, so a windowless run that wants pixels has to use a
  // real renderer with its window parked off-screen. Pass the chosen id back as
  // godotRun({ renderer }) / desktopLaunch({ renderer }).
  godotRenderers: (opts = {}) => ipcRenderer.invoke('godot:renderers', { exe: (opts && opts.exe) || '' }),
  // Every Godot the app can find, newest version first, so a project runs on
  // the most recent engine available. exes: real paths of workspace binaries
  // the renderer discovered (it is the only side that can see those).
  godotInstalls: (opts = {}) => ipcRenderer.invoke('godot:installs', { exes: (opts && opts.exes) || [] }),
  // Stable-release check against Godot's GitHub releases; current is the
  // version string of the local build being compared against.
  godotUpdateCheck: (opts = {}) => ipcRenderer.invoke('godot:updateCheck', { current: (opts && opts.current) || '' }),
  // Downloads and unpacks a release zip into the app-managed Godot folder.
  godotUpdateInstall: (opts = {}) => ipcRenderer.invoke('godot:updateInstall', {
    url: (opts && opts.url) || '', version: (opts && opts.version) || '',
  }),
  desktopPickExe: () => ipcRenderer.invoke('desktop:pickExe'),
  desktopScreenshot: (id) => ipcRenderer.invoke('desktop:screenshot', { id }),
  desktopClick: (id, x, y, opts = {}) => ipcRenderer.invoke('desktop:click', { id, x, y, ...opts }),
  desktopType: (id, text, opts = {}) => ipcRenderer.invoke('desktop:type', { id, text, ...opts }),
  desktopKey: (id, key, opts = {}) => ipcRenderer.invoke('desktop:key', { id, key, ...opts }),
  desktopReadUi: (id) => ipcRenderer.invoke('desktop:readUi', { id }),
});
