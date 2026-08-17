/**
 * PWA: установка приложения и обновление по кнопке (§13.5–13.6 UX-спеки).
 *
 * Молчаливого обновления нет: новый сервис-воркер ставится в `waiting`, человек жмёт
 * «Обновить», и только тогда — `skipWaiting` + перезагрузка. `beforeApply` даёт время
 * слить outbox и записать снапшот перед тем, как страница перезагрузится.
 *
 * `registerPwa` — чистая обвязка вокруг `navigator.serviceWorker`, framework-agnostic
 * (сигналы `@preact/signals-core`, единственная зависимость ядра). `usePwa` — тонкая
 * preact-обёртка сверху; вынесена сюда же, а не в preact.ts, потому что вместе с ней
 * живёт ленивый синглтон регистрации: сервис-воркер на страницу ставится один раз.
 */
import { signal } from '@preact/signals-core'
import type { ReadonlySignal } from '@preact/signals-core'
import { useEffect, useState } from 'preact/hooks'

export type InstallState = 'installed' | 'installable' | 'ios-manual' | 'unsupported'

export interface PwaState {
  readonly updateReady: ReadonlySignal<boolean>
  readonly version: string
  readonly installState: ReadonlySignal<InstallState>
  promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'>
  /** Слить незаписанное (см. `setBeforeApply`), поставить новый воркер и перезагрузиться. */
  applyUpdate(): Promise<void>
  dismissUpdate(): void
  /** Что сделать перед перезагрузкой: подключается, когда документ уже открыт. */
  setBeforeApply(fn: (() => Promise<void>) | undefined): void
  /** «Сбросить установленное приложение»: снять регистрацию и кеш, IndexedDB не трогается. */
  resetInstall(): Promise<void>
}

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const CHECK_EVERY_MS = 30 * 60 * 1000

export interface RegisterPwaOptions {
  /** Путь до сервис-воркера. */
  swUrl?: string
  /** Как часто перепроверять обновление, пока вкладка открыта. */
  checkEveryMs?: number
  /** Версия сборки для диагностики; по умолчанию — `globalThis.__ELM_VERSION__` либо 'dev'. */
  version?: string
  /** Что сделать перед перезагрузкой: слить outbox и записать снапшот. */
  beforeApply?: () => Promise<void>
}

function versionOf(explicit: string | undefined): string {
  if (explicit !== undefined) return explicit
  const g = globalThis as { __ELM_VERSION__?: unknown }
  return typeof g.__ELM_VERSION__ === 'string' ? g.__ELM_VERSION__ : 'dev'
}

function navigatorOf(): (Navigator & { standalone?: boolean }) | undefined {
  return (globalThis as { navigator?: Navigator & { standalone?: boolean } }).navigator
}

function isIos(): boolean {
  const ua = navigatorOf()?.userAgent ?? ''
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && 'ontouchend' in globalThis)
}

function isStandalone(): boolean {
  const mm = (globalThis as { matchMedia?: typeof matchMedia }).matchMedia
  return mm?.('(display-mode: standalone)').matches === true || navigatorOf()?.standalone === true
}

/**
 * Регистрация сервис-воркера и слежение за обновлением. Не бросает исключений в средах
 * без `navigator.serviceWorker` (SSR, тесты, старый Safari без Service Worker) — там
 * `installState` останется 'unsupported', а `updateReady` — вечным `false`.
 */
export function registerPwa(opts: RegisterPwaOptions = {}): PwaState {
  const updateReady = signal(false)
  const installState = signal<InstallState>(
    isStandalone() ? 'installed' : isIos() ? 'ios-manual' : 'unsupported',
  )
  let waiting: ServiceWorker | null = null
  let prompt: InstallPromptEvent | null = null
  let beforeApply = opts.beforeApply

  const win = globalThis as { addEventListener?: typeof addEventListener }
  win.addEventListener?.('beforeinstallprompt', (e) => {
    e.preventDefault()
    prompt = e as InstallPromptEvent
    if (installState.value !== 'installed') installState.value = 'installable'
  })
  win.addEventListener?.('appinstalled', () => {
    installState.value = 'installed'
    prompt = null
  })

  const sw = navigatorOf()?.serviceWorker
  if (sw !== undefined && globalThis.isSecureContext === true) {
    const url = opts.swUrl ?? '/sw.js'
    void sw
      .register(url, { scope: '/', updateViaCache: 'none' })
      .then((reg) => {
        const track = (w: ServiceWorker | null): void => {
          if (w === null) return
          waiting = w
          updateReady.value = true
        }
        if (reg.waiting !== null && sw.controller !== null) track(reg.waiting)
        reg.addEventListener('updatefound', () => {
          const next = reg.installing
          if (next === null) return
          next.addEventListener('statechange', () => {
            if (next.state === 'installed' && sw.controller !== null) track(next)
          })
        })
        const check = (): void => {
          void reg.update().catch(() => undefined)
        }
        const setI = (globalThis as { setInterval?: typeof setInterval }).setInterval
        setI?.(check, opts.checkEveryMs ?? CHECK_EVERY_MS)
        const doc = (globalThis as { document?: Document }).document
        doc?.addEventListener('visibilitychange', () => {
          if (doc.visibilityState === 'visible') check()
        })
      })
      .catch(() => undefined)

    let reloading = false
    sw.addEventListener('controllerchange', () => {
      if (reloading) return
      reloading = true
      globalThis.location.reload()
    })
  }

  return {
    updateReady,
    version: versionOf(opts.version),
    installState,

    async promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
      const p = prompt
      if (p === null) return 'unavailable'
      await p.prompt()
      const choice = await p.userChoice
      prompt = null
      return choice.outcome
    },

    async applyUpdate(): Promise<void> {
      if (beforeApply !== undefined) await beforeApply().catch(() => undefined)
      const w = waiting
      if (w === null) {
        globalThis.location.reload()
        return
      }
      w.postMessage('SKIP_WAITING')
    },

    dismissUpdate(): void {
      updateReady.value = false
    },

    setBeforeApply(fn): void {
      beforeApply = fn
    },

    async resetInstall(): Promise<void> {
      const reg = await navigatorOf()?.serviceWorker?.getRegistration('/')
      await reg?.unregister()
      const caches = (globalThis as { caches?: CacheStorage }).caches
      const keys = await caches?.keys()
      for (const key of keys ?? []) await caches?.delete(key)
    },
  }
}

let singleton: PwaState | null = null

/** Ленивый синглтон: `usePwa` может звать любой компонент, но воркер ставится один раз. */
function pwaSingleton(): PwaState {
  singleton ??= registerPwa()
  return singleton
}

/**
 * Реактивная обёртка над `registerPwa` для preact-компонентов: без `@preact/signals` авто-
 * подписки в JSX нет, поэтому хук сам подписывается на оба сигнала и форсирует ре-рендер —
 * компонент читает `pwa.updateReady.value` / `pwa.installState.value` как обычно.
 */
export function usePwa(): PwaState {
  const state = pwaSingleton()
  const [, setTick] = useState(0)
  useEffect(() => {
    const offReady = state.updateReady.subscribe(() => setTick((n) => n + 1))
    const offInstall = state.installState.subscribe(() => setTick((n) => n + 1))
    return () => {
      offReady()
      offInstall()
    }
  }, [state])
  return state
}
