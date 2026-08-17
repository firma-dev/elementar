import { signal } from '@preact/signals'
import type { ReadonlySignal } from '@preact/signals'

/**
 * Регистрация сервис-воркера и обновление по кнопке (§13.6). Молчаливого обновления нет:
 * человек жмёт «Обновить», перед этим приложение обязано слить outbox.
 */
export type InstallState = 'installed' | 'installable' | 'ios-manual' | 'unsupported'

export interface PwaState {
  updateReady: ReadonlySignal<boolean>
  version: string
  installState: ReadonlySignal<InstallState>
  promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'>
  applyUpdate(): Promise<void>
  dismissUpdate(): void
  /** Что сделать перед перезагрузкой: подключается, когда документ уже открыт. */
  setBeforeApply(fn: (() => Promise<void>) | undefined): void
  /** «Сбросить установленное приложение» (§13.5 п.5): IndexedDB не трогается. */
  resetInstall(): Promise<void>
}

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const CHECK_EVERY_MS = 30 * 60 * 1000

declare const __ELM_VERSION__: string | undefined

function versionOf(): string {
  return typeof __ELM_VERSION__ === 'string' ? __ELM_VERSION__ : 'dev'
}

function isIos(): boolean {
  const ua = globalThis.navigator?.userAgent ?? ''
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && 'ontouchend' in globalThis)
}

function isStandalone(): boolean {
  const nav = globalThis.navigator as Navigator & { standalone?: boolean }
  return (
    globalThis.matchMedia?.('(display-mode: standalone)').matches === true || nav.standalone === true
  )
}

export interface RegisterPwaOptions {
  swUrl?: string
  checkEveryMs?: number
  /** Что сделать перед перезагрузкой: слить outbox и записать снапшот. */
  beforeApply?: () => Promise<void>
}

export function registerPwa(opts: RegisterPwaOptions = {}): PwaState {
  const updateReady = signal(false)
  const installState = signal<InstallState>(
    isStandalone() ? 'installed' : isIos() ? 'ios-manual' : 'unsupported',
  )
  let waiting: ServiceWorker | null = null
  let prompt: InstallPromptEvent | null = null
  let beforeApply = opts.beforeApply

  globalThis.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    prompt = e as InstallPromptEvent
    if (installState.value !== 'installed') installState.value = 'installable'
  })
  globalThis.addEventListener('appinstalled', () => {
    installState.value = 'installed'
    prompt = null
  })

  const sw = globalThis.navigator?.serviceWorker
  if (sw !== undefined && globalThis.isSecureContext) {
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
        setInterval(check, opts.checkEveryMs ?? CHECK_EVERY_MS)
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') check()
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
    version: versionOf(),
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
      const reg = await globalThis.navigator?.serviceWorker?.getRegistration('/')
      await reg?.unregister()
      const keys = await globalThis.caches?.keys()
      for (const key of keys ?? []) await globalThis.caches.delete(key)
    },
  }
}
