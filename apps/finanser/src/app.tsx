import { useCallback, useMemo, useRef, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import type { Category } from './model.js'
import { dayLabel, monthLabel, monthOf } from './model.js'
import { parseStatement, parseStatementText } from './tbank.js'
import { decodeBytes } from './csv.js'
import { fold } from './text.js'
import type { ParseResult } from './tbank.js'
import { byCategory, byMonth, byPlane } from './stats.js'
import { formatShare } from './money.js'
import { buildExport, downloadJson, looksLikeExport, readExport } from './export.js'
import { demoCsv } from './demo.js'
import {
  categorized,
  clearMerchantCategory,
  compute,
  forgetEverything,
  hasData,
  merchantOverrides,
  overrides,
  restoreEverything,
  setCategory,
  setMerchantCategory,
  addStatement,
  dropStatement,
  sources,
  source,
  summary,
} from './store.js'
import { applyUpdate, updateReady } from './pwa.js'
import { Amount } from './components/Amount.js'
import { MonthChart } from './components/MonthChart.js'
import { MoneyMoves } from './components/MoneyMoves.js'
import { CategoryList } from './components/CategoryList.js'
import { Fold } from './components/Fold.js'
import { Unknown } from './components/Unknown.js'
import { TxList } from './components/TxList.js'
import { SummaryView } from './components/SummaryView.js'
import { RulesView } from './components/RulesView.js'

/** Два экрана: картина года и выписка. Операции — второй шаг, а не вкладка. */
type View = 'year' | 'txs' | 'rules'

export function App(): JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<View>('year')
  const [month, setMonth] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [category, setCategoryFilter] = useState<Category | null>(null)
  const [query, setQuery] = useState('')
  /** Сколько последних месяцев показывать. null — весь период файла. */
  const [back, setBack] = useState<number | null>(null)
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
    addStatement(result.transactions, {
      name,
      rows: result.rows,
      skipped: result.skipped,
      converted: result.converted,
      foreign: result.foreign,
      loadedAt: new Date().toISOString().slice(0, 10),
      hasCodes: result.hasCodes,
      key: result.transactions[0]?.id.split(':')[0] ?? '',
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
        const text = decodeBytes(bytes)
        // Своя выгрузка узнаётся до разбора CSV: иначе она доедет до парсера
        // таблиц и получит бессмысленное «в файле нет колонок».
        if (looksLikeExport(text)) {
          const back = readExport(text)
          if (back.error !== null) {
            setError(back.error)
            return
          }
          restoreEverything(back.transactions, back.overrides, back.merchantOverrides, {
            name: back.source?.name ?? file.name,
            rows: back.transactions.length,
            skipped: 0,
            converted: 0,
            foreign: 0,
            loadedAt: new Date().toISOString().slice(0, 10),
            hasCodes: back.transactions.some((t) => t.mcc !== null || t.bankCategory !== null),
            key: back.transactions[0]?.id.split(':')[0] ?? '',
          })
          setView('year')
          setMonth(null)
          setCategoryFilter(null)
          setError(null)
          return
        }
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

  /**
   * Период разговора. По умолчанию — весь файл, но год выписки редко совпадает
   * с вопросом: «сколько я трачу сейчас» — это последние три месяца, а не
   * двенадцать. Отсчёт идёт от последней операции, а не от сегодняшнего дня:
   * выписку могли выгрузить месяц назад, и «последние три месяца» от сегодня
   * дали бы пустой экран.
   */
  const inPeriod = useMemo(() => {
    if (back === null) return rows
    const last = rows[0]
    if (last === undefined) return rows
    const edge = new Date(`${last.date}T00:00:00Z`)
    edge.setUTCMonth(edge.getUTCMonth() - back)
    const from = edge.toISOString().slice(0, 10)
    return rows.filter((tx) => tx.date >= from)
  }, [rows, back])

  // График — навигатор внутри выбранного периода, а не итог.
  const months = useMemo(() => byMonth(inPeriod), [inPeriod])
  const yearPlanes = useMemo(() => byPlane(inPeriod), [inPeriod])

  /**
   * Разрез — то, о чём сейчас идёт разговор: весь период или один месяц.
   * Год и месяц не показываются одновременно: иначе на экране две таблицы
   * категорий, и человек складывает их глазами, получая двойную сумму.
   */
  const scope = useMemo(
    () => (month === null ? inPeriod : inPeriod.filter((tx) => monthOf(tx.date) === month)),
    [inPeriod, month],
  )
  const planes = useMemo(() => byPlane(scope), [scope])
  const cats = useMemo(() => byCategory(scope), [scope])

  const visible = useMemo(() => {
    const byCat = category === null ? scope : scope.filter((tx) => tx.category === category)
    const needle = fold(query).trim()
    if (needle === '') return byCat
    // Ищем в сложенной форме: «пятерочка» находит «PYATEROCHKA», и человеку не
    // нужно угадывать, какой раскладкой банк записал магазин.
    return byCat.filter(
      (tx) => fold(tx.description).includes(needle) || fold(tx.category).includes(needle),
    )
  }, [scope, category, query])

  const inCategory = useCallback(
    (c: Category) => scope.filter((tx) => tx.category === c && tx.amount < 0),
    [scope],
  )

  const PERIODS: ReadonlyArray<{ back: number | null; label: string }> = [
    { back: null, label: 'весь период' },
    { back: 12, label: '12 месяцев' },
    { back: 6, label: '6 месяцев' },
    { back: 3, label: '3 месяца' },
  ]

  const info = source.value
  const period = useMemo(() => {
    const first = inPeriod[inPeriod.length - 1]
    const last = inPeriod[0]
    if (first === undefined || last === undefined) return ''
    return `${dayLabel(first.date)} — ${dayLabel(last.date)}`
  }, [inPeriod])

  const fileInput = (
    <input ref={fileRef} type="file" accept=".csv,.txt,.json" class="f-sr" onChange={onPick} />
  )

  const header = (
    <>
      {updateReady.value ? (
        <div class="f-update" role="status">
          <span>Готова новая версия финансера.</span>
          <button type="button" class="f-linkish" onClick={applyUpdate}>
            обновить →
          </button>
        </div>
      ) : null}
      <header class="f-head">
        <div class="f-head__name">финансер</div>
        <div class="f-head__note">корпус Элементара · v0</div>
      </header>
    </>
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

          <p class="f-note">
            Сюда же можно вернуть свою выгрузку JSON — вместе с ней вернутся все проставленные вами
            категории.
          </p>

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

  const loaded = sources.value
  const sourceLine = (
    <div class="f-source">
      <span class="f-source__period">{period}</span>
      <span class="f-source__file">
        {loaded.length <= 1
          ? (info?.name ?? '')
          : `${loaded.length} выписки · ${rows.length} операций`}
      </span>
      <button
        type="button"
        class="f-linkish f-linkish--quiet"
        onClick={() => fileRef.current?.click()}
      >
        добавить
      </button>
    </div>
  )

  /* Список склеенных выписок. Показывается только когда их больше одной:
     на одной он был бы шумом, на нескольких — единственный способ понять,
     из чего сложилась картина, и убрать лишнюю. */
  const sourceList =
    loaded.length <= 1 ? null : (
      <ul class="f-sources" role="list">
        {loaded.map((s) => (
          <li key={s.name} class="f-sources__row">
            <span class="f-sources__name">{s.name}</span>
            <span class="f-sources__meta">{s.rows} операций</span>
            <button
              type="button"
              class="f-linkish f-linkish--quiet"
              onClick={() => dropStatement(s.name)}
            >
              убрать
            </button>
          </li>
        ))}
      </ul>
    )

  const footer = (
    <footer class="f-foot">
      <button type="button" class="f-linkish f-linkish--quiet" onClick={() => setView('rules')}>
        словарь правил →
      </button>
      <br />
      Выписка и правки лежат в хранилище этого браузера и никуда не отправляются. На общем
      компьютере так делать не стоит —{' '}
      <button
        type="button"
        class="f-linkish f-linkish--danger"
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

  if (view === 'rules') {
    return (
      <main class="f-page">
        {header}
        <RulesView
          named={merchantOverrides.value}
          manualCount={Object.keys(overrides.value).length}
          onForget={clearMerchantCategory}
          onBack={() => setView('year')}
        />
        {footer}
        {fileInput}
      </main>
    )
  }

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
        <label class="f-search">
          <span class="f-sr">Поиск по выписке</span>
          {/* Приглашение короткое: длинное обрезалось прямо в поле на телефоне,
              а обрезанная подсказка хуже отсутствующей. Полная формулировка
              осталась выше, для экранного диктора. */}
          <input
            type="search"
            value={query}
            placeholder="поиск"
            onInput={(event) => setQuery((event.currentTarget as HTMLInputElement).value)}
          />
        </label>
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
      {sourceList}
      {loaded.some((s) => s.foreign > 0) ? (
        <p class="f-note f-hint">
          {loaded.reduce((n, s) => n + s.foreign, 0)} операций в валюте банк не пересчитал в рубли —
          они посчитаны как рубли, и годовая сумма из-за них завышена или занижена.
        </p>
      ) : null}

      <div class="f-periods" role="group" aria-label="Период">
        {PERIODS.map((p) => (
          <button
            key={p.label}
            type="button"
            class={back === p.back ? 'f-period f-period--on' : 'f-period'}
            aria-pressed={back === p.back}
            onClick={() => {
              setBack(p.back)
              setMonth(null)
            }}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div class="f-tiles">
        <div class="f-tile f-tile--main">
          <span class="f-tile__k">
            {month === null ? 'Траты за период' : `Траты · ${monthLabel(month)}`}
          </span>
          <Amount class="f-tile__v" value={planes.spend.total} kopecks="never" />
          {/* Подпись стоит всегда, даже когда месяц не выбран. Раньше она
              появлялась только с выбором месяца, и плитка вырастала на двадцать
              пикселей — график уезжал вниз ровно из-под пальца, которым по нему
              и ткнули. Пустое место оставлять нечестно: во весь период там
              стоит средний месяц, он и отвечает, много это или мало. */}
          <span class="f-tile__sub">
            {month === null ? (
              <>
                в среднем{' '}
                <Amount
                  value={months.length === 0 ? 0 : Math.round(planes.spend.total / months.length)}
                  kopecks="never"
                />{' '}
                в месяц
              </>
            ) : (
              `${formatShare(planes.spend.total, yearPlanes.spend.total)}% года`
            )}
          </span>
        </div>
        <div class="f-tile">
          <span class="f-tile__k">Поступления</span>
          <Amount class="f-tile__v f-tile__v--in" value={planes.income.total} kopecks="never" />
          <span class="f-tile__sub">
            {month === null ? (
              <>
                в среднем{' '}
                <Amount
                  value={months.length === 0 ? 0 : Math.round(planes.income.total / months.length)}
                  kopecks="never"
                />{' '}
                в месяц
              </>
            ) : (
              `${formatShare(planes.income.total, yearPlanes.income.total)}% года`
            )}
          </span>
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
        named={merchantOverrides.value}
        onMerchantCategory={setMerchantCategory}
      />

      <MoneyMoves rows={scope} />

      <Fold title="Счётная сводка" meta={summary.value === null ? 'не посчитана' : undefined}>
        <p class="f-note">
          Финансер ничего не считает в фоне. Сводка появится, когда вы её попросите.
        </p>
        <p class="f-sum__act">
          <button type="button" class="f-linkish" onClick={() => compute(scope)}>
            {summary.value === null ? 'посчитать →' : 'пересчитать'}
          </button>
        </p>
        {summary.value === null ? null : <SummaryView summary={summary.value} />}
      </Fold>

      <p class="f-all">
        <button
          type="button"
          class="f-go"
          onClick={() => {
            setCategoryFilter(null)
            setView('txs')
          }}
        >
          {month === null
            ? `вся выписка · ${rows.length} операций →`
            : `выписка за ${monthLabel(month)} · ${scope.length} операций →`}
        </button>{' '}
        <button
          type="button"
          class="f-linkish f-linkish--quiet"
          onClick={() =>
            downloadJson(
              buildExport(rows, info, overrides.value, merchantOverrides.value),
              'финансер.json',
            )
          }
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
