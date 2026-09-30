# habor

> 原生桌面工作台：選擇模型、執行原生 Agent，並在單人與協作任務之間繼續同一個上下文。

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md)

habor 保留程式碼終端的直接感，同時給任務一個穩定的桌面工作區。Solo 用於快速開始，Collaborate 用於加入審查、驗證與成員分工；檔案、Diff、核准和驗證都留在同一個任務內。

## 功能

- Tauri 2 + Rust 原生桌面視窗、選單、托盤與 Windows WebView2。
- Solo 對話、工具活動、核准和歷史任務恢復。
- Collaborate 才顯示成員職責、審查門、平行工作與返工回路。
- 右側 Files、Diff、Verify 上下文面板。
- 英語、簡體中文、繁體中文、日語、韓語、西班牙語。
- `⌘K` / `Ctrl+K` 命令面板。

## 快速開始

```sh
git clone https://github.com/ReDawn-Studio/habor.git
cd habor
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @agent-router/desktop tauri:dev
```

桌面端位於 `packages/desktop`。目前先驗證工作台和多語言互動，Node App Server sidecar 將在下一步接入即時 Router 與 Agent 事件。

## 驗證

```sh
pnpm test
pnpm --filter @agent-router/desktop test:sites
cargo check --manifest-path packages/desktop/src-tauri/Cargo.toml
```

## 授權

見 [LICENSE](LICENSE)。
