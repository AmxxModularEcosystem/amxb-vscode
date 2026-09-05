# AMXB — AMX Mod X Builder for VS Code

A Visual Studio Code extension that integrates [`amxb serve`](https://github.com/AmxxModularEcosystem/amxx-builder) — the JSON-RPC interface of the `amxx-builder` CLI — into the editor. It detects AMX Mod X build manifests in your workspace and turns them into interactive UI: validation, dependency trees, include intelligence, live builds, single-file compile, deploy, RCON and watch mode.

> The extension is a demonstration client of the `amxb serve` protocol. Everything it does goes through a single `amxb serve` process per project over stdio.

## Requirements

- [Node.js](https://nodejs.org) >= 18
- [`amxx-builder`](https://github.com/AmxxModularEcosystem/amxx-builder) CLI on `PATH`:
  ```bash
  npm install -g amxx-builder   # provides the `amxb` binary
  ```
  …or set the path to your binary (or to the repository's `src/commands/serve.js`) in the `amxb.servePath` setting.
- An AMX Mod X project — a folder containing `amxbuild.yml` (or `amxbuild.yaml` / `manifest.yml`). The manifest at the **workspace root** is the primary project; manifests in subdirectories are detected too and listed in the AMXB view.

## Features

| Feature | serve method(s) |
|---|---|
| Manifest detection (root first, subdirs) + project switcher in the status bar | — |
| Manifest validation → Problems panel | `manifest.validate` |
| Manifest overview webview (resolved manifest, copy JSON, quick actions) | `manifest.resolve` |
| Build plan webview | `build.plan` |
| Live build with stages, per-plugin progress and cancellable progress | `build.start` / `build.cancel` |
| Compiler warnings/errors as in-editor diagnostics | `build.compiled` / `compile.single` |
| Single-file compile from the editor context menu | `compile.single` |
| Deploy build output / single compiled file | `deploy.start` / `deploy.file` |
| RCON commands with quick presets | `rcon.send` |
| Watch mode: auto recompile → deploy → RCON on change | `watch.start` / `watch.stop` |
| Dependencies tree with cycle/shared/error badges | `deps.tree` |
| Recursive dependency expansion (each dep expands to its own deps + includes via its own manifest) | `deps.tree` / `include.list` |
| Per-plugin include graph nested under each `.sma` (external includes shown compact, linked to their repo) | `dep-graph.get` |
| External includes section (dep repos + AMXX stdlib, grouped) | `include.list` / `amxmodx.includes.list` |
| Per-dependency include file listing | `include.list` |
| Hover on `#include` → resolved file + source | `include.resolve` |
| Missing-include diagnostics for `.sma` files | `dep-graph.get` |
| Release browsing + "set dependency ref" (edits the manifest) | `releases.list` |
| AMXX stdlib include browser | `amxmodx.includes.list` |
| Feed resolved dependency include dirs to the `amxx-pawn-all-in` extension via its programmatic API (IntelliSense parity) | `include.list` / `amxmodx.includes.list` |
| Lock editing of files in the amxb cache (dependency libraries) until explicitly allowed (JetBrains-style banner) | `cache.info` |
| Cache & compiler info | `cache.info` / `compiler.info` |

## Getting started

1. Open your project folder (the one with `amxbuild.yml`).
2. The status bar shows `AMXB: <project>`. Click it to switch projects or open the manifest.
3. Use the AMXB activity bar view for dependencies/plugins, the command palette (`AMXB: …`), or the status bar.

### Typical workflow

- **Build**: `AMXB: Build Project` (status bar / tree / palette). Watch stages and per-plugin results in the output panel; compiler warnings/errors appear in the Problems panel. Cancel with `AMXB: Cancel Build` or the progress notification.
- **Iterate on one file**: right-click a `.sma` → `AMXB: Compile File` (or `Compile & Deploy File`). The compiler output opens; errors are mapped to the file.
- **Watch**: `AMXB: Toggle Watch` — every saved `.sma` is recompiled, deployed and (if configured) followed by the RCON command. `.inc` changes recompile all depending plugins. Set `deploy.path` / `deploy.rcon` in the manifest or the `AMXB_DEPLOY_*` env vars.
- **Dependencies**: expand the project in the AMXB view → *Dependencies*. The whole dependency tree (nested deps + every dependency's include list) is **preloaded eagerly** when the project opens, so jumping to a file works without expanding anything by hand. Each include file expands into its own `#include` closure (resolved like the compiler does — project dirs, then dependency dirs, then AMXX stdlib). Files that have a canonical entry in a dep's include list are terminal reference nodes — their button reveals the source entry, and deeper nesting is explored from there; files without a source entry expand in place. stdlib/other-dep files are compact cloud nodes whose button reveals the real file, and `⇄` nodes mark cycles. Legacy repos without a manifest show *No manifest*. Right-click a dep → *Show Releases* to pick a new ref (the manifest is updated in place), or *Open on GitHub*.
- **Include graph**: expand a `.sma` under *Plugins* to browse its include closure. Project-local `.inc` files expand recursively (name shown without extension, path relative to `scripting/`); external includes (deps, AMXX stdlib) are compact cloud nodes — their button reveals the concrete include file in the dependency's *Include files* list. Click a `⇄` cycle node (or its button) to reveal the original include. Single-clicking any include opens the file; expanding is via the arrow.
- **External includes**: the section next to *Plugins* is a jump map + stdlib browser. *Dependencies* lists the repos (no include lists — those live 1:1 under *Dependencies* in the tree; clicking a repo reveals it there). *Project (public)* and *AMXX stdlib* list files — stdlib files expand one level to their own includes.
- **A note on resolution**: `amxb`'s `dep-graph.get` misses project-local includes (the project's own `scripting/include` isn't in its search dirs, and nested quoted includes resolve relative to the including file). The extension repairs the graph client-side to match what the compiler actually does, so the tree, diagnostics and hovers agree with the build.
- **Before packaging**: `AMXB: Show Build Plan` to preview what the build will produce; `AMXB: Validate Manifest` to check the manifest.

## Commands

All commands are available from the command palette (`Ctrl+Shift+P` → `AMXB:`); the relevant ones also appear on the AMXB tree, the editor context menu (`.sma` files) and the status bar.

| Command | Description |
|---|---|
| AMXB: Select Project | Switch the active project (root project listed first) |
| AMXB: Build Project | Full build with live progress (`build.start`) |
| AMXB: Cancel Build | Abort the running build (`build.cancel`) |
| AMXB: Show Build Plan | Structured `build.plan` in a webview |
| AMXB: Compile File | Compile the `.sma` with `compile.single` |
| AMXB: Compile & Deploy File | Compile then `deploy.file` the resulting `.amxx` |
| AMXB: Deploy | `deploy.start` of the whole build output |
| AMXB: Send RCON Command… | Quick presets or a custom command (`rcon.send`) |
| AMXB: Toggle Watch | Start/stop watch mode (recompile + deploy + RCON) |
| AMXB: Show Cache Info / Show Compiler Info | `cache.info` / `compiler.info` to the output panel |
| AMXB: Browse AMXX Includes… | Fuzzy-pick a stdlib `.inc` to open |
| AMXB: Show Manifest Overview | Resolved manifest webview |
| AMXB: Validate Manifest | Re-validate the active manifest |

## Settings

| Setting | Default | Description |
|---|---|---|
| `amxb.servePath` | `""` | Explicit path to `amxb` (or to the repo's `serve.js`). Falls back to `PATH`. |
| `amxb.githubToken` | `""` | GitHub token used as a fallback when the manifest defines no token (manifest `github.tokens[owner]` / `github.token_env` take priority; resolved server-side by `amxb serve`). |
| `amxb.build.archive` | `true` | Produce the zip archive on build. |
| `amxb.build.fetch` | `true` | Clone/fetch repositories during build (`false` = cache only). |
| `amxb.smaDiagnostics` | `true` | Missing-include diagnostics for `.sma` files. |
| `amxb.watch.autoRecompile` | `true` | Recompile + deploy + RCON on change while watching. |
| `amxb.watch.debounceMs` | `1000` | Client-side debounce before recompiling after a change. |
| `amxb.pawnExt.syncIncludePaths` | `true` | Feed the include dirs of the dependency versions resolved by `amxb serve` to the `Faktor.amxx-pawn-all-in` extension through its programmatic include-paths API (runtime-only, nothing written to settings or files). Contributed under the `amxb-vscode` id; no-op if the installed extension does not expose the API (see `PAWN_INCLUDE_PATHS_API.md`). |
| `amxb.cacheEditGuard` | `true` | Lock editing of files inside the amxb cache (dependency libraries): edits are reverted and an in-editor banner with an "Allow editing" button is shown until the user explicitly allows editing of that file for the current session. |

## Troubleshooting

**"amxb binary was not found on PATH"** — the extension cannot locate the CLI. Either install it (`npm install -g amxx-builder`), or point the `amxb.servePath` setting at your binary. On Windows, `amxb.cmd` is resolved automatically when installed via npm.

**"Build already running" / "Watch already running"** — `amxb serve` allows one build and one watcher per process; the extension serializes them per project, so this should not normally appear. If it does, restart the window.

**Diagnostics seem missing** — the first `dep-graph.get` / `compile.single` may need to download the AMXX compiler and dependencies (one time). Network-restricted environments should pre-warm the cache with `amxb build` from a terminal.

**Deploy says "Deploy path not configured"** — set `deploy.path` in the manifest or `AMXB_DEPLOY_PATH` in the project `.env`.

## Development

```bash
npm install
npm run build          # esbuild bundle → dist/extension.js
npm run typecheck      # tsc --noEmit
npm test               # node --test (unit + integration; integration skips without amxb)
npm run test:e2e       # real Extension Development Host run (downloads VS Code once)
```

> **Windows ↔ WSL note:** `esbuild` ships a platform-specific binary, so `node_modules` is tied to the platform it was installed on. If the folder is shared between Windows and WSL (e.g. under `/mnt/c`), run `npm install` again after switching platforms before `npm run build`. `tsc` and the pre-built tests are platform-independent.

Press `F5` in VS Code to launch the Extension Development Host. The `amxx-KnifesSystem` folder (next to this repo) is a ready-made AMX Mod X project used as the development workspace. The e2e suite automatically points `amxb.servePath` at an `amxb` binary that supports `serve` (a PATH may contain multiple amxb versions).

## License

MIT
