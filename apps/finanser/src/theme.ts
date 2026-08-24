/**
 * Тема.
 *
 * Базовая — светлая. Прототип «Финансер v0.dc.html» был светлой бумагой, и
 * тёмную сторону дизайнер глазами не проверял: следовать за настройкой
 * устройства значило показывать половине людей непроверенный вид как
 * основной. Теперь тёмная — выбор, а не умолчание.
 *
 * Палитра не выдумана: она лежит в `tokens.css` блоком `.dark`, написанным
 * вместе со светлым. Своих цветов здесь нет ни одного (Д-017).
 *
 * Инлайн-скрипта в `index.html` нет намеренно: без него CSP обходится без
 * хешей и работает на статик-хостинге, который не даёт править заголовки
 * (Д-012). Плата — возможная вспышка светлого фона у того, кто выбрал тёмную;
 * она короче, чем была бы вспышка тёмного у всех остальных.
 */
import { signal } from '@preact/signals'

const DARK = 'dark'
const KEY = 'f.theme.v1'

/** Выбранная тема. Светлая, пока человек не сказал иначе. */
export const dark = signal(false)

function apply(on: boolean): void {
  document.documentElement.classList.toggle(DARK, on)
}

/** Прочитать выбор человека. Не спросили — светлая. */
export function startTheme(): void {
  let stored: string | null = null
  try {
    stored = globalThis.localStorage?.getItem(KEY) ?? null
  } catch {
    // Приватное окно Safari: работаем со светлой, как и без выбора.
  }
  dark.value = stored === DARK
  apply(dark.value)
}

/** Переключить и запомнить. */
export function toggleTheme(): void {
  dark.value = !dark.value
  apply(dark.value)
  try {
    globalThis.localStorage?.setItem(KEY, dark.value ? DARK : 'light')
  } catch {
    // см. startTheme
  }
}
