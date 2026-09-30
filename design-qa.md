# Desktop pre-release design QA

**source visual truth path**

- `/var/folders/h_/d0ws55293h9gg6g6pk5ps2040000gn/T/codex-clipboard-5240bec7-2f00-483a-ba91-a8b98b7b238f.png` — desktop task workbench reference
- `/var/folders/h_/d0ws55293h9gg6g6pk5ps2040000gn/T/codex-clipboard-4d8f0a57-100c-47c0-a1e0-d3cf947ec0b3.png` — future collaboration reference

**implementation screenshot path**

- `/tmp/habor-native.png` — desktop preview capture, 3600 × 2338 px. The content region is judged separately from surrounding macOS/browser chrome.

**state and viewport**

- Desktop dark theme, empty local task state, macOS system locale, 1440 × 900 logical app target.
- The reference contains an active Agent task; this pre-release intentionally shows only the implemented local task state. Agent execution and collaboration are documented as future work.

**Full-view comparison evidence**

- The stable desktop skeleton remains: quiet left navigation, one central task composer, and native titlebar controls.
- The pre-release is calmer than the reference because it removes controls whose backing runtime is not connected yet.
- The composer and recent-task list are the strongest visual focus, with no fake execution cards or status claims.

**Focused region comparison evidence**

- Navigation: New task, Search, Recent tasks, and local quick-start prompts are visible and functional.
- Composer: the input, local-save status, Enter/Shift+Enter behavior, and send action are implemented.
- Native shell: language picker, command palette, menu labels, tray, and window behavior are implemented.

**Required fidelity surfaces**

- Fonts and typography: native system UI stack; task title and composer are strongest, navigation is quieter.
- Spacing and layout rhythm: fixed navigation with a flexible task column and a centered composer.
- Colors and visual tokens: dark neutral shell, peach accent, muted green local-save state, and low-contrast secondary copy.
- Image quality and asset fidelity: no reference imagery is required; Phosphor supplies consistent vector icons.
- Copy and content: visible UI copy describes local task behavior and does not claim Agent execution.

**Findings**

- No actionable P0/P1/P2 visual findings remain for the implemented pre-release scope.

**Open Questions**

- App Server integration will define the future task event, approval, file, diff, verification, model, and collaboration surfaces.

**Implementation Checklist**

- [x] Local task composer and recent task persistence
- [x] Command palette and native menu command events
- [x] Multi-language renderer and native menu labels
- [x] Native Tauri window, tray, and cross-platform shell configuration
- [x] Removed unimplemented Agent, approval, file, diff, verify, model, and collaboration controls

**Follow-up Polish**

- Add live App Server data before reintroducing execution-oriented controls.

**final result: passed**
