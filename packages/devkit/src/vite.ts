import type { PluginOption, UserConfig } from 'vite'
import { elementarPwa } from './pwa-plugin.ts'
import type { PwaPluginOptions } from './pwa-plugin.ts'

export { elementarPwa } from './pwa-plugin.ts'
export type { PwaPluginOptions } from './pwa-plugin.ts'
export { buildCsp, headersFile, inlineScriptHashes } from './pwa-plugin.ts'

/** Группа модулей в отдельный чанк: имя и что в него попадает. */
export interface ChunkGroup {
  name: string
  test?: RegExp | string
}

export interface ElementarPresetOptions extends PwaPluginOptions {
  /** Ручные группы чанков. Заданы — автоматическая нарезка rolldown отключается. */
  chunkGroups?: readonly ChunkGroup[]
  /** Корень приложения (там, где index.html). */
  root?: string
  outDir?: string
  /** Выключить PWA целиком (для юнит-сборок). */
  pwa?: boolean
  plugins?: PluginOption[]
  port?: number
}

/**
 * Vite-пресет Элементара: preact-JSX без React, современный таргет, PWA-плагин.
 * Приложение подключает его одной строкой: `export default defineConfig(elementarPreset({…}))`.
 */
export function elementarPreset(options: ElementarPresetOptions = {}): UserConfig {
  const pwa = options.pwa !== false
  const plugins: PluginOption[] = [...(options.plugins ?? [])]
  if (pwa) {
    const {
      root: _root,
      outDir: _outDir,
      pwa: _pwa,
      plugins: _plugins,
      port: _port,
      chunkGroups: _chunkGroups,
      ...pwaOptions
    } = options
    plugins.push(elementarPwa(pwaOptions))
  }

  return {
    ...(options.root === undefined ? {} : { root: options.root }),
    appType: 'spa',
    plugins,
    oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
    resolve: {
      // одна копия preact на всё дерево: две ломают контекст и сигналы
      dedupe: ['preact', 'preact/hooks', '@preact/signals', '@preact/signals-core'],
    },
    server: {
      ...(options.port === undefined ? {} : { port: options.port }),
      host: true,
    },
    preview: options.port === undefined ? {} : { port: options.port },
    build: {
      outDir: options.outDir ?? 'dist',
      target: 'es2022',
      cssTarget: 'safari16',
      sourcemap: true,
      assetsInlineLimit: 0,
      // без preload-ссылок: rolldown кладёт в них весь динамический граф, и ленивые
      // чанки (агент, календарь, настройки) уезжали бы в первую отрисовку (§12.11)
      modulePreload: false,
      rollupOptions: {
        output: {
          entryFileNames: 'assets/[name]-[hash].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
          // Ручные группы — только по требованию: заданные группы у rolldown отменяют
          // автоматическую нарезку, и всё остальное схлопывается во входной чанк.
          ...(options.chunkGroups === undefined || options.chunkGroups.length === 0
            ? {}
            : { advancedChunks: { groups: [...options.chunkGroups] } }),
        },
      },
    },
  }
}

export default elementarPreset
