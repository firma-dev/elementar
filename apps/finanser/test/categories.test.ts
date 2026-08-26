import { describe, expect, it } from 'vitest'
import { categorizeAll, pendingExtras } from '../src/categorize.js'
import {
  CATEGORIES,
  EXTRA_CATEGORIES,
  MAIN_CATEGORIES,
  MOVE_CATEGORIES,
  PARENT,
  collapse,
  currentName,
} from '../src/model.js'
import type { Tx } from '../src/model.js'

const tx = (description: string, amount = -100000): Tx => ({
  id: description,
  date: '2026-08-10',
  amount,
  description,
  mcc: null,
  bankCategory: null,
  account: 'default',
})

describe('разряды категорий', () => {
  it('основных десять — не больше и не меньше', () => {
    // Двадцать семь сразу это не точность, а работа: выбирая из двадцати семи,
    // человек каждый раз перечитывает список. Десятой стали «Переводы людям»:
    // на настоящей выписке это была самая крупная статья расходов, и до неё
    // она целиком лежала в «Прочем».
    expect(MAIN_CATEGORIES).toHaveLength(10)
  })

  it('каждая категория ровно в одном разряде', () => {
    const main = new Set(MAIN_CATEGORIES)
    const move = new Set(MOVE_CATEGORIES)
    const extra = new Set(EXTRA_CATEGORIES)
    for (const category of CATEGORIES) {
      const where = [main.has(category), move.has(category), extra.has(category)].filter(Boolean)
      expect({ category, разрядов: where.length }).toEqual({ category, разрядов: 1 })
    }
  })

  it('родитель дополнительной категории — включённая, а не такая же выключенная', () => {
    // Иначе свёртка уводила бы в категорию, которой на экране тоже нет.
    const main = new Set<string>(MAIN_CATEGORIES)
    for (const category of EXTRA_CATEGORIES) {
      expect({ category, родитель: PARENT[category] }).toEqual({
        category,
        родитель: [...main].find((m) => m === PARENT[category]),
      })
    }
  })
})

describe('свёртка', () => {
  const none = new Set<string>()

  it('выключенная уходит к родителю', () => {
    expect(collapse('Такси', none)).toBe('Транспорт')
    expect(collapse('Алкоголь', none)).toBe('Продукты')
  })

  it('включённая остаётся собой', () => {
    expect(collapse('Такси', new Set(['Такси']))).toBe('Такси')
  })

  it('основную свернуть некуда', () => {
    expect(collapse('Продукты', none)).toBe('Продукты')
    expect(collapse('Прочее', none)).toBe('Прочее')
  })

  it('деньги не пропадают: свёрнутая трата видна в родительской', () => {
    const rows = categorizeAll([tx('YANDEX GO')], {}, {}, none)
    expect(rows[0]?.category).toBe('Транспорт')
    const split = categorizeAll([tx('YANDEX GO')], {}, {}, new Set(['Такси']))
    expect(split[0]?.category).toBe('Такси')
  })

  it('сказанное человеком не сворачивается никогда', () => {
    // Он выбрал «Дети» — значит различие ему нужно, и показывать вместо него
    // «Покупки» было бы спором с ним же.
    const one = tx('OOO ZAGADKA')
    const rows = categorizeAll([one], { [one.id]: 'Дети' }, {}, none)
    expect(rows[0]?.category).toBe('Дети')
  })
})

describe('цена вопроса', () => {
  it('говорит, сколько операций и денег ждёт за выключенной категорией', () => {
    // Чтобы решение принималось до нажатия, а не после.
    const list = [tx('YANDEX GO', -30000), tx('YANDEX GO 2', -20000), tx('PYATEROCHKA', -90000)]
    const pending = pendingExtras(list, {}, {})
    expect(pending.get('Такси')).toEqual({ count: 2, spend: 50000 })
    // Основные сюда не попадают: их и включать не надо.
    expect(pending.get('Продукты')).toBeUndefined()
  })
})

describe('переименованные категории', () => {
  it('правка, сделанная до переразбивки, находит свою категорию', () => {
    expect(currentName('Связь и интернет')).toBe('Связь и подписки')
    expect(currentName('Продукты')).toBe('Продукты')
    expect(currentName('Выдуманное')).toBe('Прочее')
  })
})
