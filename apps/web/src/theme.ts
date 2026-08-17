import { signal } from '@preact/signals'
import type { ReadonlySignal } from '@preact/signals'
import { THEME_STORAGE_KEY, themeColor } from '@elementar/ui'
import type { ThemeName, ThemeSetting } from '@elementar/ui'

export { THEME_INLINE_SCRIPT } from './theme-inline.js'

function readStored(): ThemeSetting {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY)
    return raw === 'light' || raw === 'dark' ? raw : 'auto'
  } catch {
    return 'auto'
  }
}

const setting = signal<ThemeSetting>(readStored())

export const themeSetting: ReadonlySignal<ThemeSetting> = setting

export function systemTheme(): ThemeName {
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches === true ? 'dark' : 'light'
}

export function effectiveTheme(): ThemeName {
  const s = setting.value
  return s === 'auto' ? systemTheme() : s
}

/** Меняет атрибут на <html> и мета-цвет статус-бара: iOS читает именно его. */
function applyTheme(): void {
  const root = document.documentElement
  const s = setting.value
  if (s === 'auto') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', s)
  const color = themeColor[effectiveTheme()]
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    if (s === 'auto') continue
    meta.setAttribute('content', color)
    meta.removeAttribute('media')
  }
}

export function setTheme(next: ThemeSetting): void {
  setting.value = next
  try {
    if (next === 'auto') localStorage.removeItem(THEME_STORAGE_KEY)
    else localStorage.setItem(THEME_STORAGE_KEY, next)
  } catch {
    // приватный режим: тема просто не переживёт перезагрузку
  }
  applyTheme()
}

export function startTheme(): void {
  applyTheme()
}
