# habor

> Un espacio de trabajo de escritorio nativo para crear borradores de tareas locales, consultar tareas recientes y usar una paleta de comandos.

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md)

## Funciones

- Shell de escritorio multiplataforma con Tauri 2 y Rust
- Borradores de tareas locales y tareas recientes
- Ventana, menú, bandeja y paleta de comandos nativos con Tauri
- Interfaz en inglés, chino, japonés, coreano y español

## Inicio rápido

```sh
git clone https://github.com/ReDawn-Studio/habor.git
cd habor
pnpm install --frozen-lockfile
pnpm --filter @agent-router/desktop tauri:dev
```

La implementación de escritorio está en `packages/desktop`. Esta versión solo publica el shell y las tareas locales ya implementadas; Agent, aprobaciones, archivos, Diff, Verify y colaboración llegarán después de conectar el App Server.

Consulta el [README en inglés](README.md) para ver la arquitectura y la hoja de ruta.
