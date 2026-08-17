export type HapticKind = 'tick' | 'confirm' | 'warn'

const PATTERNS: Record<HapticKind, number | number[]> = {
  tick: 8,
  confirm: [10, 40, 14],
  warn: [22, 60, 22],
}

/**
 * Тактильная отдача там, где она есть (Android/Chrome). iOS Safari vibrate не
 * поддерживает — молча ничего не делаем, интерфейс от этого не зависит.
 */
export function useHaptic(): (kind: HapticKind) => void {
  return (kind: HapticKind): void => {
    if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    navigator.vibrate(PATTERNS[kind])
  }
}
