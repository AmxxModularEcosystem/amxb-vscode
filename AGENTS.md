# AGENTS.md

VS Code extension (`amxb-vscode`) that is a client for the `amxb serve` JSON-RPC protocol of [`amxx-builder`](https://github.com/AmxxModularEcosystem/amxx-builder). Everything flows through one `amxb serve` child process per project manifest over stdio (line-delimited JSON-RPC 2.0). The README documents features/settings — this file covers what it doesn't.

## Commands

```bash
npm run build        # esbuild: dist/extension.js + out-test/*.test.js (also copies test/fixtures)
npm run typecheck    # tsc --noEmit (covers src/ + test/)
npm run watch        # esbuild --watch for extension AND tests
npm test             # node --test out-test/*.test.js — runs the BUILD OUTPUT, not src/
npm run test:e2e     # real Extension Development Host via @vscode/test-electron
npx @vscode/vsce package  # builds via vscode:prepublish → npm run build
```

- **Tests run from `out-test/`, which esbuild generates.** After editing a `.ts` test, run `npm run build` (or `watch`) before `npm test`, or you're running stale bundles. `out-test/` and `dist/` are gitignored.
- `npm test` is self-contained: unit tests use `test/fixtures/fake-serve.js` as a fake serve server; integration tests (`integration.serve.test.ts`) **self-skip** unless an `amxb` binary is on PATH AND a sample project exists (see Test project below).
- `npm run test:e2e` requires: an `amxb` binary on PATH whose `--help` output contains `serve` (the runner picks it and writes `amxb.servePath` into the workspace's `.vscode/settings.json`, cleaning up after), and a test workspace containing `amxbuild.yml` — either the sibling `amxx-KnifesSystem/` dir or `~/.cache/amxb-vsc-test/CustomWeaponsAPI`. It downloads VS Code once into `.vscode-test/`.
- F5 "Run Extension" launches with `${workspaceFolder}/../amxx-KnifesSystem` as the workspace. The "Extension Tests" F5 config points at `out-test/index`, which esbuild never produces — use `npm run test:e2e` instead.

## Windows ↔ WSL

This repo is shared into WSL (`/mnt/c`). `esbuild` ships a **platform-specific binary**, so `node_modules` only works on the platform where `npm install` ran. After switching Windows/WSL, re-run `npm install` before `npm run build`. `tsc` and the prebuilt tests are platform-independent.

## TypeScript conventions (enforced by tsconfig)

- `verbatimModuleSyntax` — type-only imports MUST use `import type { ... }`. Bare value imports of types fail typecheck.
- `exactOptionalPropertyTypes` — never assign `undefined` to an optional property; omit it instead.
- `noUncheckedIndexedAccess` — indexed access yields `T | undefined`; narrow before use.

## Architecture

- **Entry**: `src/extension.ts` `activate()` wires everything: a `ServeManager` (one `amxb serve` process per manifest, spawned with `cwd = project root`), a `ProjectStore` (manifest detection), and ~16 feature modules. All disposables are pushed to `ctx.subscriptions`; `manager.stopAll()` on dispose.
- **`src/serve/`**: `binary.ts` (resolution: `amxb.servePath` setting → PATH; a `.js` path runs via `node`; `.cmd`/`.bat` needs `shell: true`), `client.ts` (JSON-RPC transport — requests never block the stdout reader so push notifications keep flowing; `request()` with `timeoutMs: 0` disables timeout for long calls like `build.start`), `manager.ts`, `protocol.ts` (every method's result type), `methods.ts` (typed method wrappers — always pass the absolute `manifest` path explicitly).
- **`src/manifest/`**: `detector.ts` finds `amxbuild.yml`/`amxbuild.yaml`/`manifest.yml` (workspace root is primary; subdirs scanned recursively) and keeps the store in sync via file watchers; `store.ts` implements `ProjectStore`.
- **`src/features/*.ts`**: each exports `register(ctx: vscode.ExtensionContext, deps: FeatureDeps): vscode.Disposable[]`. Per `src/core/types.ts`: feature modules MUST NOT modify `extension.ts`, `package.json`, `src/core`, `src/serve`, `src/util`, or `src/manifest`. New commands/settings also need `package.json` `contributes` entries.
- **`src/util/`**: `includeResolve.ts` (client-side include-graph repair), `parseCompiler.ts`, `yamlLine.ts`, `manifestSearch.ts`, `output.ts`.

## Design conventions

- **The extension is a thin client — it MUST NOT contain manifest/project logic.** All manifest and project information is pulled from `amxb serve` RPC methods (`manifest.validate`, `manifest.resolve`, `deps.tree`, `include.*`, `dep-graph.get`, `releases.list`, `cache.info`, `compiler.info`, …). Never reimplement manifest parsing, dependency resolution, or project state client-side. The only client-side code that touches project data is presentation glue for server output: `yamlLine.ts` (JSON-pointer → YAML line mapping so diagnostics land on the right line) and `parseCompiler.ts` (compiler text output → diagnostics). `repairDepGraph` is the single sanctioned workaround, for a known `dep-graph.get` gap (see Protocol quirks).
- **Missing serve capability → propose, don't hack.** When a feature needs something `amxb serve` doesn't expose, do NOT build a client-side workaround or fake it (no direct GitHub API calls from the extension, no client-side repo catalogs). Write a serve-method proposal (see "Proposing amxb serve features") and surface it to the user before implementing.

## Proposing amxb serve features

`amxb` is the user's own project (the `amxb` binary on PATH may be a local fork, e.g. `~/Desktop/amxmdox-server-builder` — check with `readlink -f $(which amxb)`). Protocol gaps are **not** hacked around client-side; they are proposed as structured method requests that the user implements in amxb.

- **Where**: proposals live in `.omo/serve-method-requests/` (this repo). `README.md` there documents the conventions; each new/changed method gets its own file (`repos-info.md`, `releases-list-fixes.md`, …).
- **Content of each proposal**: purpose, params (name/type/required/default), result shape (verbatim JSON), error contract (codes + `error.data`), token resolution, client usage, implementation hints. Match the style of `docs/serve/INDEX.md` in the amxb repo (that doc is the protocol source of truth).
- **Workflow**: 1) write the proposal in `.omo/serve-method-requests/` and surface it to the user; 2) user implements it in amxb and updates `docs/serve/INDEX.md`; 3) client code reads the **actual** documented shapes, never the proposal's wishful thinking; 4) verify empirically against a real `amxb serve` process (`serve.ping` first — cold start can be slow; keep stdin open until the response arrives) before wiring the feature; 5) then implement the client side (types in `src/serve/protocol.ts`, wrappers in `src/serve/methods.ts`, feature in `src/features/`).
- **Token model for repo-scoped methods**: manifest per-owner `github.tokens[owner]` → manifest `github.token_env` (default `GITHUB_TOKEN`) → explicit `token` param (client fallback setting) → anonymous. Client-side there is no token logic at all — the client passes the absolute `manifest` path (and optionally a `token` from a fallback setting) and serve resolves.
- **404 semantics**: GitHub returns 404 for both nonexistent and private/inaccessible repos, indistinguishable even with a token. New methods return `{ exists: false, reason: "not_found_or_no_access" }` as a **success** result; errors (`-32603`) carry `error.data = { status, repo, message }` so the client distinguishes rate limits from other failures without parsing message text.

## Protocol quirks

- `src/serve/protocol.ts` shapes are verified against **amxb v1.5.2**; source of truth is `docs/serve/INDEX.md` in the `amxx-builder` repo. JSON-RPC errors surface as `RpcError` (client.ts) and are NOT part of the result types.
- Push notifications: `build.stage` / `build.progress` / `build.compiled`, `watch.changed` (kinds: `sma|inc|file|delete|manifest`).
- **`dep-graph.get` misses project-local includes** (the project's own `scripting/include` isn't in its search dirs; nested quoted includes resolve relative to the including file). The extension repairs the graph client-side via `repairDepGraph` in `src/util/includeResolve.ts` so the tree, diagnostics, and hovers agree with what the compiler actually does. Keep that repair logic consistent when touching include resolution.
- One serve process allows one build and one watcher; `ServeManager` serializes per project.

## Testing conventions

- Unit tests: `node:test` + `node:assert/strict`, written in TS under `test/*.test.ts`. They run in plain Node and MUST NOT import `vscode` (it's external to the bundle and unavailable outside the extension host).
- Integration tests (`test/integration.serve.test.ts`) spawn a real `amxb serve` against the sample project and use `noFetch: true` to avoid network; they're the live verification of `protocol.ts` shapes.
