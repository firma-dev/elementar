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

/**
 * Год выписки в том же виде, в каком её отдаёт банк.
 *
 * Отрезок кончается сегодняшним днём, а не тридцать первым декабря. Демо
 * должно показывать то же, что покажет настоящая выписка человека, который
 * выгрузил её сегодня: на «дне» и «неделе» там должны быть операции, а не
 * пустой экран с надписью «данные за прошлый год».
 */
export function demoCsv(endsAt = new Date().toISOString().slice(0, 10)): string {
  const random = rng(20260824)
  const rows: string[] = []
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T
  const between = (lo: number, hi: number): number => lo + Math.floor(random() * (hi - lo))

  const end = new Date(`${endsAt}T00:00:00Z`)
  const dd = (date: Date): string => {
    const d = String(date.getUTCDate()).padStart(2, '0')
    const m = String(date.getUTCMonth() + 1).padStart(2, '0')
    return `${d}.${m}.${date.getUTCFullYear()}`
  }
  /** Дата за `back` месяцев до конца, в заданное число месяца. */
  const at = (back: number, day: number): Date => {
    const base = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - back, 1))
    const last = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate()
    return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), Math.min(day, last)))
  }
  const push = (date: Date, kopecks: number, description: string, hour = 12): void => {
    if (date > end) return
    rows.push(line(`${dd(date)} ${String(hour).padStart(2, '0')}:${'12'}`, kopecks, description))
  }

  for (let back = 11; back >= 0; back -= 1) {
    // Приходы: одна регулярная зарплата, кэшбэк каждый месяц и разовый заказ.
    // Разнообразие здесь не украшение — на нём видно, что «Откуда приходит»
    // отличает регулярное от случайного.
    push(at(back, 5), 18_500_000, 'Зарплата за месяц ООО РОГА И КОПЫТА', 9)
    push(at(back, 6), between(40_000, 180_000), 'Кэшбэк за обычные покупки', 3)
    if (back === 4 || back === 9) {
      push(at(back, 17), between(3_000_000, 9_000_000), 'Перевод от Пётр С.', 15)
    }

    // Обязательное и откладываемое.
    push(at(back, 7), -5_000_000, 'Перевод для пополнения счета Накопительный счет', 10)
    push(at(back, 12), -39_900, 'YANDEX PLUS', 3)
    if (back >= 5) push(at(back, 18), -59_900, 'OKKO PODPISKA', 4)
    push(at(back, 20), -(720_000 + between(0, 90_000)), 'MOSENERGOSBYT', 10)
    push(at(back, 24), -between(300_000, 900_000), 'Снятие наличных ATM 4417', 19)

    // Последний месяц дороже: в картине года должен быть виден всплеск, а на
    // коротких периодах — операции, по которым вообще есть что смотреть.
    const boost = back === 0 ? 2.2 : 1
    const days = new Date(
      Date.UTC(at(back, 1).getUTCFullYear(), at(back, 1).getUTCMonth() + 1, 0),
    ).getUTCDate()
    for (let i = 0; i < between(45, 70); i += 1) {
      const m = pick(MERCHANTS)
      const sum = Math.round(between(m.min, m.max) * 100 * boost)
      push(at(back, between(1, days + 1)), -sum, m.name, between(8, 23))
    }
  }

  // Несколько трат за последние дни: иначе «за день» и «за неделю» пусты
  // ровно у того, кто пришёл посмотреть именно на них.
  for (let ago = 6; ago >= 0; ago -= 1) {
    const date = new Date(end.getTime() - ago * 86400000)
    for (let i = 0; i < between(1, 4); i += 1) {
      const m = pick(MERCHANTS)
      push(date, -Math.round(between(m.min, m.max) * 100), m.name, between(8, 23))
    }
  }

  rows.sort()
  return `${HEADER}\n${rows.join('\n')}\n`
}
