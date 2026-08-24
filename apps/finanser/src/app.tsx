import { useCallback, useMemo, useRef, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import type { Category } from './model.js'
import { dayLabel, monthLabel, monthOf } from './model.js'
import { parseStatement, parseStatementText } from './tbank.js'
import type { ParseResult } from './tbank.js'
import { byCategory, byMonth, byPlane } from './stats.js'
import { formatShare } from './money.js'
import { buildExport, downloadJson } from './export.js'
import { demoCsv } from './demo.js'
import {
  categorized,
  compute,
  forgetEverything,
  hasData,
  setCategory,
  setMerchantCategory,
  setStatement,
  source,
  summary,
} from './store.js'
import { Amount } from './components/Amount.js'
import { MonthChart } from './components/MonthChart.js'
import { MoneyMoves } from './components/MoneyMoves.js'
import { CategoryList } from './components/CategoryList.js'
import { Unknown } from './components/Unknown.js'
import { TxList } from './components/TxList.js'
import { SummaryView } from './components/SummaryView.js'

/** Два экрана: картина года и выписка. Операции — второй шаг, а не вкладка. */
type View = 'year' | 'txs'

export function App(): JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<View>('year')
  const [month, setMonth] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [category, setCategoryFilter] = useState<Category | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const rows = categorized.value

  const accept = useCallback((result: ParseResult, name: string): void => {
    if (result.error !== null) {
      setError(result.error)
      return
    }
    if (result.transactions.length === 0) {
      setError('В файле не нашлось ни одной операции.')
      return
    }
    setStatement(result.transactions, {
      name,
      rows: result.rows,
      skipped: result.skipped,
      converted: result.converted,
      loadedAt: new Date().toISOString().slice(0, 10),
      hasCodes: result.hasCodes,
    })
    setView('year')
    setMonth(null)
    setCategoryFilter(null)
    setError(null)
  }, [])

  const load = useCallback(
    async (file: File): Promise<void> => {
      setBusy(true)
      setError(null)
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        accept(parseStatement(bytes), file.name)
      } catch {
        setError('Файл не удалось прочитать. Нужен CSV — выгрузка операций из Т-Банка.')
      } finally {
        setBusy(false)
      }
    },
    [accept],
  )

  const onPick = useCallback(
    (event: JSX.TargetedEvent<HTMLInputElement>): void => {
      const file = event.currentTarget.files?.[0]
      if (file !== undefined) void load(file)
      event.currentTarget.value = ''
    },
    [load],
  )

  const loadDemo = useCallback((): void => {
    accept(parseStatementText(demoCsv()), 'пример выписки')
  }, [accept])

  // График строится всегда по году: он навигатор, а не итог.
  const months = useMemo(() => byMonth(rows), [rows])
  const yearPlanes = useMemo(() => byPlane(rows), [rows])

  /**
   * Разрез — то, о чём сейчас идёт разговор: весь период или один месяц.
   * Год и месяц не показываются одновременно: иначе на экране две таблицы
   * категорий, и человек складывает их глазами, получая двойную сумму.
   */
  const scope = useMemo(
    () => (month === null ? rows : rows.filter((tx) => monthOf(tx.date) === month)),
    [rows, month],
  )
  const planes = useMemo(() => byPlane(scope), [scope])
  const cats = useMemo(() => byCategory(scope), [scope])

  const visible = useMemo(
    () => (category === null ? scope : scope.filter((tx) => tx.category === category)),
    [scope, category],
  )

  const inCategory = useCallback(
    (c: Category) => scope.filter((tx) => tx.category === c && tx.amount < 0),
    [scope],
  )

  const info = source.value
  const period = useMemo(() => {
    const first = rows[rows.length - 1]
    const last = rows[0]
    if (first === undefined || last === undefined) return ''
    return `${dayLabel(first.date)} — ${dayLabel(last.date)}`
  }, [rows])

  const fileInput = (
    <input ref={fileRef} type="file" accept=".csv,.txt" class="f-sr" onChange={onPick} />
  )

  const header = (
    <header class="f-head">
      <div class="f-head__name">финансер</div>
      <div class="f-head__note">корпус Элементара · v0</div>
    </header>
  )

  if (!hasData.value) {
    return (
      <main class="f-page">
        {header}
        <div class="f-empty">
          <h1 class="f-empty__title">
            Куда ушли деньги за <span class="f-mark">год</span>
          </h1>
          <p class="f-empty__lead">
            Финансер читает выписку Т-Банка, отделяет траты от переездов денег и показывает картину
            года. Всё считается прямо в браузере — данные не покидают устройство.
          </p>

          <button
            type="button"
            class="f-cta"
            aria-disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            {busy ? 'Читаю…' : 'Загрузить выписку — CSV'}
          </button>

          {error === null ? null : <p class="f-err">{error}</p>}

          <section class="f-howto">
            <h2 class="f-eyebrow f-eyebrow--quiet f-howto__title">Как выгрузить</h2>
            <ol>
              <li>
                <span>1</span>
                <span>Приложение Т-Банка → нужный счёт</span>
              </li>
              <li>
                <span>2</span>
                <span>
                  «Выписки и справки» → выписка операций за год, формат CSV. Если банк предлагает
                  полную выгрузку операций — берите её: в ней есть коды, и категории определяются
                  точнее
                </span>
              </li>
              <li>
                <span>3</span>
                <span>Откройте файл здесь</span>
              </li>
            </ol>
          </section>

          <p class="f-demo">
            <button type="button" class="f-linkish" onClick={loadDemo}>
              Посмотреть на примере годовой выписки →
            </button>
          </p>

          <p class="f-note f-hermetic">
            Страница герметична: ни одного внешнего запроса, скрипта или счётчика. Загруженное
            хранится только в этом браузере.
          </p>
        </div>
        {fileInput}
      </main>
    )
  }

  const sourceLine = (
    <div class="f-source">
      <span class="f-source__period">{period}</span>
      <span class="f-source__file">
        {info === null
          ? ''
          : `${info.name} · ${rows.length} операций${info.skipped > 0 ? ` · пропущено ${info.skipped}` : ''}`}
      </span>
      <button type="button" class="f-linkish" onClick={() => fileRef.current?.click()}>
        новая
      </button>
    </div>
  )

  const footer = (
    <footer class="f-foot">
      Выписка и правки лежат в хранилище этого браузера и никуда не отправляются. На общем
      компьютере так делать не стоит —{' '}
      <button
        type="button"
        class="f-linkish"
        onClick={() => {
          forgetEverything()
          setMonth(null)
          setCategoryFilter(null)
          setView('year')
        }}
      >
        забыть всё
      </button>
      .
    </footer>
  )

  if (view === 'txs') {
    const total = visible.reduce((sum, tx) => sum + tx.amount, 0)
    return (
      <main class="f-page">
        {header}
        {sourceLine}
        <div class="f-txhead">
          <button type="button" class="f-linkish" onClick={() => setView('year')}>
            ← картина года
          </button>
          {month === null && category === null ? null : (
            <div class="f-txhead__filters">
              <span class="f-chip">{category ?? monthLabel(month ?? '')}</span>
              <button
                type="button"
                class="f-chipoff"
                onClick={() => {
                  setMonth(null)
                  setCategoryFilter(null)
                }}
              >
                сброс ×
              </button>
            </div>
          )}
        </div>
        <p class="f-txcount">
          {visible.length} операций · итог <Amount value={total} kopecks="never" plus />
        </p>
        <TxList rows={visible} onCategory={setCategory} />
        {footer}
        {fileInput}
      </main>
    )
  }

  return (
    <main class="f-page">
      {header}
      {sourceLine}

      <div class="f-tiles">
        <div class="f-tile f-tile--main">
          <span class="f-tile__k">
            {month === null ? 'Траты за период' : `Траты · ${monthLabel(month)}`}
          </span>
          <Amount class="f-tile__v" value={planes.spend.total} kopecks="never" />
          {month === null ? null : (
            <span class="f-tile__sub">
              {formatShare(planes.spend.total, yearPlanes.spend.total)}% года
            </span>
          )}
        </div>
        <div class="f-tile">
          <span class="f-tile__k">Поступления</span>
          <Amount class="f-tile__v f-tile__v--in" value={planes.income.total} kopecks="never" />
        </div>
      </div>

      <MonthChart
        months={months}
        selected={month}
        hovered={hovered}
        onSelect={setMonth}
        onHover={setHovered}
      />

      <div class="f-scope">
        <h2 class="f-eyebrow">
          {month === null ? 'Траты по категориям' : `Траты по категориям · ${monthLabel(month)}`}
        </h2>
        {month === null ? null : (
          <button type="button" class="f-linkish" onClick={() => setMonth(null)}>
            ← весь период
          </button>
        )}
      </div>
      <CategoryList
        rows={cats}
        total={planes.spend.total}
        expanded={category}
        onToggle={setCategoryFilter}
        transactionsOf={inCategory}
        onOpenAll={(c) => {
          setCategoryFilter(c)
          setView('txs')
        }}
      />

      <Unknown
        rows={scope}
        totalSpend={planes.spend.total}
        hasCodes={info?.hasCodes ?? true}
        onMerchantCategory={setMerchantCategory}
      />

      <MoneyMoves rows={scope} />

      <section class="f-sum">
        <div class="f-sum__head">
          <h2 class="f-eyebrow">Счётная сводка</h2>
          <button type="button" class="f-linkish" onClick={() => compute(scope)}>
            {summary.value === null ? 'посчитать →' : 'пересчитать'}
          </button>
        </div>
        {summary.value === null ? (
          <p class="f-note">
            Финансер ничего не считает в фоне. Сводка появится, когда вы её попросите.
          </p>
        ) : (
          <SummaryView summary={summary.value} />
        )}
      </section>

      <p class="f-all">
        <button
          type="button"
          class="f-linkish"
          onClick={() => {
            setCategoryFilter(null)
            setView('txs')
          }}
        >
          {month === null
            ? `вся выписка · ${rows.length} операций →`
            : `выписка за ${monthLabel(month)} · ${scope.length} операций →`}
        </button>
        {' · '}
        <button
          type="button"
          class="f-linkish"
          onClick={() => downloadJson(buildExport(rows, info), 'финансер.json')}
        >
          выгрузить JSON →
        </button>
      </p>

      {error === null ? null : <p class="f-err">{error}</p>}
      {footer}
      {fileInput}
    </main>
  )
}
