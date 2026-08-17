export interface ToastOptions {
  message: string
  tone?: 'neutral' | 'success' | 'danger'
  action?: { label: string; onAction: () => void }
  /** 6000; 0 = до закрытия вручную. */
  duration?: number
  /** Одинаковый id → замена, не стопка. */
  id?: string
}

export interface ToastRecord extends ToastOptions {
  id: string
  duration: number
  tone: 'neutral' | 'success' | 'danger'
}

export interface ToastApi {
  show(o: ToastOptions): string
  dismiss(id: string): void
  clear(): void
}

/** Максимум три тоста одновременно (§11.8). */
const MAX_TOASTS = 3
const DEFAULT_DURATION = 6000

let items: readonly ToastRecord[] = []
let seq = 0
const listeners = new Set<(items: readonly ToastRecord[]) => void>()

function emit(): void {
  for (const l of listeners) l(items)
}

export function subscribeToasts(fn: (items: readonly ToastRecord[]) => void): () => void {
  listeners.add(fn)
  fn(items)
  return () => {
    listeners.delete(fn)
  }
}

export function getToasts(): readonly ToastRecord[] {
  return items
}

/** Единственное место для Undo — тост (§11.8). */
export const toast: ToastApi = {
  show(o: ToastOptions): string {
    seq += 1
    const id = o.id ?? `t${seq}`
    const record: ToastRecord = {
      ...o,
      id,
      tone: o.tone ?? 'neutral',
      duration: o.duration ?? DEFAULT_DURATION,
    }
    const existing = items.findIndex((t) => t.id === id)
    if (existing >= 0) {
      const next = items.slice()
      next[existing] = record
      items = next
    } else {
      items = [...items, record].slice(-MAX_TOASTS)
    }
    emit()
    return id
  },
  dismiss(id: string): void {
    const next = items.filter((t) => t.id !== id)
    if (next.length === items.length) return
    items = next
    emit()
  },
  clear(): void {
    if (items.length === 0) return
    items = []
    emit()
  },
}
