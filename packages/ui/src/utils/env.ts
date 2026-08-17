/** Дев-режим определяется по хосту: сборочных env-переменных в пакете нет. */
export function isDev(): boolean {
  if (typeof location === 'undefined') return false
  const h = location.hostname
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.local')
}

const warned = new Set<string>()

/** Предупреждение печатается один раз на сообщение. */
export function warnOnce(message: string): void {
  if (!isDev() || warned.has(message)) return
  warned.add(message)
  console.warn(`[@elementar/ui] ${message}`)
}
