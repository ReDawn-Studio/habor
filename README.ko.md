# habor

> 로컬 작업 초안, 최근 작업, 명령 팔레트를 제공하는 네이티브 데스크톱 워크벤치입니다.

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md)

## 주요 기능

- Tauri 2와 Rust 기반 macOS / Windows / Linux 데스크톱 셸
- 로컬 작업 생성, 추가 지시, 최근 작업 목록
- Tauri 네이티브 창, 메뉴, 트레이, 명령 팔레트
- 영어, 중국어, 일본어, 한국어, 스페인어 UI

## 빠른 시작

```sh
git clone https://github.com/ReDawn-Studio/habor.git
cd habor
pnpm install --frozen-lockfile
pnpm --filter @agent-router/desktop tauri:dev
```

데스크톱 구현은 `packages/desktop`에 있습니다. 현재는 구현된 로컬 작업과 데스크톱 셸만 공개합니다. Agent, 승인, 파일, Diff, Verify, 협업 기능은 App Server 연결 이후의 계획입니다.

자세한 구조와 로드맵은 [English README](README.md)를 참고하세요.
