// @vitest-environment happy-dom
import { render } from 'preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CategoryList } from '../src/components/CategoryList.js'
import { Unknown } from '../src/components/Unknown.js'
import { categorizeAll } from '../src/categorize.js'
import type { Categorized, Category, Tx } from '../src/model.js'

/**
 * Тесты вёрстки: компоненты рисуются по-настоящему и проверяются по тому, что
 * оказалось в разметке (Д-021).
 *
 * Раскладка сюда не входит — `happy-dom` её не считает. Проверяется то, что
 * формулируется фактом: отрисовалось ли, с какими значениями, что происходит
 * по нажатию.
 */
let root: HTMLElement

beforeEach(() => {
  document.body.innerHTML = ''
  root = document.createElement('div')
  document.body.appendChild(root)
})

const tx = (date: string, amount: number, description: string): Tx => ({
  id: `${date}-${amount}-${description}`,
  date,
  amount,
  description,
  mcc: null,
  bankCategory: null,
})

const rows: Categorized[] = categorizeAll(
  [
    tx('2026-01-05', -500000, 'PYATEROCHKA 1'),
    tx('2026-01-06', -300000, 'PYATEROCHKA 2'),
    tx('2026-01-07', -100000, 'SURF COFFEE'),
    tx('2026-01-08', -50000, 'OOO ZAGADKA MOSKVA'),
  ],
  {},
)

const totals = [
  { category: 'Продукты' as Category, spend: 800000, count: 2 },
  { category: 'Кафе и рестораны' as Category, spend: 100000, count: 1 },
  { category: 'Прочее' as Category, spend: 50000, count: 1 },
]

describe('список категорий', () => {
  it('полоса доли действительно рисуется', () => {
    // Дорожка была span без display:block, и высота на строчном элементе не
    // действовала: полос не было видно вовсе, а тест бы этого не заметил,
    // проверяй он только текст.
    render(
      <CategoryList
        rows={totals}
        total={950000}
        expanded={null}
        onToggle={() => {}}
        transactionsOf={() => []}
        onOpenAll={() => {}}
      />,
      root,
    )
    const fills = root.querySelectorAll('.f-cat__fill')
    expect(fills).toHaveLength(3)
    for (const fill of fills) {
      // Браузер нормализует запись стиля, поэтому сравниваем по смыслу,
      // а не по строке: важно, что элемент блочный и у него есть ширина.
      const style = fill.getAttribute('style') ?? ''
      expect(style).toMatch(/display:\s*block/)
      expect(style).toMatch(/width:\s*\d+%/)
    }
  })

  it('первая категория выделена акцентом, хвост — не серым из-под порога', () => {
    render(
      <CategoryList
        rows={totals}
        total={950000}
        expanded={null}
        onToggle={() => {}}
        transactionsOf={() => []}
        onOpenAll={() => {}}
      />,
      root,
    )
    const styles = [...root.querySelectorAll('.f-cat__fill')].map(
      (n) => n.getAttribute('style') ?? '',
    )
    expect(styles[0]).toContain('--el__data-negative')
    expect(styles.join(' ')).not.toContain('gray-400')
  })

  it('у строк есть ранг, доля и сумма', () => {
    render(
      <CategoryList
        rows={totals}
        total={950000}
        expanded={null}
        onToggle={() => {}}
        transactionsOf={() => []}
        onOpenAll={() => {}}
      />,
      root,
    )
    expect([...root.querySelectorAll('.f-cat__rank')].map((n) => n.textContent)).toEqual([
      '1',
      '2',
      '3',
    ])
    expect(root.textContent).toContain('84%')
    // Разряды разделяет неразрывный пробел: число не должно рваться по строкам.
    expect(root.textContent).toContain('8\u00A0000')
  })

  it('раскрытие показывает траты и зовёт в выписку, а не уводит сразу', () => {
    const toggle = vi.fn()
    render(
      <CategoryList
        rows={totals}
        total={950000}
        expanded={'Продукты' as Category}
        onToggle={toggle}
        transactionsOf={() => rows.filter((r) => r.category === 'Продукты')}
        onOpenAll={() => {}}
      />,
      root,
    )
    expect(root.querySelectorAll('.f-peek__row')).toHaveLength(2)
    expect(root.querySelector('.f-peek__all')?.textContent).toContain('выписке')
    root.querySelector<HTMLButtonElement>('.f-cat')?.click()
    expect(toggle).toHaveBeenCalledWith(null)
  })
})

describe('разбор непонятного', () => {
  const props = {
    rows,
    totalSpend: 950000,
    named: {},
    onMerchantCategory: () => {},
  }

  it('говорит про выгрузку без кодов и молчит, когда коды есть', () => {
    render(<Unknown {...props} hasCodes={false} />, root)
    expect(root.querySelector('.f-hint')?.textContent).toContain('нет кодов операций')

    document.body.innerHTML = ''
    const second = document.createElement('div')
    document.body.appendChild(second)
    render(<Unknown {...props} hasCodes />, second)
    expect(second.querySelector('.f-hint')).toBeNull()
  })

  it('в каждой строке есть выбор категории со всем списком', () => {
    render(<Unknown {...props} hasCodes />, root)
    const select = root.querySelector('select')
    expect(select).not.toBeNull()
    // Первый пункт — приглашение, дальше весь список категорий.
    expect((select?.options.length ?? 0) > 20).toBe(true)
  })

  it('предлагает категорию по уже названному похожему получателю', () => {
    render(<Unknown {...props} hasCodes named={{ 'ZAGADKA TORG': 'Дети' as Category }} />, root)
    expect(root.querySelector('.f-suggest')?.textContent).toContain('Дети')
  })
})
