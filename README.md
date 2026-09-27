# Clod Code — Agent Desktop

## Start

1. Install [Node.js LTS](https://nodejs.org/).
2. `npm install`
3. `npm start`

## Web search

The `web_search` agent tool uses SearXNG as its default provider and automatically
uses DuckDuckGo as a backup when the SearXNG request fails or returns no results.
The default public endpoint is `https://searxng.gr/search`; for better reliability,
rate-limit control, and privacy, set the endpoint to a SearXNG instance you control
in **Settings → Agent Tools → Web search**. SearXNG uses `GET` and does not require
an API key. Existing saved settings that used the old blank/DuckDuckGo default are
migrated to SearXNG automatically.

A **Provider ranking** section (Settings → Agent Tools → Web search) lets you choose
and order multiple search providers — SearXNG, Tavily, Brave, Mojeek, a custom
endpoint, and DuckDuckGo — and try them top-first until one returns results.
DuckDuckGo remains the automatic backup when "Allow fallback" is enabled. Each
provider has its own endpoint, API key, key header and method. Drag the ⋮⋮ handle to
reorder, uncheck to disable a provider, and click ⓘ to configure it. The legacy
single-endpoint/key/method fields are migrated into the SearXNG provider on first load.

## Desktop tab (hosting native apps)

Windows-only. Launched apps are re-parented into this window and kept glued to the
Desktop tab's stage; escaping pop-ups are re-homed by a watchdog.

- Capture of escaped windows is **event-driven**: a `SetWinEventHook` subscription
  runs the watchdog tick the moment a window appears, instead of waiting for the
  poll (which stays as a safety net). `CLOD_DESKTOP_NO_WINEVENT=1` disables the
  hooks, and `CLOD_DESKTOP_WATCH_INTERVAL_MS=<ms>` overrides the poll interval —
  useful when debugging capture timing.
- Promoted **top-level** guests (game windows) are re-glued to the tab on the
  host's move/resize events and on its WinEvent location-change, so they track a
  dragged window instead of trailing behind it. Guests re-parented as *children*
  need no re-glue: Windows moves a child window with its parent.
- `desktop_screenshot` reports the path it used: `printWindow` (the app rendered
  itself), `screen` (its own render came back blank — a GPU surface — so the
  composited desktop was read instead, and only while the guest actually owns
  the screen area), or `desktopCapturer` (top-level guests like game windows).
- Hosted apps run in the BACKGROUND while the user is on another tab: the guest
  window is parked beyond the host client's edge — clipped to nothing by
  geometry (a child window cannot paint outside its parent), so it can never
  cover the chat, while staying shown so the app keeps rendering. Launching an
  app never switches tabs.
  Screenshots of backgrounded GPU apps briefly restore the app to the stage,
  capture, and park it again (`resumed` in the tool result).
- `desktop_click` / `desktop_type` / `desktop_key` take a `real` flag that
  injects OS-level input with `SendInput` instead of posting window messages —
  the only thing games read, since they never see posted `WM_*` messages. It is
  gated on the Clod window already being in front (it never steals the user's
  focus on its own), the user's cursor position is restored afterwards, and the
  reply reports `via: 'sendInput'`.
- `desktop_launch` reports the launched app's DPI awareness (`dpiAware`, `dpi`),
  which is what determines whether its rects line up with the stage on a scaled
  display.
- A `desktop_*` call that omits `id` acts on the most recently launched app —
  what the tool descriptions have always promised. When several apps are hosted
  and none is remembered, the error lists them rather than failing with a bare
  "unknown app id".
- `desktop_list` (and `godot_editor action=status`) label every window: id, exe,
  pid, title, launch arguments, and — for Godot — whether that window is the
  editor or a launched game. Two Godot windows of the same build used to list as
  two identical lines, which is enough to leave an agent driving the editor
  while believing it is playing the game.
- `desktop_launch` resolves workspace paths inside `args` for Godot: `--path
  /san_andreas` becomes the real folder on disk. Godot reads a bare `/san_andreas`
  as `C:\san_andreas`, finds no project there and exits at once — which the
  caller only saw as "process exited before creating a window". A `--path` that
  names no folder in the workspace is refused with that explanation instead of
  being launched into the same silent exit, and the exited-immediately error now
  points at the arguments rather than inviting the identical retry.

## Godot: windowless runs, inspection and updates

Godot is built into the app rather than being something the user has to arrange:
when no engine can be found anywhere — not in the workspace, not on `PATH`, not
app-managed — the app downloads the newest stable release into its own folder
(`<userData>/godot/<version>/`) the first time one is needed, and reports it once.
That is why "no Godot found" is no longer an end state: the agent runs a Godot
tool, the engine provisions itself, and the run continues. It is one-time, it
respects a setting (`Settings → Agent Tools → Godot`), and it stays quiet when
GitHub is unreachable rather than turning a tool call into an error.

### The tools

| tool | what it does |
|---|---|
| `godot_project` | What the project IS, without starting the engine: name, main scene (and whether that scene file exists), window size, renderer, features, autoloads, scene/script counts. |
| `godot_check` | With `path`/`script`, parses one GDScript via `--check-only` and reports the errors without running a line. With neither, loads the whole project through `--import` — importing every resource and surfacing every parse/import error, naming the project it checked. |
| `godot_run` | Plays the game under Movie Maker mode and captures frames, or runs a test script. No windows appear. |
| `godot_editor` | Opens the real editor on the workspace project, hosted inside the Desktop tab (`open`/`close`/`status`). Opening it writes into the project — Godot rewrites `project.godot` and its `.godot/` editor state — and only one editor per project is allowed, since Godot locks the project. |

A project load (`godot_check` with no script) writes `.godot/` caches and `.import`
sidecars, exactly as the editor would, but leaves scripts and scenes untouched; a
script check writes nothing. Measured, not assumed: `godot_check` on a real
project left `project.godot`, `main.tscn` and `main.gd` byte-identical.

### What a run looks like

The goal is that **nothing appears on screen** — no game window hosted in the
Desktop tab, no stray windows stacking up. Two modes of `godot_run`:

- **No script + `screenshotPaths`** runs the project's own main scene for a
  bounded number of frames (`frames`, `fps`) under Godot's **Movie Maker mode**
  (`--write-movie`) and writes the captures to exactly the paths the caller
  named. This is the "open the game, run it, screenshot it" workflow.
- **With a `script`**, a GDScript (SceneTree `MainLoop`) run replaces the main
  loop for scripted in-engine tests. The game's own scene does *not* load in
  this mode, which is why plain scene-capture goes through Movie Maker instead.

`--script` was never able to do the first job: it replaces the main loop, so
the project's main scene never loads at all.

Scripts render on a real surface too, by default. Defaulting them to headless
looks like the cautious choice and is the opposite: a test script that takes its
own screenshot then writes empty files while still reporting success, and the
agent has no way to notice. `render="headless"` remains available for pure-logic
tests, and is refused outright when screenshots are asked for — including when
the script itself calls a save-the-frame helper.

### Why not literally `--headless`

Godot has no software rasterizer, and `--headless` is not "render without a
GPU" — the headless display server offers exactly one rendering driver,
`dummy`, and installs `RasterizerDummy` on creation
(`servers/display_server_headless.h`, unchanged from 4.0 through 4.5). Every
viewport texture is empty there, so **a headless capture is always blank**, no
matter how long the script waits or how the script is written. `godot_run`
therefore refuses `render="headless"` when screenshots are requested instead of
returning empty files, and keeps `--headless` for pure-logic tests where it is
merely faster.

Godot on Windows also has no windowless rendering path. So a run that needs
pixels creates a real window and parks it far off-screen (`--position
-4000,-4000`); it is invisible, and it closes with the run. That is what
"headless" means here.

### Renderer selection

The GPU is the default because it is faster — and because the reason hosted
Godot rendering misbehaves in this app (the Desktop tab re-parents a game into
the host window) does not apply to a windowless capture run at all. Backends are
tried in order, and `main.js` reports which ones exist:

| backend | what it is |
|---|---|
| `gpu` | No overrides: Godot picks for itself, exactly as it would for a player. |
| `swiftshader` | CPU Vulkan via Chromium's bundled ICD (see below). |
| `llvmpipe` | CPU OpenGL via a drop-in Mesa `opengl32.dll` — never fetched, see below. |

The **CPU fallbacks are already on disk or explicitly opted into**:

- **SwiftShader** needs no download. Chromium bundles `vk_swiftshader.dll`,
  `vk_swiftshader_icd.json` and a Vulkan loader next to the app binary, and this
  app is Chromium. `VK_DRIVER_FILES`/`VK_ICD_FILENAMES` point at that manifest
  and the app's own directory goes on `PATH` so Godot's `dlopen` of
  `vulkan-1.dll` resolves.
- **Mesa llvmpipe** is used when an `opengl32.dll` sits next to the Godot binary
  or in `<userData>/godot/mesa`. Mesa ships no installer for it, so it is
  reported as unavailable rather than fetched — dropping the file in is the
  opt-in. `render="software"` forces the CPU list (skipping the GPU).

Two hard-won details govern the walk:

- **Only a FAILED run advances it.** Godot 4.7 falls back on its own
  (Vulkan → Direct3D 12) and prints "your video card drivers seem not to support
  Vulkan" *while succeeding* on the next device. Treating that text as an error
  would abandon a perfectly good run, so `driverError` is gated on the run
  having failed. In capture mode a run that exits cleanly but writes **no
  frames** also counts as failure — a GPU driver producing nothing is exactly
  the case a CPU fallback should rescue.
- **The device that rendered is parsed from Godot's own banner**
  (`Using Device #0: …`) and reported in the tool result, so "did this render,
  and on what?" is answered by evidence rather than by the backend that was
  requested. `SwiftShader`/`lavapipe`/`llvmpipe` in the device name marks a CPU
  rasterizer.

Movie Maker mode is *offline* rendering at a fixed frame rate, so a slow CPU
rasterizer still produces correct, evenly paced frames — it does not have to
keep up with real time. PNG encoding dominates the cost, so keep the resolution
modest and the timeout generous.

The renderer never passes environment variables to the main process. It names a
backend, and `main.js` builds the environment — the only place a renderer-
supplied string could otherwise reach a child process's environment.

### Update checks

The Desktop tab carries a Godot card: the engine and the project it found, and
one-click **Run & capture** (which shows the resulting frame in the tab),
**Open editor**, **Check project** and **Install engine**. Each button calls the
same agent tool the AI calls, so the two cannot drift apart, and only one action
runs at a time — two Godot runs against the same project would fight.

`Settings → Agent Tools → Godot` shows the engine in use, its full path and every
other engine the app can see, and offers a stable-release update; the check also
runs once at startup (silent on failure — an offline or rate-limited GitHub is
not an error the user asked to see), and can install unattended if that toggle is
on. Details that matter:

- The comparison baseline is *which Godot the app would actually run*, resolved
  by exactly the same code `godot_run` uses. Resolving it any other way
  produced the worst possible pair of messages — "no Godot found" next to a
  `godot_run` that had just launched one from the workspace, and an update
  offered for the version already sitting there, because an empty baseline
  leaves nothing to compare against.
- An install unpacks into a `*.part-*` directory and is moved into place only
  after its binary answers `--version`, so a failed download leaves neither a
  half-written engine in the managed folder nor a destroyed install of the same
  version.
- **Runs use the newest engine available**, wherever it lives — workspace,
  app-managed install or system install — chosen by probed version rather than
  by path order, so `godot_run` and `desktop_launch` can never disagree about
  which build is meant.
- The Windows GUI build writes nothing to a pipe, so its version is read
  through the `*_console.exe` twin the official zip ships alongside it.
- Only stable tags are accepted (`/releases/latest` already skips
  pre-releases, and the tag is re-checked for `rc`/`beta`/`dev` text), and an
  install is offered only when there is an asset to fetch.
- Each release unpacks into its own `<userData>/godot/<version>/` directory
  instead of overwriting, `findGodotExe()` scans that tree newest-first ahead
  of the PATH, and the unpacked binary must answer `--version` before it is
  reported as installed — a truncated or mislabelled download is worse than no
  update, because every later `godot_run` would use it.
- The archive is read with the renderer's inlined `fflate` (a CommonJS module,
  so `main.js` requires it directly) — no subprocess and no new dependency.
