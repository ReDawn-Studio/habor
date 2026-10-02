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
  └─ task composer, streaming conversation, approvals, context panels, team workflow, and language picker
```

The desktop now connects to `packages/app-server`, which reuses the CLI Router, ACP adapters,
provider store, Agent installer, and task state. The implemented surface includes model and
permission selection, streaming task events, approvals, model switching, Files / Diff / Verify,
Agent operations, history recovery, and sequential team workflows.

## Development

```sh
pnpm --filter @agent-router/desktop tauri:dev
```

The browser preview is also available with `pnpm --filter @agent-router/desktop dev` for visual
iteration. The packaged macOS app can be built with:

```sh
pnpm --filter @agent-router/desktop tauri:build -- --bundles app
```

The next integration step is signing and notarizing distribution builds, then adding parallel team
execution with visual branch conditions. The bundled runtime keeps the service protocol as the
boundary between native Rust supervision and the React renderer.

## Languages

The desktop UI includes English, Simplified Chinese, Traditional Chinese, Japanese, Korean, and Spanish. The language picker also offers System, which follows the operating system locale. Catalogs live in `src/locales/`; add the same keys to every catalog when extending the interface.
