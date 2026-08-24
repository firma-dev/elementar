import { readFileSync } from 'node:fs'
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

describe('стиль корпуса', () => {
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

  it('поля ввода на пальце не мельче 16px', () => {
    // Меньше — и iOS Safari увеличивает страницу при фокусе, а смена категории
    // это главное действие на телефоне (DESIGN.md §4.3).
    const coarse = code.match(/@media \(pointer: coarse\)\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(coarse).toContain('select')
    expect(coarse).toContain('font-size: 16px')
    expect(code).toMatch(/\.f-search input\s*\{[^}]*font-size:\s*16px/)
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
