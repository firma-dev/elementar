import { useState } from 'preact/hooks'
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
  onRename: (key: string, name: string, bank: string) => void
  onDrop: (key: string) => void
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
  onRename,
  onDrop,
}: AccountsProps): JSX.Element | null {
  const [editing, setEditing] = useState<string | null>(null)
  if (list.length === 0) return null

  /**
   * Один счёт — переключать нечего, но назвать его есть чем.
   *
   * Переключатель из одной кнопки раньше не показывался вовсе, и вместе с ним
   * пропадала единственная дверь к имени: банк, угаданный по подписи выгрузки,
   * поправить было негде. Поэтому при одном счёте остаётся строка — имя и
   * «переименовать», без выбора «все счета», которого не из чего делать.
   */
  const only = list.length === 1 ? list[0] : undefined

  const current = list.find((a) => a.key === editing) ?? null
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
        {named < 2 || only !== undefined ? list.map(chip) : null}
        {only === undefined ? null : (
          <button
            type="button"
            class="f-linkish f-linkish--quiet"
            onClick={() => setEditing(editing === only.key ? null : only.key)}
          >
            {editing === only.key ? 'не переименовывать' : 'переименовать'}
          </button>
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

      {active === null ? null : (
        <p class="f-accs__act">
          <button
            type="button"
            class="f-linkish f-linkish--quiet"
            onClick={() => setEditing(editing === active ? null : active)}
          >
            {editing === active ? 'не переименовывать' : 'переименовать'}
          </button>
        </p>
      )}

      {current === null ? null : (
        <form
          class="f-accs__form"
          onSubmit={(event) => {
            event.preventDefault()
            const form = event.currentTarget
            const name = (form.elements.namedItem('name') as HTMLInputElement).value.trim()
            const bank = (form.elements.namedItem('bank') as HTMLInputElement).value.trim()
            if (name !== '') onRename(current.key, name, bank)
            setEditing(null)
          }}
        >
          <label class="f-field">
            <span class="f-field__k">Счёт</span>
            <input name="name" type="text" defaultValue={current.name} maxLength={40} />
          </label>
          <label class="f-field">
            <span class="f-field__k">Банк</span>
            <input name="bank" type="text" defaultValue={current.bank} maxLength={40} />
          </label>
          <div class="f-accs__buttons">
            <button type="submit" class="f-go">
              сохранить
            </button>
            {/* Удаление счёта уносит его операции — поэтому оно красное,
                стоит поодаль от «сохранить» и спрашивает. Цвет и расстояние
                уменьшают вероятность промаха, но не отменяют его: на телефоне
                мимо попадают и по красному. */}
            <Confirm
              label="убрать счёт вместе с операциями"
              question={`убрать «${current.name}» и все его операции?`}
              confirm="да, убрать"
              onConfirm={() => {
                onDrop(current.key)
                setEditing(null)
              }}
            />
          </div>
        </form>
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
