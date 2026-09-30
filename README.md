# habor

> A native desktop workbench for choosing models, running their native agents, and continuing the same task across solo work and collaboration.

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md)

habor keeps the familiar feel of a code terminal while giving local task drafts a durable desktop home. Start a task, continue its instructions, switch languages, and use the command palette without leaving the native window.

## What it does

- **Native desktop shell** — Tauri 2 with a Rust host, native menus, macOS traffic lights, tray support, and Windows WebView2 packaging.
- **Local task workbench** — create a task draft, add instructions, and keep the recent task list on the device.
- **Native shell** — use the Tauri menu, tray, `⌘K` / `Ctrl+K` command palette, and native window behavior.
- **Shared runtime boundary** — the existing CLI, Router, ACP, and native harness integrations remain the production Agent surface.
- **Cross-platform UI** — English, Simplified Chinese, Traditional Chinese, Japanese, Korean, and Spanish are available from the desktop language picker. “System” follows the OS locale.
- **Keyboard-first navigation** — `⌘K` / `Ctrl+K` opens the command palette for switching tasks, views, and context panels.

## Current desktop preview

The first desktop version is available in `packages/desktop`. It is a native Tauri window with a React content area and a Rust system host. This pre-release intentionally exposes only local task drafting, recent task persistence, command navigation, language selection, and native shell actions.

```text
Tauri Rust host
  ├─ native window, menu, shortcut, tray, process boundary
  └─ localized menu labels
React workbench
  ├─ local task composer and recent task list
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

The desktop renderer only owns local task presentation and user intent. Filesystem access, Agent processes, live task events, approvals, model routing, files, diffs, verification, and collaboration stay out of this pre-release until the App Server contract is connected.

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
- [x] Tauri 2 native desktop shell, local task drafts, command palette, and localized UI
- [ ] Connect the desktop App Server sidecar to live task events and session recovery
- [ ] Add model selection and native Agent routing to desktop tasks
- [ ] Add streaming conversation, tools, approvals, Files, Diff, and Verify
- [ ] Add Collaborate mode with member messaging, independent approvals, and saved workflows
- [ ] Reuse the same task state across CLI and desktop windows
- [ ] Package signed macOS, Windows, and Linux releases

## Contributing

Please open an issue with the operating system, task mode, language, and a short reproduction. Pull requests should keep the shared Router contract stable and include the relevant build or test command.

## License

See [LICENSE](LICENSE).
