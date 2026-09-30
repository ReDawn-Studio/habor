# habor

> 原生桌面工作台：選擇模型、執行原生 Agent，並在單人與協作任務之間繼續同一個上下文。

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md)

habor 保留程式碼終端的直接感，同時給本機任務草稿一個穩定的桌面工作區。此預發布版只開放本機任務、最近任務、命令面板、語言切換與原生視窗能力。

## 功能

- Tauri 2 + Rust 原生桌面視窗、選單、托盤與 Windows WebView2。
- 本機任務草稿、最近任務與命令面板。
- Tauri 原生視窗、選單、托盤與多語言 UI。
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

桌面端位於 `packages/desktop`。目前只呈現已實作的本機任務與桌面壳能力；模型路由、Agent、核准、檔案、Diff、Verify 和協作會在後續 App Server 接入後加入。

## 驗證

```sh
pnpm test
pnpm --filter @agent-router/desktop test:sites
cargo check --manifest-path packages/desktop/src-tauri/Cargo.toml
```

## 授權

見 [LICENSE](LICENSE)。
