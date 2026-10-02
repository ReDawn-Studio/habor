# Desktop workbench design QA

**source visual truth path**

- `/var/folders/h_/d0ws55293h9gg6g6pk5ps2040000gn/T/codex-clipboard-5240bec7-2f00-483a-ba91-a8b98b7b238f.png` — desktop task workbench reference
- `/var/folders/h_/d0ws55293h9gg6g6pk5ps2040000gn/T/codex-clipboard-4d8f0a57-100c-47c0-a1e0-d3cf947ec0b3.png` — future collaboration reference

**implementation screenshot path**

- `/tmp/habor-native.png` — desktop preview capture, 3600 × 2338 px. The content region is judged separately from surrounding macOS/browser chrome.

**state and viewport**

- Desktop dark theme, trusted workspace / empty task state, macOS system locale, 1440 × 900 logical app target.
- The reference contains an active Agent task; the implementation now reaches the same state through the App Server after a workspace is trusted and a model is selected.

**Full-view comparison evidence**

- The stable desktop skeleton remains: quiet left navigation, one central task composer, and native titlebar controls.
- The implementation keeps execution controls inside the task and reveals context panels only when requested.
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
- Copy and content: visible UI copy distinguishes workspace trust, model availability, native Agent status, and execution state.

**Findings**

- No actionable P0/P1/P2 visual findings remain for the implemented desktop scope.

**Open Questions**

- The App Server remains the live runtime boundary; release packaging should continue to verify that its bundled Node runtime is present.

**Implementation Checklist**

- [x] Local task composer and recent task persistence
- [x] Command palette and native menu command events
- [x] Multi-language renderer and native menu labels
- [x] Native Tauri window, tray, and cross-platform shell configuration
- [x] Agent, approval, file, diff, verify, model, and collaboration controls are backed by App Server calls

**Follow-up Polish**

- Add live App Server data before reintroducing execution-oriented controls.

**final result: passed**
