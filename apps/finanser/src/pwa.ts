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
 * Отпечаток сборки — из имени собственного файла.
 *
 * Модуль приложения назван по содержимому: `index-aJLiL-QX.js`. Хеш из имени
 * меняется ровно тогда, когда меняется сборка, и другого источника этого
 * знания в готовом бандле нет: идентификатор воркера считается уже после того,
 * как бандл записан, и внутрь него не попадает.
 */
function buildStamp(): string {
  const found = /-([A-Za-z0-9_-]{8,})\.js$/.exec(new URL(import.meta.url).pathname)
  return found?.[1] ?? ''
}

/**
 * Регистрация относительная: приложение может стоять по адресу `/финансер/`,
 * а не в корне, и абсолютный путь туда бы не попал. Падение регистрации ничего
 * не ломает — без воркера приложение просто требует сети на первую загрузку.
 *
 * К адресу воркера приписан отпечаток сборки, и это не украшение. Хостинг
 * отдаёт всё, что кончается на `.js`, с `max-age` в сорок пять дней, включая
 * сам `sw.js`. Браузер спрашивает у сервера, не появился ли новый воркер, —
 * и получает старую копию из собственного кэша. Выкладка проходит, файлы на
 * сервере новые, а у человека месяц живёт прежнее приложение, и плашка
 * обновления не появляется, потому что обновления как бы и нет. Проверено на
 * живом сервере: `.htaccess` этого не чинит — статику здесь отдаёт nginx.
 *
 * С отпечатком новая сборка спрашивается по другому адресу, которого в кэше
 * нет и быть не может. `updateViaCache: 'none'` — та же мысль по-другому:
 * не брать воркер из кэша при сверке. Одного его было бы мало для тех, у кого
 * старая копия уже лежит.
 */
export function registerPwa(): void {
  if (!('serviceWorker' in navigator)) return
  globalThis.addEventListener('load', () => {
    const stamp = buildStamp()
    const url = new URL(stamp === '' ? 'sw.js' : `sw.js?v=${stamp}`, document.baseURI)
    void navigator.serviceWorker
      .register(url, { updateViaCache: 'none' })
      .then(watch)
      .catch(() => {})
  })
}
