# habor Desktop

The first desktop shell uses Tauri 2 with a React renderer and a Rust host. It is intentionally
kept separate from the CLI presentation layer so the same task runtime can later serve both entry
points:

```text
Tauri Rust host
  ├─ windows, menus, shortcuts, tray, process supervision
  ├─ secure native commands and filesystem / Git boundary
  └─ Node App Server sidecar
       └─ @agent-router/core + router + adapters + ACP + native agents
React renderer
  └─ local task composer, recent task list, command palette, and language picker
```

The pre-release deliberately exposes only behavior implemented in the shell: local task drafts,
recent task persistence, command navigation, locale selection, native menu labels, and native
window/tray actions. The CLI remains the production Agent surface until the desktop App Server
contract is connected.

## Development

```sh
pnpm --filter @agent-router/desktop tauri:dev
```

The browser preview is also available with `pnpm --filter @agent-router/desktop dev` for visual
iteration. The packaged macOS app can be built with:

```sh
pnpm --filter @agent-router/desktop tauri:build -- --bundles app
```

The next integration step is to package a platform-specific `habor-app-server` Node sidecar and
connect live task events, model routing, approvals, Files, Diff, Verify, and resume actions through
a narrow App Server protocol. Those controls are intentionally absent from this pre-release.

## Languages

The desktop UI includes English, Simplified Chinese, Traditional Chinese, Japanese, Korean, and Spanish. The language picker also offers System, which follows the operating system locale. Catalogs live in `src/locales/`; add the same keys to every catalog when extending the interface.
