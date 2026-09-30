# habor

> A native desktop workbench for choosing models, running their native agents, and continuing the same task across solo work and collaboration.

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md)

habor keeps the familiar feel of a code terminal while giving the task a durable desktop home. Start with one model in **Solo**, add reviewers and verification in **Collaborate**, and inspect files, diffs, approvals, and verification results without leaving the task.

## What it does

- **Native desktop shell** — Tauri 2 with a Rust host, native menus, macOS traffic lights, tray support, and Windows WebView2 packaging.
- **Solo workbench** — start from a clean task composer, stream the conversation, see tool activity, approve actions, and continue a task later.
- **Collaboration workflow** — expose member roles, review gates, parallel work, and rework loops only when the task needs them.
- **Task context** — open Files, Diff, and Verify as a right-side context panel instead of navigating away from the conversation.
- **Native agent routing** — keep the existing CLI, Router, ACP, and native harness integrations as the shared runtime.
- **Cross-platform UI** — English, Simplified Chinese, Traditional Chinese, Japanese, Korean, and Spanish are available from the desktop language picker. “System” follows the OS locale.
- **Keyboard-first navigation** — `⌘K` / `Ctrl+K` opens the command palette for switching tasks, views, and context panels.

## Current desktop preview

The first desktop version is available in `packages/desktop`. It is a native Tauri window with a React content area and a Rust system host. The current preview validates the workbench structure and interactions with representative task data; the Node App Server sidecar is the next integration boundary for live Router and Agent events.

```text
Tauri Rust host
  ├─ native window, menu, shortcut, tray, process boundary
  └─ Node App Server sidecar (integration in progress)
       └─ core + router + adapters + ACP + native agents
React workbench
  ├─ Solo task conversation
  ├─ Collaborate workflow canvas
  └─ Files / Diff / Verify context panels
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

The desktop renderer only owns presentation and user intent. Filesystem access, process supervision, task events, approvals, and future sidecar communication stay behind Rust Host and App Server boundaries.

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
- [x] Tauri 2 native desktop shell and first Solo / Collaborate workbench
- [x] Files, Diff, Verify, approval, command palette, and localized desktop UI preview
- [ ] Connect the desktop App Server sidecar to live task events and session recovery
- [ ] Reuse the same task state across CLI and desktop windows
- [ ] Add full member messaging, independent approvals, and saved collaboration templates
- [ ] Package signed macOS, Windows, and Linux releases

## Contributing

Please open an issue with the operating system, task mode, language, and a short reproduction. Pull requests should keep the shared Router contract stable and include the relevant build or test command.

## License

See [LICENSE](LICENSE).
