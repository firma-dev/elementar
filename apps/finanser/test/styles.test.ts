import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Правила стиля, проверяемые по исходнику.
 *
 * Здесь не про красоту — про запреты, которые иначе нарушаются молча и
 * замечаются только глазом. Каждый из них уже был нарушён однажды (Д-021).
 *
 * Раскладку эти тесты не проверяют: `happy-dom` её не считает, и обещать
 * обратное было бы неправдой. Ширины колонок и переносы остаются за глазом.
 */
const css = readFileSync(new URL('../src/finanser.css', import.meta.url), 'utf8')
const tokens = readFileSync(new URL('../src/tokens.css', import.meta.url), 'utf8')

/** Правила файла без комментариев: в них цвета упоминаются в объяснениях. */
const code = css.replace(/\/\*[\s\S]*?\*\//g, '')

/** Вся разметка корпуса: по ней проверяется, что класс кем-то используется. */
function readMarkup(): string {
  const root = new URL('../src/', import.meta.url)
  const walk = (dir: URL): string => {
    let out = ''
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir)
      if (entry.isDirectory()) out += walk(child)
      else if (/\.tsx?$/.test(entry.name)) out += readFileSync(child, 'utf8')
    }
    return out
  }
  return walk(root)
}

describe('стиль корпуса', () => {
  it('в файле нет правил, которые никто не рисует', () => {
    // Мёртвые правила копятся незаметно: компонент переписали, класс из
    // разметки ушёл, стиль остался. Через десяток таких файл перестаёт
    // отвечать на вопрос «как это выглядит» — и правки начинают попадать не
    // туда, куда смотрит глаз. Однажды так набралось четыре штуки.
    const markup = readMarkup()
    const used = new Set<string>()
    for (const chunk of markup.match(/['"`\s{]([a-z0-9_ -]*f-[a-z0-9_-]+[a-z0-9_ -]*)['"`\s}]/g) ??
      []) {
      for (const token of chunk.split(/[\s'"`{}]+/)) if (token !== '') used.add(token)
    }
    const declared = new Set(code.match(/\.(f-[a-z0-9_-]+)/g)?.map((m) => m.slice(1)) ?? [])
    expect([...declared].filter((name) => !used.has(name))).toEqual([])
  })

  it('ни одного цвета литералом — только токены', () => {
    // CLAUDE.md, «Запреты»: никаких цветов хардкодом. Литерал переживает смену
    // палитры молча и разводит корпус с дизайн-системой.
    const literals = code.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g) ?? []
    expect(literals).toEqual([])
  })

  it('тени жёсткие: третий аргумент box-shadow всегда ноль', () => {
    // Канон §6, Д-006. Тени берутся из токенов, поэтому в файле корпуса своих
    // box-shadow со значениями быть не должно вовсе.
    // Тени берутся только из токенов: своих значений в файле корпуса нет.
    const own = (code.match(/box-shadow:[^;}]+/g) ?? []).filter(
      (rule) => !rule.includes('var(') && !rule.includes('none'),
    )
    expect(own).toEqual([])
  })

  it('места, которые не должны прыгать, держат высоту', () => {
    // Шапка одна на все шесть отрезков, но подписи в ней разной длины:
    // «Потрачено за год» в одну строку, «Потрачено за три месяца» в две. Без
    // запаса шапка росла на шесть пикселей — и всё, что ниже, уезжало ровно
    // там, где человек нажимает. То же с нижней подписью и с дорожкой.
    for (const selector of ['.f-head2__k', '.f-head2__sub']) {
      const rule = code.match(new RegExp(`\\${selector}\\s*\\{[^}]*\\}`))?.[0] ?? ''
      expect(rule).toMatch(/min-height/)
    }
    // Дорожка есть всегда, даже когда плана нет: появляющаяся дорожка — тот же
    // прыжок, только поменьше.
    expect(code).toMatch(/\.f-head2__track\s*\{[^}]*height:/)
  })

  it('текстовые поля на пальце не мельче 16px', () => {
    // Меньше — и iOS Safari увеличивает страницу при фокусе (DESIGN.md §4.3).
    // Правило касается настоящих полей ввода: только они вызывают фокус-зум.
    expect(code).toMatch(/\.f-search input\s*\{[^}]*font-size:\s*16px/)
  })

  it('на пальце у выбора мишень не меньше пальца', () => {
    // Своя кнопка фокус-зума не вызывает, поэтому мишень набирается высотой,
    // а не кеглем: набранная кеглем, она делала подпись к строке выписки самым
    // крупным текстом на экране.
    const coarse = code.match(/@media \(pointer: coarse\)\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(coarse).toContain('.f-pick__button')
    expect(coarse).toMatch(/min-height/)
    // И заодно кегль здесь не трогается — плотность прототипа остаётся.
    expect(coarse).not.toContain('font-size')
  })

  it('текст набирается смысловым токеном, а не цветом из палитры', () => {
    // Палитра (`--el__color-*`) при смене темы не переворачивается — это просто
    // числа. Смысловые токены (`--el__text`, `--el__text-caption`) переворачиваются.
    // Набранный палитрой текст выглядит правильно ровно в одной теме, а во второй
    // сливается с фоном: gray-700 на gray-900 даёт контраст 1,6:1.
    //
    // Исключение одно: подпись на жёлтом. `--el__mark` жёлтый в обеих темах,
    // поэтому текст на нём обязан быть тёмным в обеих — то есть именно из
    // палитры, а не из смысла.
    const rules = code.match(/[^{}]+\{[^{}]*\}/g) ?? []
    const guilty = rules.filter((rule) => {
      if (!/color:\s*var\(--el__color-/.test(rule)) return false
      return !/background:\s*var\(--el__mark\)/.test(rule)
    })
    expect(guilty).toEqual([])
  })

  it('текст не набирается серым с недостаточным контрастом', () => {
    // gray-400 на белом даёт 2,76:1 при норме 4,5:1. Для графики порог 3:1,
    // поэтому в полосах он тоже не используется — только в тексте это ловится
    // легче всего, и правило записано именно про color.
    expect(code).not.toMatch(/color:\s*var\(--el__color-gray-400\)/)
  })

  it('корпус берёт значения только из своего токен-слоя', () => {
    const used = new Set(css.match(/var\(--el__[a-z0-9-]+/g) ?? [])
    const declared = new Set(tokens.match(/--el__[a-z0-9-]+(?=\s*:)/g) ?? [])
    const missing = [...used]
      .map((v) => v.replace('var(', ''))
      .filter((name) => !declared.has(name))
    expect(missing).toEqual([])
  })
})
