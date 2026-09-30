# habor

> モデルとネイティブ Agent を選び、Solo と Collaborate の同じタスクをデスクトップで続けられるネイティブワークベンチです。

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md)

## 特徴

- Tauri 2 と Rust による macOS / Windows / Linux デスクトップシェル
- Solo のストリーミング会話、ツールイベント、承認、履歴タスク
- Collaborate でメンバーの役割、レビュー、並列処理、やり直しを可視化
- Files / Diff / Verify を右側のコンテキストパネルで表示
- 英語、中国語、日本語、韓国語、スペイン語の UI

## クイックスタート

```sh
git clone https://github.com/ReDawn-Studio/habor.git
cd habor
pnpm install --frozen-lockfile
pnpm --filter @agent-router/desktop tauri:dev
```

デスクトップ実装は `packages/desktop` にあります。現在は UI と多言語の基盤を確認するプレビューです。

[English README](README.md) に詳細な構成とロードマップがあります。
