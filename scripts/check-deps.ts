/**
 * Проверка графа зависимостей (§2.3). Падение = красный PR.
 * Запуск: npx tsx scripts/check-deps.ts  (или node --experimental-strip-types)
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname

/** Кому что разрешено. Пустой массив = не зависит ни от чего своего. */
const ALLOWED: Record<string, string[]> = {
  '@elementar/proto': [],
  '@elementar/core': ['@elementar/proto'],
  '@elementar/ui': [],
  // llm висит под core по графу §2.3: адаптеры знают про предложения агента
  '@elementar/llm': ['@elementar/proto', '@elementar/core'],
  '@elementar/shell': ['@elementar/core', '@elementar/ui', '@elementar/llm', '@elementar/proto'],
  '@elementar/devkit': [],
  '@elementar/corrector': ['@elementar/core', '@elementar/ui', '@elementar/llm', '@elementar/shell'],
  '@elementar/connector': ['@elementar/core', '@elementar/ui', '@elementar/llm', '@elementar/shell'],
  '@elementar/archiver': ['@elementar/core', '@elementar/ui', '@elementar/llm', '@elementar/shell'],
  // apps/api зависит ТОЛЬКО от proto — иначе появится соблазн расшифровать на сервере
  '@elementar/api': ['@elementar/proto'],
  '@elementar/web': [
    '@elementar/core',
    '@elementar/ui',
    '@elementar/shell',
    '@elementar/llm',
    '@elementar/proto',
    '@elementar/corrector',
    '@elementar/connector',
    '@elementar/archiver',
    '@elementar/devkit',
  ],
}

const errors: string[] = []

function pkgDirs(): string[] {
  const out: string[] = []
  for (const base of ['packages', 'apps']) {
    const dir = join(ROOT, base)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (existsSync(join(p, 'package.json'))) out.push(p)
    }
  }
  return out
}

for (const dir of pkgDirs()) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    name: string
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const allowed = ALLOWED[pkg.name]
  if (!allowed) {
    errors.push(`Пакет ${pkg.name} не описан в графе — добавь его в scripts/check-deps.ts`)
    continue
  }
  const runtime = Object.keys(pkg.dependencies ?? {}).filter((d) => d.startsWith('@elementar/'))
  for (const dep of runtime) {
    if (!allowed.includes(dep)) {
      errors.push(`${pkg.name} → ${dep}: запрещено графом §2.3`)
    }
  }
  // devkit разрешён только как devDependency
  if (runtime.includes('@elementar/devkit')) {
    errors.push(`${pkg.name} → @elementar/devkit должен быть devDependency`)
  }
  // ни один пакет не зависит от apps/*
  for (const dep of runtime) {
    if (dep === '@elementar/web' || dep === '@elementar/api') {
      errors.push(`${pkg.name} → ${dep}: пакеты не могут зависеть от приложений`)
    }
  }
}

// apps/api не должен импортировать core даже в тексте кода
const apiSrc = join(ROOT, 'apps/api/src')
if (existsSync(apiSrc)) {
  const stack = [apiSrc]
  while (stack.length) {
    const cur = stack.pop() as string
    for (const e of readdirSync(cur, { withFileTypes: true })) {
      const p = join(cur, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.name.endsWith('.ts')) {
        const src = readFileSync(p, 'utf8')
        if (src.includes('@elementar/core')) {
          errors.push(`${p}: apps/api импортирует @elementar/core (§2.3 п.7)`)
        }
      }
    }
  }
}

if (errors.length) {
  console.error('Граф зависимостей нарушен:\n' + errors.map((e) => '  · ' + e).join('\n'))
  process.exit(1)
}
console.log('Граф зависимостей в порядке.')