- Results are cached for an hour in the renderer, because GitHub allows 60
  unauthenticated API calls per hour per IP and opening Settings twice should
  not spend two of them.

## Context budget

Every Big Chat step re-sends the whole transcript, so how large tool output gets
is what decides whether a long run survives. Three rules keep a request inside
the window of whichever model actually answers it:

- **Per-result ceilings.** `fs_read` is capped in characters as well as lines
  (24,000 characters, on top of its 2,000-line window), and every Big Chat tool
  result is capped at 24,000 characters before it is stored in the thread — one
  56 KB read is otherwise paid for on every later step. Truncation is always
  announced in the result text: a silently clipped result reads as the whole
  truth.
- **Sub-agent reports.** `delegate` hands back at most 16,000 characters of a
  sub-agent's answer, announced when it clips — the caller has to be able to tell
  that a report was cut. A sub-agent's own tool results are capped separately, at
  4,000 characters.
- **The ceiling auto-compact works against** comes from `bigChatContextLimit()`:
  the thread's pinned model when it has one, otherwise the *smallest* known
  window in the fallback chain (any entry can serve a step), otherwise an assumed
  32,000 when the model list has not been loaded. It is recomputed every step,
  and compaction keeps a *budgeted* tail that never begins on a tool result, so a
  compacted request is back under the trigger it compacted for rather than
  re-compacting on every following step.

Regenerating a reply confirms first when it would discard more than four
messages, restates the original request and the open checklist for the re-run,
and marks the cut with a visible `regenerate` chip.

`npm test` is a parse-level smoke check of the three entry points plus the
context-budget regression suite in `tools/`; the per-module harnesses live under
`tools/` when it is present.

## Build

```bash
npm run build:win
npm run build:mac
npm run build:linux
```

Build on the target OS.
