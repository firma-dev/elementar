/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bp, canvas, themeColor } from '../src/tokens.js'

/**
 * Гейт контраста. Считает WCAG-контраст по НАСТОЯЩЕМУ tokens.css: значения не
 * дублируются в тесте, парсится сам файл. Пороги (§11.2): корпусный текст ≥ 4.5,
 * границы контролов и индикаторы состояния ≥ 3.0, крупный текст ≥ 3.0.
 */

const TOKENS_PATH = new URL('../src/styles/tokens.css', import.meta.url)
const SOURCE = readFileSync(TOKENS_PATH, 'utf8')
const CSS = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '')

type Decl = readonly [prop: string, value: string]
type Block = { selector: string; body: string }
type Vars = ReadonlyMap<string, readonly string[]>
type RGB = readonly [number, number, number]

function splitBlocks(src: string): Block[] {
  const out: Block[] = []
  let i = 0
  while (i < src.length) {
    const open = src.indexOf('{', i)
    if (open < 0) break
    const selector = src.slice(i, open).trim()
    let depth = 1
    let j = open + 1
    while (j < src.length && depth > 0) {
      const ch = src[j]
      if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
      j += 1
    }
    out.push({ selector, body: src.slice(open + 1, j - 1) })
    i = j
  }
  return out
}

function parseDecls(body: string): Decl[] {
  const out: Decl[] = []
  // Только верхний уровень блока: вложенные @media внутри :root не используются.
  for (const raw of body.split(';')) {
    const line = raw.trim()
    if (!line.startsWith('--')) continue
    const colon = line.indexOf(':')
    if (colon < 0) continue
    out.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()])
  }
  return out
}

function collect(decls: readonly Decl[], into: Map<string, string[]>): void {
  for (const [prop, value] of decls) {
    const list = into.get(prop)
    if (list === undefined) into.set(prop, [value])
    else list.push(value)
  }
}

const topBlocks = splitBlocks(CSS)

const baseVars = new Map<string, string[]>()
const lightVars = new Map<string, string[]>()
const darkVars = new Map<string, string[]>()
const darkMediaVars = new Map<string, string[]>()
let darkAttrDecls: Decl[] = []
let darkMediaDecls: Decl[] = []

for (const block of topBlocks) {
  if (block.selector.startsWith('@media')) {
    if (!/prefers-color-scheme:\s*dark/.test(block.selector)) continue
    for (const inner of splitBlocks(block.body)) {
      const decls = parseDecls(inner.body)
      darkMediaDecls = decls
      collect(decls, darkMediaVars)
    }
    continue
  }
  if (block.selector.startsWith('@font-face')) continue
  const decls = parseDecls(block.body)
  if (block.selector === ':root') collect(decls, baseVars)
  else if (block.selector.includes("[data-theme='light']")) collect(decls, lightVars)
  else if (block.selector.includes("[data-theme='dark']")) {
    darkAttrDecls = decls
    collect(decls, darkVars)
  }
}

function themeVars(theme: 'light' | 'dark'): Vars {
  const merged = new Map<string, readonly string[]>(baseVars)
  for (const [k, v] of theme === 'light' ? lightVars : darkVars) merged.set(k, v)
  return merged
}

/* ── Цветовая математика ─────────────────────────────────────────────── */

function parseHex(hex: string): RGB {
  const h = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex
  return [
    Number.parseInt(h.slice(1, 3), 16),
    Number.parseInt(h.slice(3, 5), 16),
    Number.parseInt(h.slice(5, 7), 16),
  ]
}

