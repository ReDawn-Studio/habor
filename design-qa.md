# Desktop workbench design QA

**source visual truth path**

- `/var/folders/h_/d0ws55293h9gg6g6pk5ps2040000gn/T/codex-clipboard-5240bec7-2f00-483a-ba91-a8b98b7b238f.png` — task workbench reference
- `/var/folders/h_/d0ws55293h9gg6g6pk5ps2040000gn/T/codex-clipboard-4d8f0a57-100c-47c0-a1e0-d3cf947ec0b3.png` — collaboration workflow reference

**implementation screenshot path**

- `/tmp/habor-native.png` — current native preview capture, 3600 × 2338 px. The content region is shown at the same dark desktop scale; the surrounding macOS/browser chrome is excluded from the content judgement.

**state and viewport**

- Desktop dark theme, empty Solo task state, macOS system locale, 1440 × 900 logical app target.
- A second implementation state was checked in the accessibility tree: task list, language picker, Collaborate mode, and Files / Diff / Verify controls are present and reachable.
- The reference shows an active task while this iteration intentionally adds the empty new-task state. The persistent shell and task-context anatomy are compared; the empty state is an intentional product extension.

**Full-view comparison evidence**

- The implementation has the same stable desktop skeleton: low-contrast left navigation, a single central task area, and an optional right context panel.
- Current task focus is stronger than the previous card-heavy layout: the empty state uses one prompt, one composer, and three restrained workflow suggestions.
- Collaborate remains a deliberate mode switch; it does not add graph controls to the Solo screen.

**Focused region comparison evidence**

- Navigation: the implementation exposes New task, Search, Teams, Projects, Recent tasks, Workflows, Settings, and Agents & models as compact rows.
- Composer: the implementation keeps model and permission controls inside the composer, with `⌘K` / `Ctrl+K` available in the top bar.
- Context: Files, Diff, and Verify are tabs in a right-side panel and can be opened without leaving the task.
- Workflow: the existing Collaborate canvas preserves role nodes, approval edges, parallel work, and the rework loop from the reference.

**Required fidelity surfaces**

- Fonts and typography: system UI stack is used for native macOS rendering; task title is the strongest text, navigation and metadata are intentionally quieter.
- Spacing and layout rhythm: 256 px navigation, flexible task column, 312 px context panel when open; the empty-state composer is centered with restrained vertical rhythm.
- Colors and visual tokens: the dark neutral shell, peach accent, lavender collaboration accent, and green verification state are carried through CSS tokens and component states.
- Image quality and asset fidelity: no reference imagery is required in this product state; Phosphor provides consistent vector UI icons.
- Copy and content: navigation and visible controls are localized; task and model names remain content strings.

**Findings**

- No actionable P0/P1/P2 visual findings remain for this iteration.

**Open Questions**

- The native sidecar connection and live task state are intentionally outside this visual preview and remain the next integration milestone.

**Implementation Checklist**

- [x] Empty Solo task state with a single focused composer
- [x] AionUI-inspired task-first left navigation
- [x] Optional right context panel for Files / Diff / Verify
- [x] Collaborate-only workflow canvas
- [x] Localized renderer and native menu labels

**Follow-up Polish**

- Add live App Server event data to replace representative task content.
- Add a first-run team setup state when the Teams entry is opened.

**final result: passed**
