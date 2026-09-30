# habor

> Un espacio de trabajo de escritorio nativo para elegir modelos, ejecutar sus agentes nativos y continuar la misma tarea en Solo y Collaborate.

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md)

## Funciones

- Shell de escritorio multiplataforma con Tauri 2 y Rust
- Conversación, eventos de herramientas, aprobaciones e historial en Solo
- Roles, revisiones, ramas paralelas y retrabajo en Collaborate
- Paneles laterales Files, Diff y Verify
- Interfaz en inglés, chino, japonés, coreano y español

## Inicio rápido

```sh
git clone https://github.com/ReDawn-Studio/habor.git
cd habor
pnpm install --frozen-lockfile
pnpm --filter @agent-router/desktop tauri:dev
```

La implementación de escritorio está en `packages/desktop`. Esta versión valida la interfaz y la base de traducciones; la integración del App Server llegará después.

Consulta el [README en inglés](README.md) para ver la arquitectura y la hoja de ruta.
