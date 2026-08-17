/**
 * Те же значения токенов, что и в tokens.css, но для JS: theme-color, canvas, QR,
 * брейкпоинты. Значения обязаны совпадать с CSS — расхождение ловит test/contrast.test.ts.
 */

export const bp = { sm: 480, md: 768, lg: 1024, xl: 1280 } as const

export type Breakpoint = keyof typeof bp

/** Значение <meta name="theme-color"> для каждой темы. */
export const themeColor = { light: '#FCFBF9', dark: '#131417' } as const

/** Цвета для растровых поверхностей (canvas, QR), где CSS-переменные недоступны. */
export const canvas = {
  light: { bg: '#FCFBF9', surface: '#FFFFFF', fg: '#221F1B', line: '#DAD5CC' },
  dark: { bg: '#131417', surface: '#191B1F', fg: '#F2F4F7', line: '#2A2E35' },
} as const

/** QR рисуется всегда в максимальном контрасте, вне зависимости от темы. */
export const qr = {
  light: { module: '#221F1B', quiet: '#FCFBF9' },
  dark: { module: '#0E0F11', quiet: '#F2F4F7' },
} as const

export const duration = {
  instant: 80,
  fast: 130,
  base: 200,
  slow: 320,
  sheet: 380,
  toast: 6000,
} as const

/** Порог, после которого показывается скелетон (§11.8). */
export const SKELETON_DELAY_MS = 180

export type ThemeName = keyof typeof themeColor
export type ThemeSetting = ThemeName | 'auto'

/** Ключ в localStorage; тема — свойство устройства, в документе её нет (§11.4). */
export const THEME_STORAGE_KEY = 'e.theme'
