# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Product decisions

- This is a native desktop application, not a website. Tauri 2 owns the window and system shell;
  React renders the workspace content inside it.
- Solo mode stays simple and task-focused. Collaboration mode is the only place that expands the
  model responsibility graph and workflow canvas.
- The renderer must not access the filesystem or Agent processes directly. Rust Host commands and
  the future Node App Server sidecar are the boundary for task state, events, approvals, files,
  diffs, and history recovery.
- Preserve the existing CLI and Router packages as the shared runtime contract while the desktop
  surface moves to interactive controls and panels.
- Keep the first screen calm and task-first: New task, Search, Teams, Projects, Recent tasks,
  Workflows, and Settings live in the left navigation. Files, Diff, and Verify open in the right
  context panel without leaving the task; the collaboration graph remains a deliberate mode switch.
- The renderer uses locale catalogs for English, Simplified Chinese, Traditional Chinese, Japanese,
  Korean, and Spanish. The System choice follows the OS locale, stores the preference locally, and
  updates native Tauri menu labels when the command is available.
