import { createLogger, defineConfig } from 'vite'
import { elementarPreset } from '@elementar/devkit/vite'
import { dropUnusedFonts, finanserPwa } from './build/pwa.ts'

/**
 * Финансер v0 герметичен (Д-012): в графе приложения нет `@elementar/proto`,
 * значит нет и ни одного домена. PWA-плагин девкита выключен — он пишет
 * абсолютные пути в precache, а финансер должен открываться и по адресу
 * `/финансер/`; вместо него свой воркер с относительными путями.
 *
 * `base: './'` — по той же причине: ассеты адресуются относительно страницы,
 * а не корня сайта.
 */
/**
 * Гасим ровно одно предупреждение: `@font-face` Basis приходит из общего файла
 * дизайн-системы с абсолютными путями, `dropUnusedFonts` выбрасывает эти правила
 * целиком, но vite успевает пожаловаться на пути раньше. Предупреждение ложное
 * и постоянное — а постоянное ложное предупреждение хуже, чем никакого:
 * рядом с ним перестают читать настоящие.
 */
const logger = createLogger()
const passthrough = { warn: logger.warn.bind(logger), warnOnce: logger.warnOnce.bind(logger) }
const isFalseAlarm = (message: string): boolean => message.includes('/fonts/basis-')
logger.warn = (message, options): void => {
  if (!isFalseAlarm(message)) passthrough.warn(message, options)
}
logger.warnOnce = (message, options): void => {
  if (!isFalseAlarm(message)) passthrough.warnOnce(message, options)
}

export default defineConfig({
  ...elementarPreset({ pwa: false, port: 5174 }),
  base: './',
  customLogger: logger,
  plugins: [
    dropUnusedFonts('Basis Grotesque Pro'),
    finanserPwa({ version: process.env['ELM_VERSION'] ?? '0.1.0' }),
  ],
})
