import { useCallback, useMemo, useRef, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import type { Category } from './model.js'
import { dayLabel, monthLabel, monthOf, pickable, statementName } from './model.js'
import { parseFile, parseStatementText } from './statement.js'
import { decodeBytes } from './csv.js'
import { fold } from './text.js'
import type { ParseResult } from './statement.js'
import { pendingExtras } from './categorize.js'
import { byCategory, byMonth, byPlane } from './stats.js'
import { formatAmount, formatShare, parseAmount } from './money.js'
import type { Kopeck } from './money.js'
import {
  PERIODS,
  bounds,
  daysBehind,
  elapsed,
  isDaily,
  periodOf,
  previous,
  previousLabel,
  weekStart,
} from './period.js'
import type { PeriodKey } from './period.js'
import { limitFor, toGoal } from './plan.js'
import { byIncomeSource, nextArrival } from './income.js'
import { foreignCurrencies, stillForeign } from './rates.js'
import { buildExport, downloadJson, looksLikeExport, readExport } from './export.js'
import { demoCsv } from './demo.js'
import {
  categorized,
  clearMerchantCategory,
  compute,
  backupDue,
  markSaved,
  forgetEverything,
  storageFailed,
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
  cashSplits,
  extras,
  plan,
  rates,
  setCashSplit,
  setRate,
  transactions,
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
import { Confirm } from './components/Confirm.js'
import { Accounts } from './components/Accounts.js'
import { Balance } from './components/Balance.js'
import { DayChart } from './components/DayChart.js'
import { IncomeView } from './components/IncomeView.js'
import { Regular } from './components/Regular.js'
import { Head } from './components/Head.js'
import { MonthChart } from './components/MonthChart.js'
import { MoneyMoves } from './components/MoneyMoves.js'
import { CategoryList } from './components/CategoryList.js'
import { CashView } from './components/CashView.js'
import { Extras } from './components/Extras.js'
import { Fold } from './components/Fold.js'
import { SavingsView } from './components/SavingsView.js'
import { Unknown } from './components/Unknown.js'
import { TxList } from './components/TxList.js'
import { SummaryView } from './components/SummaryView.js'
import { RulesView } from './components/RulesView.js'
/**
 * Знак — из пакета фирменного стиля, а не копией и не путём наружу.
 *
 * Копия в корпусе расходилась бы с корневой на первой же правке. Относительный
 * путь «../../../elementar.svg» это чинил, но заводил зависимость от того, где
 * файл лежит в чужом каталоге: сосед переносит — у нас молча пропадает шапка.
 */
import logo from '@elementar/brand/elementar.svg'
import { IncomeChart } from './components/IncomeChart.js'
import { Transfers, sentToPeople } from './components/Transfers.js'

/**
 * Один экран — сводка. Всё, что отвечает на вопросы «сколько», «на что» и
 * «сколько отложено», лежит на нём: вкладок и вторых страниц нет.
 *
 * Два исключения — выписка целиком и словарь правил. Это не разделы сводки, а
 * выход к сырым данным: шестьсот строк операций в сводку не кладутся, и место
 * им за её пределами.
 */
type View = 'year' | 'txs' | 'rules'

/** Месяц цели для демо: восемь месяцев вперёд. */
function demoGoalMonth(): string {
  const now = new Date()
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 8, 1))
  return d.toISOString().slice(0, 7)
}

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
  /**
   * Месяц, а не год.
   *
   * Приложение открывают в обычный день с вопросом «сколько я уже потратил», а
   * не «куда всё ушло за год». Год — это разбор раз в квартал, и он в одном
   * нажатии отсюда; месяц — то, на что смотрят постоянно, и он же совпадает с
   * тем, как сбрасывается бюджет.
   */
  const [period, setPeriod] = useState<PeriodKey>('month')
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
      // Разница между «файл пустой» и «строки были, но ни одна не прочиталась»
      // для человека решающая: в первом случае он принёс не тот файл, во
      // втором — тот, и виновато приложение. Молчать об этом значит отправить
      // его искать ошибку у банка.
      setError(
        result.rows > 0
          ? `Строк в файле ${result.rows}, но ни одну не удалось прочитать: ` +
              'не разобрались дата или сумма. Похоже, колонки в этой выгрузке ' +
              'названы непривычно — пришлите файл, и разбор поправят.'
          : 'В файле не нашлось ни одной операции.',
      )
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
      accountLabels: result.accountLabels,
      bank: result.bank,
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
        // к выгрузке не меняется (Д-026). Через `statementName`, потому что
        // браузер имя меняет: «выписка (1).csv» — тот же счёт, а не второй.
        const name = statementName(file.name)
        accept(await parseFile(bytes, name), name)
      } catch {
        setError('Файл не удалось прочитать. Нужна выгрузка операций из банка: CSV или .xlsx.')
      } finally {
        setBusy(false)
      }
    },
    [accept],
  )

  /**
   * Перетаскивание файла на страницу.
   *
   * На настольном экране это короче диалога выбора: выписка обычно лежит в
   * «Загрузках», которые видны рядом с окном браузера. Диалог при этом никуда
   * не девается — на телефоне перетаскивать нечем.
   */
  const [dragging, setDragging] = useState(false)
  const onDrop = useCallback(
    (event: JSX.TargetedDragEvent<HTMLElement>): void => {
      event.preventDefault()
      setDragging(false)
      const file = event.dataTransfer?.files?.[0]
      if (file !== undefined) void load(file)
    },
    [load],
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
    // Демо приходит с заполненным планом. Без него копилка показывала нули и
    // шесть месяцев «без плана»: половина экрана уходила на объяснение, что
    // здесь ничего нет, — а демо существует ровно затем, чтобы показать, как
    // выглядит заполненное приложение.
    setPlan({
      income: 18_500_000 as Kopeck,
      fixed: 7_200_000 as Kopeck,
      save: 5_000_000 as Kopeck,
      saved: 32_000_000 as Kopeck,
      goal: 60_000_000 as Kopeck,
      goalDate: demoGoalMonth(),
      // В примере остаток назван рукой — как у человека, чей банк его не
      // выгружает. Иначе главное число «можно тратить» в демо не считается.
      onAccount: 7_384_000 as Kopeck,
      onAccountAt: today(),
    })
  }, [accept])

  /**
   * Край данных — самая поздняя операция, какая есть.
   *
   * Всё считается от него, а не от системной даты: данные приезжают выпиской,
   * а не проводами из банка, и «за день» от сегодняшнего числа показало бы
   * ноль на недельной выгрузке (Д-026). Насколько край отстал, приложение
   * говорит вслух — см. `behind`.
   */
  /** Разрез по счёту: `null` — все сразу. */
  const onAccount = useMemo(
    () => (account === null ? rows : rows.filter((tx) => tx.account === account)),
    [rows, account],
  )

  /**
   * Край считается по выбранному счёту, а не по всем операциям сразу.
   *
   * Считался по всем — и выбор счёта, выписка по которому кончилась в июне,
   * при общем крае в декабре давал нули в «дне», «неделе» и «месяце»: отрезок
   * отмерялся от чужой даты. Подпись внизу при этом бодро сообщала «данные по
   * 31 декабря» — про другой счёт. Человек видел пустой экран и никакого
   * объяснения.
   *
   * Список отсортирован от новых к старым, поэтому край — первая строка.
   */
  const edge = useMemo(() => onAccount[0]?.date ?? today(), [onAccount])
  /** Самая ранняя операция: по ней видно, осталось ли что-то за краем отрезка. */
  const oldest = useMemo(() => onAccountDates(onAccount), [onAccount])
  const behind = useMemo(() => daysBehind(edge, today()), [edge])

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

  /**
   * Остаток по счетам.
   *
   * Сперва то, что выгрузил банк. Если не выгрузил ни один — то, что назвал
   * человек, пересчитанное операциями после названной даты: назвал в
   * понедельник, во вторник потратил — во вторник число уже другое.
   */
  const balance = useMemo(() => {
    const known = loaded.filter((s) => typeof s.balance === 'number' && s.balance !== null)
    if (known.length > 0) return known.reduce((sum, s) => sum + (s.balance ?? 0), 0)

    const named = plan.value.onAccountAt
    if (named === '' || plan.value.onAccount === 0) return null
    const after = onAccount
      .filter((tx) => tx.date > named)
      .reduce((sum, tx) => sum + tx.amount, 0)
    return plan.value.onAccount + after
  }, [loaded, onAccount, plan.value.onAccount, plan.value.onAccountAt])

  /** Остаток назван рукой — об этом стоит сказать прямо в ячейке. */
  const balanceByHand =
    loaded.every((s) => typeof s.balance !== 'number' || s.balance === null) &&
    plan.value.onAccountAt !== ''

  const allIncome = useMemo(
    () => onAccount.reduce((sum, tx) => (tx.amount > 0 ? sum + tx.amount : sum), 0),
    [onAccount],
  )
  /** Валюты, которые банк не пересчитал. Пусто — говорить не о чем. */
  const currencies = useMemo(() => foreignCurrencies(transactions.value), [transactions.value])
  const enabledExtras = useMemo(() => new Set(extras.value), [extras.value])
  /** Что предлагать в выборе категории: выключенные туда не попадают. */
  const options = useMemo(() => pickable(enabledExtras), [enabledExtras])
  /** Что лежит за выключенными категориями — считается по разрезу, не по всему. */
  const pending = useMemo(
    () => pendingExtras(scope, overrides.value, merchantOverrides.value),
    [scope, overrides.value, merchantOverrides.value],
  )
  /**
   * Насколько отличается от прошлого такого же отрезка.
   *
   * Пустой прошлый отрезок сравнением не считается: «+100%» против нуля
   * означает не рост, а то, что данных за прошлый раз просто нет. Показать это
   * ростом значило бы соврать первым же числом на экране.
   */
  const change = useMemo(() => {
    if (day !== null || month !== null) return null
    const was = previous(period, edge)
    if (was === null) return null
    const list = onAccount.filter((tx) => tx.date >= was.from && tx.date <= was.to)
    if (list.length === 0) return null
    const before = byPlane(list)
    const delta = (now: number, then: number): number | null =>
      then === 0 ? null : Math.round(((now - then) / then) * 100)
    return {
      spend: delta(planes.spend.total, before.spend.total),
      income: delta(planes.income.total, before.income.total),
      label: previousLabel(period, edge),
    }
  }, [onAccount, period, edge, day, month, planes])

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
    <input
      ref={fileRef}
      type="file"
      accept=".csv,.txt,.json,.xlsx"
      class="f-sr"
      onChange={onPick}
    />
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
        {/* Знак Элементара и имя корпуса — одной группой слева: это одна
            подпись, «чей и какой», а не две разные надписи.

            Знак кладётся маской, а не картинкой: в файле цвет зашит чёрным, и
            картинкой он остался бы чёрным на чёрном в тёмной теме. Маска берёт
            из файла только форму, а красит его `currentColor` — тем же цветом,
            что и текст рядом. */}
        <div class="f-head__mark">
          <span class="f-head__logo" style={`--f-logo:url(${logo})`} aria-hidden="true" />
          <span class="f-head__name">финансер</span>
          <span class="f-head__note">v0</span>
        </div>
        {/* Обновить выписку — в правом углу шапки, если данные уже есть.
            Загрузка стояла в подвале рядом с выгрузкой, потому что случается
            раз в месяц. Но раз в месяц она случается обязательно, и искать её
            внизу страницы каждый раз — это и есть та работа, которой быть не
            должно. Пустому экрану кнопка не нужна: там загрузка и так главное
            действие посередине. */}
        {hasData.value ? (
          <button
            type="button"
            class="f-head__load"
            onClick={() => fileRef.current?.click()}
            title="Добавить свежую выписку: операции склеятся, правки останутся"
          >
            {busy ? 'Читаю…' : 'обновить выписку →'}
          </button>
        ) : null}
      </header>
      {/* Отказ хранилища. Плашка висит и не закрывается: закрыть её значило бы
          снова замолчать, а положение не изменится само — оно изменится, когда
          человек выгрузит файл. Поэтому в плашке действие, а не «понятно». */}
      {storageFailed.value ? (
        <p class="f-note f-alarm">
          Браузер не сохраняет: хранилище переполнено или запрещено. Всё, что на экране, живёт до
          закрытия вкладки — выгрузите JSON внизу страницы, иначе разметка пропадёт.
        </p>
      ) : null}
    </>
  )

  if (!hasData.value) {
    return (
      <main
        class={dragging ? 'f-page f-page--drop' : 'f-page'}
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        {header}
        <div class="f-empty">
          <h1 class="f-empty__title">
            Куда ушли деньги за <span class="f-mark">год</span>
          </h1>
          <p class="f-empty__lead">
            Финансер читает банковскую выписку, отделяет траты от переездов денег и показывает
            картину года. Всё считается прямо в браузере — данные не покидают устройство.
          </p>

          <button
            type="button"
            class="f-cta"
            aria-disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            {busy ? 'Читаю…' : dragging ? 'Отпустите файл' : 'Загрузить выписку'}
          </button>

          {error === null ? null : <p class="f-err">{error}</p>}

          <section class="f-howto">
            <h2 class="f-eyebrow f-eyebrow--quiet f-howto__title">Как выгрузить</h2>
            <ol>
              <li>
                <span>1</span>
                <span>Приложение банка → нужный счёт</span>
              </li>
              <li>
                <span>2</span>
                <span>
                  Выписка или история операций за год, формат CSV или Excel. Если банк предлагает
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
  /**
   * Чьи это данные: банк, если человек его назвал, иначе имя счёта.
   *
   * Банк не выводится из выписки: в файле его нет, а угадывать по набору
   * колонок значит подписать чужие деньги наугад. Зато назвать его человек
   * может один раз — в «переименовать» у счёта, — и дальше это имя стоит
   * везде, где раньше стояло имя файла.
   */
  const whoseData = ((): string => {
    const banks = [...new Set(accounts.value.map((a) => a.bank.trim()).filter((b) => b !== ''))]
    if (banks.length === 1) return banks[0] ?? ''
    if (banks.length > 1) return `${banks.length} банка`
    const names = accounts.value.map((a) => a.name)
    if (names.length === 1) return names[0] ?? ''
    return info?.name ?? ''
  })()

  /**
   * Сохранить разметку файлом.
   *
   * Одно действие на все кнопки, которые его звали: «выгрузить JSON» и
   * «сохранить копию» делали одно и то же двумя одинаковыми кусками кода, и
   * отметку «сохранено» ставил только один из них.
   */
  const saveJson = (): void => {
    downloadJson(buildExport(rows, info, overrides.value, merchantOverrides.value), 'финансер.json')
    // Ручная выгрузка — тоже сохранение: напоминать о ней сразу после того, как
    // человек её сделал, значит не смотреть на него вовсе.
    markSaved(today())
  }

  /**
   * Переустановить приложение.
   *
   * Снимает сервис-воркер и его кэши, потом перезагружает страницу. Хранилище
   * не трогается: выписка и правки живут в `localStorage`, а не в кэше, и
   * терять их ради обновления кода незачем.
   */
  const reinstall = (): void => {
    void (async () => {
      try {
        const workers = (await navigator.serviceWorker?.getRegistrations?.()) ?? []
        for (const worker of workers) await worker.unregister()
        const keys = (await globalThis.caches?.keys?.()) ?? []
        for (const key of keys) await globalThis.caches.delete(key)
      } catch {
        // Браузер может запрещать и то и другое — перезагрузка всё равно
        // полезна: без воркера страница придёт из сети.
      }
      globalThis.location.reload()
    })()
  }

  const freshness = (
    <p class="f-fresh">
      <span class={behind > 2 ? 'f-fresh__k f-fresh__k--old' : 'f-fresh__k'}>
        Данные по {dayLabel(edge)}
        {behind === 0 ? '' : `, это ${behind} ${dayWord(behind)} назад`}
      </span>{' '}
      {/* Имя банка, а не имя файла: «account_statement_25.06.26-18.08.26» не
          отвечает ни на один вопрос. Банк называет человек — сам он ниоткуда
          не берётся, и выдумывать его за человека нельзя. Пока не назван,
          стоит имя счёта: «Карта ·3523». */}
      {loaded.length <= 1 ? whoseData : `${loaded.length} выписки`}
    </p>
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
      onDrop={(key) => {
        dropAccount(key)
        setMonth(null)
        setDay(null)
        setCategoryFilter(null)
      }}
    />
  )

  /**
   * Подвал — только подпись. Действия из него уехали в «Настройку»: словарь
   * правил, тема и «забыть всё» стояли строкой ссылок внизу страницы, где их
   * никто не искал, и выглядели тремя разными вещами.
   */
  const footer = (
    <footer class="f-foot">Элементар · финансер · всё считается в этом браузере</footer>
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
    <main
      class={dragging ? 'f-page f-page--drop' : 'f-page'}
      onDragOver={(event) => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {header}
      {/* Наверху — только то, чем человек переключает картину. Строка про
          свежесть данных ушла в подвал: она отвечает на вопрос, который
          задают раз в день, а место занимала в самом дорогом ряду. */}
      <div class="f-top">
        {/* Обёртка есть всегда, даже когда счёт один и переключатель молчит:
            без неё «обновить» уезжало к левому краю. */}
        <div class="f-top__accs">{accountSwitch}</div>
      </div>

      {/* Валюта: не предупреждение, а поле. Предупреждение не превращает
          неправду в правду — тысяча лир продолжала складываться с тысячей
          рублей. Курс называет человек: сам он не выясняется, любой источник
          курса это внешний запрос (ТЗ §1). */}
      {currencies.size === 0 ? null : (
        <div class="f-rates">
          {/* Предупреждение уходит, когда курс назван: висящее «0 операций
              не пересчитано» — это тревога о том, чего уже нет. */}
          {stillForeign(rows, rates.value) === 0 ? (
            <p class="f-note">
              Операции в валюте пересчитаны по названному курсу. {[...currencies.keys()].join(', ')}{' '}
              — курс средний за период, а не на день покупки: точнее из выписки не узнать.
            </p>
          ) : (
            <p class="f-note f-hint">
              {stillForeign(rows, rates.value)} операций в валюте банк не пересчитал в рубли. Пока
              курс не назван, они посчитаны как рубли — и сумма из-за них неверна.
            </p>
          )}
          {[...currencies].map(([code, count]) => (
            <label key={code} class="f-field">
              <span class="f-field__k">
                {code} · {count} оп. · рублей за единицу
              </span>
              <input
                type="text"
                inputMode="decimal"
                value={
                  rates.value[code] === undefined
                    ? ''
                    : formatAmount(rates.value[code] ?? 0, { kopecks: 'auto', abs: true })
                }
                onChange={(event) => {
                  const raw = (event.currentTarget as HTMLInputElement).value
                  setRate(code, Math.abs(parseAmount(raw) ?? 0))
                }}
              />
            </label>
          ))}
        </div>
      )}

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

      {/* График тоже один на все отрезки и всегда на месте. На «дне» рисуется
          его неделя с подсветкой: один столбик не с чем сравнивать, а пустое
          место снова сдвигало бы всё, что ниже. */}
      {/* Две колонки на широком экране. В одну картина занимала две с половиной
          высоты монитора: чтобы дойти до категорий, надо было прокрутить мимо
          графика, а «картина» тем и хороша, что видна целиком.

          Период и главные числа остаются во всю ширину: они общие для обеих
          половин, и в колонке шестая кнопка «6 мес» переносилась на две строки.
          На телефоне колонка одна — там ширины нет. */}
      {/* Три числа, за которыми возвращаются каждый день. Отдельной полосой над
          блоками: они не про расходы и не про копилку, они про «сколько есть
          сейчас», и внутри любого блока читались бы как его часть. */}
      <Balance
        onAccount={balance as Kopeck | null}
        byHand={balanceByHand}
        onSet={(kopecks) => {
          // Остаток называется на край данных: человек смотрит в банк сегодня,
          // а выписка кончается вчера — и операции между ними уже учтены.
          setPlan({ ...plan.value, onAccount: kopecks, onAccountAt: edge })
        }}
        next={arrival}
        edge={edge}
        owedToSavings={toGoal(plan.value, setAside as Kopeck)}
      />

      {/* Три блока. Каждый отвечает на свой вопрос и не залезает в чужой:
          расходы — «куда ушло», копилка — «сколько отложено и успеваем ли»,
          доходы — «откуда приходит». Границы блоков видимые: без них соседние
          смыслы читаются как один длинный список. */}
      <div class="f-cols">
        <div class="f-cols__left">
          <section class="f-block f-block--spend">
            <h2 class="f-block__title">Расходы</h2>

            {/* Главное число стоит в своём блоке, над своим графиком и своим
              списком. Раньше обе плитки жили общей шапкой наверху, а расходы и
              доходы — блоками ниже: сумма была оторвана от того, что её
              объясняет. */}
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
              change={change}
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
                // Раздел раскрывается перерисовкой, а она случится не сейчас: до неё
                // блока в разметке ещё нет, и прокручивать не к чему.
                setPlanOpen(true)
                requestAnimationFrame(() =>
                  document.querySelector('.f-plan')?.scrollIntoView({ block: 'center' }),
                )
              }}
              part="spend"
            />

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

            {/* Порядок разделов: сначала то, что сообщает, потом то, что
          настраивает. Разбор непонятного и наличные — первыми: они сильнее
          всего меняют картину, всё остальное её только объясняет. Переводы
          людям стояли здесь же, пока были свёрнутым разделом; теперь у них
          свой блок под расходами. */}
            <Unknown
              rows={scope}
              totalSpend={planes.spend.total}
              hasCodes={info?.hasCodes ?? true}
              named={merchantOverrides.value}
              options={options}
              onMerchantCategory={setMerchantCategory}
            />

            {/* Наличные — рядом с разбором непонятного: обе про одно, про деньги,
          о которых выписка не сказала ничего. */}
            <CashView
              rows={scope}
              splits={cashSplits.value}
              totalSpend={planes.spend.total}
              options={options}
              onSplit={setCashSplit}
            />

            {/* Что уходит само — рядом с «откуда приходит»: оба про то, что человек
          не выбирает каждый день, а обнаруживает раз в полгода. */}
            <Regular rows={onAccount} edge={edge} />

            <MoneyMoves rows={scope} onUnpair={(id) => setCategory(id, 'Доход')} />
          </section>

          {/* Переводы людям — свой блок под расходами, а не строка среди
              категорий и не свёрнутый раздел внутри них. На выписке без кодов
              это самая крупная статья трат, и разбирается она не как категория,
              а по людям: кому и когда.

              Блока нет вовсе, когда переводов нет: рамка с тенью и пустотой
              внутри — это обещание содержимого, которого не будет. Пустой он
              и висел, пока условие жило внутри компонента: `null` убирает
              содержимое, но не коробку. */}
          {sentToPeople(scope).length === 0 ? null : (
            <section class="f-block f-block--transfers">
              <Transfers
                rows={scope}
                totalSpend={planes.spend.total}
                options={options}
                onMerchantCategory={setMerchantCategory}
                onCategory={setCategory}
              />
            </section>
          )}
        </div>

        {/* Доходы — блок наравне с расходами, а не приписка сбоку. Деньги
            приходят и уходят: это две половины одного вопроса, и разный вес у
            них означал бы, что одна половина важнее. */}
        <section class="f-block f-block--income">
          <h2 class="f-block__title">Доходы</h2>

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
            change={change}
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
              // Раздел раскрывается перерисовкой, а она случится не сейчас: до неё
              // блока в разметке ещё нет, и прокручивать не к чему.
              setPlanOpen(true)
              requestAnimationFrame(() =>
                document.querySelector('.f-plan')?.scrollIntoView({ block: 'center' }),
              )
            }}
            part="income"
          />

          {/* График прихода — зеркало расходного: тот же скелет, те же вёдра,
              тот же язык. Без него доходы были единственной половиной картины
              без формы: сумма и список источников, но не видно, ровно они идут
              или рывками. */}
          <IncomeChart
            rows={onAccount}
            from={period === 'day' ? weekStart(edge) : range.from}
            to={period === 'day' ? edge : range.to}
            months={months}
            daily={daily}
          />

          {/* Все операции, а не отрезок: за один день приходов нет, и раздел
              исчезал бы ровно тогда, когда о нём вспоминают (Д-026). */}
          <IncomeView
            rows={onAccount}
            edge={edge}
            total={allIncome as Kopeck}
            onExclude={(ids) => {
              // Не удаление, а переклассификация: операции остаются в выписке и
              // видны в «Движениях денег». Выбросить их значило бы разойтись с
              // тем, что человек видит в приложении банка.
              for (const id of ids) setCategory(id, 'Переводы')
            }}
          />
        </section>

        <section class="f-block f-block--save">
          <SavingsView rows={onAccount} edge={edge} plan={plan.value} onChange={setPlan} />
        </section>

        <section class="f-block f-block--tools">
          <h2 class="f-block__title">Настройка</h2>

          {/* Меню, а не россыпь ссылок внизу страницы.
              Там жили шесть действий в трёх видах сразу — подчёркнутая ссылка,
              красная подчёркнутая, синяя — и ни одно не выглядело кнопкой, хотя
              все шесть кнопки. Теперь строка: слева о чём, справа что можно
              сделать. Вид у всех один. */}
          <div class="f-set">
            <div class="f-set__row">
              <span class="f-set__k">Выписка</span>
              <span class="f-set__acts">
                <button type="button" class="f-chip" onClick={() => fileRef.current?.click()}>
                  {busy ? 'читаю…' : 'обновить'}
                </button>
                <button type="button" class="f-chip" onClick={saveJson}>
                  выгрузить JSON
                </button>
              </span>
            </div>

            <div class="f-set__row">
              <span class="f-set__k">Копия</span>
              <span class="f-set__acts">
                <button type="button" class="f-chip" onClick={saveJson}>
                  сохранить копию
                </button>
              </span>
              {/* Напоминание стоит рядом с самим действием, а не отдельной
                  плашкой над сводкой: там оно отодвигало то, ради чего пришли. */}
              {backupDue(today()) ? (
                <span class="f-set__note">
                  Выписка и правки живут только в этом браузере — копии больше недели нет.
                </span>
              ) : null}
            </div>

            {/* Кнопка на случай, если приложение всё-таки застряло на старой
                версии. Раньше выхода не было вовсе: воркер отдавал страницу из
                кэша, не спрашивая сеть, и человеку оставалось чистить данные
                сайта руками — вместе с выпиской. Здесь снимается воркер и его
                кэши, выписка и правки остаются на месте. */}
            <div class="f-set__row">
              <span class="f-set__k">Приложение</span>
              <span class="f-set__acts">
                <button type="button" class="f-chip" onClick={reinstall}>
                  переустановить
                </button>
              </span>
              <span class="f-set__note">
                Снимет сохранённую копию приложения и загрузит свежую с сервера. Выписка и
                проставленные категории останутся.
              </span>
            </div>

            <div class="f-set__row">
              <span class="f-set__k">Вид</span>
              <span class="f-set__acts">
                {/* Тёмная тема — выбор, а не умолчание (Д-035). */}
                <button type="button" class="f-chip" onClick={toggleTheme}>
                  {dark.value ? 'светлая тема' : 'тёмная тема'}
                </button>
              </span>
            </div>

            <div class="f-set__row">
              <span class="f-set__k">Правила</span>
              <span class="f-set__acts">
                <button type="button" class="f-chip" onClick={() => setView('rules')}>
                  словарь правил
                </button>
              </span>
            </div>

            <div class="f-set__row">
              <span class="f-set__k">Данные</span>
              <span class="f-set__acts">
                <Confirm
                  label="сбросить всё"
                  question="сбросить выписку и все проставленные категории?"
                  confirm="да, сбросить"
                  chip
                  onConfirm={() => {
                    forgetEverything()
                    setMonth(null)
                    setCategoryFilter(null)
                    setView('year')
                  }}
                />
              </span>
              <span class="f-set__note">
                Выписка и правки лежат в хранилище этого браузера и никуда не отправляются. На общем
                компьютере так делать не стоит.
              </span>
            </div>
          </div>

          <Extras enabled={enabledExtras} pending={pending} onToggle={toggleExtra} />
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
        </section>
      </div>

      {/* Единственная громкая кнопка на экране: она ведёт к списку операций,
          ради которого всё остальное и считалось. Выгрузка и загрузка стояли
          рядом с ней тихими ссылками — теперь они в «Настройке», где им место:
          обе про файлы, и обе случаются раз в месяц. */}
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
      </p>

      {/* Две колонки на широком экране. В одну картина занимала две с
          половиной высоты монитора: чтобы увидеть категории, надо было
          прокрутить мимо графика, а «картина года» тем и хороша, что видна
          целиком. Слева то, что отвечает «сколько», справа — «на что».

          На телефоне колонка одна: там ширины нет, и порядок сверху вниз
          остаётся прежним. */}

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
