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
  └─ Solo task workspace, Collaborate workflow, Files / Diff / Verify panels
```

The current preview is a UI-first shell with representative task data. It verifies the desktop
information architecture and interaction model before wiring the Node App Server events into the
renderer. The CLI remains the production task surface while the shared router and adapters are
connected to the desktop host.

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
connect task, event, approval, file, diff, and resume actions through a narrow App Server protocol.
