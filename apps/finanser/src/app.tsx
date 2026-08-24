import { useCallback, useMemo, useRef, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import type { Category } from './model.js'
import { dayLabel, monthLabel, monthOf, pickable } from './model.js'
import { parseStatement, parseStatementText } from './statement.js'
import { decodeBytes } from './csv.js'
import { fold } from './text.js'
import type { ParseResult } from './statement.js'
import { pendingExtras } from './categorize.js'
import { byCategory, byMonth, byPlane } from './stats.js'
import { formatShare } from './money.js'
import type { Kopeck } from './money.js'
import { PERIODS, bounds, daysBehind, elapsed, isDaily, periodOf, weekStart } from './period.js'
import type { PeriodKey } from './period.js'
import { limitFor, toGoal } from './plan.js'
import { byIncomeSource, nextArrival } from './income.js'
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
  accounts,
  activeAccount,
  dropAccount,
  extras,
  plan,
  renameAccount,
  toggleExtra,
  setPlan,
  sources,
  source,
  summary,
} from './store.js'
import { applyUpdate, updateReady } from './pwa.js'
import { dark, toggleTheme } from './theme.js'
import { Amount } from './components/Amount.js'
import { Accounts } from './components/Accounts.js'
import { Balance } from './components/Balance.js'
import { DayChart } from './components/DayChart.js'
import { IncomeView } from './components/IncomeView.js'
import { Head } from './components/Head.js'
import { PlanView } from './components/PlanView.js'
import { MonthChart } from './components/MonthChart.js'
import { MoneyMoves } from './components/MoneyMoves.js'
import { CategoryList } from './components/CategoryList.js'
import { Extras } from './components/Extras.js'
import { Fold } from './components/Fold.js'
import { Unknown } from './components/Unknown.js'
import { TxList } from './components/TxList.js'
import { SummaryView } from './components/SummaryView.js'
import { RulesView } from './components/RulesView.js'

/** Два экрана: картина и выписка. Операции — второй шаг, а не вкладка. */
type View = 'year' | 'txs' | 'rules'

/** Сегодняшний день по часам устройства. Отдельной функцией — её видно в тестах. */
function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Самая ранняя дата в списке. Список отсортирован от свежих к старым. */
function onAccountDates(rows: readonly { date: string }[]): string | null {
  return rows[rows.length - 1]?.date ?? null
}

/** «1 день назад», «2 дня назад», «5 дней назад». */
function dayWord(n: number): string {
  const tens = n % 100
  const ones = n % 10
  if (tens >= 11 && tens <= 14) return 'дней'
  if (ones === 1) return 'день'
  if (ones >= 2 && ones <= 4) return 'дня'
  return 'дней'
}