function toLinear(c: number): number {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

function fromLinear(v: number): number {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055
  return Math.max(0, Math.min(255, Math.round(c * 255)))
}

function relativeLuminance([r, g, b]: RGB): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

function contrast(a: RGB, b: RGB): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

function toOklab([r, g, b]: RGB): RGB {
  const lr = toLinear(r)
  const lg = toLinear(g)
  const lb = toLinear(b)
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

function fromOklab([L, a, b]: RGB): RGB {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ]
}

const MIX_RE = /^color-mix\(in oklab,\s*(.+?)\s+([\d.]+)%,\s*(.+)\)$/

function evaluate(value: string, vars: Vars, seen: ReadonlySet<string>): RGB {
  const v = value.trim()
  if (v.startsWith('#')) return parseHex(v)

  const varMatch = /^var\((--[\w-]+)\)$/.exec(v)
  if (varMatch !== null) {
    const name = varMatch[1]
    if (name === undefined) throw new Error(`битый var(): ${v}`)
    return resolve(name, vars, seen)
  }

  const mix = MIX_RE.exec(v)
  if (mix !== null) {
    const [, aRaw, pctRaw, bRaw] = mix
    if (aRaw === undefined || pctRaw === undefined || bRaw === undefined) {
      throw new Error(`битый color-mix: ${v}`)
    }
    const p = Number.parseFloat(pctRaw) / 100
    const a = toOklab(evaluate(aRaw, vars, seen))
    const b = toOklab(evaluate(bRaw, vars, seen))
    return fromOklab([
      (a[0] ?? 0) * p + (b[0] ?? 0) * (1 - p),
      (a[1] ?? 0) * p + (b[1] ?? 0) * (1 - p),
      (a[2] ?? 0) * p + (b[2] ?? 0) * (1 - p),
    ])
  }

  throw new Error(`не умею вычислять значение: ${v}`)
}

/** Значение токена = последнее объявление (как и в каскаде браузера). */
function resolve(name: string, vars: Vars, seen: ReadonlySet<string> = new Set()): RGB {
  if (seen.has(name)) throw new Error(`циклическая ссылка: ${name}`)
  const list = vars.get(name)
  const value = list?.[list.length - 1]
  if (value === undefined) throw new Error(`токен не объявлен: ${name}`)
  return evaluate(value, vars, new Set([...seen, name]))
}

function ratio(fg: string, bg: string, theme: 'light' | 'dark'): number {
  const vars = themeVars(theme)
  return contrast(resolve(fg, vars), resolve(bg, vars))
}

function hex(name: string, theme: 'light' | 'dark'): string {
  const [r, g, b] = resolve(name, themeVars(theme))
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`.toUpperCase()
}

/* ── Наборы токенов ──────────────────────────────────────────────────── */

const THEMES = ['light', 'dark'] as const

/** Фоны, на которых лежит корпусный текст в покое. */
const RESTING_BG = [
  '--e-bg',
  '--e-surface',
  '--e-surface-raised',
  '--e-surface-hover',
] as const

/** Утопленный фон поля и фон нажатия: там допускается только fg / fg-2. */
const SECONDARY_BG = ['--e-bg-sunken', '--e-surface-active'] as const

const ALL_BG = [...RESTING_BG, ...SECONDARY_BG] as const

/** Токены корпусного текста. */
const BODY_FG = [
  '--e-fg',
  '--e-fg-2',
  '--e-fg-3',
  '--e-accent',
  '--e-success',
  '--e-warning',
  '--e-danger',
  '--e-list-work',
  '--e-list-home',
  '--e-list-hobby',
  '--e-list-craft',
  '--e-agent',
  '--e-actor-a',
  '--e-actor-b',
] as const

const TONES = [
  '--e-accent',
  '--e-success',
  '--e-warning',
  '--e-danger',
  '--e-list-work',
  '--e-list-home',
  '--e-list-hobby',
  '--e-list-craft',
  '--e-agent',
] as const

const BODY_MIN = 4.5
const NON_TEXT_MIN = 3.0

describe('контраст: корпусный текст ≥ 4.5', () => {
  for (const theme of THEMES) {
    for (const fg of BODY_FG) {
      for (const bg of RESTING_BG) {
        it(`${theme}: ${fg} на ${bg}`, () => {
          expect(ratio(fg, bg, theme)).toBeGreaterThanOrEqual(BODY_MIN)
        })
      }
    }
    for (const fg of ['--e-fg', '--e-fg-2'] as const) {
      for (const bg of SECONDARY_BG) {
        it(`${theme}: ${fg} на ${bg}`, () => {
          expect(ratio(fg, bg, theme)).toBeGreaterThanOrEqual(BODY_MIN)
        })
      }
    }
  }
})

describe('контраст: крупный текст, иконки и индикаторы ≥ 3.0', () => {
  for (const theme of THEMES) {
    for (const bg of ALL_BG) {
      // --e-fg-muted допустим только для текста ≥ 24px и иконок (§11.3).
      it(`${theme}: --e-fg-muted на ${bg}`, () => {
        expect(ratio('--e-fg-muted', bg, theme)).toBeGreaterThanOrEqual(NON_TEXT_MIN)
      })
      it(`${theme}: --e-line-focus на ${bg}`, () => {
        expect(ratio('--e-line-focus', bg, theme)).toBeGreaterThanOrEqual(NON_TEXT_MIN)
      })
    }
    // Тональные цвета на утопленном фоне и на фоне нажатия — только иконки и полоски.
    for (const fg of TONES) {
      for (const bg of SECONDARY_BG) {
        it(`${theme}: ${fg} (иконка) на ${bg}`, () => {
          expect(ratio(fg, bg, theme)).toBeGreaterThanOrEqual(NON_TEXT_MIN)
        })
      }
    }
  }
})

describe('контраст: граница контрола ≥ 3.0', () => {
  for (const theme of THEMES) {
    // Фон нажатия исключён сознательно: это кратковременное состояние,
    // граница контрола меряется относительно фонов покоя.
    for (const bg of [...RESTING_BG, '--e-bg-sunken'] as const) {
      it(`${theme}: --e-line-control на ${bg}`, () => {
        expect(ratio('--e-line-control', bg, theme)).toBeGreaterThanOrEqual(NON_TEXT_MIN)
      })
    }
  }
})

describe('контраст: заливки', () => {
  for (const theme of THEMES) {
    for (const bg of ['--e-solid', '--e-solid-hover', '--e-solid-active'] as const) {
      it(`${theme}: --e-solid-fg на ${bg}`, () => {
        expect(ratio('--e-solid-fg', bg, theme)).toBeGreaterThanOrEqual(BODY_MIN)
      })
    }
    it(`${theme}: --e-accent-fg на --e-accent`, () => {
      expect(ratio('--e-accent-fg', '--e-accent', theme)).toBeGreaterThanOrEqual(BODY_MIN)
    })
    for (const tone of TONES) {
      it(`${theme}: --e-fg-on-solid на ${tone}`, () => {
        expect(ratio('--e-fg-on-solid', tone, theme)).toBeGreaterThanOrEqual(BODY_MIN)
      })
    }
  }
})

describe('контраст: тинты', () => {
  for (const theme of THEMES) {
    for (const tone of TONES) {
      const tint = `${tone}-tint`
      it(`${theme}: --e-fg на ${tint}`, () => {
        expect(ratio('--e-fg', tint, theme)).toBeGreaterThanOrEqual(BODY_MIN)
      })
      it(`${theme}: ${tone} (точка/полоска) на ${tint}`, () => {
        expect(ratio(tone, tint, theme)).toBeGreaterThanOrEqual(NON_TEXT_MIN)
      })
    }
  }
})

describe('декоративный hairline остаётся декоративным', () => {
  for (const theme of THEMES) {
    it(`${theme}: --e-line ниже 3:1 и не равен --e-line-control`, () => {
      expect(ratio('--e-line', '--e-bg', theme)).toBeLessThan(NON_TEXT_MIN)
      expect(hex('--e-line', theme)).not.toBe(hex('--e-line-control', theme))
    })
  }
})

describe('измеренные значения из §11.2 не разъезжаются', () => {
  const expected: ReadonlyArray<
    readonly ['light' | 'dark', string, string, number]
  > = [
    ['light', '--e-paper-900', '--e-paper-0', 15.87],
    ['light', '--e-paper-700', '--e-paper-0', 9.13],
    ['light', '--e-paper-600', '--e-paper-0', 4.99],
    ['light', '--e-paper-500', '--e-paper-0', 3.63],
    ['light', '--e-blue-700', '--e-paper-0', 7.9],
    ['light', '--e-steel-600', '--e-paper-0', 5.58],
    ['light', '--e-clay-600', '--e-paper-0', 4.91],
    ['light', '--e-moss-600', '--e-paper-0', 5.21],
    ['light', '--e-plum-600', '--e-paper-0', 5.91],
    ['light', '--e-iris-600', '--e-paper-0', 5.58],
    ['light', '--e-red-600', '--e-paper-0', 6.67],
    ['light', '--e-paper-900', '--e-paper-25', 15.08],
    ['light', '--e-paper-600', '--e-paper-25', 4.74],
    ['dark', '--e-ink-100', '--e-ink-900', 16.72],
    ['dark', '--e-ink-300', '--e-ink-900', 11.42],
    ['dark', '--e-ink-400', '--e-ink-900', 7.78],
    ['dark', '--e-ink-500', '--e-ink-900', 5.86],
    ['dark', '--e-ink-550', '--e-ink-900', 3.53],
    ['dark', '--e-blue-300', '--e-ink-900', 9.74],
    ['dark', '--e-steel-300', '--e-ink-900', 8.2],
    ['dark', '--e-clay-300', '--e-ink-900', 8.28],
    ['dark', '--e-moss-300', '--e-ink-900', 8.88],
    ['dark', '--e-plum-300', '--e-ink-900', 8.15],
    ['dark', '--e-ink-550', '--e-ink-850', 3.3],
  ]

  for (const [theme, fg, bg, value] of expected) {
    it(`${theme}: ${fg} на ${bg} = ${value.toFixed(2)}`, () => {
      expect(ratio(fg, bg, theme)).toBeCloseTo(value, 1)
    })
  }
})

describe('фолбэки к color-mix', () => {
  const withMix = SOURCE.split('\n')
    .map((line, i) => ({ line: line.trim(), i }))
    .filter(({ line }) => line.includes('color-mix('))

  it('в тёмной теме есть хотя бы один color-mix', () => {
    expect(withMix.length).toBeGreaterThan(0)
  })

  // iOS Safari < 16.4 отбрасывает объявление с color-mix целиком (§11.4).
  for (const { line, i } of withMix) {
    const prop = line.slice(0, line.indexOf(':')).trim()
    it(`${prop}: строкой выше стоит статический hex (строка ${i + 1})`, () => {
      const lines = SOURCE.split('\n')
      const previous = (lines[i - 1] ?? '').trim()
      expect(previous).toMatch(new RegExp(`${prop}:\\s*#[0-9a-fA-F]{3,8}\\s*;`))
    })
  }
})

