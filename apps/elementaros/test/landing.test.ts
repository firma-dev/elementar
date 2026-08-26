import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Проверки лендинга по исходнику.
 *
 * Две вещи ломаются молча и глазом не ловятся. Первая — тезисы: они выверены,
 * и любая правка формулировки должна быть намеренной, а не побочным эффектом
 * вёрстки. Вторая — цвета и отступы мимо токенов: один такой hex не заметен на
 * светлой теме и вылезает на тёмной.
 *
 * Раскладку тесты не проверяют — переносы и ширины остаются за глазом.
 */

const css = readFileSync(new URL('../src/landing.css', import.meta.url), 'utf8')

/** Правила без комментариев: в объяснениях цвета и размеры упоминаются словами. */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '')

/** Вся разметка лендинга одной строкой. */
function readSource(): string {
  const dir = new URL('../src/', import.meta.url)
  let out = ''
  for (const entry of readdirSync(dir)) {
    if (entry.endsWith('.tsx')) out += readFileSync(new URL(entry, dir), 'utf8')
  }
  return out
}

const source = readSource()

/** Текст разметки без тегов: то, что человек прочтёт на экране. */
const text = source
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
  .replace(/\{' '\}/g, ' ')
  .replace(/<[^>]+>/g, '')
  .replace(/\s+/g, ' ')

describe('тезисы', () => {
  // Дословно из брифа. Тест падает не «потому что нельзя», а чтобы правка
  // тезиса была отдельным решением человека.
  const theses = [
    'элементар ос',
    'Среда, спроектированная после ИИ, а не до него.',
    'Чат — пустое поле.',
    'Не спроси что угодно. Сделай вот это.',
    'AGI — это человек плюс нейросеть.',
    'терминал → мышь → супертерминал',
    'Экран — не склад окон. Экран — ответ.',
    'Движок — расходник. Ценность — в корпусе.',
    'Среда собирается из корпусов.',
    'Данные не уезжают в облако.',
    'Среда предлагает. Решает человек.',
    'Один файл. Любая модель. Новый корпус.',
    'ОС не проектируют. Она вырастает.',
    'Среда растёт корпусами. Собери свой.',
    'Начни с работающего.',
  ]

  for (const thesis of theses) {
    it(`на месте: «${thesis}»`, () => {
      expect(text).toContain(thesis)
    })
  }

  it('наборного знака «аƨี» на странице нет', () => {
    // Знак снят по решению человека: тайская огласовка не прилипает к латинской
    // базе, и шейпер рисовал под ней пунктирный кружок-заполнитель. Проверка
    // сторожит возврат — латинская «ƨ» U+01A8 в текстах лендинга не встречается.
    expect(source).not.toContain('\u01A8')
    expect(source).not.toContain('\u0E35')
  })
})

describe('лента', () => {
  it('четырнадцать экранов, пронумерованных подряд', () => {
    const nums = [...source.matchAll(/num="(\d\d)"/g)].map((m) => m[1] ?? '')
    expect(nums).toEqual([
      '00',
      '01',
      '02',
      '03',
      '04',
      '05',
      '06',
      '07',
      '08',
      '09',
      '10',
      '11',
      '12',
      '13',
    ])
  })

  it('у каждого экрана свой якорь', () => {
    const ids = [...source.matchAll(/id="([a-z]+)"/g)].map((m) => m[1] ?? '')
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('логотип стоит на обложке и в финале', () => {
    expect(source.match(/<Logo/g)).toHaveLength(2)
  })

  it('на ленте ровно одно действие, и оно ведёт в финансер', () => {
    // Лента кончается шагом наружу. Двух действий быть не должно: второе
    // отбирает вес у первого, а первое здесь — единственное, ради чего лента
    // написана.
    const links = [...source.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map((m) => m[1] ?? '')
    expect(links).toEqual(['/финансер/'])
  })

  it('копия логотипа для фавиконки совпадает с оригиналом', () => {
    // Знак живёт в корне репозитория (канон §6), разметка берёт его оттуда
    // напрямую. В `public` лежит копия — её видит только тег `icon`, и
    // разойтись с оригиналом она может молча.
    const canon = readFileSync(new URL('../../../elementar.svg', import.meta.url), 'utf8')
    const copy = readFileSync(new URL('../public/elementar.svg', import.meta.url), 'utf8')
    expect(copy).toBe(canon)
  })
})

describe('стили', () => {
  it('цвета только из токенов', () => {
    expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(rules).not.toMatch(/\b(rgba?|hsla?|oklch)\(/)
  })

  it('пиксели — только волосяная линия и брейкпоинты', () => {
    const outsideMedia = rules.replace(/@media[^{]+\{/g, '{')
    const px = [...outsideMedia.matchAll(/(-?[\d.]+)px/g)].map((m) => m[1])
    expect(px.filter((value) => value !== '1')).toEqual([])
  })

  it('тени жёсткие: своих box-shadow нет, только токены', () => {
    for (const shadow of rules.match(/box-shadow:[^;]+;/g) ?? []) {
      expect(shadow).toMatch(/var\(--e-shadow-/)
    }
  })

  it('каждый класс разметки описан в стилях', () => {
    const used = new Set(
      [...source.matchAll(/class="([^"{]+)"/g)].flatMap((m) => (m[1] ?? '').split(/\s+/)),
    )
    for (const name of used) {
      if (name === '') continue
      expect(css, `класс ${name} не описан`).toContain(`.${name}`)
    }
  })
})
