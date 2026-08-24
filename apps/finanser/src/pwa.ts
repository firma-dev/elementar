/**
 * Сервис-воркер и обновление версии.
 *
 * Правило §13.6: молчаливой подмены нет. Новая версия не встаёт под руками —
 * она ждёт, а человеку показывается плашка. Это не вежливость: подмена под
 * открытой вкладкой сносит кэш со старыми ассетами, и страница белеет (эту
 * гонку мы уже ловили живьём, см. `build/pwa.ts`).
 *
 * Обратная сторона правила — без плашки новая версия доезжала только при
 * холодном запуске, и человек мог неделю сидеть на старой, не зная об этом.
 */
import { signal } from '@preact/signals'

/** Новая версия скачана и ждёт нажатия. */
export const updateReady = signal(false)

let waiting: ServiceWorker | null = null

/** Поставить дождавшуюся версию и перезагрузить страницу. */
export function applyUpdate(): void {
  if (waiting === null) return
  // Ждём смены контролирующего воркера, а не таймера: перезагрузка раньше
  // времени вернёт ту же старую версию, и человек нажмёт ещё раз.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    globalThis.location.reload()
  })
  waiting.postMessage({ type: 'skip-waiting' })
}

function watch(registration: ServiceWorkerRegistration): void {
  const offer = (worker: ServiceWorker | null): void => {
    if (worker === null) return
    waiting = worker
    updateReady.value = true
  }

  // Версия могла дождаться ещё до того, как мы подписались.
  offer(registration.waiting)

  registration.addEventListener('updatefound', () => {
    const installing = registration.installing
    if (installing === null) return
    installing.addEventListener('statechange', () => {
      // `controller` пуст на самой первой установке — тогда это не обновление,
      // а первый приход, и плашку показывать не о чем.
      if (installing.state === 'installed' && navigator.serviceWorker.controller !== null) {
        offer(installing)
      }
    })
  })
}

/**
 * Регистрация относительная: приложение может стоять по адресу `/финансер/`,
 * а не в корне, и абсолютный путь туда бы не попал. Падение регистрации ничего
 * не ломает — без воркера приложение просто требует сети на первую загрузку.
 */
export function registerPwa(): void {
  if (!('serviceWorker' in navigator)) return
  globalThis.addEventListener('load', () => {
    void navigator.serviceWorker
      .register(new URL('sw.js', document.baseURI))
      .then(watch)
      .catch(() => {})
  })
}
