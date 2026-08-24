/**
 * Выгрузка JSON (ТЗ §2 п.6): человек не заперт внутри финансера. Файл собирается
 * в памяти вкладки и отдаётся через blob: — ни одного запроса наружу.
 */
import type { Categorized } from './model.js'
import type { SourceInfo } from './store.js'

export interface ExportShape {
  format: 'elementar.finanser'
  version: 1
  source: SourceInfo | null
  /** Суммы в копейках — тот же вид, в котором они считались. */
  units: 'kopeck'
  transactions: Array<{
    id: string
    date: string
    amount: number
    description: string
    mcc: string | null
    bankCategory: string | null
    category: string
    source: Categorized['source']
  }>
}

export function buildExport(list: readonly Categorized[], source: SourceInfo | null): ExportShape {
  return {
    format: 'elementar.finanser',
    version: 1,
    source,
    units: 'kopeck',
    transactions: list.map((tx) => ({
      id: tx.id,
      date: tx.date,
      amount: tx.amount,
      description: tx.description,
      mcc: tx.mcc,
      bankCategory: tx.bankCategory,
      category: tx.category,
      source: tx.source,
    })),
  }
}

/** Сохранение файла. Ссылка живёт ровно до клика и отзывается сразу после. */
export function downloadJson(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
