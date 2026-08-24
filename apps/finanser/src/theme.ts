/**
 * Тёмная тема.
 *
 * Палитра не выдумана: она лежит в `tokens.css` блоком `.dark` — его написал
 * дизайнер вместе со светлым. Прототип «Финансер v0.dc.html» тёмную сторону не
 * включал и, значит, не проверял глазами; поэтому здесь только переключение,
 * ни одного своего цвета (Д-017).
 *
 * Инлайн-скрипта в `index.html` нет намеренно: без него CSP обходится без
 * хешей и работает на статик-хостинге, который не даёт править заголовки
 * (Д-012). Плата — возможная вспышка светлого фона на первом кадре; чтобы её
 * сгладить, `<meta name="color-scheme">` объявлен как `light dark`, и холст под
 * страницей браузер красит сам.
 */

const DARK = 'dark'

function apply(dark: boolean): void {
  document.documentElement.classList.toggle(DARK, dark)
}

/** Следуем настройке устройства. Своего переключателя у v0 нет. */
export function startTheme(): void {
  const media = globalThis.matchMedia?.('(prefers-color-scheme: dark)')
  if (media === undefined) return
  apply(media.matches)
  media.addEventListener('change', (event) => apply(event.matches))
}
