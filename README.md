# habor

> A native desktop workbench for choosing models, running their native agents, and continuing the same task across solo work and collaboration.

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md)

habor keeps the familiar feel of a code terminal while giving the same Router task a durable desktop home. Choose a real native Agent, stream its work, approve actions, inspect files and diffs, switch models, and continue the task from the desktop or CLI.

## What it does

- **Native desktop shell** — Tauri 2 with a Rust host, native menus, macOS traffic lights, tray support, and Windows WebView2 packaging.
- **Task workbench** — create trusted workspace tasks, select a real model and native Agent, stream events, approve actions, and resume history.
- **CLI parity at the service boundary** — the desktop reuses the CLI's Router, ACP adapters, provider store, Agent installer, authentication status, task affinity, and recovery state.
- **Files, Diff, Verify** — inspect workspace files safely, read the current Git diff, and run an explicitly selected package verification script.
- **Team workflows** — assign member roles and models, pass messages between members, run a sequential review workflow, and save reusable templates.
- **Native shell** — use the Tauri menu, tray, `⌘K` / `Ctrl+K` command palette, and native window behavior.
- **Shared runtime boundary** — the existing CLI, Router, ACP, and native harness integrations remain the production Agent surface.
- **Cross-platform UI** — English, Simplified Chinese, Traditional Chinese, Japanese, Korean, and Spanish are available from the desktop language picker. “System” follows the OS locale.
- **Keyboard-first navigation** — `⌘K` / `Ctrl+K` opens the command palette for switching tasks, views, and context panels.

## Current desktop preview

The first desktop version is available in `packages/desktop`. It is a native Tauri window with a React content area, a Rust system host, and a Node App Server sidecar. The sidecar is the shared service boundary for the desktop and CLI runtime.

```text
Tauri Rust host
  ├─ native window, menu, shortcut, tray, process boundary
  └─ localized menu labels and sidecar supervision
Node App Server
  ├─ Router + ACP + native Agent sessions
  ├─ task state, approvals, model switching, and history recovery
  ├─ workspace files, Git diff, verification, and team workflows
  └─ provider configuration and Agent install/auth operations
React workbench
  ├─ model / permission task composer
  ├─ streaming conversation, approvals, and execution activity
  ├─ Files / Diff / Verify context panels
  └─ team members, role handoff, and workflow templates
  ├─ command palette
  └─ six locale catalogs
```

## Quick start

Requirements: Node.js 22.19 or newer, pnpm 11, and Rust stable for the native shell.

```sh
git clone https://github.com/ReDawn-Studio/habor.git
cd habor
pnpm install --frozen-lockfile
pnpm build
```

Run the existing CLI:

```sh
pnpm habor
```

Run the desktop preview in a browser:

```sh
pnpm --filter @agent-router/desktop dev
```

The existing terminal workflow and model / Agent commands remain documented in [CLI guide](docs/cli.md).

Run the native desktop app on macOS, Windows, or Linux:

```sh
pnpm --filter @agent-router/desktop tauri:dev
```

Build a macOS app bundle:

```sh
pnpm --filter @agent-router/desktop tauri:build -- --bundles app
```

## Project structure

```text
packages/
├── core/       shared Agent, Session, Event, and Workspace contracts
├── router/     model-to-harness routing, task affinity, and state
├── adapters/   native ACP clients and legacy bridges
├── cli/        habor terminal client
├── dsh-acp/    DeepSeek Harness ACP server
└── desktop/    Tauri 2 shell and React workbench
```

The desktop renderer only owns presentation and user intent. Filesystem access, Agent processes, task events, approvals, model routing, files, diffs, verification, and collaboration go through the App Server boundary; the renderer never accesses them directly.

## Language support

The UI is localized through small JSON catalogs in `packages/desktop/src/locales/`. New translations should cover the same interaction keys as English, preserve product and model names, and add a README in the language list above. The language preference is stored locally and applies without restarting the window.

## Validation

```sh
pnpm test
pnpm --filter @agent-router/desktop test:sites
cargo check --manifest-path packages/desktop/src-tauri/Cargo.toml
```

## Roadmap

- [x] Shared Router, ACP, native Agent adapters, and CLI task state
- [x] Tauri 2 native desktop shell, App Server sidecar, command palette, and localized UI
- [x] Model selection, native Agent routing, streaming task events, approvals, and task recovery
- [x] Files, Git Diff, verification scripts, model switching, provider state, and Agent operations
- [x] Collaborate mode with member roles, handoff messages, sequential workflows, and templates
- [x] Bundle a Node runtime and the App Server into the desktop application
- [ ] Sign and notarize distribution builds
- [ ] Add parallel team execution and visual branching conditions
- [ ] Package signed macOS, Windows, and Linux releases

## Contributing

Please open an issue with the operating system, task mode, language, and a short reproduction. Pull requests should keep the shared Router contract stable and include the relevant build or test command.

## License

See [LICENSE](LICENSE).
