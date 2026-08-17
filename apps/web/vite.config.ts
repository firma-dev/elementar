import { defineConfig } from 'vite'
import { elementarPreset } from '@elementar/devkit/vite'
// Прямой путь к env.ts, а не пакетный импорт: конфиг vite грузится нодой напрямую,
// и она не умеет доставать './x.js' из TS-исходников @elementar/proto. Домены по-прежнему
// живут ровно в одном файле (§1.3).
import { API_ORIGIN, WS_ORIGIN } from '../../packages/proto/src/env.ts'

// Одна строка пресета: JSX preact, PWA-плагин, precache с хешами, CSP с хешем темы.
export default defineConfig(
  elementarPreset({
    connectSrc: [API_ORIGIN, WS_ORIGIN],
    version: process.env['ELM_VERSION'] ?? '0.1.0',
    port: 5173,
  }),
)
