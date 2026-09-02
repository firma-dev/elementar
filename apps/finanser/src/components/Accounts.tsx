import type { JSX } from 'preact'
import type { Account } from '../store.js'
import { Confirm } from './Confirm.js'

export interface AccountsProps {
  list: readonly Account[]
  /** Какой счёт выбран. `null` — все сразу. */
  active: string | null
  /** Сколько операций на каждом счёте: ключ → число. */
  counts: Readonly<Record<string, number>>
  onSelect: (key: string | null) => void
  /** Убрать счёт вместе с его операциями. */
  onDrop: (key: string) => void
  /**
   * Показывать ли «убрать счёт».
   *
   * На сводке — нет: это редкое и необратимое действие, а сводка висит перед
   * глазами каждый день, и опасная кнопка на ней просится под палец. Место ей
   * там же, где остальное хозяйство, — в «подробно».
   */
  removable?: boolean
}

/**
 * Переключатель счетов.
 *
 * При одном счёте не показывается вовсе: переключатель из одной кнопки — это
 * деталь, за которую человек ничего не получает. Появляется со второго счёта,
 * когда различать действительно надо.
 *
 * Цвет у каждого счёта свой и раздан по порядку заведения. Выбирать его
 * человеку не предлагается: работа есть, пользы нет — важно лишь, чтобы два
 * счёта не выглядели одинаково.
 *
 * «Все счета» стоит первым и выбран по умолчанию: вопрос «сколько я трачу»
 * задают про все деньги, а не про одну карту.
 *
 * Переименования здесь больше нет. Имя счёта — это карта, а банк узнаётся по
 * подписи выгрузки: обе строки берутся из самого файла, и править их руками
 * было нечего. Кнопка стояла рядом с единственным счётом и предлагала работу
 * там, где работы нет.
 *
 * Банк — не второй уровень переключения, а подпись над группой. Два уровня
 * стоили бы двух касаний вместо одного, а счетов у человека обычно три-пять:
 * прятать их за банком значило бы платить каждый день за порядок, который
 * виден и так. Подпись появляется, только когда банк назван, и только когда
 * названо больше одного: над единственной группой она ничего не сообщает.
 */
/**
 * Классы тонов перечислены, а не собраны из шаблона.
 *
 * Собранное из шаблона имя класса не найти поиском по коду: ни глазом, ни
 * проверкой, которая следит, чтобы в стилях не оставалось правил, которые
 * никто не рисует. Список из шести строк дешевле такой слепоты.
 */
const TONE = ['f-acc--t0', 'f-acc--t1', 'f-acc--t2', 'f-acc--t3', 'f-acc--t4', 'f-acc--t5'] as const

/**
 * Хвост имени счёта рядом с названием банка: «Карта ·3523» → «·3523».
 *
 * Слово «карта» рядом с именем банка не сообщает ничего: у банка карта и есть
 * то, чем платят. А четыре цифры сообщают, какая именно.
 */
function short(name: string): string {
  const digits = /·\s*(\d{4})\s*$/.exec(name)
  return digits === null ? name : `·${digits[1]}`
}

export function Accounts({
  list,
  active,
  counts,
  onSelect,
  onDrop,
  removable = false,
}: AccountsProps): JSX.Element | null {
  if (list.length === 0) return null

  /**
   * Один счёт — переключать нечего, но назвать его есть чем.
   *
   * Переключатель из одной кнопки раньше не показывался вовсе, и вместе с ним
   * пропадала единственная дверь к нему: убрать счёт было негде. Поэтому при
   * одном счёте строка остаётся — имя и «убрать», без выбора «все счета»,
   * которого не из чего делать.
   */
  const only = list.length === 1 ? list[0] : undefined
  /** Счёт, о котором сейчас идёт речь: единственный или выбранный. */
  const victim = only ?? list.find((account) => account.key === active)

  const groups = groupByBank(list)
  const named = groups.filter((g) => g.bank !== '').length

  const chip = (account: Account): JSX.Element => (
    <button
      key={account.key}
      type="button"
      class={[
        'f-acc',
        TONE[account.tone % TONE.length] ?? TONE[0],
        active === account.key ? 'f-acc--on' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      aria-pressed={active === account.key}
      title={`${account.name}${account.bank === '' ? '' : ` · ${account.bank}`} · ${counts[account.key] ?? 0} операций`}
      onClick={() => onSelect(account.key)}
    >
      <span class="f-acc__dot" aria-hidden="true" />
      {/* Банк и счёт вместе: «Райффайзен ·3523». По отдельности ни то ни
          другое не отвечает на вопрос «чьи это деньги» — «Карта ·3523» не
          говорит, чья карта, а один банк не говорит, какая из его карт. */}
      {account.bank === '' ? account.name : `${account.bank} ${short(account.name)}`}
    </button>
  )

  return (
    <div class="f-accs">
      <div class="f-accs__row" role="group" aria-label="Счета">
        {only === undefined ? (
          <button
            type="button"
            class={active === null ? 'f-acc f-acc--on' : 'f-acc'}
            aria-pressed={active === null}
            onClick={() => onSelect(null)}
          >
            все счета
          </button>
        ) : null}
        {/* Единственный счёт — не кнопка. Нажатие на неё ничего не меняет:
            выбирать не из чего, а жёлтая заливка «выбрано» кричит о состоянии,
            которого нет. Остаётся подпись в той же рамке. */}
        {only !== undefined ? (
          <span class={`f-acc f-acc--label ${TONE[only.tone % TONE.length] ?? TONE[0]}`}>
            <span class="f-acc__dot" aria-hidden="true" />
            {only.bank === '' ? only.name : `${only.bank} ${short(only.name)}`}
          </span>
        ) : named < 2 ? (
          list.map(chip)
        ) : null}

        {/* Убрать счёт — рядом с ним самим, а не в общем меню: убирают всегда
            конкретный, и выбирать его вторым действием из списка было бы
            лишней работой. Появляется, когда счёт один или когда он выбран:
            в остальных случаях непонятно, о котором речь.

            Уносит операции этого счёта, поэтому спрашивает. «Сбросить всё»
            рядом не заменяет: там уходит вся работа, здесь — одна выписка из
            нескольких. */}
        {victim === undefined || !removable ? null : (
          <Confirm
            label="убрать счёт"
            question={`убрать «${victim.name}» и все его операции?`}
            confirm="да, убрать"
            chip
            onConfirm={() => onDrop(victim.key)}
          />
        )}
      </div>

      {named < 2 ? null : (
        <div class="f-accs__banks">
          {groups.map((group) => (
            <div key={group.bank} class="f-accs__bank">
              <span class="f-accs__bankname">{group.bank === '' ? 'без банка' : group.bank}</span>
              {group.list.map(chip)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Счета по банкам. Безымянные — последней группой: они не банк, а «пока не сказано». */
function groupByBank(list: readonly Account[]): Array<{ bank: string; list: Account[] }> {
  const byBank = new Map<string, Account[]>()
  for (const account of list) {
    const group = byBank.get(account.bank) ?? []
    group.push(account)
    byBank.set(account.bank, group)
  }
  const out = [...byBank.entries()].map(([bank, group]) => ({ bank, list: group }))
  return out.sort((a, b) => (a.bank === '' ? 1 : b.bank === '' ? -1 : a.bank.localeCompare(b.bank)))
}
