# habor

> 모델과 네이티브 Agent를 선택하고 Solo와 Collaborate에서 같은 작업을 계속하는 네이티브 데스크톱 워크벤치입니다.

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md)

## 주요 기능

- Tauri 2와 Rust 기반 macOS / Windows / Linux 데스크톱 셸
- Solo 스트리밍 대화, 도구 이벤트, 승인, 작업 기록
- Collaborate에서 멤버 역할, 리뷰, 병렬 처리, 재작업 흐름 표시
- Files / Diff / Verify 오른쪽 컨텍스트 패널
- 영어, 중국어, 일본어, 한국어, 스페인어 UI

## 빠른 시작

```sh
git clone https://github.com/ReDawn-Studio/habor.git
cd habor
pnpm install --frozen-lockfile
pnpm --filter @agent-router/desktop tauri:dev
```

데스크톱 구현은 `packages/desktop`에 있습니다. 현재는 UI와 다국어 기반을 검증하는 프리뷰입니다.

자세한 구조와 로드맵은 [English README](README.md)를 참고하세요.