export function App(): JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<View>('year')
  const [month, setMonth] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [category, setCategoryFilter] = useState<Category | null>(null)
  const [query, setQuery] = useState('')
  /** Какой отрезок смотрим. Год — то, с чего корпус начинался (ТЗ §1). */
  const [period, setPeriod] = useState<PeriodKey>('year')
  /** Выбранный день внутри короткого периода. */
  const [day, setDay] = useState<string | null>(null)
  /** Раскрыт ли план: его открывает и «задать план» из полосы предела. */
  const [planOpen, setPlanOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const rows = categorized.value
  const loaded = sources.value
  const account = activeAccount.value

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
      key: name,
      balance: result.balance,
      accounts: result.accounts,
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
            key: back.source?.name ?? file.name,
            balance: null,
            accounts: [...new Set(back.transactions.map((t) => t.account))],
          })
          setView('year')
          setMonth(null)
          setCategoryFilter(null)
          setError(null)
          return
        }
        // Имя файла передаётся как запасной ключ счёта: если банк не выгрузил
        // номер карты, различать счета больше нечем, а имя файла от выгрузки
        // к выгрузке не меняется (Д-026).
        accept(parseStatement(bytes, file.name), file.name)
      } catch {
        setError('Файл не удалось прочитать. Нужен CSV — выгрузка операций из банка.')
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
    accept(parseStatementText(demoCsv(), 'пример выписки'), 'пример выписки')
  }, [accept])

  /**
   * Край данных — самая поздняя операция, какая есть.
   *
   * Всё считается от него, а не от системной даты: данные приезжают выпиской,
   * а не проводами из банка, и «за день» от сегодняшнего числа показало бы
   * ноль на недельной выгрузке (Д-026). Насколько край отстал, приложение
   * говорит вслух — см. `behind`.
   */
  const edge = useMemo(() => rows[0]?.date ?? today(), [rows])
  /** Самая ранняя операция: по ней видно, осталось ли что-то за краем отрезка. */
  const oldest = useMemo(() => onAccountDates(rows), [rows])
  const behind = useMemo(() => daysBehind(edge, today()), [edge])

  /** Разрез по счёту: `null` — все сразу. */
  const onAccount = useMemo(
    () => (account === null ? rows : rows.filter((tx) => tx.account === account)),
    [rows, account],
  )

  const range = useMemo(() => bounds(period, edge), [period, edge])
  const daily = isDaily(period)

  /** Операции периода. Границы включительные с обеих сторон. */
  const inPeriod = useMemo(
    () => onAccount.filter((tx) => tx.date >= range.from && tx.date <= range.to),
    [onAccount, range],
  )

  // График — навигатор внутри выбранного периода, а не итог.
  const months = useMemo(() => byMonth(inPeriod), [inPeriod])
  const yearPlanes = useMemo(() => byPlane(inPeriod), [inPeriod])

  /**
   * Разрез — то, о чём сейчас идёт разговор: весь период, один месяц или один
   * день. Два разреза одновременно не показываются: иначе на экране две
   * таблицы категорий, и человек складывает их глазами, получая двойную сумму.
   */
  const scope = useMemo(() => {
    if (day !== null) return inPeriod.filter((tx) => tx.date === day)
    if (month !== null) return inPeriod.filter((tx) => monthOf(tx.date) === month)
    return inPeriod
  }, [inPeriod, month, day])
  const planes = useMemo(() => byPlane(scope), [scope])
  const cats = useMemo(() => byCategory(scope), [scope])

  /** Предел трат на период: считается из плана, а не вводится (Д-026). */
  const limit = useMemo(() => limitFor(period, edge, plan.value), [period, edge, plan.value])
  const pace = useMemo(() => elapsed(period, edge), [period, edge])

  /**
   * Отложенное за календарный месяц края данных. Считается по операциям плана
   * «переезд» с категорией «Накопления» — спрашивать его не за чем.
   */
  const setAside = useMemo(() => {
    const from = `${edge.slice(0, 7)}-01`
    let sum = 0
    for (const tx of onAccount) {
      if (tx.date < from || tx.date > edge) continue
      if (tx.category !== 'Накопления') continue
      if (tx.amount < 0) sum -= tx.amount
    }
    return sum
  }, [onAccount, edge])

  /** Остаток по счетам: сумма последних известных остатков выгрузок. */
  const balance = useMemo(() => {
    const known = loaded.filter((s) => typeof s.balance === 'number' && s.balance !== null)
    if (known.length === 0) return null
    return known.reduce((sum, s) => sum + (s.balance ?? 0), 0)
  }, [loaded])

  const allIncome = useMemo(
    () => onAccount.reduce((sum, tx) => (tx.amount > 0 ? sum + tx.amount : sum), 0),
    [onAccount],
  )
  const enabledExtras = useMemo(() => new Set(extras.value), [extras.value])
  /** Что предлагать в выборе категории: выключенные туда не попадают. */
  const options = useMemo(() => pickable(enabledExtras), [enabledExtras])
  /** Что лежит за выключенными категориями — считается по разрезу, не по всему. */
  const pending = useMemo(
    () => pendingExtras(scope, overrides.value, merchantOverrides.value),
    [scope, overrides.value, merchantOverrides.value],
  )
  const incomeSources = useMemo(() => byIncomeSource(onAccount, edge), [onAccount, edge])
  const arrival = useMemo(() => nextArrival(incomeSources, edge), [incomeSources, edge])

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

  const info = source.value
  const spec = periodOf(period)

  /** Сколько операций на каждом счёте — подсказка в переключателе. */
  const counts = useMemo(() => {
    const out: Record<string, number> = {}
    for (const tx of rows) out[tx.account] = (out[tx.account] ?? 0) + 1
    return out
  }, [rows])

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

  /**
   * Свежесть данных.
   *
   * Строка отвечает на вопрос, которого человек не задаёт вслух, но от ответа
   * на который зависит смысл всех чисел выше: за какое число это посчитано.
   * «Обновить» стоит здесь же — это самое частое действие в ежедневном
   * сценарии, и класть его дальше одного касания было бы дорого (Д-026).
   */
  const freshness = (
    <p class="f-fresh">
      <span class={behind > 2 ? 'f-fresh__k f-fresh__k--old' : 'f-fresh__k'}>
        Данные по {dayLabel(edge)}
        {behind === 0 ? '' : `, это ${behind} ${dayWord(behind)} назад`}
      </span>{' '}
      {loaded.length <= 1 ? (info?.name ?? '') : `${loaded.length} выписки`}
    </p>
  )

  const refresh = (
    <button type="button" class="f-go f-go--small" onClick={() => fileRef.current?.click()}>
      ОБНОВИТЬ
    </button>
  )

  const accountSwitch = (
    <Accounts
      list={accounts.value}
      active={account}
      counts={counts}
      onSelect={(key) => {
        activeAccount.value = key
        setMonth(null)
        setDay(null)
        setCategoryFilter(null)
      }}
      onRename={renameAccount}
      onDrop={dropAccount}
    />
  )

  const footer = (
    <footer class="f-foot">
      <button type="button" class="f-linkish f-linkish--quiet" onClick={() => setView('rules')}>
        словарь правил →
      </button>
      {' · '}
      {/* Тёмная тема — выбор, а не умолчание: прототип был светлой бумагой,
          и тёмную сторону дизайнер глазами не проверял. */}
      <button type="button" class="f-linkish f-linkish--quiet" onClick={toggleTheme}>
        {dark.value ? 'светлая тема' : 'тёмная тема'}
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
        <TxList rows={visible} options={options} onCategory={setCategory} />
        {footer}
        {fileInput}
      </main>
    )
  }

  return (
    <main class="f-page">
      {header}
      {/* Наверху — только то, чем человек переключает картину. Строка про
          свежесть данных ушла в подвал: она отвечает на вопрос, который
          задают раз в день, а место занимала в самом дорогом ряду. */}
      <div class="f-top">
        {accountSwitch}
        {refresh}
      </div>

      {loaded.some((s) => s.foreign > 0) ? (
        <p class="f-note f-hint">
          {loaded.reduce((n, s) => n + s.foreign, 0)} операций в валюте банк не пересчитал в рубли —
          они посчитаны как рубли, и сумма из-за них завышена или занижена.
        </p>
      ) : null}

      {/* Период — это режим, а не фильтр: ниже меняется не только число, но и
          то, о чём вообще идёт речь. На коротких отрезках это дневной ритм —
          сколько уже потрачено и сколько осталось; на длинных — картина по
          месяцам и категориям (Д-026). */}
      <div class="f-periods" role="group" aria-label="Период">
        {PERIODS.map((p) => (
          <button
            key={p.key}
            type="button"
            class={period === p.key ? 'f-period f-period--on' : 'f-period'}
            aria-pressed={period === p.key}
            onClick={() => {
              setPeriod(p.key)
              setMonth(null)
              setDay(null)
            }}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Шапка одна на все шесть отрезков: раньше короткие показывали полосу
          предела, длинные — две плитки, и переключение сдвигало всё, что ниже,
          на сто с лишним пикселей — ровно там, где человек нажимает. */}
      <Head
        title={day !== null ? dayLabel(day) : month !== null ? monthLabel(month) : spec.title}
        spent={planes.spend.total}
        income={planes.income.total}
        limit={limit}
        elapsed={pace}
        average={
          daily || months.length === 0
            ? null
            : {
                spend: Math.round(planes.spend.total / months.length) as Kopeck,
                income: Math.round(planes.income.total / months.length) as Kopeck,
              }
        }
        saving={
          daily
            ? {
                done: setAside as Kopeck,
                left: toGoal(plan.value, setAside as Kopeck),
                goal: plan.value.save,
              }
            : null
        }
        onSetPlan={() => {
          setPlanOpen(true)
          // Раздел раскрывается перерисовкой, а она случится не сейчас:
          // до неё блока в разметке ещё нет, и прокручивать не к чему.
          requestAnimationFrame(() =>
            document.querySelector('.f-plan')?.scrollIntoView({ block: 'center' }),
          )
        }}
      />

      {/* График тоже один на все отрезки и всегда на месте. На «дне» рисуется
          его неделя с подсветкой: один столбик не с чем сравнивать, а пустое
          место снова сдвигало бы всё, что ниже. */}
      {daily ? (
        <DayChart
          rows={onAccount}
          from={period === 'day' ? weekStart(edge) : range.from}
          to={period === 'day' ? edge : range.to}
          limit={limitFor('day', edge, plan.value)}
          selected={day}
          onSelect={(next) => {
            setDay(next)
            setCategoryFilter(null)
          }}
        />
      ) : (
        <MonthChart
          months={months}
          selected={month}
          hovered={hovered}
          onSelect={setMonth}
          onHover={setHovered}
        />
      )}

      <div class="f-scope">
        <h2 class="f-eyebrow">
          {day !== null
            ? `Траты по категориям · ${dayLabel(day)}`
            : month !== null
              ? `Траты по категориям · ${monthLabel(month)}`
              : 'Траты по категориям'}
        </h2>
        {day === null && month === null ? null : (
          <button
            type="button"
            class="f-linkish"
            onClick={() => {
              setMonth(null)
              setDay(null)
            }}
          >
            ← {spec.title}
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

      {/* Все операции, а не отрезок: за один день приходов нет, и раздел
          исчезал бы ровно тогда, когда о нём вспоминают (Д-026). */}
      {/* Ещё категории — сразу под картиной по категориям: включают их,
          глядя именно на неё. */}
      <Extras enabled={enabledExtras} pending={pending} onToggle={toggleExtra} />

      <IncomeView rows={onAccount} edge={edge} total={allIncome as Kopeck} />

      <Unknown
        rows={scope}
        totalSpend={planes.spend.total}
        hasCodes={info?.hasCodes ?? true}
        named={merchantOverrides.value}
        options={options}
        onMerchantCategory={setMerchantCategory}
      />

      <MoneyMoves rows={scope} />

      <PlanView
        plan={plan.value}
        setAside={setAside as Kopeck}
        open={planOpen}
        onOpenChange={setPlanOpen}
        onChange={setPlan}
      />

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

      <Balance onAccount={balance as Kopeck | null} next={arrival} saved={plan.value.saved} />

      <p class="f-all">
        <button
          type="button"
          class="f-go"
          onClick={() => {
            setCategoryFilter(null)
            setView('txs')
          }}
        >
          {scope.length} операций →
        </button>
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

      {/* Данные старше выбранного отрезка не прячутся молча: если они есть,
          выход к ним стоит здесь же (Д-026). Строка появляется один раз при
          загрузке и не мигает по ходу работы. */}
      {oldest !== null && oldest < range.from ? (
        <p class="f-older">
          есть операции и раньше, с {dayLabel(oldest)} —{' '}
          <button
            type="button"
            class="f-linkish"
            onClick={() => {
              setPeriod('all')
              setMonth(null)
              setDay(null)
            }}
          >
            показать всё
          </button>
        </p>
      ) : null}
      {period === 'all' ? (
        <p class="f-older">
          показано всё загруженное —{' '}
          <button
            type="button"
            class="f-linkish"
            onClick={() => {
              setPeriod('year')
              setMonth(null)
              setDay(null)
            }}
          >
            вернуться к году
          </button>
        </p>
      ) : null}
      {error === null ? null : <p class="f-err">{error}</p>}
      {freshness}
      {footer}
      {fileInput}
    </main>
  )
}