describe('тёмная тема объявлена одинаково для атрибута и для медиазапроса', () => {
  it('[data-theme="dark"] и prefers-color-scheme: dark совпадают', () => {
    expect(darkAttrDecls.length).toBeGreaterThan(30)
    expect(darkMediaDecls).toEqual(darkAttrDecls)
  })
})

describe('tokens.ts не разъезжается с tokens.css', () => {
  it('theme-color соответствует --e-bg каждой темы', () => {
    expect(themeColor.light.toUpperCase()).toBe(hex('--e-bg', 'light'))
    expect(themeColor.dark.toUpperCase()).toBe(hex('--e-bg', 'dark'))
  })

  it('canvas повторяет семантические цвета', () => {
    for (const theme of THEMES) {
      expect(canvas[theme].bg.toUpperCase()).toBe(hex('--e-bg', theme))
      expect(canvas[theme].surface.toUpperCase()).toBe(hex('--e-surface', theme))
      expect(canvas[theme].fg.toUpperCase()).toBe(hex('--e-fg', theme))
      expect(canvas[theme].line.toUpperCase()).toBe(hex('--e-line', theme))
    }
  })

  it('брейкпоинты совпадают с --e-bp-*', () => {
    const values = baseVars
    for (const [name, px] of Object.entries(bp)) {
      const list = values.get(`--e-bp-${name}`)
      expect(list?.[list.length - 1]).toBe(`${px}px`)
    }
  })
})

describe('все семантические токены разрешаются', () => {
  const semantic = [...new Set([...lightVars.keys(), ...darkVars.keys()])].filter(
    (name) =>
      !name.startsWith('--e-shadow') &&
      !name.includes('scrim') &&
      lightVars.has(name) &&
      darkVars.has(name),
  )

  it('в каждой теме объявлен один и тот же набор', () => {
    expect(semantic.length).toBeGreaterThan(30)
    expect([...lightVars.keys()].sort()).toEqual([...darkVars.keys()].sort())
  })

  for (const theme of THEMES) {
    it(`${theme}: var()-цепочки не рвутся`, () => {
      for (const name of semantic) {
        expect(() => resolve(name, themeVars(theme))).not.toThrow()
      }
    })
  }
})
