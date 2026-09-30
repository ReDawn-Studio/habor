# habor

> ローカルタスクの下書き、履歴、コマンドパレットを扱うネイティブデスクトップワークベンチです。

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md)

## 特徴

- Tauri 2 と Rust による macOS / Windows / Linux デスクトップシェル
- ローカルタスクの作成、追記、最近のタスク
- Tauri のネイティブウィンドウ、メニュー、トレイ、コマンドパレット
- 英語、中国語、日本語、韓国語、スペイン語の UI

## クイックスタート

```sh
git clone https://github.com/ReDawn-Studio/habor.git
cd habor
pnpm install --frozen-lockfile
pnpm --filter @agent-router/desktop tauri:dev
```

デスクトップ実装は `packages/desktop` にあります。現在は実装済みのローカルタスクとデスクトップシェルだけを公開しています。Agent、承認、ファイル、Diff、Verify、協働機能は App Server 接続後の予定です。

[English README](README.md) に詳細な構成とロードマップがあります。
