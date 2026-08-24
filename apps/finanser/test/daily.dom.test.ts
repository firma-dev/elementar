// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { parseStatementText } from '../src/statement.js'
import {
  accounts,
  addStatement,
  categorized,
  dropAccount,
  forgetEverything,
  setCategory,
  transactions,
} from '../src/store.js'

/**
 * Ежедневная петля: выгрузил — открыл — разобрал — завтра выгрузил снова.
 *
 * Это единственный сценарий, ради которого корпус вообще может стать
 * ежедневным, и он же тот, который раньше был сломан: ключ выписки менялся при
 * каждой новой выгрузке, и всё загруженное задваивалось (Д-026).
 */
const HEAD = 'Дата операции;Сумма операции;Описание\n'

const day = (date: string, sum: string, what: string): string => `${date};${sum};${what}\n`

const monday =
  HEAD + day('05.01.2026', '-300,00', 'SURF COFFEE') + day('06.01.2026', '-900,00', 'PYATEROCHKA')
const tuesday = monday + day('07.01.2026', '-450,00', 'OOO ZAGADKA')

function load(csv: string, file = 'operations.csv'): void {
  const result = parseStatementText(csv, file)
  addStatement(result.transactions, {
    name: file,
    rows: result.rows,
    skipped: result.skipped,
    converted: result.converted,
    foreign: result.foreign,
    loadedAt: '2026-01-07',
    hasCodes: result.hasCodes,
    key: file,
    balance: result.balance,
    accounts: result.accounts,
  })
}

beforeEach(() => {
  forgetEverything()
})

describe('ежедневная петля', () => {
  it('вторая выгрузка того же счёта добавляет новое, а не задваивает старое', () => {
    load(monday)
    expect(transactions.value).toHaveLength(2)
    load(tuesday)
    expect(transactions.value).toHaveLength(3)
  })

  it('ручная правка переживает следующую выгрузку', () => {
    // Ради этого всё и затевалось: человек разобрал непонятное сегодня, а
    // завтра выгрузил заново — разобранное должно остаться разобранным.
    load(monday)
    const coffee = categorized.value.find((tx) => tx.description === 'SURF COFFEE')
    expect(coffee).toBeDefined()
    setCategory(coffee?.id ?? '', 'Подарки')

    load(tuesday)
    const again = categorized.value.find((tx) => tx.description === 'SURF COFFEE')
    expect(again?.category).toBe('Подарки')
    expect(again?.source).toBe('manual')
  })

  it('та же выписка, поданная десять раз подряд, ничего не меняет', () => {
    for (let i = 0; i < 10; i += 1) load(tuesday)
    expect(transactions.value).toHaveLength(3)
  })
})

describe('счета', () => {
  it('разные файлы заводят разные счета', () => {
    load(monday, 'дебетовая.csv')
    load(monday, 'кредитная.csv')
    expect(accounts.value).toHaveLength(2)
    // Одинаковые покупки с двух карт не схлопываются: иначе пропадают деньги.
    expect(transactions.value).toHaveLength(4)
  })

  it('счёт убирается вместе со своими операциями и не трогает чужие', () => {
    load(monday, 'дебетовая.csv')
    load(tuesday, 'кредитная.csv')
    const credit = accounts.value.find((a) => a.name === 'кредитная')
    dropAccount(credit?.key ?? '')
    expect(accounts.value).toHaveLength(1)
    expect(transactions.value).toHaveLength(2)
  })
})
