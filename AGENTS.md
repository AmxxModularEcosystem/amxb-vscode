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
- `npm run test:e2e` requires: an `amxb` binary on PATH whose `--help` output contains `serve` (the runner picks it and writes `amxb.servePath` into the workspace's `.vscode/settings.json`, cleaning up after), and a test workspace containing `amxbuild.yml` — either the sibling `amxb-vsc-test-workspace/` dir or `~/.cache/amxb-vsc-test/CustomWeaponsAPI`. It downloads VS Code once into `.vscode-test/`.
- F5 "Run Extension" launches with `${workspaceFolder}/../amxb-vsc-test-workspace` as the workspace. The "Extension Tests" F5 config points at `out-test/index`, which esbuild never produces — use `npm run test:e2e` instead.

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
- **Missing serve capability → propose, don't hack.** When a feature needs something `amxb serve` doesn't expose, do NOT build a client-side workaround or fake it. Propose adding the missing method to the `amxb serve` protocol (in the `amxx-builder` repo) instead, and surface that proposal to the user before implementing.

## Protocol quirks

- `src/serve/protocol.ts` shapes are verified against **amxb v1.5.2**; source of truth is `docs/serve/INDEX.md` in the `amxx-builder` repo. JSON-RPC errors surface as `RpcError` (client.ts) and are NOT part of the result types.
- Push notifications: `build.stage` / `build.progress` / `build.compiled`, `watch.changed` (kinds: `sma|inc|file|delete|manifest`).
- **`dep-graph.get` misses project-local includes** (the project's own `scripting/include` isn't in its search dirs; nested quoted includes resolve relative to the including file). The extension repairs the graph client-side via `repairDepGraph` in `src/util/includeResolve.ts` so the tree, diagnostics, and hovers agree with what the compiler actually does. Keep that repair logic consistent when touching include resolution.
- One serve process allows one build and one watcher; `ServeManager` serializes per project.

## Testing conventions

- Unit tests: `node:test` + `node:assert/strict`, written in TS under `test/*.test.ts`. They run in plain Node and MUST NOT import `vscode` (it's external to the bundle and unavailable outside the extension host).
- Integration tests (`test/integration.serve.test.ts`) spawn a real `amxb serve` against the sample project and use `noFetch: true` to avoid network; they're the live verification of `protocol.ts` shapes.
