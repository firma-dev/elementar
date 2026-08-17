import type { Slot, Tone } from '@elementar/ui'

/** Общая структура пунктов: TabBar и Rail — две проекции одного списка (§11.9). */
export interface NavItem {
  id: string
  label: string
  icon?: Slot
  badge?: number | 'dot'
  tone?: Tone
}

export function badgeText(badge: number | 'dot' | undefined): string | null {
  if (badge === undefined) return null
  if (badge === 'dot') return ''
  if (badge <= 0) return null
  return badge > 99 ? '99+' : String(badge)
}
