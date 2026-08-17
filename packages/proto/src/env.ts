/**
 * Единственное место, где живут домены. Ни один другой файл монорепо не имеет права
 * писать домен литералом: CSP, CORS, ссылки, QR и wrangler.toml берут значения отсюда.
 *
 * ЗАГЛУШКА: боевой домен ещё не выбран. Значения ниже — ASCII-плейсхолдеры
 * на зарезервированном TLD `.example`; при выборе домена меняются ровно здесь.
 * Кириллический домен, если он появится, живёт только как редирект на ASCII-литерал (§1.3).
 */
export const ORIGIN = 'https://elementar.example' // ЗАГЛУШКА
export const API_ORIGIN = 'https://s.elementar.example' // ЗАГЛУШКА
export const WS_ORIGIN = 'wss://s.elementar.example' // ЗАГЛУШКА

/** База REST API (§8.5). */
export const API_BASE = `${API_ORIGIN}/v1`

/** База WebSocket (§8.7). */
export const WS_BASE = `${WS_ORIGIN}/v1`

/**
 * Значение `Access-Control-Allow-Origin`: ASCII-литерал, НИКОГДА не эхо заголовка Origin
 * (§4.8) — эхо открывает чтение любому сайту.
 */
export const ALLOWED_ORIGIN = ORIGIN

/** Префиксы маршрутов дверей на основном домене (§5.1): /p/ — планер, /f/ — финансер. */
export const APP_PREFIX = {
  planer: '/p',
  finanser: '/f',
} as const
export type AppPrefix = (typeof APP_PREFIX)[keyof typeof APP_PREFIX]

/**
 * Постоянная ссылка: `<ORIGIN><prefix>/<docId>#<fragment>`.
 * Фрагмент не отправляется в HTTP-запросе (но остаётся доступен скриптам, §4.7.2 п.3).
 */
export function docUrl(prefix: string, docId: string, fragment: string): string {
  return `${ORIGIN}${prefix}/${docId}#${fragment}`
}
