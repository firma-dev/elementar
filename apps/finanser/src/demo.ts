/**
 * Демонстрационная выписка. Прототип дизайн-сессии предлагает «посмотреть на
 * примере годовой выписки» — это она.
 *
 * Данные придуманы и собираются здесь же, детерминированным генератором.
 * Настоящая выписка в демо не кладётся принципиально: демо открыто всем, кто
 * зашёл по ссылке, а выписка — это год чужой жизни.
 *
 * Строится CSV, а не готовые операции: демо проходит ровно тот же путь, что и
 * файл человека, — тот же разбор, те же правила, те же ошибки, если они есть.
 */

const HEADER = 'Дата операции;Дата платежа;Сумма операции;Валюта операции;Описание'

interface Merchant {
  name: string
  min: number
  max: number
}

const MERCHANTS: readonly Merchant[] = [
  { name: 'PYATEROCHKA 5566 MOSCOW', min: 300, max: 3500 },
  { name: 'VKUSVILL 1120', min: 400, max: 2500 },
  { name: 'MAGNIT MM ORION', min: 200, max: 1800 },
  { name: 'YANDEX GO', min: 180, max: 900 },
  { name: 'SURF COFFEE', min: 250, max: 600 },
  { name: 'DODO PIZZA', min: 500, max: 1600 },
  { name: 'OOO ROGA I KOPYTA 1204 MOSCOW RUS', min: 100, max: 4000 },
  { name: 'APTEKA GORZDRAV', min: 200, max: 2400 },
  { name: 'LUKOIL AZS 123', min: 1500, max: 3500 },
  { name: 'OZON RU', min: 300, max: 7000 },
  { name: 'WILDBERRIES', min: 400, max: 6000 },
  { name: 'MOSGORTRANS', min: 60, max: 120 },
  { name: 'LEROY MERLIN', min: 800, max: 9000 },
  { name: 'ZAGADKA TRADE SPB', min: 300, max: 2200 },
  // Ниже — намеренно неопознаваемые имена. Без них «Разбор непонятного» в демо
  // пуст, и человек не видит ни того, что словарь знает не всё, ни того, как
  // это чинится одним движением. Суммы у них небольшие: демо должно показать
  // механизм, а не убедить, что финансер ничего не умеет.
  { name: 'OOO SVETLYJ PUT MOSKVA RUS', min: 200, max: 900 },
  { name: 'IP KOROLEV A A MOSCOW RUS', min: 150, max: 700 },
  { name: 'MASTERSKAYA 12 MOSCOW RUS', min: 300, max: 1200 },
]

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const

/** Линейный конгруэнтный генератор: демо обязано быть одинаковым при каждом показе. */
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function money(kopecks: number): string {
  const sign = kopecks < 0 ? '-' : ''
  const abs = Math.abs(kopecks)
  return `${sign}${Math.trunc(abs / 100)},${String(abs % 100).padStart(2, '0')}`
}

function line(date: string, kopecks: number, description: string): string {
  return `${date};${date.slice(0, 10)};${money(kopecks)};RUB;"${description}"`
}

/** Год выписки в том же виде, в каком её отдаёт банк. */
export function demoCsv(year = 2025): string {
  const random = rng(20260824)
  const rows: string[] = []
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T
  const between = (lo: number, hi: number): number => lo + Math.floor(random() * (hi - lo))

  for (let month = 1; month <= 12; month += 1) {
    const mm = String(month).padStart(2, '0')
    const days = DAYS_IN_MONTH[month - 1] ?? 30

    rows.push(line(`05.${mm}.${year} 09:12`, 18_500_000, 'Зарплата за месяц'))
    rows.push(line(`12.${mm}.${year} 03:11`, -39_900, 'YANDEX PLUS'))
    if (month <= 7) rows.push(line(`18.${mm}.${year} 04:02`, -59_900, 'OKKO PODPISKA'))
    rows.push(line(`20.${mm}.${year} 10:00`, -(720_000 + between(0, 90_000)), 'MOSENERGOSBYT'))
    rows.push(
      line(`24.${mm}.${year} 19:40`, -between(300_000, 900_000), 'Снятие наличных ATM 4417'),
    )

    // Декабрь дороже остальных: в картине года должен быть виден всплеск.
    const boost = month === 12 ? 2.2 : 1
    for (let i = 0; i < between(45, 70); i += 1) {
      const m = pick(MERCHANTS)
      const day = String(between(1, days + 1)).padStart(2, '0')
      const hour = String(between(8, 23)).padStart(2, '0')
      const minute = String(between(0, 60)).padStart(2, '0')
      const sum = Math.round(between(m.min, m.max) * 100 * boost)
      rows.push(line(`${day}.${mm}.${year} ${hour}:${minute}`, -sum, m.name))
    }
  }

  return `${HEADER}\n${rows.join('\n')}\n`
}
