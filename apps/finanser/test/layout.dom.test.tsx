// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CategoryList } from '../src/components/CategoryList.js'
import { Unknown } from '../src/components/Unknown.js'
import { Transfers } from '../src/components/Transfers.js'
import { Pick } from '../src/components/Pick.js'
import { pickable } from '../src/model.js'
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
  time: null,
  mcc: null,
  bankCategory: null,
  account: 'default',
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

/** Разбор живёт в свёрнутом разделе: сначала открыть, потом проверять. */
const open = (host: HTMLElement): void => {
  // Состояние хука доезжает до разметки не сразу — `act` дожидается перерисовки.
  act(() => {
    host.querySelector<HTMLButtonElement>('.f-fold__head')?.click()
  })
}

describe('разбор непонятного', () => {
  const props = {
    rows,
    totalSpend: 950000,
    named: {},
    options: pickable(new Set()),
    onMerchantCategory: () => {},
  }

  it('говорит про выгрузку без кодов и молчит, когда коды есть', () => {
    render(<Unknown {...props} hasCodes={false} />, root)
    // Пока раздел закрыт, из него не видно ничего, кроме заголовка.
    expect(root.querySelector('.f-hint')).toBeNull()
    open(root)
    expect(root.querySelector('.f-hint')?.textContent).toContain('нет кодов операций')

    document.body.innerHTML = ''
    const second = document.createElement('div')
    document.body.appendChild(second)
    render(<Unknown {...props} hasCodes />, second)
    open(second)
    expect(second.querySelector('.f-hint')).toBeNull()
  })

  it('в каждой строке есть свой выбор категории, а не нативный select', () => {
    render(<Unknown {...props} hasCodes />, root)
    open(root)
    // Нативного поля здесь быть не должно: его рисует операционная система.
    expect(root.querySelector('select')).toBeNull()
    expect(root.querySelector('.f-pick__button')).not.toBeNull()
    // Список раскрывается только по нажатию — закрытым он ничего не занимает.
    expect(root.querySelector('.f-pick__list')).toBeNull()
    act(() => {
      root.querySelector<HTMLButtonElement>('.f-pick__button')?.click()
    })
    // Не двадцать семь: десять основных и шесть «не трат». Выключенные
    // дополнительные сюда не попадают — их включают отдельным разделом.
    expect(root.querySelectorAll('.f-pick__option')).toHaveLength(16)
  })

  it('предлагает категорию по уже названному похожему получателю', () => {
    render(<Unknown {...props} hasCodes named={{ 'ZAGADKA TORG': 'Дети' as Category }} />, root)
    open(root)
    expect(root.querySelector('.f-suggest')?.textContent).toContain('Дети')
  })
})

describe('выбор', () => {
  const options = ['Продукты', 'Кафе', 'Транспорт']
  const draw = (onChange = (): void => {}): void => {
    render(<Pick value="" options={options} label="Категория" onChange={onChange} />, root)
  }
  const key = (name: string): void => {
    act(() => {
      root
        .querySelector('.f-pick__button')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }))
    })
  }

  it('показывает приглашение, пока ничего не выбрано', () => {
    draw()
    expect(root.querySelector('.f-pick__value')?.textContent).toBe('— выбрать —')
  })

  it('открывается стрелкой и выбирает с клавиатуры', () => {
    const picked = vi.fn()
    draw(picked as unknown as () => void)
    key('ArrowDown')
    expect(root.querySelector('.f-pick__list')).not.toBeNull()
    key('ArrowDown')
    key('Enter')
    // Открылись на первом пункте, шагнули на второй — выбран он.
    expect(picked).toHaveBeenCalledWith('Кафе')
    // После выбора список закрывается сам.
    expect(root.querySelector('.f-pick__list')).toBeNull()
  })

  it('закрывается по Esc, ничего не выбрав', () => {
    const picked = vi.fn()
    draw(picked as unknown as () => void)
    key('ArrowDown')
    key('Escape')
    expect(root.querySelector('.f-pick__list')).toBeNull()
    expect(picked).not.toHaveBeenCalled()
  })

  it('End уводит на последний пункт', () => {
    const picked = vi.fn()
    draw(picked as unknown as () => void)
    key('ArrowDown')
    key('End')
    key('Enter')
    expect(picked).toHaveBeenCalledWith('Транспорт')
  })
})

describe('кому вы переводите', () => {
  const sent = (day: string, amount: number, who: string): Tx =>
    tx(day, amount, `Перевод на номер 0079990000001. Получатель: ${who} Осуществлен через СБП.`)

  const people: Categorized[] = categorizeAll(
    [
      sent('2026-01-03', -6500000, 'Марина Игоревна К.'),
      sent('2026-02-03', -6500000, 'Марина Игоревна К.'),
      sent('2026-02-08', -900000, 'Анна Сергеевна В.'),
      tx('2026-02-09', -500000, 'PYATEROCHKA 1'),
    ],
    {},
    {},
  )

  it('переводы собраны по людям, а покупка сюда не попала', () => {
    act(() => {
      render(
        <Transfers
          rows={people}
          totalSpend={14400000}
          options={pickable(new Set())}
          onMerchantCategory={() => {}}
          onCategory={() => {}}
        />,
        root,
      )
    })
    const names = [...root.querySelectorAll('.f-tr__name')].map((n) => n.textContent ?? '')
    expect(names).toHaveLength(2)
    // Двое, самый крупный сверху; «Пятёрочка» — не перевод и в разделе её нет.
    expect(names[0]).toContain('Марина')
    expect(names.join(' ')).not.toContain('PYATEROCHKA')
  })

  it('категория ставится человеку — одним выбором на все его переводы', () => {
    const named = vi.fn()
    act(() => {
      render(
        <Transfers
          rows={people}
          totalSpend={14400000}
          options={pickable(new Set())}
          onMerchantCategory={named}
          onCategory={() => {}}
        />,
        root,
      )
    })
    act(() => {
      root.querySelector<HTMLButtonElement>('.f-pick__button')?.click()
    })
    const option = [...root.querySelectorAll<HTMLElement>('.f-pick__option')].find(
      (node) => node.textContent?.trim() === 'Жильё и ЖКХ',
    )
    act(() => {
      option?.click()
    })
    expect(named).toHaveBeenCalledTimes(1)
    expect(named.mock.calls[0]?.[1]).toBe('Жильё и ЖКХ')
  })

  it('строка раскрывается, и у каждого перевода свой выбор', () => {
    const one = vi.fn()
    act(() => {
      render(
        <Transfers
          rows={people}
          totalSpend={14400000}
          options={pickable(new Set())}
          onMerchantCategory={() => {}}
          onCategory={one}
        />,
        root,
      )
    })
    act(() => {
      root.querySelector<HTMLButtonElement>('.f-tr__name')?.click()
    })
    // У Марины два перевода — значит две строки внутри.
    expect(root.querySelectorAll('.f-peek__row')).toHaveLength(2)

    act(() => {
      root.querySelector<HTMLButtonElement>('.f-peek__row .f-pick__button')?.click()
    })
    const option = [...root.querySelectorAll<HTMLElement>('.f-pick__option')].find(
      (node) => node.textContent?.trim() === 'Здоровье',
    )
    act(() => {
      option?.click()
    })
    expect(one).toHaveBeenCalledTimes(1)
    expect(one.mock.calls[0]?.[1]).toBe('Здоровье')
  })
})
