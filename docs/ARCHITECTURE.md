# ЭЛЕМЕНТАР — единый технический документ

> Версия 1.0 · сведено из четырёх спецификаций (crypto, backend, client-core, design-planner)
> и двух враждебных ревью. Это **единственный источник истины**. Всё, что противоречит
> этому файлу — устарело, включая исходные спецификации проектировщиков.
>
> Документ написан так, чтобы по нему писался код без догадок. Там, где значение не
> зафиксировано, стоит слово **ЗАГЛУШКА** и указано, откуда его взять.

---

## Как читать разделы «Решено»

В конце каждого раздела есть блок **«Решено против чего»** — короткий список расхождений
между исходными спеками и принятое решение с причиной. Если через полгода возникнет соблазн
вернуться к отвергнутому варианту, там написано, почему он был отвергнут.

---

# 1. Обзор и принципы

## 1.1 Что строим

Экосистема узких браузерных приложений («корпусов») на одной общей оболочке.
Девять корпусов трёх типов:

| Тип | Корпуса | Свойство |
|---|---|---|
| **ДВЕРИ** | планер, финансер, конвертор, постер | Открыл, сделал, закрыл. Свой маршрут, свой экран. |
| **СЛОИ** | корректор, связной, архивер | Своей двери нет. Работают внутри дверей. |
| **МОСТЫ** | почтер, одинэсер | Чужая инфраструктура, свой интерфейс. **См. §1.5 — мосты не влезают в модель слепого сервера, для них отдельная архитектура.** |

Продаётся не приложение — продаётся **скорость появления нового корпуса**: дизайн-система,
локальное хранилище, шифрование, раздача по ссылке, слияние правок, слот под модель уже готовы.

## 1.2 Девять принципов, из которых выводится всё остальное

1. **Никаких аккаунтов.** Ни регистрации, ни входа, ни восстановления. У документа есть
   идентификатор и ключ; ключ живёт во фрагменте ссылки. Следствие принимается целиком:
   потерял ссылку и устройство — потерял данные, и мы не сможем даже подтвердить, что
   документ существовал.
2. **Сервер слеп.** Сервер хранит шифротекст и не может его прочитать. Не «не станет» —
   не может. Это определяет форму каждого API.
3. **Local-first.** Приложение полностью работает офлайн. Сервер нужен только для синка
   между устройствами и для парного режима. Локальная копия — источник истины,
   серверная — реле.
4. **Слияние на клиенте, всегда.** Сервер не умеет мержить (слеп) и не участвует в
   определении порядка. Порядок задаётся логическими часами внутри шифротекста.
5. **Агент предлагает, человек подтверждает.** У агента физически нет мутирующего API.
   Всё, что создал агент, существует как предложение до явного жеста человека.
6. **Движок — расходник.** LLM подключается через адаптер ключом пользователя. По умолчанию
   запрос идёт из браузера мимо нашего сервера.
7. **Минимализм с обоснованием.** Каждое поле в модели защищено объяснением. Поле, которое
   можно вывести или заменить существующим механизмом, не добавляется. Продукт может дойти
   до состояния «готово» и перестать развиваться.
8. **Честность вместо магии.** Всё, от чего мы не защищаем, написано прямым текстом в
   интерфейсе, а не спрятано в мелкий шрифт. Обещание, которое техника не выполняет,
   не даётся (см. §4.7 — список того, от чего НЕ защищаемся).
9. **Одна оболочка — одно происхождение.** Один домен, один scope, один сервис-воркер,
   одно хранилище. Девять корпусов — это маршруты внутри одного приложения (§13.1).

## 1.3 Домен и происхождение

Кириллический домен создаёт три конкретные проблемы: punycode в QR даёт 109 байт вместо 98
(QR version 7, 45×45 вместо 41×41), часть сканеров калечит IDN, заголовок
`Access-Control-Allow-Origin` обязан быть в punycode, а «починка» его эхом `Origin` открывает
чтение любому сайту.

**Решение:**

```
Каноническое происхождение (ссылки, QR, CORS, CSP):   https://elementar.app   (ЗАГЛУШКА, см. ниже)
Синк-API:                                             https://s.elementar.app
Кириллический домен:                                  элементар.рф → 301 на elementar.app
```

`elementar.app` — **ЗАГЛУШКА**: нужен реально зарегистрированный короткий ASCII-домен.
Требования: ≤ 14 символов, диктуется голосом, не путается на слух. До регистрации в коде
использовать константу `ORIGIN` из `packages/proto/src/env.ts`, нигде не хардкодить.

Кириллический домен остаётся как «вывеска» и редирект. Он **никогда** не появляется
в ссылке на документ, в QR и в CORS-заголовках.

## 1.4 Единицы измерения решений

Три числа, к которым сводятся все компромиссы:

| Что | Бюджет | Проверяется |
|---|---|---|
| Первая отрисовка планера (оболочка + экран списка) | ≤ 35 КБ gzip | `size-limit` в CI, гейт на PR |
| Всё приложение со всеми ленивыми чанками | ≤ 110 КБ gzip | `size-limit`, предупреждение |
| Стоимость 1000 активных документов | ≤ $10/мес | ручной пересчёт при смене тарифов |

## 1.5 Мосты: честная оговорка

Почтер (IMAP/SMTP) и одинэсер (обмен с 1С) требуют сервера, который **держит учётные
данные и ходит наружу**: из браузера сырой TCP невозможен, у 1С нет CORS. Модель «сервер
видит только слепые блобы» их исключает.

**Решение:** мосты не входят в v1 и **не строятся на sync-инфраструктуре дверей**. Для них
проектируется отдельный `apps/bridge` (см. `docs/adr/0006-bridges.md`): сессионный Durable
Object, учётные данные шифруются клиентом и расшифровываются **в памяти** DO на время сессии,
не персистятся, DO уничтожается по завершении. Это другая модель доверия, и в интерфейсе
она будет подписана другой. До появления этого ADR в реализации мостов слово «элементар
не видит ваших данных» произносить нельзя.

Считаем корпусов в v1: **семь на общей оболочке + два моста на отдельной архитектуре.**

**Решено против чего.**
Против «девять корпусов на одной оболочке» (все спеки подразумевали) — ревью 2 п.17 право:
два корпуса архитектурно невозможны в модели слепого сервера, и молчать об этом нельзя.
Против кириллического домена в ссылках (backend §5, design §8.4) — ревью 1 право про
punycode в ACAO и QR-версию.

---

# 2. Раскладка монорепо и граф зависимостей

## 2.1 Дерево

```
elementar/
├── package.json                pnpm workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── vitest.workspace.ts
├── .size-limit.json            бюджеты по входам (§1.4)
├── scripts/
│   ├── check-deps.ts           проверка графа зависимостей (§2.3)
│   └── check-protocol.ts       клиентский кодек ≡ серверный кодек (§2.4)
├── docs/
│   ├── ARCHITECTURE.md         ← этот файл
│   └── adr/
│       ├── 0001-merge-strategy.md        почему свой оп-лог, а не Yjs
│       ├── 0002-crypto-and-links.md      почему docId не выводится из ключа
│       ├── 0003-schema-evolution.md      аддитивная схема, forward-compat
│       ├── 0004-pwa-update-policy.md     почему обновление только по кнопке
│       ├── 0005-dates.md                 почему LocalDate без зоны
│       ├── 0006-bridges.md               почтер и одинэсер вне модели
│       └── 0007-single-origin.md         один манифест, один scope
├── packages/
│   ├── proto/        @elementar/proto     wire-типы, кодек кадров, деривация ключей
│   ├── core/         @elementar/core      исполняемая среда документа
│   ├── ui/           @elementar/ui        дизайн-система (чистая презентация)
│   ├── shell/        @elementar/shell     оболочка: AppShell, ShareSheet, слот модели, агент
│   ├── llm/          @elementar/llm       адаптеры провайдеров
│   ├── devkit/       @elementar/devkit    vite-пресет, pwa-плагин, шаблон SW
│   ├── corrector/    @elementar/corrector СЛОЙ
│   ├── connector/    @elementar/connector СЛОЙ
│   └── archiver/     @elementar/archiver  СЛОЙ
└── apps/
    ├── web/          @elementar/web       ЕДИНОЕ приложение: прихожая + все двери (§13.1)
    ├── api/          @elementar/api       Cloudflare Worker (синк)
    └── bridge/       @elementar/bridge    мосты, вне v1 (§1.5)
```

Обратите внимание: **нет `apps/planer`, `apps/finanser`, …**. Все двери — маршруты внутри
`apps/web`. Причина в §13.1 (на iOS отдельный манифест = отдельное хранилище, и прихожая
физически не видит документы планера).

Внутри `apps/web`:

```
apps/web/
├── index.html
├── vite.config.ts               → import preset from '@elementar/devkit/vite'
├── public/
│   ├── manifest.webmanifest     ОДИН манифест, scope '/'
│   └── i/                       иконки
└── src/
    ├── main.tsx                 роутер, тема, регистрация SW
    ├── routes.ts                '/' прихожая, '/p/:docId' планер, '/f/:docId' финансер …
    ├── theme.ts                 инлайн-скрипт темы (хешируется в CSP, §13.4)
    ├── shell/                   прихожая, экран «не найдено», экран восстановления
    └── corpus/
        ├── planer/              ДВЕРЬ 1 — §12
        │   ├── schema.ts        ЕДИНСТВЕННЫЙ источник модели планера (§12.2)
        │   ├── strings.ts       все строки одним объектом
        │   ├── screens/         Now, Lists, Projects, Calendar, Task, Trash, Settings
        │   ├── agent/           инструменты агента (read/propose)
        │   └── index.ts         ленивый вход двери
        ├── finanser/            заглушка, не в v1
        └── …
```

## 2.2 Дерево `packages/core/src`

```
packages/core/src/
├── index.ts              публичный фасад (§7.7)
├── preact.ts             entry: провайдер и хуки
├── pwa.ts                entry: регистрация SW, установка
├── testing.ts            entry: фейки для vitest
├── id.ts                 recordId, actorId, base62, детерминированные id (§6.9)
├── hlc.ts                гибридные логические часы
├── frac.ts               дробный индекс порядка
├── schema/
│   ├── types.ts          FieldSchema, CollectionSchema, CorpusDef
│   ├── define.ts         defineCorpus(), f.*
│   └── migrate.ts        миграции схемы документа
├── doc/
│   ├── state.ts          DocState, RecordState, ячейки
│   ├── apply.ts          apply(state, op)
│   ├── merge.ts          mergeState(a, b) — §6.8
│   ├── purge.ts          водяной знак чистки надгробий — §6.7
│   ├── tx.ts             транзакции → операции
│   ├── view.ts           материализация, сигналы, дифф
│   ├── query.ts          фильтры, сортировки, группировки
│   ├── undo.ts           локальный undo/redo с проверкой владения — §6.10
│   └── handle.ts         DocHandle
├── ops/
│   ├── types.ts          Op
│   ├── codec.ts          сериализация + forward-compat
│   ├── coalesce.ts       схлопывание последовательных правок — §7.4
│   └── compact.ts        снапшоты и усечение лога
├── crypto/
│   ├── b32.ts            Crockford base32
│   ├── keys.ts           HKDF-дерево из K_link
│   ├── envelope.ts       конверт EL1
│   ├── nonce.ts          сессионный источник nonce — §4.4
│   ├── link.ts           разбор и сборка ссылки, приглашения
│   ├── password.ts       wrap-record, Argon2id/PBKDF2
│   └── sign.ts           Ed25519 / ECDSA P-256, канонизация запроса
├── storage/
│   ├── schema.ts         объектные хранилища IndexedDB
│   ├── idb.ts            открытие + лестница миграций
│   ├── repo.ts           DocRepo: снапшот/лог/outbox/секреты
│   └── persist.ts        navigator.storage.persist, квоты, авто-экспорт
├── sync/
│   ├── machine.ts        конечный автомат (чистая функция)
│   ├── transport.ts      WebSocket, backoff, heartbeat
│   ├── http.ts           HTTP-путь: push через fetch(keepalive) — §7.5
│   ├── outbox.ts         очередь исходящих
│   ├── chain.ts          хеш-цепочка лога, детекция форка — §6.11
│   ├── session.ts        склейка repo ↔ transport ↔ doc
│   ├── presence.ts       шифрованное присутствие
│   └── digest.ts         сводка «пока вас не было» — §6.12
├── proposals/
│   ├── types.ts          Proposal, ProposalChange
│   └── store.ts          коллекция _proposals, accept/reject/rebase
└── util/
    ├── backoff.ts  batch.ts  bytes.ts  emitter.ts  assert.ts  ct.ts
```

`package.json` ядра:

```jsonc
{
  "name": "@elementar/core",
  "type": "module",
  "sideEffects": false,
  "exports": {
    ".":         { "types": "./dist/index.d.ts",   "import": "./dist/index.js" },
    "./preact":  { "types": "./dist/preact.d.ts",  "import": "./dist/preact.js" },
    "./pwa":     { "types": "./dist/pwa.d.ts",     "import": "./dist/pwa.js" },
    "./testing": { "types": "./dist/testing.d.ts", "import": "./dist/testing.js" }
  },
  "dependencies": {
    "@elementar/proto": "workspace:*",
    "@preact/signals-core": "^1.8.0"
  },
  "peerDependencies": { "preact": "^10.24.0" },
  "peerDependenciesMeta": { "preact": { "optional": true } }
}
```

## 2.3 Граф зависимостей

```
                    proto
                   ╱  │  ╲
                  ╱   │   ╲
              core    │    api            (api зависит ТОЛЬКО от proto)
             ╱   ╲    │
            ╱     ╲   │
          llm      ui │                   (ui не зависит ни от чего, кроме preact)
            ╲     ╱   │
             ╲   ╱    │
             shell ───┘                   (shell = core + ui + llm + proto)
            ╱  │  ╲
    corrector connector archiver          (слои: core + ui + llm + shell)
            ╲  │  ╱
             apps/web                     (web: core + ui + shell + llm + слои)

devkit — только devDependency у всех
```

Правила, проверяемые `scripts/check-deps.ts` в CI (падение = красный PR):

1. `proto` не зависит ни от чего, кроме TypeScript-типов.
2. `core` зависит только от `proto` и `@preact/signals-core`.
3. `ui` **не зависит от `core`**: дизайн-система не знает слов «документ», «docId», «Proposal».
   Компоненты, которым нужны эти типы (`ShareSheet`, `ModelSlotSettings`, `AgentProposal`,
   `AppShell`), живут в `shell`, а не в `ui`.
4. `shell` зависит от `core`, `ui`, `llm`, `proto`.
5. Слои зависят от `core`, `ui`, `llm`, `shell`, но **не друг от друга**.
6. Ни один пакет не зависит от `apps/*`.
7. `apps/api` **не импортирует `core`** — иначе появится соблазн расшифровать на сервере.
   Разрешён только `proto`.
8. `apps/api` не имеет права объявлять константы протокола локально: все размеры, пороги
   и коды ошибок импортируются из `proto`. Линтер проверяет по списку имён.

## 2.4 Почему `proto` вынесен отдельно

Кодек кадров и деривация ключей должны быть **одним кодом** на клиенте и на сервере, иначе
рассинхрон форматов гарантирован. `scripts/check-protocol.ts` в CI прогоняет
кросс-тест: пакет, закодированный клиентским кодеком, проходит серверную валидацию, и наоборот;
вектор деривации, посчитанный в браузерном окружении, совпадает с посчитанным в
workers-окружении.

```
packages/proto/src/
├── index.ts
├── env.ts        ORIGIN, API_ORIGIN — единственное место, где живут домены
├── consts.ts     все размеры, пороги, TTL, цены операций
├── codes.ts      ElmErrorCode
├── http.ts       типы всех эндпоинтов (§8.5)
├── ws.ts         ClientMsg / ServerMsg (§8.7)
├── frames.ts     кодек транспортного кадра (§8.4)
├── canon.ts      канонизация подписываемой строки (§4.5)
└── keys.ts       имена HKDF-info, размеры, форматы docId и фрагмента
```

**Решено против чего.**
Против россыпи `apps/planer`, `apps/finanser`, … (client-core §1, design §1) — ревью 2 п.13:
отдельные манифесты на iOS дают отдельные хранилища, прихожая перестаёт работать, оболочка
качается заново для каждой двери. Против `ui/src/shell/*` с `ShareSheet` и `ModelSlotSettings`
(design §1) — ревью 2 п.17: это нарушает собственное правило графа; введён `packages/shell`.

---

# 3. Модель данных и формат документа

## 3.1 Принцип

Документ = **множество типизированных коллекций плоских записей**. Запись = плоский набор
полей. Вложенности нет: она выражается ссылкой (`f.ref`). Одна машинерия слияния работает
для всех корпусов.

Состояние — не «объекты», а **карта ячеек**: каждое поле хранит `{значение, метка HLC}`.
Из этого следует, что `apply(state, op)` коммутативна, ассоциативна и идемпотентна, порядок
доставки не важен, векторные часы и граф версий не нужны, и сервер может быть тупым слепым реле.

## 3.2 Базовые типы

```ts
// packages/core/src/id.ts, hlc.ts
export type DocId     = string & { readonly __brand: 'DocId' }   // 20 симв. Crockford base32
export type ActorId   = string                                    // 8 симв. base62, на устройство
export type RecordId  = string                                    // 16 симв. base62, сортируемый
export type HlcString = string  // "0193f1a2b3c4-0007-k3f9x1m2" — лексикографически сортируем
export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue }

export type LocalDate = string  // 'YYYY-MM-DD', БЕЗ часового пояса
export type LocalTime = string  // 'HH:MM'
export type OrderKey  = string  // дробный индекс base62 + '#' + actorId
```

**Про даты.** `f.date()` — это календарная дата **без зоны**. Момент времени с зоной — это
отдельный тип `f.datetime()`, которого в планере нет. Причина в `docs/adr/0005-dates.md`:
планер про «сегодня/завтра», а не про встречи в разных часовых поясах; ISO-8601 с зоной на
двух устройствах в разных TZ даёт «задача уехала на вчера». Поля `meta.tz` не существует.

## 3.3 DSL схемы

```ts
// packages/core/src/schema/types.ts

export type FieldKind =
  | 'text' | 'number' | 'bool' | 'date' | 'time' | 'datetime'
  | 'enum' | 'ref' | 'tagged' | 'json'   // всё это — LWW-регистры
  | 'set'                                // OR-Set (add-wins)
  | 'blob'                               // ссылка на вложение

export interface FieldSchema<V = unknown> {
  readonly kind: FieldKind
  readonly default?: V
  readonly nullable?: boolean
  readonly max?: number            // предел длины/значения, проверяется в tx
  readonly long?: boolean          // многострочный текст → хранить проигравшие версии
  readonly keepConflicts?: boolean // по умолчанию = long
  readonly of?: string             // ref: имя коллекции
  readonly variants?: Readonly<Record<string, { ref?: string }>>  // tagged (§3.4)
  readonly values?: readonly string[]                              // enum
  readonly onDangling?: 'orphan' | 'keep'  // ref/tagged: политика висячей ссылки (§3.5)
  readonly redact?: boolean        // не отдавать агенту без явного разрешения
}

export interface CollectionSchema<T extends Record<string, FieldSchema>> {
  readonly fields: T
  readonly ordered?: boolean            // есть дробный индекс порядка
  readonly groupBy?: keyof T & string   // поле-контейнер, внутри него ведётся свой порядок
  readonly label: (rec: any) => string  // человекочитаемое имя для корзины и предложений
  readonly softDeleteDays?: number      // по умолчанию 30
  readonly cold?: (rec: any, now: number) => boolean  // политика архивации (§3.8)
}

export interface CorpusDef<S extends Record<string, CollectionSchema<any>>> {
  readonly id: string           // 'planer'
  readonly schemaVersion: number
  readonly collections: S
  readonly migrations?: DocMigration[]
  readonly meta?: Record<string, FieldSchema>
}
```

Конструкторы полей:

```ts
// packages/core/src/schema/define.ts
export const f = {
  text:     (o?: { max?: number; long?: boolean; keepConflicts?: boolean }) => FieldSchema<string>,
  number:   (o?: { max?: number }) => FieldSchema<number>,
  bool:     (def?: boolean) => FieldSchema<boolean>,
  date:     () => FieldSchema<LocalDate>,        // 'YYYY-MM-DD', без зоны
  time:     () => FieldSchema<LocalTime>,        // 'HH:MM'
  datetime: () => FieldSchema<string>,           // ISO-8601 с зоной, для постера/почтера
  enum:     <const V extends readonly string[]>(values: V, o?: { default?: V[number] }) => FieldSchema<V[number]>,
  ref:      <C extends string>(collection: C, o?: { onDangling?: 'orphan' | 'keep' }) => FieldSchema<RecordId | null>,
  /** Размеченное объединение в ОДНОЙ ячейке: 'list:home' | 'proj:<recordId>'. См. §3.4. */
  tagged:   <const V extends Record<string, { ref?: string }>>(variants: V, o?: { default?: string; onDangling?: 'orphan' | 'keep' }) => FieldSchema<string>,
  set:      <V extends string = string>() => FieldSchema<readonly V[]>,
  json:     <V extends JsonValue>() => FieldSchema<V>,
  blob:     () => FieldSchema<BlobRef | null>,
  nullable: <V>(s: FieldSchema<V>) => FieldSchema<V | null>,
}
```

Выведение типов записи:

```ts
export type RecordOf<C extends CollectionSchema<any>> = {
  readonly id: RecordId
  readonly createdAt: HlcString
  readonly updatedAt: HlcString
} & { -readonly [K in keyof C['fields']]: ValueOf<C['fields'][K]> }

export type CorpusData<D extends CorpusDef<any>> = {
  [K in keyof D['collections']]: RecordOf<D['collections'][K]>
}
```

Прикладной код **никогда** не объявляет свои интерфейсы записей. `Task` получается только
как `CorpusData<typeof PLANER>['task']`. Если типы разъедутся — падает сборка, а не парный режим.

## 3.4 Контейнер — одна ячейка (`f.tagged`)

Ключевая правка после ревью. Если контейнер задан двумя независимыми полями
(`bucket: enum` и `project: ref`), то после офлайн-слияния получается состояние
«и в списке, и в проекте»: Виктор перенёс задачу в проект, Аня — в список «Быт», обе
операции применяются к разным ячейкам, задача рисуется дважды.

`f.tagged` хранит контейнер строкой `'<variant>:<value>'` в **одной** LWW-ячейке:

```ts
bucket: f.tagged({
  list: { },                 // 'list:work' | 'list:home' | 'list:hobby' | 'list:craft'
  proj: { ref: 'project' },  // 'proj:<recordId>'
}, { default: 'list:work', onDangling: 'orphan' })
```

Парсер и конструктор в ядре:

```ts
export type Tagged = { variant: string; value: string }
export function parseTagged(v: string): Tagged            // 'proj:aB3k' → { variant:'proj', value:'aB3k' }
export function formatTagged(t: Tagged): string
export const ORPHAN = 'list:orphan' as const              // псевдогруппа (§3.5)
```

Свойства:

* перенос между списком и проектом — **одна** операция, атомарная при слиянии;
* `groupBy: 'bucket'` даёт домен порядка на каждый контейнер, включая каждый проект
  (у задач внутри проекта есть собственное пространство ручного порядка);
* инвариант «ровно один контейнер» доказывается property-тестом (§6.13, тест 6).

## 3.5 Висячие ссылки

Валидация «ссылка указывает на живую запись» работает только внутри `tx`. Слияние её обходит:
Аня офлайн удалила проект «Ремонт», Виктор офлайн положил в него шесть задач.

Правило материализации (`doc/view.ts`):

> Живая запись, чей `groupBy`-контейнер указывает на надгробие или на несуществующую запись,
> материализуется в псевдогруппу `ORPHAN = 'list:orphan'`. Её значение ячейки при этом
> **не меняется** — если проект восстановят, задачи вернутся сами.

Планер рисует `ORPHAN` секцией **«Без проекта»** в конце экрана «Быт» (не отдельный экран,
не корзина). Инвариант property-теста: **не существует живой записи, не видимой ни на одном
экране.**

При `onDangling: 'keep'` запись остаётся в своей группе и просто не показывается —
для корпусов, где это осмысленно. В планере не используется.

## 3.6 Ячейки состояния

```ts
// packages/core/src/doc/state.ts

export interface Lww<V = JsonValue> {
  v: V
  t: HlcString
  /** Проигравшие версии для полей с keepConflicts. Кольцо на 3. */
  c?: Array<{ v: V; t: HlcString }>
}
export interface OrSet { e: Record<string, HlcString>; x: Record<string, HlcString> }
export type Cell = Lww | OrSet

export interface RecordState {
  f: Record<string, Cell>
  o?: Lww<OrderKey>          // дробный ключ порядка
  g?: Lww<string>            // контейнер (значение f.tagged/groupBy-поля, зеркалится сюда)
  del?: HlcString            // надгробие
  und?: HlcString            // восстановление
  cre: HlcString
  upd: HlcString
}

export interface DocState {
  v: 1
  corpus: string
  schema: number
  meta: Record<string, Lww>
  col: Record<string, Record<RecordId, RecordState>>
  /** Водяной знак чистки надгробий. Операции по записям с cre < purgedBefore отбрасываются. */
  purgedBefore: HlcString
  /** Голова хеш-цепочки лога, включённая в состояние (§6.11). base32, 32 байта. */
  chainHead: string
  /** Последний серверный seq, включённый в состояние. Метаданное, в слиянии не участвует. */
  seq: number
  /** Счётчик применённых операций с момента снапшота — триггер компактизации. */
  applied: number
}
```

**Нет `f.counter` и нет PN-счётчиков.** Ревью 2 п.18а право: у них нет потребителя.
Баланс в финансере — это сумма проводок, а не счётчик. Вид ячейки, ветка в merge и три
property-теста удаляются до появления реального потребителя.

## 3.7 Операции

```ts
// packages/core/src/ops/types.ts
interface OpBase { i: HlcString; c: string; r: RecordId }   // id (=HLC), коллекция, запись

export type Op =
  | (OpBase & { k: 's'; v: Record<string, JsonValue> })   // set полей (LWW)
  | (OpBase & { k: 'd' })                                 // delete (надгробие)
  | (OpBase & { k: 'u' })                                 // undelete
  | (OpBase & { k: 'o'; o?: OrderKey; g?: string })       // порядок и/или контейнер
  | (OpBase & { k: 'g+' | 'g-'; p: string; e: string[] }) // OR-Set
  | ({ i: HlcString; k: 'm'; v: Record<string, JsonValue> })  // мета документа
```

Сериализация — компактный JSON. Пример:

```json
{"i":"0193f1a2b3c4-0007-k3f9x1m2","k":"s","c":"task","r":"aB3k9Qx1mZ0p7Yc2","v":{"done":true}}
```

118 байт JSON → ~150 байт после шифрования, паддинга и обвязки кадра.

**Forward-compat:** операция с неизвестной коллекцией, неизвестным полем или неизвестным `k`
сохраняется в состоянии как есть, попадает в снапшот и уходит обратно в синк, но не
показывается. Причина: у супругов могут быть разные версии приложения, а принудительно
обновить второго нельзя — сервер слепой.

## 3.8 Политика архивации («холодная» часть)

Выполненные задачи не удаляются никогда, и за год пара с ежедневным повтором наберёт
десятки тысяч живых записей — при заявленном пределе «сотни, максимум тысячи» и отказе
от виртуализации это гарантированный тормоз.

```ts
// в схеме коллекции
cold: (t, now) => t.done && t.doneAt != null && now - t.doneAt > 90 * 864e5
```

Правило: записи, для которых `cold()` истинно, живут в снапшоте, но **не материализуются
в сигналы** и не попадают ни в один запрос, кроме явного `col.task.cold()`. Экран архива
в v1 не рисуется — только экспорт видит их целиком.

Тест приёмки: 10 000 записей, из которых 9 000 холодные, открытие документа ≤ 400 мс
на CPU-дросселе 4×.

## 3.9 Служебные коллекции

Коллекции с префиксом `_` не попадают в `CorpusData` и не видны обычными запросами.

| Коллекция | Содержимое | Зачем |
|---|---|---|
| `_actors` | `{ id: ActorId, name: string, lastSeenAt: number, mergedInto?: ActorId }` | Имена участников. Внутри документа → шифруется, сервер не видит (§6.14). |
| `_proposals` | `Proposal` (§10.4) | Предложения агента. Внутри документа → видны партнёру. |

## 3.10 Формат документа на диске и в экспорте

Снапшот — это `DocState`, сериализованный **каноническим** способом (сортировка ключей,
без пробелов) — от этого зависит побайтовое сравнение состояний в приёмке парного режима.

```ts
export function canonicalize(state: DocState): Uint8Array   // детерминированно
export function stateHash(state: DocState): string          // base32 SHA-256 от canonicalize
```

Экспорт `.elementar` — zip-контейнер:

```
manifest.json     { v:1, corpus, schemaVersion, docId, exportedAt, hasBlobs }
state.json        каноническая сериализация DocState
blobs/<id>        вложения, если withBlobs
```

Из экспорта **явно вырезаются**: ключи LLM-провайдеров, `secrets`-стор, настройки устройства.
Файл `recovery.txt` (docId + K_link) в экспорт **не** входит — это отдельная операция (§5.6).

**Решено против чего.**
Против двух моделей планера (client-core §2.4 vs design §6) — ревью 2 п.1: источник истины
один, `defineCorpus`. Против `bucket: enum` + `project: ref` — ревью 2 п.2: введён `f.tagged`.
Против `f.date()` с зоной и `meta.tz` (client-core §2.3) — ревью 2 п.4. Против `f.counter`
и `event`/`rrule`/`tags` — ревью 2 п.18: нет потребителя. Против `draft: boolean` в задаче
(design §6) — ревью 2 п.9: предложения живут в `_proposals`, а не в реальных записях (§10.4).

---

# 4. Криптография и модель угроз

Единственный источник истины по ключам, форматам и подписи — этот раздел и
`packages/proto/src/keys.ts` + `packages/core/src/crypto/*`. `apps/api` не имеет права
дублировать ни одну константу отсюда.

## 4.1 Сводка форматов

```
Ссылка:      https://elementar.app/p/<docId:20>#<fragment:53>
docId:       96 бит CSPRNG → 20 символов Crockford base32 (uppercase)
fragment:    [ver:1 = 0x01][K_link:32 байта] → 33 байта → 53 символа base32
URL целиком: 98 ASCII-байт → QR byte mode, ECC M → version 6, 41×41 модуля
```

```ts
// packages/proto/src/keys.ts
export const PROTOCOL_VERSION = 1 as const
export const MAGIC = 'EL1' as const
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'  // 32 симв., без I L O U

export const SIZES = {
  DOC_ID_BYTES: 12,        DOC_ID_CHARS: 20,
  LINK_SECRET_BYTES: 32,
  FRAGMENT_BYTES: 33,      FRAGMENT_CHARS: 53,
  NONCE_BYTES: 12,         SESSION_TAG_BYTES: 8,
  GCM_TAG_BYTES: 16,       HEADER_BYTES: 16,      AAD_BYTES: 16,
  KDF_SALT_BYTES: 16,
  SIG_NONCE_BYTES: 12,
  CHAIN_HASH_BYTES: 32,
} as const

export const INFO = {
  WRITE_KEY:  'elementar/1/write-key',
  KEK:        'elementar/1/kek',
  INVITE:     'elementar/1/invite',
} as const
```

## 4.2 Кодирование: Crockford base32

Регистронезависимо, нет визуально смежных `I/L/O/U`, диктуется голосом, дефисы допустимы и
игнорируются при разборе. В QR (byte mode) не проигрывает base64url: и 98, и 89 байт попадают
в один и тот же QR version 6.

```ts
export function b32encode(bytes: Uint8Array): string   // uppercase, без padding
/**
 * Регистронезависимо; I,i,l,L → 1; O,o → 0; дефисы и пробелы отбрасываются;
 * U/u — ошибка; ненулевой хвостовой bit-паддинг → NonCanonicalEncoding.
 */
export function b32decode(s: string): Uint8Array
```

Отображение в UI — группами по 5 (`K7M4Q-8XB2N-…`), в URL слитно.
**Жёсткое правило:** любой отображаемый или вводимый идентификатор проходит фильтр
«только символы `CROCKFORD_ALPHABET`». Тест `no-homoglyph.test.ts` сканирует строковые
литералы в `strings.ts` и в документации на не-ASCII внутри примеров идентификаторов —
в исходной спеке в примере `K7M4Q-8XВ2N` стояла кириллическая «В».

## 4.3 Дерево ключей

**docId НЕ выводится из K_link.** Два независимых значения CSPRNG.

```ts
const docIdBytes = crypto.getRandomValues(new Uint8Array(12))  // 96 бит
const kLink      = crypto.getRandomValues(new Uint8Array(32))  // 256 бит
```

Причина, и это одно из двух самых важных решений документа: при деривации `docId = HKDF(S)`
любой, кто знает `docId` (а он лежит в пути URL, в логах Cloudflare, в истории браузера,
у превью-бота мессенджера), может **проверять кандидатов офлайн**, без обращения к серверу.
Против случайного 256-битного ключа это ничего не даёт, но ровно этот механизм превращает
пароль на ссылку в офлайн-оракул (см. §5.4) и однажды будет применён к чему-то более слабому.
Класс ошибок убирается целиком.

Связь id ↔ ключ обеспечивается **криптографически, а не деривацией**: `docId` входит в AAD
каждого пакета (§4.4).

```
K_link (32B, во фрагменте)
├─ signSeed = HKDF(K_link, salt=docIdBytes, info="elementar/1/write-key", 32) → Ed25519 seed
├─ KEK0     = HKDF(K_link, salt=docIdBytes, info="elementar/1/kek", 32)          ← без пароля
└─ KEK1     = HKDF(K_link ‖ argon2id(pw, pwSalt), salt=docIdBytes, info="elementar/1/kek", 32)

K_doc (32B, случайный, ВСЕГДА хранится завёрнутым)
└─ AES-256-GCM для всех пакетов документа
```

Все деривации — HKDF-SHA256, `salt = docIdBytes`.

**`readToken` удалён.** В исходной крипто-спеке он был bearer-токеном чтения. Теперь чтение
требует такой же подписи, как запись (§4.5): один механизм вместо двух, токен не оседает в
HAR-файлах, в логах прокси и на скриншотах devtools, и нет соблазна «на чтение подпись не нужна».

**K_doc всегда случайный и всегда завёрнутый — даже без пароля.** Это даёт главное свойство:
включение, смена и снятие пароля меняют только 80-байтную wrap-запись, не требуют
перешифрования документа и **не меняют ссылку**. Если бы в беспарольном режиме
`K_doc = HKDF(K_link)`, добавление пароля позже не защищало бы ничего.

## 4.4 Конверт, AAD и nonce

```
байты  0..2  : "EL1"
байт   3     : type
байты  4..15 : nonce = sessionTag(8) ‖ counter(4, big-endian)
байты 16..   : ciphertext ‖ tag(16)
```

Накладные расходы: 32 байта на пакет.

```ts
export const PacketType = {
  OpBatch:  0x01,   // батч CRDT-операций
  Snapshot: 0x02,   // полный слепок состояния
  KeyWrap:  0x03,   // обёртка K_doc (шифруется на KEK, не на K_doc)
  DocMeta:  0x04,   // заголовок/цвет документа + wrapVer (§5.5)
  Presence: 0x05,   // эфемерное присутствие (§6.14)
  Forward:  0x06,   // указатель на новый документ после ротации
} as const
export type PacketType = (typeof PacketType)[keyof typeof PacketType]

/** Всегда 16 байт: "EL1"(3) ‖ type(1) ‖ docIdBytes(12) */
export function buildAad(type: PacketType, docId: DocId): Uint8Array
```

AAD связывает шифротекст с версией протокола (запрет тихого даунгрейда), типом пакета
(нельзя подсунуть снапшот вместо оп-пакета) и документом (нельзя перенести блоб между
документами). Nonce аутентифицируется самим GCM и в AAD не дублируется.

### Nonce: сессионный тег, ничего не персистится

Исходная крипто-спека предлагала персистентный `deviceTag` + high-water счётчик в IndexedDB
с резервированием блоками через Web Locks. Ревью 1 показало, что это не работает:
(а) требование «`save()` durable до возврата промиса» в браузере **недостижимо** —
IndexedDB имеет relaxed durability, Safari теряет записи при крахе; (б) детекция клона
хранилища (восстановление бэкапа профиля) работает только онлайн и только если сервер
отдал наши собственные пакеты — а враждебный сервер их придержит и тем самым отключит
детекцию. Два офлайн-клона с одинаковым `deviceTag` и откатанным счётчиком дают повтор
`(key, nonce)` в AES-GCM: XOR открытых текстов, восстановление H, подделка тегов.

**Решение:**

```
nonce = sessionTag(8, CSPRNG при каждом старте приложения) ‖ counter(4, в памяти)
```

```ts
// packages/core/src/crypto/nonce.ts
export interface NonceSource {
  next(): Uint8Array               // синхронно, без ожидания, без IO
  readonly sessionTag: Uint8Array  // 8 байт
  rotate(): void                   // при counter > 2^32 − 2^20
}
/** sessionTag генерируется здесь и НИКОГДА не пишется на диск. */
export function createNonceSource(): NonceSource
```

Свойства:

* каждая вкладка, каждый запуск, каждый воркер получает свой `sessionTag` — Web Locks,
  резервирование блоками, `CounterPersistError` и клон-детекция исчезают целиком;
* восстановление бэкапа профиля безопасно **по построению**: старый `sessionTag` мёртв;
* коллизия: при 10⁴ сессиях на документ вероятность ≈ (10⁴)²/2 / 2⁶⁴ ≈ **2.7·10⁻¹²**;
  при 10⁶ сессиях ≈ 2.7·10⁻⁸ — всё ещё приемлемо;
* переполнение счётчика при 2³² пакетов в одной сессии — `rotate()`.

Тест (заменяет исходный «8 вкладок × 100 000 next()»):

> **nonce-clone.test.ts** — два клона одного профиля (одинаковый IndexedDB, разные запуски)
> не выдают ни одного одинакового nonce; после полной потери IndexedDB новые пакеты не
> пересекаются со старыми; 10⁶ вызовов `next()` в одной сессии не дают дубликатов.

## 4.5 Подпись: одна на всё, включая чтение

Канонизируемая строка (`packages/proto/src/canon.ts`) — **обязательно с методом и путём**.
В исходной крипто-спеке `sigInput = "EL1W"‖docId‖ts‖bodyLen‖sha256(body)` не содержал ни
метода, ни пути: подпись пустого тела для WS-хендшейка переигрывалась как
`DELETE /d/:docId` в пределах окна 120 с.

```ts
// sigInput — бинарная конкатенация, все длины big-endian:
//   "EL1W"(4) ‖ ver(1) ‖ u8(len METHOD) ‖ METHOD ‖ u16be(len path) ‖ path
//   ‖ docIdBytes(12) ‖ u64be(unixMillis) ‖ sigNonce(12) ‖ sha256(body)(32)
export function canonicalSigInput(a: {
  method: string        // 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string          // без query, например '/v1/docs/K7M4.../deltas'
  docIdBytes: Uint8Array
  tsMs: number
  sigNonce: Uint8Array  // 12 байт CSPRNG на запрос
  bodySha256: Uint8Array
}): Uint8Array
```

Заголовок:

```
X-Elm-Sig: v1,<alg>,<tsMs>,<sigNonce b32>,<signature b32>
```

`alg ∈ { 'ed25519', 'p256' }`. Ключ выводится из `signSeed`; сервер хранит `sigPub`,
зафиксированный при создании (TOFU — оба партнёра выводят один и тот же ключ из K_link,
конфликта нет). Fallback ECDSA P-256 обязателен и протестирован: Ed25519 в WebCrypto есть
не везде (особенно во встроенных браузерах мессенджеров, куда ссылка и приезжает по QR),
алгоритм фиксируется в `sig_alg` документа при создании и не меняется.

Импорт Ed25519-seed в WebCrypto через PKCS#8:

```ts
const PKCS8_ED25519_PREFIX = new Uint8Array([
  0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20
])  // затем 32 байта seed
```

Проверка на сервере (внутри DocDO):

1. `|now − tsMs| ≤ 120 000`, иначе `401 ELM_SIG_EXPIRED`;
2. `sigNonce` не встречался за последние 300 с — **персистентно**, см. ниже;
3. `sha256(body)` совпадает;
4. подпись валидна ключом `sigPub`;
5. иначе — `401`.

**Антиреплей персистится.** В исходной спеке `nonces` был `Map` в памяти DO, а DO засыпает
полностью, когда нет пиров: после хибернации окно обнуляется и захваченный запрос
(TLS-инспектирующий прокси, скомпрометированный edge) переигрывается, включая `DELETE`.

```sql
CREATE TABLE IF NOT EXISTS sig_nonces (
  nonce   BLOB PRIMARY KEY,   -- 12 байт
  seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sig_nonces_seen ON sig_nonces (seen_at);
```

Чистка по alarm раз в 60 с: `DELETE FROM sig_nonces WHERE seen_at < now - 300000`.
Инвариант теста: **после `ctx.abort()` / эвикции / хибернации реплей всё ещё отбивается.**

Подпись обязательна на **всех** операциях: `GET /docs/{id}`, `/deltas`, `/snapshot`,
WS-хендшейк (в субпротоколе), `POST`, `PUT`, `DELETE`. Анонимного read-only WS не существует.
Ответ на любой неавторизованный или неизвестный запрос — байт в байт одинаковый `404` (§9.4).

## 4.6 Паддинг

Сервер видит размеры пакетов: «купить молоко» и «развод, делим квартиру на Профсоюзной»
отличимы по длине. Паддинг ISO/IEC 7816-4 (`0x80`, далее нули) **до шифрования**:

```ts
export function bucketSize(n: number): number {
  const m = n + 1                                   // +1 под маркер 0x80
  if (m <= 4096)  return Math.ceil(m / 256) * 256
  if (m <= 65536) return Math.ceil(m / 4096) * 4096
  return Math.ceil(m / 65536) * 65536
}
```

Включён по умолчанию; выключается для снапшотов > 1 MiB, где оверхед перевешивает пользу.
Паддинг **встроен в формат v1**, а не добавляется потом: менять формат позже дороже.

## 4.7 Модель угроз

### 4.7.1 От чего защищаемся

| # | Угроза | Чем закрыта |
|---|---|---|
| 1 | Оператор сервера и хостер читают содержимое | Слепые блобы; ключ никогда не уходит в HTTP-запрос |
| 2 | Дамп D1 / утечка R2 / судебный запрос | Отдаётся шифротекст и метаданные; ключей на сервере нет физически |
| 3 | Перебор docId | 96 бит + обязательная подпись на чтение + лимиты (§9) |
| 4 | Утечка docId (Referer, логи, скриншот) | Без подписи docId бесполезен; `Referrer-Policy: no-referrer`; SPA-шелл `/p/<id>` отдаётся идентично для любого id |
| 5 | Вандализм посторонним | Ed25519-подпись из K_link на каждой мутации |
| 6 | Реплей | ts ±120 с + **персистентный** кэш sigNonce 300 с |
| 7 | Повтор nonce при офлайн-правках | Сессионный `sessionTag` (§4.4) — ничего не персистится, клоны безопасны по построению |
| 8 | Перенос блоба между документами, подмена типа, даунгрейд версии | AAD = `"EL1"‖type‖docId` |
| 9 | Утечка ссылки при заданном пароле | Argon2id 64 MiB × 3 + сгенерированный 55-битный пароль (§5.4) |
| 10 | Понижение/откат wrap-записи сервером | Монотонный `wrapVer` + запрет понижения `alg` + клампы KDF (§5.5) |
| 11 | Незаметный форк состояния партнёров сервером | Хеш-цепочка лога + сверка головы через presence (§6.11) |
| 12 | Стирание истории компактором | Компакция только до `min(ack)` по всем видимым пирам + корзина срезанных дельт в R2 (§8.9) |
| 13 | Необратимое удаление держателем ссылки | Тумбстон с окном восстановления 7 дней; 3 поколения снапшотов; локальная история (§8.10) |
| 14 | Корреляция документов одного пользователя | `clientId` уникален на пару (устройство, документ); `create_ip_hash` удалён из схемы |
| 15 | Утечка размеров правок | Паддинг по корзинам (частично) |
| 16 | Утечка ссылки через канал шаринга | Одноразовое приглашение (§5.3) — утечка становится **обнаружимой** |

### 4.7.2 От чего НЕ защищаемся — явный список

Это не оговорки мелким шрифтом. Каждый пункт обязан быть произнесён в интерфейсе на
странице «Как это устроено» и, где отмечено, в момент соответствующего действия.

1. **Ссылка = полный доступ на чтение и запись, навсегда.** Отзыва нет. Тот, кто открывал
   планер, уже скачал содержимое к себе. Цена отсутствия аккаунтов.
2. **Держатель ссылки может стереть и переписать документ.** В том числе бывший партнёр.
   Смягчение — окно восстановления 7 дней и локальная копия, но не защита. Текст в UI
   шаринга обязателен.
3. **Полный URL с фрагментом остаётся доступен скриптам навсегда** через
   `performance.getEntriesByType('navigation')[0].name`. `history.replaceState` чистит
   только адресную строку. Формулировка «фрагмент никогда не покидает браузер» **неверна**;
   корректная формулировка: «фрагмент не отправляется в HTTP-запросе».
4. **Ссылка, отправленная в мессенджер, лежит в его облаке навсегда.** Переписыватели ссылок
   (Outlook SafeLinks, корпоративные шлюзы), превью-боты, Universal Clipboard, Handoff,
   «отправить на устройство» — всё это копирует строку целиком вместе с фрагментом.
   Смягчение: §5.3, одноразовое приглашение.
5. **История браузера синхронизируется в облако** (Chrome/Firefox Sync) вместе с фрагментом
   до того, как мы успеваем что-либо стереть.
6. **Cloudflare видит сырой IP и полный путь с docId** независимо от нас. Наша слепота —
   только про содержимое. Logpush отключён, `head_sampling_rate` 0.05, но это не защита от
   самого Cloudflare.
7. **Сервер видит метаданные:** docId, IP, время каждого обращения, размеры после паддинга,
   количество пакетов, `clientId` → число пишущих устройств, факт наличия пароля, момент
   создания и удаления. Траффик-анализ «эти двое правят планер каждый вечер в 23:00» возможен.
8. **Сервер может подавлять и придерживать данные.** Хеш-цепочка делает это **обнаружимым**,
   но не устранимым: заставить сервер отдать данные нельзя.
9. **Скомпрометированный деплой приложения.** Мы отдаём JS — подменённый бандл выгрузит
   фрагмент. Отдельно и хуже: **сервис-воркер видит `client.url` целиком, вместе с
   фрагментом**, через `clients.matchAll()`, без всякого XSS, переживает перезагрузки и
   работает офлайн. Компрометация деплоя на одну минуту даёт постоянный доступ ко всем
   документам на всех устройствах, которые в эту минуту обновились. Смягчения в §13.5;
   полностью не устраняется.
10. **Скомпрометированное устройство.** Расширения браузера, malware, разблокированный
    телефон. Локальные данные в IndexedDB лежат **открытым текстом** — иначе нет local-first
    без пароля на каждый запуск.
11. **Слабый самопридуманный пароль.** 30 бит ломаются за 2.5 часа на 100 GPU.
12. **Адаптер модели.** Любой запрос к провайдеру выносит открытый текст наружу.
    E2E-шифрование на это не распространяется по определению.
13. **Постквантовая стойкость подписи.** Ed25519 падает под Шором. Под угрозой только
    авторизация записи, не конфиденциальность (AES-256 против Гровера — 128 бит).
14. **Потеря и устройства, и ссылки.** Восстановления нет. Бэкдора нет.
15. **Слежка за фактом активности пары** через метаданные (п. 7) — паддинг и одинаковые
    404 снижают, но не убирают.

## 4.8 Заголовки и CSP

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'sha256-<хеш инлайн-скрипта темы, считается на сборке>';
  style-src 'self' 'unsafe-inline';        /* только для CSS-переменных темы */
  img-src 'self' data: blob:;
  font-src 'self';
  connect-src 'self' https://s.elementar.app wss://s.elementar.app;
  object-src 'none';
  base-uri 'none';
  frame-ancestors 'none';
  form-action 'none';
  require-trusted-types-for 'script';
  upgrade-insecure-requests
Referrer-Policy: no-referrer
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
X-Content-Type-Options: nosniff
Permissions-Policy: geolocation=(), camera=(self), microphone=()
Cache-Control: no-store           /* на /v1/* */
```

`camera=(self)` нужен для сканирования QR при переносе документа между устройствами.

**Access-Control-Allow-Origin — только punycode/ASCII-литерал из `proto/env.ts`,
никогда не эхо `Origin`.** Эхо открывает чтение любому сайту.

Всё содержимое документа рендерится как текст: `innerHTML` запрещён линтером,
HTML-режим Markdown не существует, автолинк строит `<a>` через DOM API.

**Решено против чего.**
Против `docId = HKDF(S)` (backend §0.1, client-core §4.1) — ревью 1: офлайн-оракул.
Против `readToken` (crypto §5.2) — один механизм авторизации вместо двух; заодно уходит
соблазн «на чтение подпись не нужна». Против отсутствия подписи на чтение (backend §5.2) —
ревью 1: один docId давал весь шифротекст и живой поток дельт. Против персистентного
счётчика nonce (crypto §3.3) — ревью 1: durability недостижима, клон-детекция отключается
враждебным сервером. Против `sigInput` без метода и пути (crypto §5.1) — ревью 1: подпись
GET переигрывалась как DELETE. Против антиреплея в памяти (backend §3.2) — ревью 1:
хибернация обнуляет окно.

---

# 5. Ссылки, QR, опциональный пароль

## 5.1 Постоянная ссылка

```
https://elementar.app/p/<docId:20>#<fragment:53>
```

`/p/` — планер, `/f/` — финансер, и так далее; маршрут внутри единого приложения (§13.1).
Всё слева от `#` публично и бесполезно без фрагмента. Всё справа не отправляется в
HTTP-запросе — но см. §4.7.2 п.3–5 о том, где оно всё же оказывается.

```ts
// packages/core/src/crypto/link.ts
export interface DocumentKeys { docId: DocId; docIdBytes: Uint8Array; linkSecret: Uint8Array }
export interface ParsedLink   { docId: DocId; linkSecret: Uint8Array; version: 1 }

export function createDocumentKeys(): DocumentKeys
export function buildLink(origin: string, keys: DocumentKeys, route?: string): string
export function parseLink(input: string): ParsedLink   // полный URL | '<docId>#<fragment>'
```

Контрольная сумма во фрагмент не добавляется: ручной ввод фрагмента — это уже провал UX,
а ошибка расшифровки и так даёт понятное сообщение.

## 5.2 Порядок обращения с фрагментом (изменён после ревью)

Исходные спеки стирали фрагмент из адресной строки **немедленно** после разбора. Это создаёт
худший из возможных сценариев: человек открыл документ по ссылке, две недели вносил задачи,
уехал в отпуск на 10 дней, Safari выселил IndexedDB — документ потерян полностью, и предложение
«сохрани ссылку» показывалось при первом закрытии, когда ключа в адресной строке уже не было.

**Новый порядок:**

```ts
export type LinkPersistState = 'unsaved' | 'saved'

/**
 * Разбирает location. Фрагмент НЕ стирается, пока persistState !== 'saved'.
 * После сохранения адресная строка приводится к виду /p/<docId>?d=1 —
 * закладка продолжает опознавать документ, но ключа в ней уже нет.
 */
export function consumeLinkFromLocation(loc?: Location, hist?: History): ParsedLink | null
export function sealAddressBar(docId: DocId, hist?: History): void
```

1. Документ открыт по ссылке → фрагмент разобран, секрет положен в IndexedDB, **фрагмент
   остаётся в адресной строке**.
2. Сразу показывается шит «Сохраните ссылку» с тремя действиями:
   «Скопировать» / «Поделиться» (`navigator.share`) / «Скачать файл-ключ».
3. Любое из трёх → `sealAddressBar()`, фрагмент исчезает, состояние `saved`.
4. Пропуск шита («Позже») → фрагмент остаётся до следующего запуска, шит повторяется.
5. Синк для документа, открытого по чужой ссылке, включается **по умолчанию** — иначе
   слепой снапшот на сервере не спасает при выселении локального хранилища.
6. Если `navigator.storage.persist()` вернул `false`, раз в 7 дней приложение **автоматически**
   (без кнопки) скачивает `.elementar` в «Загрузки» и пишет об этом строкой в журнале.

## 5.3 Одноразовое приглашение — основной способ передать ссылку человеку

Постоянная ссылка в мессенджере остаётся в его облаке навсегда (§4.7.2 п.4). Это главный
практический вектор ровно в целевом сценарии «дать ссылку супругу».

```
Ссылка-приглашение: https://elementar.app/i/<iid:20>#<inviteSecret:53>
```

```ts
export interface Invite { iid: string; url: string; expiresAt: number }

/** Клиент: I = CSPRNG(32); iid = b32(HKDF(I, info='elementar/1/invite', 12));
 *  blob = AES-GCM(HKDF(I, info='elementar/1/invite-kek'), K_link ‖ docIdBytes). */
export function createInvite(session: DocSession, ttlMs?: number): Promise<Invite>
/** Погашение: GET /v1/invite/{iid} → blob; сервер удаляет запись атомарно при первой отдаче. */
export function redeemInvite(url: string): Promise<ParsedLink>
```

Параметры: TTL **15 минут**, счётчик использований **1**, запись удаляется атомарно
(`DELETE … RETURNING` в DO). Превью-бот мессенджера, переписыватель ссылок и облако
получают протухший или уже сожжённый секрет; получатель видит честное
«приглашение уже использовано — попросите новое», и **утечка становится обнаружимой**.

Постоянная ссылка остаётся для двух случаев: **QR** (сканируется лично, глазами, с экрана
на экран) и **файл-ключ** (§5.6). Кнопка «Скопировать постоянную ссылку» есть, но она
вторая, и рядом с ней текст: «Эта ссылка работает всегда. Если она попадёт в чужие руки —
отозвать её нельзя».

## 5.4 Пароль — второй фактор поверх ссылки

Схема из backend-спеки (`S = Argon2id(password, salt=HKDF(pepper))`, `docId = HKDF(S)`)
**отвергнута целиком**. Утверждение «верификатора пароля нет нигде» было ложным: верификатор —
сам `docId`, он в пути URL, в логах, в истории браузера, у превью-бота. Имея ссылку и docId,
атакующий перебирает локально на GPU `pw → Argon2id → S → HKDF → docId` без единого обращения
к серверу; rate-limiter не участвует; 30-битный пароль ломается за часы.

**Правило, которое надо помнить при любом изменении протокола:**

> Никакое публичное значение — `docId`, `wrap.salt`, ETag, любое поле, которое видит сервер, —
> не должно быть функцией пароля. Иначе оно становится офлайн-верификатором.

Итоговая схема: `KEK1 = HKDF(K_link ‖ argon2id(pw, pwSalt), salt=docIdBytes, info=INFO.KEK)`.

* У кого пароль, но нет ссылки — не имеет ничего (256-битный пробел).
* У кого ссылка, но нет пароля — вынужден считать Argon2id, и только он вообще способен
  на офлайн-перебор.
* Реальный сценарий, который это закрывает: ссылка утекла в общий чат, а пароль передали голосом.

### Параметры

```ts
export const KDF_DEFAULTS = {
  argon2id: { m: 65536 /* KiB = 64 MiB */, t: 3, p: 1, outLen: 32 },
  pbkdf2:   { iterations: 600_000, hash: 'SHA-256' as const, outLen: 32 },
  saltBytes: 16,
  targetMs: 700,
} as const

/** Жёсткие клампы. Значения из wrap-записи, выходящие за границы, — ОШИБКА, а не исполнение. */
export const KDF_LIMITS = {
  argon2id: { mMax: 262_144 /* 256 MiB */, mMin: 8_192, tMax: 8, tMin: 1, pMax: 4, pMin: 1 },
  pbkdf2:   { iMax: 5_000_000, iMin: 100_000 },
  algAllow: ['none', 'argon2id', 'pbkdf2-sha256'] as const,
} as const
```

Без клампов сервер (или держатель ссылки через `PUT /wrap`) кладёт `m = 4 GiB, t = 999` и
получает гарантированный OOM или зависание на телефоне партнёра — DoS одной строкой.

Argon2id грузится ленивым wasm-чанком (~20 КБ gz) **только** при наличии пароля.
PBKDF2-путь обязателен, протестирован и выбирается, если `WebAssembly` недоступен;
на старом iOS Safari 64 MiB могут не выделиться — тогда честный откат с записью в wrap.

Скорость подбора на одной RTX 4090: PBKDF2-600k ≈ 1.75·10⁴ паролей/с; Argon2id 64 MiB × 3
ограничен пропускной способностью памяти (~384 MiB трафика на кандидат при ~1 ТБ/с)
≈ 1.2·10³ паролей/с. Выигрыш ×14.

| энтропия | 1×4090 | 100×4090 |
|---|---|---|
| 30 бит (обычный человеческий) | 10 дней | 2.5 часа |
| 44 бита (4 слова из 2048) | 465 лет | 4.7 года |
| **55 бит (5 слов из 2048)** | **9.5·10⁵ лет** | **9.5·10³ лет** |

Вывод не про KDF: **KDF не спасает слабый пароль, спасает энтропия.** Поэтому пароль
**генерируется приложением** — 5 слов из русского списка 2048 = 55 бит.

```ts
export interface GeneratedPassphrase { words: string[]; text: string; bits: number }
export function generatePassphrase(wordCount?: number): GeneratedPassphrase  // default 5
export interface PasswordStrength { bits: number; verdict: 'reject' | 'weak' | 'ok' | 'strong' }
export function estimatePassword(pw: string): PasswordStrength  // < 40 бит → 'reject'
```

Поле «придумать свой» есть, ниже 40 бит — отказ с объяснением.
Нормализация: `password.normalize('NFKC')`; обрезаются только `\n`/`\r` от копипасты.

### Хранение пароля на устройстве

При `mode: 'password'` в IndexedDB лежит **только** `wrap`. Расшифрованный `K_doc` живёт в
памяти сессии. На холодном старте спрашивается пароль. Галочка «запомнить на этом устройстве»
явная; при ней в `secrets` кладётся `K_doc`, и рядом честный текст: «на этом устройстве
планер будет открываться без пароля». Хранить сырой секрет рядом с non-extractable
`CryptoKey` и называть это защитой — театр.

## 5.5 Wrap-record и защита от отката

```ts
export type KdfParams =
  | { alg: 'none' }
  | { alg: 'argon2id'; m: number; t: number; p: number; salt: string /* b32 */ }
  | { alg: 'pbkdf2-sha256'; i: number; salt: string /* b32 */ }

export interface WrapRecord {
  v: 1
  /** Монотонный. Увеличивается на 1 при каждой смене. Защита от отката сервером. */
  wrapVer: number
  kdf: KdfParams
  nonce: string   // b32, 12 байт (единственное место со случайным nonce — записей единицы)
  ct: string      // b32, 48 байт = K_doc(32) + tag(16)
}
```

Wrap хранится на сервере, и сервер видел все прошлые версии. Отдав клиенту прежнюю запись
с `kdf.alg = 'none'` (валидную обёртку того же `K_doc` под KEK0), сервер снимает второй
фактор. Клиенту нечем это отличить.

**Правила клиента (все три обязательны):**

1. Максимальный виденный `wrapVer` хранится локально **и** дублируется в подписанном
   пакете `DocMeta` внутри лога. Запись с меньшим `wrapVer` — отказ, громкая ошибка
   `WrapRollback`, а не тихое принятие.
2. Понижение `kdf.alg` с `argon2id`/`pbkdf2-sha256` на `none` при том же или меньшем
   `wrapVer` — отказ. Легальное снятие пароля всегда увеличивает `wrapVer`.
3. Параметры KDF клампятся по `KDF_LIMITS` **до** запуска вычисления.

Операции с паролем меняют только wrap-record и **не меняют ссылку** — партнёру не нужно
пересканировать QR:

```ts
setPassword(session, pw): Promise<WrapRecord>
changePassword(session, cur, next): Promise<WrapRecord>
removePassword(session, cur): Promise<WrapRecord>
```

Честное предупреждение в UI при смене/снятии: «Тот, кто уже открывал планер, доступ не
потеряет. Пароль защищает только от того, кто получит ссылку в будущем.»

Кому нужна **настоящая** граница, а не косметика — отдельная кнопка
«Сменить пароль с отсечкой»: ротация `K_doc`, перешифрование снапшота, новое поколение.
Старые локальные реплики партнёра при этом всё равно остаются у него (§4.7.2 п.1).

## 5.6 Файл-ключ и восстановление

```ts
/** Возвращает содержимое recovery-файла. По умолчанию ЗАШИФРОВАН парольной фразой. */
export function exportRecovery(session: DocSession, opts: {
  protect: { mode: 'passphrase'; passphrase: string } | { mode: 'plain' }
}): Promise<{ filename: string; body: string }>
```

По умолчанию `mode: 'passphrase'` со сгенерированной фразой: иначе файл с `K_link` уезжает
в iCloud/OneDrive открытым текстом вместе с папкой «Загрузки». Выбор `plain` требует
подтверждения с текстом «этот файл — полный доступ к планеру; храните как ключ от квартиры».

Ключи LLM-провайдеров в recovery **не входят** и в экспорт документа **не входят**.

## 5.7 QR

```ts
export interface QrPlan { text: string; bytes: number; version: number; modules: number; ecc: 'L'|'M'|'Q' }
/** Считает без генерации картинки — UI заранее знает размер и не рисует нечитаемое. */
export function planQr(link: string, ecc?: 'L'|'M'|'Q'): QrPlan
```

Каноническая ссылка = 98 байт → ECC M → **version 6, 41×41 модуля**. Уверенно снимается с
экрана телефона с 10 см и печатается размером 25 мм. Кириллический домен дал бы 109 байт,
version 7 (45×45), и часть сканеров калечит IDN — поэтому §1.3.

QR рисуется локально (SVG), энкодер (~4 КБ) грузится ленивым чанком вместе с шитом
«Поделиться». Тёмные модули — `--e-fg`, поле — `--e-surface`, тихая зона 4 модуля.

## 5.8 Ротация: что возможно и что нет

| Операция | Возможно | Что реально происходит |
|---|---|---|
| Сменить/снять пароль | да | перезаворачивается wrap-record, ссылка та же, `wrapVer++` |
| Удалить документ с сервера | да | подписанный DELETE → тумбстон, окно восстановления 7 дней (§8.10) |
| Перевыпустить документ | да | новый docId + K_link + K_doc; состояние переносится открытым текстом на клиенте |
| Отозвать доступ у того, у кого была ссылка | **нет** | он видел открытый текст и, вероятно, имеет локальную реплику |
| Узнать, у кого есть ссылка | **нет** | аккаунтов нет |
| Помешать бывшему партнёру работать со своей копией | **нет** | это его данные на его устройстве |

```ts
export interface RekeyResult { oldDocId: DocId; next: DocumentKeys; link: string }
/**
 * carryOver: true  — в старый документ пишется Forward-пакет с новой ссылкой (плановый переезд
 *                    вместе с партнёром). Отзыва доступа при этом НЕ происходит.
 * carryOver: false — старый документ тумбстонится.
 */
export function rekeyDocument(session: DocSession, opts: { carryOver: boolean; deleteOld: boolean }): Promise<RekeyResult>
```

Текст в UI, не мелким шрифтом:

> Ссылка — это и есть ключ. Отозвать её нельзя: тот, кто её открывал, уже скачал содержимое
> к себе, и может стереть или переписать серверную копию. Что можно: сделать новый планер
> с новой ссылкой и удалить старый. Всё, что человек уже видел, останется у него.

**Решено против чего.**
Против `#p=<pepper>` и деривации docId из пароля (backend §0.2) — ревью 1: офлайн-оракул.
Против немедленного `replaceState` (crypto §9.2, client-core §4.3) — ревью 2 п.14: ключ
исчезал раньше, чем человек успевал его сохранить. Против шаринга постоянной ссылки как
основного пути (все спеки) — ревью 1: введено одноразовое приглашение. Против
незащищённого `exportRecovery` (crypto §9.5) — ревью 1.

---

# 6. Слияние правок и парный режим — алгоритм целиком

## 6.1 Выбор механизма

**Свой операционный лог (delta-log CRDT) на LWW-регистрах с гибридными логическими часами.**
Не Yjs, не Automerge, не Loro.

| | LWW плоский | **Свой оп-лог** | Yjs | Automerge 2 |
|---|---|---|---|---|
| вес рантайма (gzip) | ~1 КБ | **~6 КБ** | ~33 КБ + y-protocols ~4 + провайдер ~3 | ~1.1 МБ wasm |
| работа через слепое реле | да | **да** | да | да |
| сходимость при любом порядке доставки | да | **да** | да | да |
| порядок при параллельных перестановках | ломается | **дробный индекс** | Y.Array, интерливинг возможен | корректно |
| посимвольное слияние текста | нет | **нет** (LWW + сохранение проигравшей версии) | да | да |
| «удаление против правки» | своя | **своя, явная** | Y.Map воскрешает поле | писать руками |
| отладка при «у нас разошлось» | тривиально | **тривиально: лог — JSON** | бинарный формат | бинарный + wasm |
| предложения агента как объекты | руками | **естественно: `Op[]`** | теневой документ | теневой документ |
| риск | потеря правок | ~600 строк, которые нельзя «почти правильно» | зависимость, которую не выкинуть | вес недопустим |

Три причины по убыванию веса:

1. **Семантика важнее алгебры.** Главные конфликты в планере — не «две буквы в одном слове»,
   а «я отметил задачу сделанной, а ты её удалил» и «мы оба перетащили её в разные списки».
   Yjs решает алгебру и не решает эти вопросы: их всё равно писать руками поверх. То есть Yjs
   добавляет 40 КБ и не снимает ни одной строчки прикладного кода.
2. **Вес.** Оболочка продаётся как «открыл по ссылке, работает на телефоне мгновенно».
   40 КБ — это больше бюджета первой отрисовки целиком (§1.4).
3. **Предложения агента.** Proposal — это буквально «список операций, ещё не применённых».

**Где сознательно проигрываем:** одновременная правка длинной заметки двумя людьми. Смягчение:
поля `long: true` сохраняют проигравшую версию в `cell.c[]` и показывают человеку чипом
«версия партнёра» (§12.7 — этот чип **нарисован**, а не только описан). В v2 — опциональный
ленивый плагин `@elementar/core/text-crdt` (RGA поверх той же оп-модели, ~3 КБ) под флагом
`f.text({ long: true, collab: true })`; API не меняется.

**Из интерфейса убрано обещание посимвольного соредактирования**, которое было в дизайн-спеке
(«ввод чужого текста в реальном времени показывается, это CRDT-текст»). Обещание, которое
техника не выполняет, не даётся.

## 6.2 Гибридные логические часы

```ts
export interface Hlc { wall: number; ctr: number; actor: ActorId }

export class Clock {
  constructor(actor: ActorId, persisted?: { wall: number; ctr: number })
  now(): Hlc
  observe(remote: HlcString): void
  tick(): HlcString
  readonly drift: number   // насколько наши часы отстают от увиденных чужих, мс
}
```

```
now():
  pt = Date.now()
  if pt > wall:  wall = pt; ctr = 0
  else:          ctr = ctr + 1
  if ctr > 0xFFFF: wall = wall + 1; ctr = 0        // переполнение — см. ниже
  return { wall, ctr, actor }

observe(r):
  pt = Date.now()
  wall' = max(wall, r.wall, pt)
  if wall' == wall == r.wall: ctr = max(ctr, r.ctr) + 1
  else if wall' == wall:      ctr = ctr + 1
  else if wall' == r.wall:    ctr = r.ctr + 1
  else:                       ctr = 0
  if ctr > 0xFFFF: wall' = wall' + 1; ctr = 0
  wall = wall'
```

**Переполнение счётчика обязательно.** `hex4(ctr)` — 16 бит; при импорте `.elementar`
на 70 000+ операций, попадающих в одну миллисекунду, счётчик переполняется и HLC
перестают быть уникальными. Правило «`ctr > 0xFFFF` → `wall++`, `ctr = 0`» закрывает это
и не ломает монотонность.

Кодирование, лексикографически сортируемое и одновременно являющееся `OpId`:

```
encode({wall, ctr, actor}) = hex12(wall) + '-' + hex4(ctr) + '-' + actor
// "0193f1a2b3c4-0007-k3f9x1m2" → 26 символов
```

Тотальный порядок — сравнение строк; тай-брейк по актору встроен в хвост.

Кривые часы: если `r.wall − Date.now() > 5 мин`, операция принимается (иначе разойдёмся),
но `drift` растёт и UI один раз показывает «часы на этом устройстве отстают» — на практике
это единственная причина, по которой правки будут проигрывать необъяснимо.

## 6.3 Серверное время не участвует в порядке — никогда

В backend-спеке `deltas.ts` — серверное время приёма, и оно же попадало в лог как атрибут
дельты. Офлайн-правка трёхдневной давности при синке получает более поздний `ts`, чем
сегодняшняя правка партнёра: при любом LWW офлайн-устройство всегда выигрывает. Это ровно
сценарий «телефон мужа был офлайн с воскресенья» и прямое нарушение жёсткого требования №4.

**Правило, зафиксированное в коде и в тесте:**

> `seq` и `ts` из транспортного кадра — метаданные доставки. Они используются для
> «докачать с позиции N» и для метрик и **никогда** не участвуют в разрешении конфликтов.
> Порядок задаётся `Op.i` (HLC) внутри шифротекста; тай-брейк — по `actor` в хвосте HLC.

Тест `ordering-offline.test.ts`: правка офлайн-устройства трёхдневной давности, доставленная
сегодня, **не** перебивает более свежую правку партнёра.

## 6.4 Дробный индекс порядка

```ts
export function keyBetween(a: OrderKey | null, b: OrderKey | null, actor: ActorId): OrderKey
export function keysBetween(a: OrderKey | null, b: OrderKey | null, n: number, actor: ActorId): OrderKey[]
export function needsRebalance(keys: OrderKey[]): boolean   // true, если max длина > 48
```

Алфавит base-62 (`0-9A-Za-z`), midpoint как в LexoRank. К каждому ключу приписывается
`#actorId` — два клиента, вставившие «между теми же соседями» офлайн, получают **разные**
ключи, обе записи выживают, порядок между ними детерминирован у обоих (сравнение actor).

Сортировка: `(orderKey, recordId)` — второй компонент для записей без ключа.

Ребаланс: при `needsRebalance` клиент с открытым документом и связью один раз переписывает
ключи всей группы одним пакетом `o`-операций. Редкое событие; параллельный ребаланс у двоих
сойдётся к одному из двух вариантов по HLC. У офлайн-партнёра он приедет пачкой и визуально
перетряхнёт список — это принятая цена, список подсвечивается как «перестроен».

## 6.5 apply: инвариант

```ts
export function apply(state: DocState, op: Op): { state: DocState; changes: ChangeSet }
```

**Коммутативна, ассоциативна, идемпотентна.** Повторная доставка старой операции ничего не
портит: `if (op.i <= cell.t) return unchanged`. Отсюда: не нужны векторные часы, причинный
буфер и граф версий; сервер может отдавать операции в любом порядке и сколько угодно раз.

Порядок проверок внутри `apply`:

```
1. if (op.i <= state.purgedBefore && записи нет) → отбросить (§6.7)
2. rec = state.col[op.c][op.r] ?? создать пустую с cre = op.i
3. по виду операции:
   's'      : для каждого поля — if (op.i > cell.t) записать, старое → cell.c[] при keepConflicts
              иначе — if (keepConflicts && op.i > младшей из c[]) положить в c[]
   'd'      : rec.del = max(rec.del, op.i)
   'u'      : rec.und = max(rec.und, op.i)
   'o'      : rec.o / rec.g по тому же правилу LWW
   'g+'/'g-': OR-Set: e[el] = max(e[el], op.i) / x[el] = max(x[el], op.i)
   'm'      : мета документа, LWW
4. rec.upd = max(rec.upd, op.i)
5. вернуть ChangeSet: { created, updated: Map<recordId, field[]>, deleted, moved, restored }
```

Живость записи: `alive = rec.del == null || (rec.und != null && rec.und > rec.del)`.

## 6.6 Разрешение конфликтов по случаям

**(a) Правка против правки одного поля.** Побеждает больший HLC. При `keepConflicts`
(по умолчанию все `long: true`) проигравшее значение уходит в `cell.c[]` (кольцо на 3).
В UI — чип «версия партнёра» под полем; тап показывает обе, выбор пишет операцию `s` и
чистит `c`. Любая правка этого поля человеком чистит `c` автоматически: человек видел поле,
значит решил.

**(b) Удаление против правки — удаление побеждает всегда**, независимо от HLC. Правка,
пришедшая после удаления, применяется к ячейкам (не теряется), но запись остаётся мёртвой.
Она видна в «Недавно удалённых» с пометкой «партнёр правил после удаления» и кнопкой
«Вернуть» (операция `u` с текущим HLC → `und > del` → запись жива).
Причина: правило «правка воскрешает» даёт зомби (жена стёрла три пункта, у мужа они всплыли
через час) — худший из возможных багов для доверия к парному режиму.

**(c) Перестановка против перестановки.** Обе пишут `o` (и, может, `g`), побеждает больший
HLC. Дубликатов позиции нет по построению (ключ содержит actor), потерянных записей нет.
Худший исход — «я перетащил, а через секунду прыгнуло»: заметно, объяснимо, исправимо.
UI подсвечивает переехавшую строку 800 мс.

**(d) Перенос контейнера против правки полей.** Ортогонально: `g` и `f.title` — разные ячейки.
Перенос «в список» против переноса «в проект» — **одна и та же ячейка** благодаря `f.tagged`
(§3.4), поэтому побеждает ровно один, и состояния «и там, и там» не существует.

**(e) Оба создали «одно и то же».** Две записи с разными RecordId. Дедуп не автоматический:
слой «связной» может предложить объединить (proposal), человек подтверждает. Молча склеивать
нельзя.

**(f) Множества (OR-Set).** Элемент жив, если `add.t >= rem.t`.

**(g) Разные версии схемы.** Неизвестное сохраняется (§3.7). Если `state.schema >
def.schemaVersion + 2`, документ переводится в режим только чтения с просьбой обновить
приложение — единственный случай, когда парный режим блокируется, и он громкий.

**(h) Повторяющиеся задачи.** См. §6.9 — специального кода слияния нет.

**(i) Undo против свежей правки партнёра.** См. §6.10.

## 6.7 Чистка надгробий: водяной знак вместо часов

Исходное правило «чистка надгробий старше 30 дней, локальная и детерминированная по времени»
ломает сходимость: она детерминирована по `del.t`, но **триггерится локальным `Date.now()`**.
Устройство А почистило надгробие на 31-й день, устройство Б ещё нет и досылает старую правку
по этой записи → у А `apply` создаёт запись заново, живой, без надгробия. Зомби. Плюс
приёмочный критерий «состояния совпадают побайтово» не выполняется ни разу, если хоть одно
надгробие пересекло границу 30 дней между устройствами.

**Решение — водяной знак в самом состоянии:**

```ts
// packages/core/src/doc/purge.ts
export function purgeTombstones(state: DocState, upto: HlcString): DocState
```

Правила:

1. `DocState.purgedBefore: HlcString` — часть состояния, попадает в снапшот, синхронизируется.
2. Обновляется **только** вместе с записью снапшота и **только** до
   `min(HLC, подтверждённый всеми известными акторами)` — то есть до границы, за которой
   ни один участник не может прислать ничего нового.
3. Кандидаты на чистку: записи с `del != null && del < purgedBefore && (und == null || und < del)`.
4. `apply` отбрасывает операции по записям, которых нет и у которых `op.i <= purgedBefore`.
5. `purgedBefore` при слиянии двух состояний берётся как **max** (§6.8).

Тогда две машины сходятся побайтово независимо от того, кто когда чистил, и зомби невозможен.
Property-тест обязателен (§6.13, тест 5).

Граница «известных акторов» берётся из `_actors` и из подтверждений `ack` — консервативно:
если актор не подтверждал ничего 90 дней, он выбывает из расчёта, и об этом пишется в журнал.

## 6.8 mergeState — обязательная функция, которой не было

Протокол предусматривает загрузку чужого снапшота (клиент вернулся через месяц, лог за
это время срезан). Такой клиент обязан **слить** чужой снапшот со своим локальным состоянием,
где лежат неотправленные правки. В API исходного ядра была только `apply(state, op)`.

```ts
// packages/core/src/doc/merge.ts
export function mergeState(a: DocState, b: DocState): DocState
```

Алгоритм — поячеечно, чисто, без побочных эффектов:

```
corpus/schema: должны совпадать; schema = max, при разнице > 2 → BLOCKED
meta:          по каждому ключу — Lww с большим t; проигравший → c[] при keepConflicts
col:           объединение по коллекциям и recordId
  для записи, присутствующей в обоих:
    f[field]: Lww → больший t; c[] = топ-3 по t из объединения проигравших
              OrSet → e/x поэлементно max по HLC
    o, g:     Lww → больший t
    del, und: max по каждому
    cre:      min (запись создана тогда, когда её создали раньше)
    upd:      max
  для записи, присутствующей только в одном:
    если её cre < max(purgedBefore) → отбросить (она уже вычищена у другого)
    иначе                            → взять как есть
purgedBefore:  max(a, b)
chainHead:     не сливается — берётся из того состояния, чей seq больше; расхождение
               голов при равном seq = сигнал форка (§6.11)
seq:           max
applied:       0 (после merge всегда пишется снапшот)
```

Свойства, проверяемые тестом: `mergeState` коммутативна, ассоциативна, идемпотентна и
**эквивалентна применению всех операций**:

```
mergeState(snapshot(ops[0..k]), applyAll(ops[k+1..n])) ≡ applyAll(ops[0..n])
```

## 6.9 Повторяющиеся задачи: детерминированный идентификатор

Правило из дизайн-спеки («после merge две задачи с одинаковыми `seriesId` и `date` и обе
`!done` → остаётся с меньшим id») — это мутация, порождаемая слиянием, поверх ядра, которое
требует чистого коммутативного `apply`. И оно не работает там, где нужно: муж отметил
ежедневную задачу в понедельник (следующая — вторник), жена офлайн отметила её же во вторник
(следующая — среда). Даты разные → дедуп молчит → пара получает две ветки повтора навсегда.

**Решение — сделать так, чтобы дубликат не мог возникнуть:**

```ts
// packages/core/src/id.ts
/** Детерминированный recordId экземпляра серии. HMAC-SHA256, усечение до 16 base62. */
export function seriesRecordId(seriesId: RecordId, occurrenceIndex: number): RecordId
```

При выполнении повторяющейся задачи создаётся следующий экземпляр с
`id = seriesRecordId(seriesId, occurrenceIndex + 1)`. Оба супруга, отметив одну и ту же
задачу офлайн, создают запись с **одним и тем же id** — обычный LWW склеивает их без единой
строчки специального кода. `occurrenceIndex` — порядковый номер повторения, а не дата,
поэтому расхождение в вычисленной дате не разводит ветки: победит одна дата по HLC.

Для этого `TxCollection.create` принимает необязательный `id` (он всё равно нужен для
импорта и для принятия предложений агента).

Дедуп из слияния **удалён целиком**.

## 6.10 Undo с проверкой владения ячейкой

Undo реализуется обратной операцией с **текущим** HLC (иначе он не сойдётся). Отсюда дыра:
Аня переносит задачу на среду, Виктор через 5 секунд жмёт Cmd+Z, отменяя своё вчерашнее
действие по той же ячейке → его операция с бо́льшим HLC затирает среду. Формально
«только свои действия», фактически потеря чужой правки.

**Правило (случай (i) в §6.6):**

> Перед записью обратной операции сравнить `actor`, зашитый в `cell.t`, с собственным
> `actorId`. Если ячейку последним писал не я — этот шаг undo **не выполняется**;
> показывается «Аня изменила это после вас», шаг снимается со стека, стек не рушится.

```ts
export interface UndoHandle {
  can: ReadonlySignal<boolean>
  canRedo: ReadonlySignal<boolean>
  undo(): UndoResult
  redo(): UndoResult
}
export type UndoResult =
  | { ok: true; label: string }
  | { ok: false; reason: 'empty' | 'foreign-cell'; by?: ActorId; field?: string }
```

Тест: **undo никогда не понижает и не перезаписывает ячейку, последним писавшим в которую
был другой актор.**

Отдельный случай — undo принятия предложения агента после того, как партнёр уже поправил
одну из принятых задач: те записи, чьи ячейки партнёр трогал, остаются; остальные удаляются;
тост сообщает «вернул 5 из 7, две изменила Аня».

## 6.11 Хеш-цепочка лога: детекция форка и придерживания

Сервер может выборочно придерживать дельты одному из двоих: муж и жена видят разные версии
плана переезда и оба уверены, что синхронизированы. Исходные спеки называли это «отказом в
обслуживании» — это атака на целостность, и она бьёт ровно в жёсткое требование №4.

**Формат.** В открытый текст каждого `OpBatch`-пакета кладётся голова цепочки на момент
создания:

```
plaintext(OpBatch) = prevHead(32) ‖ json(Op[])
newHead = SHA-256( prevHead ‖ sha256(json(Op[])) )
```

Снапшот фиксирует `chainHead` на `baseSeq`.

**Проверка на клиенте (`sync/chain.ts`):**

```ts
export interface ChainState { head: string; bySeq: Map<number, string> }
export type ChainVerdict =
  | { ok: true; head: string }
  | { ok: false; kind: 'gap' | 'fork'; atSeq: number; expected: string; got: string }

export function verifyChain(prev: ChainState, batch: DecryptedBatch[]): ChainVerdict
```

* `gap` — пришёл пакет, чей `prevHead` не равен нашей голове: сервер что-то придержал
  или отдал не всё.
* `fork` — два разных пакета заявляют один и тот же `prevHead` при разных `newHead`
  и это не параллельная ветка от одного момента, а расхождение после схождения.

Параллельные ветки (двое писали офлайн одновременно) — **норма**: цепочка сходится, когда
оба батча применены и следующий пакет ссылается на общую голову. Поэтому проверка
формулируется как «голова достижима», а не «голова равна».

**Сверка между партнёрами.** Текущая голова обменивается в presence-пакете (§6.14) —
шифрованном, сервер её не видит и не может подделать. Если у двоих онлайн-пиров головы
не сходятся дольше 60 секунд при пустых outbox — громкий баннер:

> «Сервер отдаёт неполную историю. Часть правок партнёра может быть не видна.
>  Проверьте связь; если не пройдёт — сделайте экспорт.»

Цена: 32 байта на пакет. За детектируемость форка — приемлемо.
Отдельный экран отладки «сверить контрольную сумму состояния с партнёром» показывает
`stateHash(state)` (§3.10) — его можно сравнить голосом.

## 6.12 Сводка «пока вас не было» вместо потока тостов

Дизайн-спека показывала конфликты тостами по 6 секунд и вычеркнула корзину. На главном
сценарии это разваливается: приёмка — двое офлайн, по 20 правок каждый, включая удаления
того, что правит другой. После слияния прилетит восемь тостов, из которых человек увидит
максимум три, а потом информация исчезнет навсегда.

**Два механизма вместо одного:**

1. **Тост** — только для правок, пришедших в течение сессии, когда человек смотрит на экран,
   и только для тех, что перебили его собственную правку в последние 10 секунд.
   «Аня перенесла задачу на среду» + «Вернуть».
2. **Шит «Пока вас не было»** — при выходе из фазы `CATCHUP`, если применено больше
   `DIGEST_THRESHOLD = 5` чужих операций:

```ts
// packages/core/src/sync/digest.ts
export interface CatchupDigest {
  since: number                 // epoch ms последнего онлайна
  byActor: Array<{ actor: ActorId; name: string; created: number; updated: number; deleted: number }>
  items: Array<{
    kind: 'created' | 'updated' | 'deleted' | 'moved'
    collection: string; recordId: RecordId; label: string
    fields?: string[]; by: ActorId
    /** Правка по записи, которую этот человек редактировал офлайн. */
    conflictedWithMine: boolean
  }>
}
export function buildDigest(changes: ChangeSet[], state: DocState, mine: ActorId): CatchupDigest
```

Шит: «Пока вас не было: Аня добавила 4, изменила 7, удалила 3» + список + «Вернуть» у каждой
строки. Это переживает офлайн-слияние, а тост нет.

3. **Экран «Недавно удалённые»** возвращён (это `ListView` + `Row`, полдня работы) и является
   приёмочным критерием парного режима.

```ts
export interface Trash<S> {
  items: ReadonlySignal<readonly TrashItem[]>
  restore(collection: keyof S & string, id: RecordId): void
  purge(collection: keyof S & string, id: RecordId): void
  purgeAll(): void
}
export interface TrashItem {
  collection: string; id: RecordId; label: string
  deletedAt: HlcString; deletedBy: ActorId
  byPeer: boolean               // удалил не я
  editedAfterDelete: boolean    // кто-то правил после удаления
}
```

Формулировка в списке «чего не делаем» меняется на: **«истории версий нет, корзина есть»**.

## 6.13 Property-тесты слияния — обязательны до первого релиза парного режима

`packages/core/src/doc/__tests__/converge.prop.test.ts`, vitest + fast-check:

1. **Сходимость.** Для случайного набора операций любые две перестановки дают побайтово
   равные `DocState` после `canonicalize`.
2. **Идемпотентность.** Применение набора дважды = один раз.
3. **Дельта-эквивалентность.** `snapshot(ops[0..k]) + ops[k+1..n] ≡ apply(ops[0..n])`.
4. **mergeState.** Коммутативна, ассоциативна, идемпотентна, и
   `mergeState(snapshot, local) ≡ applyAll(all ops)`.
5. **Чистка надгробий.** Две машины с разным временем чистки сходятся побайтово;
   ни при каком расписании чистки не возникает живой записи, ранее удалённой.
6. **Ровно один контейнер.** После любой перестановки операций у каждой задачи ровно одно
   значение `bucket`, и нет живой записи, не видимой ни на одном экране (включая `ORPHAN`).
7. **Симуляция пары.** Два актора, случайные разделения и склейки офлайн-периодов;
   инварианты: нет дублей в списке, нет живых записей без ключа порядка, нет зомби после `d`,
   нет двух живых экземпляров одной серии повтора.
8. **Порядок и офлайн.** Правка трёхдневной давности не перебивает свежую правку партнёра.
9. **Undo.** Undo не перезаписывает чужую ячейку.
10. **Golden-файлы forward-compat.** Лог, записанный «старой» схемой, применяется новой и
    наоборот; неизвестные поля переживают round-trip.

**Приёмка парного режима — не юнит-тест, а сценарий:** два браузера, обоим выключить сеть,
у каждого 20 правок (включая удаление того, что правит другой, и перетаскивания), включить
сеть, дождаться `LIVE` → `stateHash` совпадает, шит «Пока вас не было» и экран «Недавно
удалённые» объясняют человеку, что произошло.

## 6.14 Парный режим: присутствие и авторство

### Имена — в документе, не в протоколе

Сервер отдаёт только число пиров и непрозрачные блобы. Имя партнёра берётся из служебной
коллекции `_actors` **внутри документа** (§3.9): она шифруется и синхронизируется, сервер
её не видит.

```ts
interface ActorRecord {
  id: ActorId
  name: string           // '' = «Кто-то»
  lastSeenAt: number
  mergedInto?: ActorId   // связь после переустановки, см. ниже
}
```

**Слот цвета вычисляется, а не присваивается:** `slot = sorted(aliveActorIds)[0] === id ? 'a' : 'b'`.
Императивное «третий вошедший получает b» не сходится: два устройства офлайн оба возьмут 'a'.

**Переустановка и выселение хранилища.** `actorId` генерируется один раз и кладётся в
`_actors` вместе с именем. Если появляется новый актор с тем же именем, приложение
предлагает: «Это то же устройство Ани?» → пишется `mergedInto`, и атрибуция не рассыпается
на «Кто-то». Автоматически ничего не склеивается.

### Присутствие — шифрованный эфемерный блоб

```ts
// сообщение WS, ретранслируется DO по комнате, TTL 30 c, НЕ хранится
{ t: 'pres', ct: B32 }   // ct = EL1-пакет типа Presence, ≤ 256 байт

// открытый текст внутри:
interface PresencePayload {
  actor: ActorId
  view: { kind: 'list'; list: string } | { kind: 'project'; id: RecordId }
       | { kind: 'calendar' } | { kind: 'today' }
  editing: RecordId | null
  chainHead: string     // для сверки §6.11
  at: number
}
```

Сервер видит 256 байт непонятно чего и число пиров. Слепота сохраняется, а «Аня — в списке
Быт» и подсветка правящейся строки становятся исполнимыми. Heartbeat 15 с, TTL 30 с.

### Что показывается и что нет

* Присутствие — **два средства и только они**: цветная точка-аватар в шапке и мягкая
  подсветка строки, которую партнёр правит сейчас.
* **Никаких живых курсоров, «печатает…», ленты активности, счётчика «онлайн 2».**
* Авторство асимметрично: своё — никогда; чужое непрочитанное — точка 6px цвета партнёра
  (гаснет, когда строка была на экране ≥ 1 с, по IntersectionObserver, не по клику);
  чужое прочитанное — только в карточке задачи.
* «Кто открывал: 2 устройства» из дизайн-спеки **заменено** на «Правили: 2 устройства» —
  считаются уникальные акторы в локальном логе. Сервер историю присутствия не хранит и не отдаёт.

**Решено против чего.**
Против Yjs/Automerge — вес и отсутствие прикладной семантики. Против серверного `ts` в
разрешении конфликтов (backend §3.1/§4.1) — ревью 1: офлайн всегда выигрывает.
Против локальной чистки по часам (client-core §5.4) — ревью 2 п.7: зомби и расхождение.
Против дедупа повторов в слиянии (design §6.3) — ревью 2 п.8: детерминированный id.
Против «сервер отдаёт только число пиров» (client-core §6.4) при требовании имён в UI
(design §8.1) — ревью 2 п.5: `_actors` + шифрованный presence. Против тостов как
единственного канала (design §8.3) — ревью 2 п.6: сводка и корзина.

---

# 7. Локальное хранилище и sync-движок

## 7.1 IndexedDB

Одна база `elementar` на всё приложение (одно происхождение, один scope — §13.1),
версия целым числом, лестница миграций.

| store | keyPath | индексы | содержимое |
|---|---|---|---|
| `docs` | `docId` | `by_opened` (lastOpenedAt), `by_corpus` | карточка: corpus, title (локально открытым текстом), schemaVersion, seq, lastOpenedAt, pinned, sync-настройки, linkPersistState |
| `snapshots` | `[docId, seq]` | `by_doc` (docId) | `{ docId, seq, state: DocState, savedAt }` — structured clone, без JSON.stringify |
| `ops` | `[docId, i]` | `by_seq` `[docId, seq]` | применённые операции хвоста лога (свои и чужие) |
| `outbox` | `[docId, i]` | `by_next` `[docId, nextAt]` | `{ op, ct, tries, nextAt }` — исходящие |
| `secrets` | `docId` | — | `{ mode: 'plain' \| 'password', linkSecret?: ArrayBuffer, wrap: WrapRecord, wrapVer: number, sigAlg }` |
| `blobs` | `[docId, blobId]` | — | вложения + метаданные, зеркало R2 |
| `settings` | `key` | — | глобальное устройства: actorId, тема, язык, провайдеры LLM и ключи, флаги |
| `journal` | auto | `by_time` | последние 200 системных событий (экран «Что случилось», багрепорты) |

`snapshots.keyPath = [docId, seq]` — потому что обещано «удерживаются 2 последних снапшота»
(защита от сбоя записи), а с `keyPath: docId` они не влезают.

Снапшот отдельным стором, а не полем в `docs`: structured clone большого объекта не должен
блокировать чтение карточек — прихожая открывается мгновенно, не читая состояний.

```ts
type IdbMigration = (db: IDBDatabase, tx: IDBTransaction) => void
export const IDB_MIGRATIONS: IdbMigration[] = [
  /* v1 */ (db) => { /* создать все восемь сторов и индексы */ },
]
export const IDB_VERSION = IDB_MIGRATIONS.length
```

Правила: миграции только аддитивные и идемпотентные; стор никогда не удаляется (Safari
склонен ронять `onupgradeneeded` на удалении); если открытие упало — база **не трётся**,
поднимается аварийный режим: документ читается из последнего снапшота в памяти, UI предлагает
экспорт.

При `mode: 'password'` поле `linkSecret` в `secrets` **отсутствует**, если человек не поставил
галочку «запомнить на этом устройстве» (§5.4).

## 7.2 Компактизация и квоты

* Снапшот перезаписывается при `applied > 400` **или** размере хвоста лога > 256 КБ,
  с дебаунсом 2 с простоя; удерживаются 2 последних.
* Локальный лог усекается до `snapshot.seq`.
* Чистка надгробий — только через `purgedBefore` (§6.7), только вместе с записью снапшота.
* `persist.ts`: при создании первого документа — `navigator.storage.persist()`;
  слежение за `navigator.storage.estimate()`; при `usage/quota > 0.8` — предупреждение и
  предложение выгрузить архив; при `persist() === false` — авто-экспорт раз в 7 дней (§5.2).

## 7.3 Конечный автомат синка

```
                 ┌───────── LOCAL ◄──── (нет сети / синк выключен)
   open()        │             ▲
 ──────► LOADING ┤             │ OFFLINE
                 │             │
                 └──► CONNECTING ──WELCOME──► CATCHUP ──drained──► LIVE
                        ▲   │                    │                  │
                 RETRY  │   │ ERROR/CLOSE        │ ERROR            │ HIDDEN>60s
                        │   ▼                    ▼                  ▼
                      BACKOFF ◄──────────────────┘               PAUSED
                        │                                           │ VISIBLE
                        └───────────────────────────────────────────┘
   ERROR(auth)   ──► DENIED     (неверный ключ / документ удалён)
   ERROR(schema) ──► BLOCKED    (документ новее клиента → только чтение)
   FORK          ──► LIVE + баннер (§6.11) — не отдельное состояние, а флаг
```

Автомат — чистая функция `reduce(state, event) → [state, Effect[]]`; эффекты
(`connect`, `send`, `schedule`, `persist`, `flushHttp`) исполняет `session.ts`.
Так автомат тестируется без сети.

События: `OPEN, LOADED, ENABLE_SYNC, DISABLE_SYNC, NET_ONLINE, NET_OFFLINE, SOCK_OPEN,
SOCK_CLOSE, WELCOME, OPS, ACK, LOCAL_OP, DRAINED, TIMER, HIDDEN, VISIBLE, PAGEHIDE,
ERR_AUTH, ERR_RATE, ERR_SCHEMA, ERR_CHAIN, ERR_OTHER, CLOSE`.

```ts
export type SyncPhase = 'loading'|'local'|'connecting'|'catchup'|'live'|'backoff'|'paused'|'denied'|'blocked'
export interface SyncStatus {
  phase: SyncPhase
  online: boolean
  pending: number                 // операций в outbox
  lastSyncedAt: number | null
  peers: number
  retryInMs: number | null
  chainWarning: boolean           // §6.11
  error: { code: SyncErrorCode; message: string } | null
}
```

Для человека это четыре слова:

| состояние | что видит человек |
|---|---|
| `LOCAL`, `BACKOFF`, `PAUSED` | «офлайн» (точка серая) |
| `CONNECTING`, `CATCHUP`, `LIVE` с `pending > 0` | «синхронизирую» (точка мигает) |
| `LIVE` с `pending == 0` | «вместе» (точка зелёная, рядом аватар партнёра) |
| `DENIED`, `BLOCKED`, `chainWarning` | «требуется внимание» + текст |

## 7.4 Транспорт и исходящая очередь

* `wss://s.elementar.app/v1/docs/:docId/ws`, подпись в субпротоколе (§8.7).
* Heartbeat: авто-ответ DO на `p`/`o` (не будит объект), клиент шлёт `p` каждые 25 с;
  нет ответа 10 с → закрыть, `BACKOFF`.
* Backoff: `min(60_000, 500 · 2^n)` ± 30 % джиттера; `n` сбрасывается после `welcome`
  и удержания соединения 30 с. При `NET_ONLINE` и `VISIBLE` — немедленная попытка.
* `visibilitychange`: скрыто > 60 с → сокет закрывается (`PAUSED`), экономия батареи.
* Ограничения: кадр ≤ 128 КБ, пачка ≤ 64 операции.

```ts
export interface OutboxItem { docId: DocId; i: HlcString; ct: string; tries: number; nextAt: number }
```

* Операция пишется в `ops` (применена локально) и в `outbox` в **одной** IDB-транзакции
  вместе с обновлением дебаунса снапшота. Пропасть между «показал на экране» и «сохранил»
  невозможна.
* Отправка пачками; `ack` удаляет элементы. Идемпотентность полная: `i` уникален,
  сервер игнорирует повтор по `(clientId, clientSeq)`, клиент — по `apply`.
* Порядок сохраняется, но не требуется.
* Умерший элемент (`tries > 12`) не выбрасывается, помечается и показывается в «Что случилось».

**Коалесценция.** Заметка сохраняется по мере ввода; при LWW на всё поле дебаунс 400 мс
даёт поток операций по 300–600 байт и выбивает порог компактизации на одной длинной заметке.

* дебаунс правки текстового поля — **1500 мс простоя** (было 400);
* `ops/coalesce.ts`: последовательные `s`-операции **одного актора** по одной паре
  `(record, field)` внутри окна 30 с схлопываются в одну — и до отправки, и до записи в лог.
  Схлопывание сохраняет HLC последней операции.

## 7.5 HTTP-путь: флаш outbox при уходе в фон

Автомат уходит в `PAUSED` и закрывает сокет, а iOS может выгрузить вкладку в любой момент.
Правки, записанные локально и не отправленные, ждали бы следующего открытия приложения —
партнёр их не видит, хотя интерфейс показал «офлайн» и человек считает, что всё в порядке.
Через WebSocket на выгрузке отправить нельзя.

```ts
// packages/core/src/sync/http.ts
/** Отправляет хвост outbox через fetch(..., { keepalive: true }). Тело ≤ 60 КБ (лимит keepalive). */
export function flushOutboxBeacon(docId: DocId, items: OutboxItem[]): void
```

Подписка в `session.ts`: `visibilitychange → hidden` и `pagehide` → `flushOutboxBeacon`.
Эндпоинт — обычный `POST /v1/docs/{id}/deltas` (§8.5), та же подпись, тот же формат кадров;
подпись считается заранее и держится готовой, чтобы на выгрузке не ждать асинхронную крипту.

Если элементов больше, чем влезает в 60 КБ, отправляется самое старое, остальное остаётся
в outbox — при следующем открытии догонит.

## 7.6 Открытие документа: порядок операций

```
1.  consumeLinkFromLocation() → { docId, linkSecret }; фрагмент НЕ стирается (§5.2)
2.  deriveLinkIdentity()      → signing identity, KEK0
3.  локальный снапшот есть?   → да: работаем офлайн немедленно (local-first), шаги 4+ параллельно
4.  GET /v1/docs/{id}         [подпись] → DocMeta { seq, snapshotSeq, snapshotGen, wrap, wrapVer }
5.  проверка wrapVer          → откат/понижение alg (§5.5) → WrapRollback, стоп
6.  wrap.kdf.alg !== 'none'?  → спросить пароль; argon2-wasm грузится ЗДЕСЬ и только здесь
7.  unwrapDocKey()            → K_doc
8.  createNonceSource()       → готовы писать (синхронно, без IO)
9.  снапшот новее локального? → GET /snapshot, decrypt, mergeState(local, remote)  (§6.8)
10. GET /deltas?since=…       → decrypt, verifyChain (§6.11), apply
11. persist { docId, linkSecret|wrap, snapshot } в IndexedDB
12. показать шит «Сохраните ссылку», если linkPersistState === 'unsaved' (§5.2)
13. WS /ws — парный режим
14. digest, если применено > 5 чужих операций (§6.12)
```

Шаг 11 означает: **устройство сохраняет доступ навсегда, даже без ссылки.** Это требование
local-first, и его надо назвать в интерфейсе: «этот планер теперь открывается с этого
устройства без ссылки».

## 7.7 Публичный API ядра

```ts
export function defineCorpus<S extends Record<string, CollectionSchema<any>>>(def: CorpusDef<S>): Corpus<S>

export interface OpenOptions {
  sync?: boolean          // по умолчанию true
  endpoint?: string
  password?: string
  readOnly?: boolean
}

export interface Corpus<S> {
  readonly id: string
  create(init?: { title?: string; seed?: (t: Tx<S>) => void }): Promise<DocHandle<S>>
  open(ref: ParsedLink | DocId, opts?: OpenOptions): Promise<DocHandle<S>>
  list(): Promise<DocCard[]>
  forget(docId: DocId): Promise<void>
}

export interface DocHandle<S> {
  readonly id: DocId
  readonly corpus: string
  readonly actor: ActorId

  readonly title: Signal<string>
  readonly meta: ReadonlySignal<Record<string, unknown>>
  readonly col: { [K in keyof S]: Collection<RecordOf<S[K]>> }

  tx(fn: (t: Tx<S>) => void, opts?: { label?: string; undoable?: boolean }): TxResult

  readonly undo: UndoHandle
  readonly sync: SyncHandle
  readonly proposals: ProposalStore
  readonly trash: Trash<S>
  readonly actors: ReadonlySignal<readonly ActorRecord[]>
  readonly presence: ReadonlySignal<readonly PresencePayload[]>
  readonly digest: ReadonlySignal<CatchupDigest | null>

  share(): Promise<{ url: string; qr: string }>
  invite(): Promise<Invite>                                   // §5.3
  setPassword(password: string | null): Promise<void>
  rotate(): Promise<RekeyResult>                              // §5.8
  exportRecovery(opts: RecoveryOpts): Promise<{ filename: string; body: string }>

  export(opts?: { withBlobs?: boolean }): Promise<Blob>
  import(file: Blob, mode: 'merge' | 'replace'): Promise<void>

  readonly _state: ReadonlySignal<DocState>
  stateHash(): string
  onChange(cb: (c: ChangeSet) => void): Unsubscribe
  close(): Promise<void>
}
```

### Коллекции и запросы

```ts
export interface Collection<T extends { id: RecordId }> {
  readonly name: string
  readonly all: ReadonlySignal<readonly T[]>       // живые, «горячие», в порядке дробного индекса
  readonly count: ReadonlySignal<number>
  byId(id: RecordId): ReadonlySignal<T | undefined>
  where(spec: Where<T>): ReadonlySignal<readonly T[]>
  group<K extends keyof T>(field: K): ReadonlySignal<ReadonlyMap<T[K], readonly T[]>>
  conflicts(id: RecordId): ReadonlySignal<Partial<Record<keyof T, unknown[]>>>
  cold(): Promise<readonly T[]>                    // холодная часть (§3.8), не сигнал
}

export type Where<T> =
  Partial<{ [K in keyof T]: T[K] | { in: T[K][] } | { not: T[K] } | { gte: T[K] } | { lte: T[K] } }>
  & { $order?: { by: keyof T; dir?: 'asc'|'desc' }; $limit?: number; $search?: string }
```

Материализация точечная: `apply` возвращает `ChangeSet`, `view.ts` обновляет только сигналы
затронутых записей и производные запросы, чьи ключи задеты.

### Транзакции

```ts
export interface Tx<S> {
  readonly col: { [K in keyof S]: TxCollection<RecordOf<S[K]>> }
  meta(patch: Record<string, JsonValue>): void
}
export type Position =
  | { at: 'start' | 'end' }
  | { before: RecordId } | { after: RecordId }
  | { group: string; at?: 'start' | 'end' }

export interface TxCollection<T> {
  /** id — необязателен; нужен для импорта, для принятия предложений и для серий (§6.9). */
  create(value: Partial<Omit<T,'id'|'createdAt'|'updatedAt'>>, pos?: Position, id?: RecordId): RecordId
  update(id: RecordId, patch: Partial<T>): void
  remove(id: RecordId): void
  restore(id: RecordId): void
  move(id: RecordId, pos: Position): void
  addTo(id: RecordId, field: keyof T & string, ...items: string[]): void
  removeFrom(id: RecordId, field: keyof T & string, ...items: string[]): void
  resolveConflict(id: RecordId, field: keyof T & string, value: unknown): void
}
export interface TxResult { ops: number; ids: RecordId[]; undoToken: string | null }
```

Валидация схемой на входе транзакции (длины, enum, варианты `tagged`, живость ссылок);
нарушение — исключение, ни одна операция не записана (транзакция атомарна в IDB).

### Preact-биндинги (`@elementar/core/preact`)

```tsx
export function DocProvider<S>(props: { doc: DocHandle<S>; children: ComponentChildren }): VNode
export function useDoc<S>(): DocHandle<S>
export function useCollection<S, K extends keyof S>(name: K): Collection<RecordOf<S[K]>>
export function useQuery<T>(sig: ReadonlySignal<readonly T[]>): readonly T[]
export function useRecord<T>(collection: string, id: RecordId): T | undefined
export function useSyncStatus(): SyncStatus
export function useProposals(): readonly Proposal[]
export function useTx<S>(): (fn: (t: Tx<S>) => void, opts?: { label?: string }) => TxResult
export function usePwa(): PwaState
```

**Решено против чего.**
Против `snapshots.keyPath = docId` (client-core §5.1) — ревью 2 п.22г. Против дебаунса
400 мс на заметке (design §7.7) — ревью 2 п.16: поток операций. Против отсутствия
HTTP-пути отправки (client-core §6) — ревью 2 п.21: правки теряются при выгрузке вкладки.

---

# 8. Бэкэнд: D1, Durable Objects, R2, эндпоинты

Один Worker (`apps/api`, `@elementar/api`), два класса Durable Object, одна база D1,
один бакет R2, один KV-неймспейс под флаги.

Правило одной фразой: **DocDO знает правду о документе, D1 знает список документов,
R2 хранит то, что не влезло в DO.**

## 8.1 Что где живёт

| Хранилище | Что лежит | На горячем пути? |
|---|---|---|
| **DocDO** (`idFromName(docId)`) | `sigPub`, `seq`, лог дельт, снапшот ≤ 256 KiB, wrap-record, sig-nonces, presence в памяти, per-doc лимиты | да |
| **LimiterDO** (256 шардов) | токен-бакеты, счётчики промахов, блоки | да, до DocDO — **но не для неизвестных id**, см. §9.3 |
| **D1** | каталог: строка на документ, TTL, размеры, очередь уборки, суточные метрики | **нет** (асинхронно, дебаунс 60 с) |
| **R2** | снапшоты > 256 KiB, три поколения, корзина срезанных дельт | только для крупных документов |
| **KV `CONFIG`** | kill-switch, флаги | читается с `cacheTtl: 60` |
| **Cache API** | «этот docId существует / точно не существует» | да, **до** LimiterDO (§9.3) |

Пороги (все — из `packages/proto/src/consts.ts`):

| Величина | Значение |
|---|---|
| дельта — максимум | 64 KiB |
| пакет дельт | 1 MiB / 256 кадров |
| снапшот inline в DO | ≤ 256 KiB (чанками по 64 KiB) |
| снапшот в R2 | > 256 KiB, до 2 MiB |
| лог — мягкий порог компакции | 200 дельт **или** 512 KiB |
| лог — жёсткий порог | 1200 дельт **или** 2.5 MiB |
| лог — потолок | 2000 дельт **или** 4 MiB → `507` |
| суммарный след документа | 12 MiB |
| поколений снапшота | 3 |
| корзина срезанных дельт в R2 | 7 дней |

## 8.2 D1: DDL

`apps/api/migrations/`, применяется `wrangler d1 migrations apply elementar-catalog`.

### `0001_init.sql`

```sql
-- Каталог документов. Ни одного байта пользовательских данных.
CREATE TABLE docs (
  id              TEXT    PRIMARY KEY,         -- docId, 20 симв. Crockford base32
  sig_alg         INTEGER NOT NULL,            -- 1 = ed25519, 2 = ecdsa-p256
  sig_pub         BLOB    NOT NULL,            -- 32 (ed25519) или 65 (p256) байт
  app             INTEGER NOT NULL DEFAULT 0,  -- 0 unknown, 1 planer, 2 finanser, …
  state           INTEGER NOT NULL DEFAULT 0,  -- 0 active, 1 tombstone, 2 frozen

  seq             INTEGER NOT NULL DEFAULT 0,
  snapshot_seq    INTEGER NOT NULL DEFAULT 0,
  snapshot_gen    INTEGER NOT NULL DEFAULT 0,
  snapshot_bytes  INTEGER NOT NULL DEFAULT 0,
  snapshot_loc    INTEGER NOT NULL DEFAULT 0,  -- 0 = внутри DO, 1 = R2
  log_count       INTEGER NOT NULL DEFAULT 0,
  log_bytes       INTEGER NOT NULL DEFAULT 0,
  total_bytes     INTEGER NOT NULL DEFAULT 0,
  wrap_ver        INTEGER NOT NULL DEFAULT 1,  -- монотонный, §5.5

  created_at      INTEGER NOT NULL,            -- unix ms
  updated_at      INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,            -- дебаунс 1 ч
  expires_at      INTEGER NOT NULL,
  deleted_at      INTEGER,                     -- тумбстон; восстановление до deleted_at + 7d
  purge_after     INTEGER                      -- физическое стирание не раньше этого момента
) STRICT;

CREATE INDEX idx_docs_gc        ON docs (state, expires_at);
CREATE INDEX idx_docs_purge     ON docs (state, purge_after);
CREATE INDEX idx_docs_last_seen ON docs (last_seen_at);
CREATE INDEX idx_docs_big       ON docs (total_bytes DESC) WHERE state = 0;

-- Очередь физической уборки.
CREATE TABLE gc_queue (
  id        TEXT    PRIMARY KEY,     -- '<docId>' или '<docId>#snap<gen>' или '<docId>#trash'
  stage     INTEGER NOT NULL DEFAULT 0,  -- 0 новый, 1 r2 очищен, 2 do очищен
  attempts  INTEGER NOT NULL DEFAULT 0,
  due_at    INTEGER NOT NULL,
  last_err  TEXT
) STRICT;

CREATE INDEX idx_gc_due ON gc_queue (due_at, stage);

-- Зеркало блокировок из LimiterDO: только для админского обзора. TTL обязателен.
CREATE TABLE abuse_blocks (
  prefix_hash   BLOB    PRIMARY KEY,   -- HMAC(pepper_дня, ip-префикс)[0..16]
  reason        INTEGER NOT NULL,      -- 1 miss-storm, 2 create-flood, 3 bytes-flood, 4 llm-flood, 9 ручной
  strikes       INTEGER NOT NULL DEFAULT 1,
  blocked_until INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,      -- физическое удаление строки, ≤ 48 ч
  updated_at    INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_blocks_expires ON abuse_blocks (expires_at);

-- Только агрегаты. Ни одного docId.
CREATE TABLE metrics_daily (
  day            TEXT    PRIMARY KEY,  -- 'YYYY-MM-DD' UTC
  docs_created   INTEGER NOT NULL DEFAULT 0,
  docs_deleted   INTEGER NOT NULL DEFAULT 0,
  docs_expired   INTEGER NOT NULL DEFAULT 0,
  deltas_in      INTEGER NOT NULL DEFAULT 0,
  bytes_in       INTEGER NOT NULL DEFAULT 0,
  bytes_out      INTEGER NOT NULL DEFAULT 0,
  ws_opens       INTEGER NOT NULL DEFAULT 0,
  compactions    INTEGER NOT NULL DEFAULT 0,
  blocks_issued  INTEGER NOT NULL DEFAULT 0,
  challenges     INTEGER NOT NULL DEFAULT 0,
  http_429       INTEGER NOT NULL DEFAULT 0,
  http_404       INTEGER NOT NULL DEFAULT 0
) STRICT;
```

### `0002_flags.sql`

```sql
CREATE TABLE flags (
  k          TEXT PRIMARY KEY,
  v          TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

INSERT INTO flags (k, v, updated_at) VALUES
  ('accept_creates', '1', unixepoch() * 1000),
  ('accept_writes',  '1', unixepoch() * 1000),
  ('llm_relay',      '1', unixepoch() * 1000),
  ('challenge_mode', '0', unixepoch() * 1000);  -- 0 авто, 1 всегда Turnstile, 2 никогда
```

Флаги дублируются в KV `CONFIG` (крон `*/5` синхронизирует), читаются с `{ cacheTtl: 60 }` —
0 запросов на горячем пути в среднем. Рубильник действует за 60 секунд.

### Чего в схеме специально НЕТ

**`create_ip_hash` и индекс `idx_docs_create_ip` удалены.** Пара «усечённый HMAC IP + индекс
по нему» — это готовый инструмент «покажи все документы, созданные с этого адреса», то есть
связывание человека с набором его документов. Пространство /24 — всего 2²⁴, перец доступен
любому с доступом к деплою, значит хеш обращается мгновенно. Это ровно отменяет усилия по
декорреляции. Счётчик создания живёт в `LimiterDO` в памяти с TTL и **не привязан к строкам
документов**.

`ELM_IP_PEPPER` **ротируется ежедневно**: рабочий перец = `HKDF(ELM_IP_PEPPER, 'YYYY-MM-DD')`.
Кросс-дневная корреляция становится невозможной.

Также нет: ни одного заголовка, названия задачи, даты, e-mail, User-Agent, сырого IP.

## 8.3 DocDO — внутреннее устройство

```sql
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v BLOB NOT NULL);
-- ключи: init, sig_alg, sig_pub, app, seq, snapshot_seq, snapshot_gen, snapshot_bytes,
--        snapshot_loc, snapshot_r2_key, log_bytes, wrap, wrap_ver, created_at, updated_at,
--        last_seen_flushed_at, state, deleted_at

CREATE TABLE IF NOT EXISTS deltas (
  seq        INTEGER PRIMARY KEY,   -- монотонный, выдаётся DO
  client_id  BLOB    NOT NULL,      -- 8 байт, случайные, на пару (устройство, документ)
  client_seq INTEGER NOT NULL,
  ts         INTEGER NOT NULL,      -- серверное время приёма; МЕТАДАННОЕ, в порядке не участвует (§6.3)
  bytes      INTEGER NOT NULL,
  payload    BLOB    NOT NULL       -- шифротекст, EL1-пакет
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_deltas_client ON deltas (client_id, client_seq);

CREATE TABLE IF NOT EXISTS snap_chunks (
  gen INTEGER NOT NULL, idx INTEGER NOT NULL, payload BLOB NOT NULL,
  PRIMARY KEY (gen, idx)
);

-- Персистентный антиреплей (§4.5). Без него хибернация обнуляет окно.
CREATE TABLE IF NOT EXISTS sig_nonces (nonce BLOB PRIMARY KEY, seen_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ix_sig_nonces_seen ON sig_nonces (seen_at);

-- Подтверждения приёма по устройствам: граница безопасной компакции (§8.9).
CREATE TABLE IF NOT EXISTS acks (
  client_id BLOB PRIMARY KEY,
  acked_seq INTEGER NOT NULL,
  at        INTEGER NOT NULL
);
```

`ux_deltas_client` — вся идемпотентность синка: переподключившийся клиент повторно шлёт
дошедшее, `INSERT OR IGNORE` глотает дубли, в `ack` возвращается ранее выданный `seq`.

Состояние в памяти (не персистится):

```ts
interface Peer {
  sessionId: string        // 8B base64url, эфемерный
  ws: WebSocket
  clientId: Uint8Array
  lastBeat: number
  presence: string | null  // ≤ 256 байт шифротекста, сервер не разбирает
}
interface DocRuntime {
  peers: Map<string, Peer>
  writeWindow: { minute: RingCounter; hour: RingCounter }
  dirty: boolean
}
```

Инварианты:

1. `seq` монотонен и никогда не переиспользуется, даже после компакции.
2. `snapshot_seq ≤ seq`; дельты с `seq ≤ snapshot_seq` могут быть срезаны (но сначала — в корзину).
3. Клиент с `since < snapshot_seq` догнать дельтами нельзя — ему `resync`.
4. Любая запись проходит через один поток DO — гонок нет по построению.
5. DO пишет в D1 только по alarm (60 с при `dirty`) и синхронно — при create/delete/freeze.

Alarm (60 с) делает четыре вещи: флаш метаданных в D1, чистка `sig_nonces` старше 300 с,
выселение пиров без heartbeat > 60 с, проверка порогов компакции. Если пиров нет и
`dirty === false` и таблица `sig_nonces` пуста — alarm не перевзводится, DO засыпает.
**Пока `sig_nonces` непуста, alarm перевзводится обязательно** — иначе окно антиреплея
не чистится и таблица растёт.

**Хибернация WebSocket обязательна.** Без `state.acceptWebSocket` DO считается активным всё
время соединения: 6 000 подключений/сут × 0.5 ч × 0.128 GB ≈ 41.5 M GB-s/мес × $12.50/M
≈ **$519/мес** против ~$0 с хибернацией. Это не оптимизация, а условие существования проекта.

## 8.4 Транспортный кадр

```
offset  size  поле
0       1     magic  = 0xE1
1       1     ver    = 0x01
2       2     count  (u16 LE)
4       ...   count × frame

frame:
+0      8     seq        (u64 LE)  0 в направлении клиент→сервер
+8      8     clientId
+16     4     clientSeq  (u32 LE)
+20     8     ts         (u64 LE, ms)  0 в направлении клиент→сервер
+28     4     len        (u32 LE)
+32     len   payload    ← EL1-пакет (§4.4), сервер его не разбирает
```

Валидация: `magic`/`ver` совпадают, `count ≤ 256`, `len ≤ 65536`, сумма `len ≤ 1 MiB`,
`payload[0..2] === 'EL1'`. Любое нарушение → `400 ELM_BAD_FRAME`, ни одного краша.
Кодек — `packages/proto/src/frames.ts`, один и тот же код на клиенте и сервере (§2.4).

## 8.5 REST API

База: `https://s.elementar.app/v1`.

**Все эндпоинты, кроме `/health` и `/challenge`, требуют подписи (§4.5).**
Анонимного чтения не существует.

Общие заголовки ответа:

```
Cache-Control: no-store
Cross-Origin-Resource-Policy: same-origin
X-Content-Type-Options: nosniff
Access-Control-Allow-Origin: https://elementar.app        (ASCII-литерал, НИКОГДА не эхо Origin)
Access-Control-Allow-Headers: content-type, x-elm-sig, x-elm-client, x-elm-base-seq, x-elm-challenge
Access-Control-Expose-Headers: x-elm-seq, x-elm-gen, x-elm-head, x-elm-quota, retry-after, etag
Access-Control-Max-Age: 86400
```

### Типы

```ts
// packages/proto/src/http.ts
export type SigAlg = 'ed25519' | 'p256'
export type B32 = string

export type ElmErrorCode =
  | 'ELM_BAD_REQUEST'     // 400
  | 'ELM_BAD_FRAME'       // 400
  | 'ELM_SIG_INVALID'     // 401
  | 'ELM_SIG_EXPIRED'     // 401
  | 'ELM_SIG_REPLAY'      // 401
  | 'ELM_SIG_MISSING'     // 401
  | 'ELM_CHALLENGE'       // 403 — нужен Turnstile-токен
  | 'ELM_NOT_FOUND'       // 404 — единый ответ для «нет», «удалён», «протух», «нет подписи»
  | 'ELM_EXISTS'          // 409 — docId занят другим ключом
  | 'ELM_STALE_BASE'      // 409 — снапшот от устаревшего base_seq
  | 'ELM_UNSAFE_BASE'     // 409 — компакция обогнала подтверждения пиров (§8.9)
  | 'ELM_WRAP_STALE'      // 409 — wrapVer не больше текущего
  | 'ELM_TOO_LARGE'       // 413
  | 'ELM_FROZEN'          // 423
  | 'ELM_RATE_LIMITED'    // 429
  | 'ELM_QUOTA_LOG_FULL'  // 507
  | 'ELM_QUOTA_DOC_FULL'  // 507
  | 'ELM_SHUTDOWN'        // 503
  | 'ELM_INTERNAL'        // 500

export interface ErrorBody {
  error: {
    code: ElmErrorCode
    message: string
    retryAfter?: number
    quota?: { used: number; limit: number; unit: 'bytes' | 'deltas' }
  }
}
```

### Таблица эндпоинтов

| Метод | Путь | Подпись | Цена (§9.2) | Ответ |
|---|---|---|---|---|
| `GET` | `/v1/health` | — | 0 | `200 { ok: true }` |
| `GET` | `/v1/challenge` | — | 1 | `200 { sitekey }` |
| `POST` | `/v1/docs` | да | 25 | `201 DocMeta` |
| `GET` | `/v1/docs/{id}` | да | 1 | `200 DocMeta` |
| `GET` | `/v1/docs/{id}/snapshot?gen=` | да | 3 | `200` binary |
| `PUT` | `/v1/docs/{id}/snapshot` | да | 10 + ⌈bytes/32KiB⌉ | `200 SnapshotResult` |
| `GET` | `/v1/docs/{id}/deltas?since=&limit=` | да | 2 | `200` binary |
| `POST` | `/v1/docs/{id}/deltas` | да | 4 + ⌈bytes/16KiB⌉ | `200 PushResult` |
| `PUT` | `/v1/docs/{id}/wrap` | да | 5 | `200 { wrapVer }` |
| `DELETE` | `/v1/docs/{id}` | да | 5 | `204` |
| `POST` | `/v1/docs/{id}/undelete` | да | 5 | `200 DocMeta` |
| `GET` | `/v1/docs/{id}/ws` | да (субпротокол) | 5 | `101` |
| `POST` | `/v1/invite` | да | 5 | `201 { iid, expiresAt }` |
| `GET` | `/v1/invite/{iid}` | нет | 5 | `200` binary, одноразово |
| `POST` | `/v1/llm/{provider}` | нет, Turnstile | 50 | стрим |

### `POST /v1/docs`

```ts
export interface CreateDocRequest {
  docId: DocId                // 20 симв. Crockford base32, сгенерирован клиентом
  sigAlg: SigAlg
  sigPub: B32                 // raw 32 (ed25519) | raw 65 uncompressed (p256)
  app?: number                // 0..255
  wrap: WrapRecord            // §5.5, wrapVer = 1
  snapshot?: B32              // начальный слепой блоб, ≤ 256 KiB
  challenge?: string          // Turnstile-токен, если сервер его требует
}

export interface DocMeta {
  docId: DocId
  seq: number
  snapshotSeq: number
  snapshotGen: number
  snapshotBytes: number
  logCount: number
  logBytes: number
  totalBytes: number
  wrap: WrapRecord
  wrapVer: number
  sigAlg: SigAlg
  createdAt: number
  updatedAt: number
  expiresAt: number
  state: 'active' | 'frozen' | 'tombstone'
  deletedAt?: number          // при tombstone: до deletedAt + 7d можно undelete
  limits: { maxDeltaBytes: number; maxSnapshotBytes: number; maxLogBytes: number; maxLogCount: number }
  compactionNeeded: boolean
  /** Граница, до которой компакция безопасна (§8.9). */
  safeCompactSeq: number
}
```

Порядок обработки: kill-switch → лимитер → (Turnstile, если включён) → валидация формата
`docId` и `sigPub` → **проверка подписи ключом `sigPub` из тела** (доказательство владения
приватным ключом) → `DocDO.init()` → `waitUntil`: `INSERT INTO docs`, метрика.

Идемпотентность: повтор с тем же `docId` и той же `sigPub` → `200` с текущим `DocMeta`;
с другой `sigPub` → `409 ELM_EXISTS`. Важно для «нажал создать, сеть моргнула».

### `GET /v1/docs/{id}/deltas`

Query: `since` (u64, эксклюзивно), `limit` (1..256, дефолт 128).

* `since < snapshotSeq` → `409 { error: { code: 'ELM_STALE_BASE' }, resyncFrom: snapshotSeq }`.
* Иначе `200`, тело — транспортный пакет (§8.4), заголовки `X-Elm-Head`, `X-Elm-More: 0|1`.

### `POST /v1/docs/{id}/deltas`

Тело — транспортный пакет. Заголовок `X-Elm-Client: <clientId b32>`.

```ts
export interface PushResult {
  accepted: number
  duplicates: number
  assigned: Array<{ clientSeq: number; seq: number }>   // включая дубликаты — с их прежним seq
  head: number
  compactionNeeded: boolean
  safeCompactSeq: number
  logCount: number
  logBytes: number
}
```

Весь пакет пишется в одной SQLite-транзакции DO: либо все кадры приняты, либо ни один.
`413` — дельта > 64 KiB или пакет > 1 MiB. `507 ELM_QUOTA_LOG_FULL` — лог упёрся в потолок;
лечится `PUT /snapshot`; чтение и WS при этом продолжают работать.

### `PUT /v1/docs/{id}/snapshot`

Заголовок `X-Elm-Base-Seq: <n>`. Тело — шифротекст, ≤ 2 MiB.

```ts
export interface SnapshotResult {
  snapshotSeq: number
  snapshotGen: number
  bytes: number
  location: 'do' | 'r2'
  prunedDeltas: number
  head: number
}
```

Логика — см. §8.9 (там же правило безопасности компакции).

### `PUT /v1/docs/{id}/wrap`

```ts
export interface PutWrapRequest { wrap: WrapRecord }   // wrap.wrapVer должен быть > текущего
```

Сервер принимает только строго больший `wrapVer`, иначе `409 ELM_WRAP_STALE`. Это не защищает
клиента от враждебного сервера (для этого §5.5), но отсекает гонку двух устройств и случайный
откат.

### `DELETE` и `POST /undelete`

`DELETE` → `state = tombstone`, `deleted_at = now`, `purge_after = now + 7d`. Блобы и лог
**не трогаются** до `purge_after`. Пиры получают `bye`. `GET` любого рода после этого
возвращает `404` — но `POST /v1/docs/{id}/undelete` с валидной подписью в течение 7 дней
восстанавливает документ целиком. Кнопка «Восстановить удалённый планер» есть в прихожей,
если локально сохранён ключ.

Причина: держатель ссылки (в том числе бывший партнёр) может стереть документ, и «мгновенный
DELETE + одно поколение снапшота 7 дней» означал полную и необратимую потерю (§4.7.1 п.13).

### `POST /v1/invite` и `GET /v1/invite/{iid}`

```ts
export interface CreateInviteRequest { iid: string /* 20 симв. b32 */; blob: B32 /* ≤ 128 байт */ }
export interface CreateInviteResponse { iid: string; expiresAt: number }
```

Хранится в отдельном `InviteDO` (`idFromName('inv:' + iid)`), TTL 15 минут, счётчик
использований 1, отдача и удаление — атомарно. `GET` без подписи (получатель не имеет ключа
до погашения), поэтому цена высокая и лимит жёсткий (§9.2).

## 8.6 R2

```
doc/{docId}/snap/{gen}.bin          снапшот поколения gen (customMetadata: seq, gen, bytes, sha256)
doc/{docId}/trash/{fromSeq}-{toSeq}.bin   срезанные при компакции дельты, TTL 7 дней
```

Держим **три** поколения снапшота (было одно + предыдущее). Старшие удаляются кроном.
Корзина срезанных дельт — страховка от «компактор свернул то, чего партнёр не видел».

## 8.7 WebSocket

### Открытие

```
GET /v1/docs/{docId}/ws
Sec-WebSocket-Protocol: elm.v1, since.<n>, cl.<clientId b32>, sig.<alg>.<ts>.<nonce b32>.<sig b32>
```

Сервер отвечает `Sec-WebSocket-Protocol: elm.v1`. Подпись покрывает канонизацию
`GET` + `/v1/docs/{docId}/ws` + пустое тело (§4.5). **Без валидной подписи соединение не
поднимается вообще** (`404`); анонимного read-only режима нет.

Base64url/base32 без паддинга состоят из валидных `tchar` — субпротокол-токен легален.

```ts
this.ctx.acceptWebSocket(server, [sessionId])
this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('p', 'o'))
ws.serializeAttachment({ sessionId, clientId, since })
```

### Сообщения

```ts
// packages/proto/src/ws.ts
export type ClientMsg =
  | { t: 'sub'; since: number }
  | { t: 'ack'; upto: number }
  | { t: 'pres'; ct: B32 | null }                 // шифрованный блоб ≤ 256 байт (§6.14)
  | { t: 'snapshot-ready'; baseSeq: number; bytes: number }
  | { t: 'bye' }
// + бинарный кадр = push дельт

export type ServerMsg =
  | { t: 'welcome'; head: number; snapshotSeq: number; snapshotGen: number
      sessionId: string; peers: PeerInfo[]; compactionNeeded: boolean
      safeCompactSeq: number; serverTime: number }
  | { t: 'ack'; assigned: Array<{ clientSeq: number; seq: number }>; head: number
      duplicates: number; compactionNeeded: boolean; safeCompactSeq: number }
  | { t: 'resync'; snapshotSeq: number; reason: 'behind-snapshot' | 'log-pruned' }
  | { t: 'snapshot'; snapshotSeq: number; snapshotGen: number }
  | { t: 'peer'; ev: 'join' | 'leave' | 'pres'; peer: PeerInfo }
  | { t: 'compact-request'; upto: number; logCount: number; logBytes: number; urgency: 'soft' | 'hard' }
  | { t: 'error'; code: ElmErrorCode; message: string; retryAfter?: number }
  | { t: 'bye'; code: ElmErrorCode; retryAfter?: number }
// + бинарный кадр = широковещание дельт

export interface PeerInfo {
  sessionId: string
  pres: B32 | null    // непрозрачно для сервера
  since: number       // ms с момента подключения
}
```

Текстовые кадры — JSON-контроль, бинарные — пакеты дельт. Разделение ради отладки:
в devtools видна управляющая часть, а данные всё равно шифротекст.

### Сценарии

**Подключение.** `welcome` содержит `head` и `snapshotSeq`. Если `since ≥ snapshotSeq` —
сервер шлёт бинарные кадры пачками по 128. Иначе `resync`: клиент забирает снапшот по HTTP
(мегабайт через WS-кадры дороже и рискованнее) и переподключается.

**Запись.** Клиент шлёт кадр с `seq=0, ts=0`. DO присваивает `seq`, пишет в SQLite, шлёт
отправителю `ack`, остальным — кадр с проставленными `seq`/`ts`. Локально операции уже
применены оптимистично.

**Офлайн.** Клиент копит операции с монотонным `clientSeq`. При восстановлении — WS или
`POST /deltas`. Дубли отсекаются по `UNIQUE(client_id, client_seq)`. Порядок доставки
транспортом не гарантируется; порядок применения задаётся HLC внутри шифротекста (§6.3).

**Парный режим.** Presence — только в памяти DO, TTL 30 с, полезная нагрузка шифрованная.
Максимум 8 пиров на документ.

**Разрыв.** Экспоненциальный бэкофф с джиттером: 1, 2, 4, 8, 15, 30, 60 с (±30 %).
При `bye` с `retryAfter` — ждать ровно столько.

## 8.8 Лимит по clientId — мягкий

Исходное «16 разных clientId в сутки → `423 ELM_FROZEN` на час» — самострел: `clientId`
эфемерен (приватное окно, переустановка PWA, новое устройство, выселение IndexedDB через
7 дней бездействия в Safari), честная пара упирается сама, а злонамеренный держатель ссылки
замораживает документ навсегда, циклируя clientId раз в час.

**Правило:** LRU на 16 активных `clientId` за 24 часа **с вытеснением**, без заморозки.
Вытесненный клиент просто теряет строку в `acks` (это влияет только на границу компакции,
§8.9). Заморозка (`423`) остаётся только по объёму и скорости записи.

Отдельно фиксируется требование к клиенту: **клиент обязан переживать потерю `clientId`
и всего IndexedDB без деградации** — новый `clientId`, новый `sessionTag`, повторная выкачка
снапшота, `mergeState`.

## 8.9 Компакция: полный протокол

Сервер не может свернуть лог сам — он слеп. Компакция всегда клиентская. Но исходный
протокол позволял одному пиру стереть историю другого: сервер выбирал компактора по
**клиентскому** `since`, а компактор сворачивал до `head` и `DELETE FROM deltas WHERE seq <= baseSeq`.
Пир, который сам только что отресинкался или просто врёт про `since`, обрезает дельты,
которые партнёр никогда не получал.

**Правило безопасности:**

```
safeCompactSeq = min(
  acks.acked_seq по всем clientId, активным за последние ACK_WINDOW = 30 дней,
  head
)
```

`PUT /snapshot` принимается только при `snapshotSeq < baseSeq ≤ safeCompactSeq`,
иначе `409 ELM_UNSAFE_BASE` с телом `{ safeCompactSeq }`. Компактор пересобирает снапшот
на безопасной границе.

Если единственный активный клиент — сам компактор, `safeCompactSeq = head`, и всё работает
как раньше. Если партнёр не появлялся 30 дней, он выпадает из расчёта — и это ровно тот
момент, когда срезанные дельты уходят в **корзину R2 на 7 дней**, а не в небытие.

Полный порядок:

```
1. Пороги: soft = 200 дельт | 512 KiB; hard = 1200 | 2.5 MiB; потолок = 2000 | 4 MiB → 507.
2. При soft DO выбирает компактора детерминированно: пир с наибольшим СЕРВЕРНЫМ ack
   (не с клиентским since), при равенстве — подключившийся раньше.
   Шлёт ему compact-request { upto: safeCompactSeq, urgency: 'soft' }.
3. Компактор строит снапшот состояния на upto, шифрует (тип Snapshot, AAD с docId),
   вкладывает chainHead (§6.11), делает PUT /snapshot с X-Elm-Base-Seq: upto.
4. DO проверяет baseSeq ≤ safeCompactSeq, gen = snapshotGen + 1,
   ≤ 256 KiB → snap_chunks, иначе R2 doc/{id}/snap/{gen}.bin.
5. Срезанные дельты копируются в R2 doc/{id}/trash/{from}-{to}.bin (TTL 7 дней),
   затем DELETE FROM deltas WHERE seq <= baseSeq.
6. Поколение gen-3 ставится в gc_queue.
7. Broadcast 'snapshot' всем пирам. Флаш в D1.
8. Нет ответа за 60 с → запрос следующему пиру. Пиров нет → compactionNeeded: true
   в каждом HTTP-ответе; первый зашедший клиент сделает снапшот.
9. При hard — запрос всем пирам сразу. При потолке — 507 на запись, чтение и WS живут,
   принимается только PUT /snapshot.
```

**Клиент обязан отвергать снапшот без корректного `chainHead`**, не сходящегося с его
цепочкой, — с баннером, а не тихим принятием.

## 8.10 TTL и уборка

| Состояние | TTL от `last_seen_at` |
|---|---|
| создан, но `seq = 0` (пустой) | 7 дней |
| есть записи | 365 дней |
| тумбстон | 7 дней до `purge_after`, потом стирание; строка живёт ещё 30 дней |

`last_seen_at` обновляется при любом успешном обращении, флашится в D1 не чаще раза в час
на документ. `DocMeta.expiresAt` отдаётся клиенту, и планер рисует в настройках документа
«серверная копия истечёт 12 марта». Локальная копия не истекает никогда.

365 дней вместо 180 — потому что предупреждать некого (аккаунтов нет), а «планер переезда»
могут открыть через год. Число вынесено в `ELM_TTL_ACTIVE_DAYS` и меняется одной строкой.

Кроны:

```
*/5 * * * *   дренаж gc_queue (до 200 задач), синк flags → KV, чистка abuse_blocks по expires_at
0 3 * * *     скан TTL пачками по 500, физическое стирание тумбстонов с purge_after < now,
              удаление снапшотов поколения < gen-2 и корзины trash старше 7 дней
0 4 * * 0     недельный ролл-ап metrics_daily, поиск аномалий по idx_docs_big
```

Дренаж очереди: `stage 0` → удалить `doc/{id}/` из R2 → `stage 1` → `DocDO.destroy()`
(`ctx.storage.deleteAll()`, закрыть сокеты с `bye`, `ctx.abort()`) → `stage 2` → через
30 дней `DELETE FROM docs`. При ошибке `attempts += 1`, `due_at = now + 2^attempts мин`,
после 8 попыток — в лог для ручного разбора.

## 8.11 Квоты

| Лимит | Значение | Ответ |
|---|---|---|
| дельта | 64 KiB | `413` |
| пакет дельт | 1 MiB / 256 кадров | `413` |
| снапшот | 2 MiB | `413` |
| лог | 2000 дельт / 4 MiB | `507` |
| суммарный след документа | 12 MiB | `507 ELM_QUOTA_DOC_FULL` |
| пиров на документ | 8 | `bye ELM_RATE_LIMITED` |
| активных clientId | LRU 16 / 24 ч, **без заморозки** | — |
| записей в документ | 60/мин, 600/ч | `429` |
| байт в документ | 2 MiB/мин, 20 MiB/ч | `429` |

Заголовок `X-Elm-Quota: log=412/2000;bytes=1048576/4194304` на каждом ответе.

## 8.12 `wrangler.toml`

```toml
name = "elementar-sync"
main = "src/index.ts"
compatibility_date = "2026-06-01"
compatibility_flags = ["nodejs_compat"]
workers_dev = false

[observability]
enabled = true
head_sampling_rate = 0.05
# Logpush ОТКЛЮЧЁН намеренно: логи содержат путь с docId (§4.7.2 п.6).

[placement]
mode = "smart"

[[durable_objects.bindings]]
name = "DOC"
class_name = "DocDO"

[[durable_objects.bindings]]
name = "LIMITER"
class_name = "LimiterDO"

[[durable_objects.bindings]]
name = "INVITE"
class_name = "InviteDO"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["DocDO", "LimiterDO", "InviteDO"]

[[d1_databases]]
binding = "DB"
database_name = "elementar-catalog"
database_id = "ЗАГЛУШКА — подставить после `wrangler d1 create`"
migrations_dir = "migrations"

[[r2_buckets]]
binding = "SNAPSHOTS"
bucket_name = "elementar-snapshots"

[[kv_namespaces]]
binding = "CONFIG"
id = "ЗАГЛУШКА — подставить после `wrangler kv namespace create`"

[triggers]
crons = ["*/5 * * * *", "0 3 * * *", "0 4 * * 0"]

[vars]
ELM_ENV = "production"
ELM_ALLOWED_ORIGIN = "https://elementar.app"    # ASCII-литерал, см. §1.3
ELM_MAX_DELTA_BYTES = 65536
ELM_MAX_PACKET_BYTES = 1048576
ELM_MAX_SNAPSHOT_BYTES = 2097152
ELM_INLINE_SNAPSHOT_BYTES = 262144
ELM_LOG_SOFT_COUNT = 200
ELM_LOG_SOFT_BYTES = 524288
ELM_LOG_HARD_COUNT = 1200
ELM_LOG_HARD_BYTES = 2621440
ELM_LOG_CEIL_COUNT = 2000
ELM_LOG_CEIL_BYTES = 4194304
ELM_DOC_TOTAL_BYTES = 12582912
ELM_TTL_ACTIVE_DAYS = 365
ELM_TTL_EMPTY_DAYS = 7
ELM_TOMBSTONE_DAYS = 7
ELM_SNAPSHOT_GENERATIONS = 3
ELM_ACK_WINDOW_DAYS = 30
ELM_MAX_PEERS = 8
ELM_LIMITER_SHARDS = 256
ELM_AUTH_BUCKET_CAPACITY = 240
ELM_AUTH_BUCKET_REFILL = 4
ELM_MISS_BUCKET_CAPACITY = 20
ELM_MISS_BUCKET_REFILL = 0.2
ELM_404_MIN_MS = 25

# Секреты (wrangler secret put):
#   ELM_IP_PEPPER    — 32 байта, HMAC IP-префиксов; рабочий перец ротируется по дням
#   ELM_TURNSTILE_SECRET
#   ELM_ADMIN_TOKEN  — /admin/*, закрыт Cloudflare Access

[[routes]]
pattern = "s.elementar.app/*"
zone_name = "elementar.app"

[env.dev]
vars = { ELM_ENV = "dev", ELM_ALLOWED_ORIGIN = "http://localhost:5173" }
```

## 8.13 Структура пакета и тест-план

```
apps/api/
  wrangler.toml  package.json  vitest.config.ts       # @cloudflare/vitest-pool-workers
  migrations/{0001_init.sql,0002_flags.sql}
  waf-rules.md                                        # эшелон 0, §9.1
  src/
    index.ts            fetch + scheduled, роутер
    env.d.ts
    http/{router,cors,errors,sig,exists,turnstile}.ts
    do/{doc,limiter,invite}.ts
    routes/{docs.create,docs.meta,docs.snapshot.get,docs.snapshot.put,
            docs.deltas.get,docs.deltas.post,docs.wrap,docs.delete,docs.undelete,
            docs.ws,invite,llm.relay,health}.ts
    cron/{gc,ttl,rollup}.ts
    lib/{frames,ipHash,catalog,r2}.ts
  test/
    frames.test.ts  sig.test.ts  replay.test.ts  limiter.test.ts
    doc.sync.test.ts  compaction.test.ts  enumeration.test.ts
    undelete.test.ts  invite.test.ts  blindness.test.ts
```

Обязательный минимум перед выкаткой:

1. **frames** — round-trip; обрезанный буфер, `count` больше фактического, `len` за границей →
   `ELM_BAD_FRAME`, ни одного краша.
2. **sig** — валидная подпись проходит; изменённые тело, **путь, метод**, просроченный `ts`,
   повторный nonce — не проходят; обе схемы, ed25519 и p256; подпись для `GET /ws`,
   поданная на `DELETE /docs/{id}`, **отвергается**.
3. **replay** — после `ctx.abort()` / хибернации реплей всё ещё отбивается (§4.5).
4. **idempotency** — двойная отправка `(clientId, clientSeq)` → `accepted:1, duplicates:1`,
   один и тот же `seq`.
5. **reconnect** — отставание на 200 дельт догоняется; отставание за снапшот → `resync`.
6. **compaction** — soft рождает `compact-request` с `upto = safeCompactSeq`;
   `PUT` с `baseSeq > safeCompactSeq` → `409 ELM_UNSAFE_BASE`; срезанные дельты найдены в R2-корзине.
7. **enumeration** — см. §9.6.
8. **quota** — заливка до `507`, чтение и WS живут, `PUT /snapshot` разблокирует.
9. **undelete** — DELETE → 404 на всех GET → undelete в течение 7 дней восстанавливает
   лог, снапшот и wrap; после `purge_after` — не восстанавливает.
10. **invite** — второй `GET /invite/{iid}` возвращает `404`; по истечении 15 минут — `404`.
11. **blindness** — интеграционный инвариант: после сценария «создать планер, добавить
    50 задач» пройтись по всем таблицам D1 и всем ключам DO и убедиться, что ни одно поле
    не содержит подстроки из открытого текста. Это тест философии, он должен падать громко.

## 8.14 Стоимость

Модель: 1000 активных документов, 1.8 устройства на документ, 60 дельт/сутки,
6 000 WS-подключений/сутки (сессия ~30 мин), 45 000 WS-сообщений, 25 000 HTTP-запросов,
300 компакций, средний документ 180 KiB.

**Учтено то, чего не было в исходной модели:** запрос к LimiterDO на каждый входящий
запрос и мусорный трафик (см. §9).

| Позиция | Объём/мес | Включено | Сверх | Тариф | $/мес |
|---|---|---|---|---|---|
| Workers requests | 2.1 M | 10 M | 0 | $0.30/M | 0.00 |
| Workers CPU | ~1.8 M CPU-мс | 30 M | 0 | $0.02/M | 0.00 |
| DO requests (Doc) | 5.3 M | 1 M | 4.3 M | $0.15/M | 0.65 |
| **DO requests (Limiter)** | **~2.0 M** | — | 2.0 M | $0.15/M | **0.30** |
| DO duration (с хибернацией) | ~9 000 GB-s | 400 000 | 0 | $12.50/M GB-s | 0.00 |
| DO SQLite rows written | ~6 M | 50 M | 0 | $1.00/M | 0.00 |
| DO SQLite rows read | ~130 M | 25 B | 0 | $0.001/M | 0.00 |
| DO storage | ~0.15 GB | 5 GB | 0 | $0.20/GB | 0.00 |
| D1 rows written | ~0.8 M | 50 M | 0 | $1.00/M | 0.00 |
| R2 storage (3 поколения + корзина) | ~0.9 GB | 10 GB | 0 | $0.015/GB | 0.00 |
| R2 class A / B | ~20 k / ~50 k | 1 M / 10 M | 0 | — | 0.00 |
| План Workers Paid | — | — | — | $5.00 | 5.00 |
| **Итого** | | | | | **≈ $5.95 / мес** |

Мусорный трафик: 10⁶ запросов к несуществующим docId в месяц добавляют ~$0.30 к Workers
requests и **0** к DO — потому что для неизвестного id DocDO не инстанцируется (§9.3).
Именно ради этого сделана проверка существования до лимитера.

| Документов | $/мес (оценка) |
|---|---|
| 100 | 5.00 |
| 1 000 | 5.95 |
| 10 000 | ~15 |
| 100 000 | ~110 |

**Решено против чего.**
Против `docId = HKDF(S)` / base64url (backend §0.1) — §4.3. Против анонимного чтения
(backend §5.2) — ревью 1. Против `create_ip_hash` (backend §2) — ревью 1: деанонимизация
вшита в схему. Против одного поколения снапшота и мгновенного DELETE — ревью 1: введены
3 поколения, корзина дельт, тумбстон 7 дней. Против выбора компактора по клиентскому `since`
(backend §6.4) — ревью 1: введён `safeCompactSeq`. Против заморозки по 16 clientId
(backend §7.3) — ревью 1: LRU без заморозки.

---

# 9. Rate limiting и защита от перебора — с числами

## 9.1 Три эшелона

**Эшелон 0 — WAF-правила зоны.** Единственная защита, которая ничего не стоит при атаке
(срабатывает до Worker'а). Настраивается в дашборде, фиксируется в репозитории как
`apps/api/waf-rules.md`:

```
(http.host eq "s.elementar.app" and http.request.uri.path matches "^/v1/docs/[^/]+$")
  → rate limit: 600 req / 1 min / ip, action: managed_challenge
(http.host eq "s.elementar.app" and http.request.method eq "POST" and http.request.uri.path eq "/v1/docs")
  → rate limit: 30 req / 1 hour / ip, action: managed_challenge
(http.host eq "s.elementar.app" and http.request.uri.path matches "^/v1/invite/")
  → rate limit: 20 req / 1 min / ip, action: block 60s
(cf.threat_score > 40 and starts_with(http.request.uri.path, "/v1/llm"))
  → managed_challenge
```

Действие — `managed_challenge`, **не** `block`: за одним IPv4 /24 у мобильного оператора
стоят десятки тысяч человек.

**Эшелон 1 — Cache API: существует ли docId.** До лимитера и до DocDO (§9.3).

**Эшелон 2 — LimiterDO, два раздельных бакета** (§9.2).

**Эшелон 3 — DocDO, per-doc лимиты.** Бесплатны: объект уже поднят, счётчики в памяти.

## 9.2 Два бакета вместо одного

Исходная схема списывала штраф за 404 (до 640 токенов) из **общего** бакета ёмкостью 120 —
то есть один промах выносил нормальную работу. При этом промах у честного клиента — **штатное
событие**: документ протух по TTL, партнёр удалил документ, человек открыл старую закладку.

**Правило: штраф за перебор применяется только к запросам без валидной аутентификации и
живёт в отдельном бакете, который физически не может заблокировать запрос с валидной подписью.**

```ts
interface PrefixState {
  auth: { tokens: number; lastRefill: number }     // ёмкость 240, +4/с
  miss: { tokens: number; lastRefill: number }     // ёмкость 20,  +0.2/с (12/мин)
  missStreak: number
  lastMissAt: number
  challengeUntil: number    // до этого момента требовать Turnstile
  blockedUntil: number      // жёсткий блок, максимум 15 минут
}

export const BUCKETS = {
  auth: { capacity: 240, refillPerSec: 4 },
  miss: { capacity: 20,  refillPerSec: 0.2 },
} as const

const MISS_BASE = 5
function missCost(streak: number): number {
  return MISS_BASE * 2 ** Math.min(streak, 4)   // 5, 10, 20, 40, 80 — потолок 80
}
```

Порядок для входящего запроса:

```
1. Есть ли валидная подпись для существующего документа?
   ДА  → списать цену операции из auth-бакета. Промахи не считаются вообще.
   НЕТ → списать missCost(missStreak) из miss-бакета, missStreak += 1.
2. miss-бакет пуст → challengeUntil = now + 10 мин; ответ 403 ELM_CHALLENGE
   (Turnstile, работает без аккаунтов), НЕ блок.
3. missStreak ≥ 20 за 10 минут → blockedUntil = now + min(2^(strikes-1) минут, 15 минут).
4. Успешный аутентифицированный ответ → missStreak = max(0, missStreak - 1).
5. 30 минут без промахов → missStreak = 0.
6. Списание промаха — в waitUntil, ПОСЛЕ отправки ответа: атакующий не получает
   тайминговой разницы, честный пользователь — задержки.
```

Потолок жёсткого блока — **15 минут**, не 24 часа. Блок зеркалится в `abuse_blocks` только
для админского обзора и **обязан** иметь `expires_at ≤ 48 ч` с физическим удалением кроном.

Гранулярность префикса: IPv4 → **/24 только для challenge, никогда для блока**
(блок — по полному адресу); IPv6 → **/64** (не /56).
`prefixHash = b32(HMAC(HKDF(ELM_IP_PEPPER, 'YYYY-MM-DD'), prefix)[0..16])` — перец ротируется
ежедневно, кросс-дневная корреляция невозможна. Сырой IP не покидает Worker и никуда не пишется.

Шардирование: `shard = fnv1a(prefixHash) % 256`, `env.LIMITER.idFromName('lim:' + shard)`.
256 шардов — достаточно, чтобы не упереться в один поток DO, и достаточно мало, чтобы шарды
оставались горячими. Состояние в памяти, снапшот в `ctx.storage` по alarm раз в 10 с
(переживает эвикцию, теряет максимум 10 с истории), выселение записей, не тронутых 15 минут.

Не KV (eventual consistency бесполезна для счётчиков, $5/M за запись) и не D1
(1 строка на запрос = $1/M и +5–15 мс латентности).

### Цены операций (auth-бакет)

| Операция | Токенов |
|---|---|
| `GET /docs/{id}` | 1 |
| `GET /deltas` | 2 |
| `GET /snapshot` | 3 |
| `POST /deltas` | 4 + ⌈bytes / 16 KiB⌉ |
| `PUT /snapshot` | 10 + ⌈bytes / 32 KiB⌉ |
| `PUT /wrap`, `DELETE`, `undelete`, `POST /invite` | 5 |
| WS upgrade | 5 |
| WS-сообщение | считается в DocDO, не в LimiterDO |
| `POST /docs` | 25 |
| `GET /invite/{iid}` | 5 (из miss-бакета — подписи нет) |
| `POST /llm/*` | 50 |

Проверка на адекватность: нормальный день пары — ~30 WS-открытий, ~2000 WS-сообщений
(не считаются), десяток HTTP-запросов ≈ **200 токенов за сутки** при бюджете 240 с
пополнением 4/с. Честный пользователь лимита не видит никогда.

## 9.3 Не инстанцировать DocDO для неизвестного id

`idFromName(любой docId)` создаёт объект и тарифицируется: атакующий не вскроет документ,
но выставит счёт и наплодит пустых DO. Одновременно заявленная неотличимость 404 нарушается
таймингом: холодный старт DO против отсутствия строки — измеримая разница.

**Порядок:**

```
1. Формат docId невалиден (не 20 символов Crockford) → 404 сразу, из изолята,
   без единого обращения куда-либо.
2. Cache API: ключ 'https://exists/<docId>'.
   HIT «нет»  → 404 сразу (TTL 300 с).
   HIT «есть» → идём дальше.
   MISS       → одно чтение D1 (`SELECT 1 FROM docs WHERE id=? AND state<>1`),
                результат кладётся в Cache API с TTL 300 с (положительный) / 60 с (отрицательный).
3. LimiterDO.
4. Только теперь DocDO.
```

Состояние блокировки/челленджа префикса тоже держится в Cache API — повторный мусор
не стоит даже запроса к LimiterDO.

Кэш инвалидируется при `POST /docs` и `DELETE` (запись положительного/отрицательного
значения напрямую).

**Нормализация времени 404.** Все ветки «нет документа», «нет подписи», «подпись неверна»,
«удалён», «протух», «неверный формат» дают **байт в байт одинаковый** ответ (тело, заголовки,
отсутствие `Retry-After` на первых промахах) и выравниваются по нижней границе
`ELM_404_MIN_MS = 25` мс. Проверяется в `enumeration.test.ts`.

SPA-шелл `/p/<id>` на основном домене отдаётся **идентично для любого id** — превью-бот
мессенджера не может проверить существование документа.

## 9.4 Единый 404

```
HTTP/1.1 404 Not Found
Cache-Control: no-store
Content-Type: application/json
Content-Length: 62

{"error":{"code":"ELM_NOT_FOUND","message":"Not found"}}
```

Ни `Retry-After`, ни `X-Elm-*`, ни различия в порядке заголовков.

## 9.5 Проверка чисел: перебор docId

Пространство `2^96 = 7.92·10²⁸`.

Без всяких лимитов, при `L` живых документах и `R` попытках в секунду ожидаемое время до
первого попадания `T = 2^96 / (L·R)`:

| L | R | T |
|---|---|---|
| 10⁶ | 10³ | 2.5·10¹² лет |
| 10⁶ | 10⁶ | 2.5·10⁹ лет |
| 10⁹ | 10⁹ *(нереалистичный ботнет + весь интернет в базе)* | 2 510 лет |

Для сравнения: 64 бита при `L=10⁶, R=10⁶` дают 580 часов — то есть на 64 битах безопасность
целиком держалась бы на rate-limit, а rate-limit ломается (прокси, ошибка конфигурации,
миграция на другой edge). **96 бит делают перебор невозможным даже при полностью отключённом
лимитере.** 128 бит удлинили бы docId до 26 символов без выигрыша.

С лимитером: устойчивая скорость на префикс — 12 промахов/мин до челленджа, дальше Turnstile.
Ботнет 10⁵ адресов, каждый решает челлендж (щедро) → `R ≈ 2·10⁴/с`. При `L = 10⁶`:
`T = 7.92·10²⁸ / (10⁶ · 2·10⁴) ≈ 3.96·10¹⁸ с ≈ 1.25·10¹¹ лет`.

**Лимитер здесь — не рубеж обороны, а способ не платить Cloudflare за чужой трафик.**
Плюс второй рубеж: даже угаданный docId бесполезен без подписи (§4.5).

## 9.6 Тест `enumeration.test.ts`

1. 25 запросов к случайным docId с одного префикса: цена растёт как 5, 10, 20, 40, 80, 80, …;
   на исчерпании miss-бакета приходит `403 ELM_CHALLENGE`, **не** `429` и не блок.
2. Параллельно с этим запрос с валидной подписью к существующему документу от того же
   префикса **проходит** — auth-бакет не тронут. Это главный тест раздела.
3. Успешный аутентифицированный ответ снижает `missStreak`.
4. Время ответа 404 для «нет документа» и «есть документ, подпись неверна» отличается
   не более чем на 5 мс и не меньше `ELM_404_MIN_MS`.
5. 1000 запросов к несуществующим id создают **ноль** экземпляров DocDO (счётчик в моке).
6. Блок никогда не длится дольше 15 минут; `abuse_blocks` не содержит строк с
   `expires_at > now + 48h`.

## 9.7 Proof-of-work: не берём

Исходные спеки предлагали PoW 18 бит на создание документа и 16 бит на LLM-релей.
`2^18` SHA-256 — это ~25 мс на ноутбуке и микросекунды на GPU, а честный телефон платит
0.2–0.5 с. Атакующий покупает миллионы решений за копейки. Это налог на пользователя,
а не защита.

**Решение:** PoW удалён целиком. Барьер на создание держат: WAF-правило зоны
(30 созданий/час/IP → managed challenge), auth-бакет (25 токенов на создание), квота
5 документов/час и 20/сутки на префикс (в памяти LimiterDO, без привязки к строкам D1),
и `flags.accept_creates = 0` как рубильник. Эскалация под атакой — **Turnstile**:
работает без аккаунтов, не требует от честного телефона ничего, и стоит атакующему
реальных денег.

Если однажды PoW всё же понадобится — только memory-hard (Argon2-based), а не SHA-256
leading zeros: только это даёт асимметрию против GPU.

## 9.8 Что мы честно не закрываем

* **CGNAT.** Даже с challenge-вместо-блока один агрессивный скрипт в кафе создаёт
  челлендж-стену для всех за тем же NAT на 10 минут. Верхняя граница жёсткая: 15 минут блока,
  10 минут челленджа, /64 для IPv6, полный адрес (не /24) для блока IPv4.
* **Оплату мусорного трафика.** Workers-запросы тарифицируются даже для мгновенного 404.
  Единственная защита — WAF на уровне зоны, которая не тарифицируется.
* **Distributed low-and-slow.** Ботнет, делающий по одному запросу с адреса в час, не
  отличим от честных пользователей и не ловится ничем. Он же безвреден: `T` из §9.5.

**Решено против чего.**
Против единого бакета со штрафом до 640 (backend §8.4) — ревью 1: DoS по честным
пользователям. Против 24-часового блока /24 — ревью 1: CGNAT. Против PoW (backend §5.7) —
ревью 1: нет асимметрии. Против инстанцирования DocDO на любой id (backend §1) — ревью 1:
счёт и тайминговый оракул.

---

# 10. Слот под модель и правило «агент предлагает — человек подтверждает»

## 10.1 Транспорт: прямо из браузера

Три режима:

```ts
export interface LlmTransportConfig {
  mode: 'direct' | 'own-relay' | 'elm-relay'
  relayUrl?: string
}
```

| Режим | Когда | Что происходит |
|---|---|---|
| **`direct`** (по умолчанию) | Anthropic (`anthropic-dangerous-direct-browser-access: true`), OpenAI, всё, что отдаёт CORS | Запрос идёт из браузера ключом пользователя мимо нас. Ноль стоимости, ноль латентности, нечего логировать — значит нечего утечь. |
| **`own-relay`** (второй в UI) | Провайдер без CORS | Пользователь вставляет URL собственного Worker'а; даём шаблон в один клик (30 строк). Мы не на пути вообще. Идеологически самый правильный режим. |
| **`elm-relay`** (последний) | Осознанный выбор | Ключ пользователя идёт через наш Worker. |

**Авто-фолбэк на `elm-relay` запрещён.** В backend-спеке адаптер ловил CORS-ошибку и
«помечал провайдера `needsRelay` и дальше шёл через релей». Провайдер (или сетевой
атакующий, ломающий CORS-преflight) тем самым **заставляет** ключ пользователя ходить через
наш сервер — а вся конструкция построена на том, что нам верить не надо. Подменённый деплой
Worker'а собирает ключи всех пользователей.

Правильное поведение при CORS-ошибке: показать явный экран с тремя вариантами
(«поставить свой релей — шаблон», «сменить провайдера», «использовать релей элементара»)
и текстом: **«ваш ключ провайдера пойдёт через сервер элементара»**. Переключение —
только по явному действию человека, и оно запоминается пер-провайдер.

## 10.2 Как релей не становится бесплатным шлюзом

Ключевое свойство: **у релея нет собственных ключей**. Красть нечего, бесплатных токенов
не раздаётся. Остаётся злоупотребление нами как транспортом:

1. **Allowlist хостов и путей.** Жёстко зашитый список; `POST /v1/llm/{provider}` не
   принимает произвольный URL. Никакого `?url=`.
2. **Обязательный ключ пользователя.** Нет заголовка с ключом → `400`. Анонимные запросы
   не проксируются даже к публичным эндпоинтам.
3. **Turnstile-токен**, одноразовый, TTL 60 с.
4. **Origin-проверка**: `Origin` должен быть нашим доменом, иначе `403`.
5. **Лимиты**: 50 токенов из auth-бакета за запрос, плюс отдельный счётчик 20/мин, 300/ч,
   8 MiB тела в час.
6. **Форма**: тело ≤ 256 KiB, ответ ≤ 4 MiB, таймаут 60 с, без редиректов,
   `cf: { cacheEverything: false }`.
7. **Гигиена**: вырезаются `Cookie`, `X-Forwarded-*`, `CF-*`; пробрасываются только
   `content-type`, ключевой заголовок, `anthropic-version`, `accept`. Ответ стримится
   насквозь. Логи: код ответа, размер, длительность — **ни промптов, ни ключей, ни docId,
   ни длины ключа**.
8. **Рубильник** `flags.llm_relay = 0`.

```ts
const ALLOW: Record<string, { host: string; path: RegExp; keyHeader: string }> = {
  anthropic: { host: 'api.anthropic.com', path: /^\/v1\/messages$/,            keyHeader: 'x-api-key' },
  openai:    { host: 'api.openai.com',    path: /^\/v1\/chat\/completions$/,   keyHeader: 'authorization' },
  deepseek:  { host: 'api.deepseek.com',  path: /^\/chat\/completions$/,       keyHeader: 'authorization' },
  moonshot:  { host: 'api.moonshot.cn',   path: /^\/v1\/chat\/completions$/,   keyHeader: 'authorization' },
}
```

## 10.3 Провайдеры и адаптеры (`@elementar/llm`)

```ts
export interface LlmCapabilities { streaming: boolean; tools: boolean; images: boolean; json: boolean; maxContext: number }
export interface ModelInfo { id: string; label: string; context: number }

export interface LlmProvider {
  readonly id: string
  readonly label: string
  readonly capabilities: LlmCapabilities
  listModels?(): Promise<ModelInfo[]>
  stream(req: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmEvent>
}

export interface LlmRequest {
  model: string
  system?: string
  messages: LlmMessage[]
  tools?: LlmToolSpec[]
  toolChoice?: 'auto' | 'none' | { name: string }
  maxTokens?: number
  temperature?: number
  responseFormat?: 'text' | 'json'
}
export type LlmMessage =
  | { role: 'user' | 'assistant'; content: LlmPart[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string }
export type LlmPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: string; dataB64: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }

export type LlmEvent =
  | { type: 'start'; model: string }
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'usage'; input: number; output: number }
  | { type: 'stop'; reason: 'end' | 'tool_use' | 'length' | 'abort' | 'refusal' }
  | { type: 'error'; code: LlmErrorCode; message: string; retryAfterMs?: number }

export type LlmErrorCode = 'auth'|'rate'|'context'|'network'|'cors'|'model'|'server'|'aborted'
```

| Файл | Покрывает |
|---|---|
| `providers/anthropic.ts` | Claude; SSE `/v1/messages` |
| `providers/openai-compatible.ts` | OpenAI, DeepSeek, Qwen, GLM, Mistral, OpenRouter, Ollama/LM Studio на localhost — один адаптер, различие в `baseUrl` и `model` |
| `providers/google.ts` | Gemini (`streamGenerateContent`) |
| `providers/echo.ts` | детерминированная заглушка для тестов и демо без ключа |

```ts
export interface ProviderConfig {
  providerId: string; baseUrl?: string; apiKey: string; model: string
  label?: string; transport: LlmTransportConfig
}
export interface LlmRegistry {
  configs: ReadonlySignal<readonly ProviderConfig[]>
  active: ReadonlySignal<ProviderConfig | null>
  add(c: ProviderConfig): Promise<void>
  remove(id: string): Promise<void>
  setActive(id: string): Promise<void>
  probe(c: ProviderConfig): Promise<{ ok: true; models: ModelInfo[] } | { ok: false; code: LlmErrorCode }>
  resolve(): LlmProvider | null
}
```

**Где живёт ключ:** стор `settings` в IndexedDB **этого устройства**. Не синхронизируется,
не попадает в документ, не попадает в экспорт (вырезается явно), не попадает в
`exportRecovery`, не логируется даже по длине.

Весь `@elementar/llm` — **ленивый чанк**: он не грузится, пока человек не открыл слот модели
или не нажал кнопку агента.

## 10.4 Правило слоёв: зашито в типы

```ts
export interface ToolContext<S> {
  /** Только чтение. У агента физически нет мутирующего API. */
  doc: DocReadonly<S>
  now(): Date
  signal: AbortSignal
}
export interface ReadTool<S, I, O> {
  name: string; description: string; input: JsonSchema
  effect: 'read'
  run(input: I, ctx: ToolContext<S>): Promise<O>
}
export interface ProposeTool<S, I> {
  name: string; description: string; input: JsonSchema
  effect: 'propose'
  plan(input: I, ctx: ToolContext<S>): Promise<ProposalDraft>
}
export type AgentTool<S> = ReadTool<S, any, any> | ProposeTool<S, any>
```

Тип-гарантия: `ToolContext` не содержит `tx`, `create`, `update`. `ProposeTool.plan` умеет
вернуть только черновик. Мутирующие функции ядра принимают `Actor`, а `runAgent` не может
его создать: конструктор `HumanActor` не экспортируется из публичного входа, только через
UI-жест. Проверяется тестом `no-agent-mutation.test.ts`.

### Предложения — наложение, а не записи

Дизайн-спека делала агента создателем **настоящих** записей с `draft: true`. Это ломает
гарантию: записи агента уже в документе, уже в снапшоте, уже в синке, а инвариант
«не показывать черновики» переносится в двадцать мест (`counts`, «Сейчас», календарь, поиск,
экспорт, экран проекта). Одно забытое место — и выдумка модели стала данными.

**Механизм один: `_proposals`.** Поле `draft` в схеме задачи не существует.

```ts
export interface ProposalChange {
  kind: 'create' | 'update' | 'delete' | 'move'
  collection: string
  recordId: RecordId              // предвычислен, чтобы accept был детерминирован
  label: string
  before?: Record<string, unknown>
  after?: Record<string, unknown>
  /** Операции ИМЕННО этого изменения. Верхнеуровневого ops[] нет. */
  ops: Op[]
}

export interface Proposal {
  id: RecordId
  title: string
  rationale?: string
  origin: { provider: string; model: string; runId: string; toolName: string; by: ActorId }
  changes: ProposalChange[]
  /** Отпечаток: 'recordId#field' → HLC на момент создания. Для isStale. */
  base: Record<string, HlcString>
  status: 'pending' | 'accepted' | 'rejected'
  createdAt: HlcString
}

export interface ProposalStore {
  pending: ReadonlySignal<readonly Proposal[]>
  put(draft: ProposalDraft, origin: Proposal['origin']): Promise<RecordId>
  /** only — индексы changes[]. Однозначно, потому что ops лежат внутри change. */
  accept(id: RecordId, only?: number[]): Promise<void>
  reject(id: RecordId): Promise<void>
  /** Правка черновика до принятия — это правка самого Proposal, а не задачи. */
  edit(id: RecordId, changeIndex: number, patch: Record<string, JsonValue>): Promise<void>
  isStale(p: Proposal): boolean
  rebase(id: RecordId): Promise<Proposal>
}
```

Исходная сигнатура `accept(id, only?: number[])` была неисполнима: `only` индексировал
`preview.changes`, а применялись `ops[]` верхнего уровня, и соответствие между ними нигде
не задавалось (один `create` — это 2–3 операции). Теперь `ops` живут **внутри** каждого
`change`, и частичное принятие однозначно.

`_proposals` — коллекция внутри документа, значит синхронизируется партнёру: жена видит,
что муж попросил агента разложить переезд, и может подтвердить сама.

**Истечение черновиков — фильтр представления, а не операция.** Дизайн-спека предлагала
«черновики тихо истекают через 24 часа», то есть автоматическую запись в общий документ без
человека — прямо против правила. Правильно: `pending` фильтрует по `createdAt > now − 24 ч`,
а физическая чистка происходит локально при следующей записи снапшота.

### Что видит агент

`ToolContext.doc` отдаёт **срез**, а не весь документ: текущий контейнер (список или проект),
плюс заголовки задач соседних контейнеров без заметок. Поля с `redact: true` вырезаются.
Причина двойная: приватность запроса к чужому провайдеру (§4.7.2 п.12) и качество
предложений (весь документ размывает контекст). Расширение среза — явная галочка
«показать агенту весь планер» в шите агента, не по умолчанию.

**Решено против чего.**
Против авто-фолбэка на релей (backend §9.2) — ревью 1: молчаливый даунгрейд доверия.
Против `draft: boolean` на задаче (design §6/§8.5) — ревью 2 п.9: инвариант в 20 местах.
Против `accept(id, only)` поверх плоского `ops[]` (client-core §7.3) — ревью 2 п.9:
неисполнимо. Против автоистечения черновиков записью в документ — ревью 2 п.9.

---

# 11. Дизайн-система `@elementar/ui`

## 11.0 Принципы

1. **Спокойная плотность.** Список задач — основной экран, он должен читаться как страница,
   а не как панель управления: тёплая бумажная подложка, hairline-разделители, отсутствие
   рамок вокруг всего подряд.
2. **Цвет — это смысл.** Хроматика зарезервирована: четыре списка, агент, два участника,
   три статуса. Всё остальное — графит на бумаге. Если элемент цветной, у цвета есть значение.
3. **Движение подтверждает, а не развлекает.** Максимум 320 мс, кроме шита (380 мс).
4. **Палец важнее курсора.** Мобильная раскладка проектируется первой.
5. **`ui` не знает про документы.** Компоненты, которым нужны `docId`, `Proposal`,
   `ProviderConfig`, живут в `packages/shell` (§2.3).

Компоненты не импортируют цвета напрямую — только через семантические токены. Корпус может
переопределить семантический слой, но не примитивы.

## 11.1 Структура пакета

```
packages/ui/
  package.json                  // exports: ".", "./css"
  scripts/contrast.test.ts      // пересчёт ВСЕХ контрастов, гейт в CI (§11.7)
  src/
    tokens/
      primitives.css            сырые ступени палитры и шкал, без семантики
      semantic.light.css        :root, [data-theme="light"]
      semantic.dark.css         [data-theme="dark"] + @media prefers-color-scheme
      typography.css            @font-face + шкала
      motion.css                длительности, кривые, reduced-motion
      layout.css                брейкпоинты, safe-area, тач-цели, z-index
      index.css                 единая точка импорта
      tokens.ts                 те же значения для JS (theme-color, canvas, QR, брейкпоинты)
    base/reset.css              ~60 строк, без normalize.css
    components/
      Button/ IconButton/ Field/ Checkbox/ Card/ ListView/ Overlay/
      Toast/ EmptyState/ Skeleton/ Menu/ Tabs/ Avatar/ Chip/ Divider/ Spinner/
    hooks/
      useMediaQuery.ts useReducedMotion.ts useFocusTrap.ts useSwipe.ts
      useLongPress.ts useFlip.ts useHaptic.ts useVisualViewport.ts
    index.ts
```

## 11.2 Примитивы

```css
/* packages/ui/src/tokens/primitives.css */
:root {
  /* Бумага: тёплая нейтраль, hue ≈ 50 */
  --e-paper-0:   #FCFBF9;
  --e-paper-25:  #F7F5F2;
  --e-paper-50:  #F1EEE9;
  --e-paper-100: #E8E4DD;
  --e-paper-200: #DAD5CC;
  --e-paper-300: #C4BDB2;
  --e-paper-400: #A39B8E;
  --e-paper-500: #8B8374;
  --e-paper-600: #756C60;
  --e-paper-700: #4C453C;
  --e-paper-800: #332E28;
  --e-paper-900: #221F1B;
  --e-paper-950: #14120F;

  /* Графит: холодная нейтраль (тёмная тема) */
  --e-ink-950: #0E0F11;
  --e-ink-900: #131417;
  --e-ink-850: #191B1F;
  --e-ink-800: #202329;
  --e-ink-700: #2A2E35;
  --e-ink-600: #3A3F48;
  --e-ink-550: #666D78;
  --e-ink-500: #8A929E;
  --e-ink-400: #A2A9B4;
  --e-ink-300: #C7CCD4;
  --e-ink-200: #E2E5EA;
  --e-ink-100: #F2F4F7;

  /* Хроматика: пары «светлая / тёмная» */
  --e-blue-700:  #33507A;  --e-blue-300:  #A8BEE0;   /* акцент, фокус, ссылки */
  --e-steel-600: #46688F;  --e-steel-300: #8FB0D6;   /* список: работа      */
  --e-clay-600:  #9C5F45;  --e-clay-300:  #DBA184;   /* список: быт         */
  --e-moss-600:  #4F7350;  --e-moss-300:  #97BE97;   /* список: хобби       */
  --e-plum-600:  #7C5480;  --e-plum-300:  #C6A0CB;   /* список: творчество  */
  --e-iris-600:  #6B5AA6;  --e-iris-300:  #B3A6E4;   /* агент               */
  --e-green-600: #3E7A56;  --e-green-300: #86C39C;   /* успех               */
  --e-amber-700: #8A6520;  --e-amber-300: #E0BE72;   /* внимание            */
  --e-red-600:   #9B3A31;  --e-red-300:   #EC9E96;   /* опасность           */
}
```

### Измеренные контрасты

Все значения ниже **пересчитываются скриптом** `packages/ui/scripts/contrast.test.ts`
при каждом прогоне CI. В исходной дизайн-спеке фигурировало выдуманное число
(`--e-fg-3 = 6.17`, при том что `paper-600` даёт 4.99) — тест существует ровно для того,
чтобы такого больше не случалось.

| токен | на `#FCFBF9` | на `#F7F5F2` |
|---|---|---|
| `--e-paper-900` основной текст | 15.87 | 15.08 |
| `--e-paper-700` второстепенный | 9.13 | 8.68 |
| `--e-paper-600` приглушённый | 4.99 | 4.74 |
| `--e-paper-500` граница контрола | 3.63 | 3.45 |
| `--e-blue-700` | 7.90 | 7.51 |
| `--e-steel-600` | 5.58 | 5.31 |
| `--e-clay-600` | 4.91 | 4.67 |
| `--e-moss-600` | 5.21 | 4.95 |
| `--e-plum-600` | 5.91 | 5.62 |
| `--e-iris-600` | 5.58 | — |
| `--e-red-600` | 6.67 | 6.34 |

| токен | на `#131417` | на `#191B1F` |
|---|---|---|
| `--e-ink-100` | 16.72 | 15.65 |
| `--e-ink-300` | 11.42 | 10.69 |
| `--e-ink-400` | 7.78 | 7.28 |
| `--e-ink-500` | 5.86 | — |
| `--e-ink-550` граница контрола | 3.53 | 3.30 |
| `--e-blue-300` | 9.74 | 9.12 |
| `--e-steel-300 / clay-300 / moss-300 / plum-300` | 8.20 / 8.28 / 8.88 / 8.15 | ≥ 7.6 |

Пороги гейта: корпусный текст ≥ 4.5, границы контролов и индикаторы состояния ≥ 3.0,
крупный текст ≥ 3.0.

## 11.3 Семантика — светлая тема

```css
/* packages/ui/src/tokens/semantic.light.css */
:root, [data-theme='light'] {
  --e-bg:              var(--e-paper-0);
  --e-bg-sunken:       var(--e-paper-50);
  --e-surface:         #FFFFFF;
  --e-surface-raised:  var(--e-paper-0);   /* шит, меню, поповер: НЕ дубликат --e-surface */
  --e-surface-hover:   var(--e-paper-25);
  --e-surface-active:  var(--e-paper-50);
  --e-scrim:           rgb(34 31 27 / 0.32);

  --e-fg:              var(--e-paper-900);  /* 15.87 */
  --e-fg-2:            var(--e-paper-700);  /*  9.13 */
  --e-fg-3:            var(--e-paper-600);  /*  4.99 */
  --e-fg-muted:        var(--e-paper-500);  /*  3.63 — ТОЛЬКО крупный текст и иконки, см. ниже */
  --e-fg-on-solid:     var(--e-paper-0);

  --e-line:            var(--e-paper-200);  /* декоративный hairline, смысла не несёт */
  --e-line-soft:       var(--e-paper-100);
  --e-line-control:    var(--e-paper-500);  /* граница контрола, 3.63 ≥ 3:1 */
  --e-line-focus:      var(--e-blue-700);

  --e-solid:           var(--e-paper-900);
  --e-solid-hover:     var(--e-paper-800);
  --e-solid-active:    var(--e-paper-950);
  --e-solid-fg:        var(--e-paper-0);

  --e-accent:          var(--e-blue-700);
  --e-accent-tint:     #EAF0F8;
  --e-accent-fg:       var(--e-paper-0);

  --e-success:         var(--e-green-600);  --e-success-tint: #E8F1EB;
  --e-warning:         var(--e-amber-700);  --e-warning-tint: #F6EFDF;
  --e-danger:          var(--e-red-600);    --e-danger-tint:  #F7E9E7;

  --e-list-work:       var(--e-steel-600);  --e-list-work-tint:  #E9EEF6;
  --e-list-home:       var(--e-clay-600);   --e-list-home-tint:  #F6EBE4;
  --e-list-hobby:      var(--e-moss-600);   --e-list-hobby-tint: #E9F0E9;
  --e-list-craft:      var(--e-plum-600);   --e-list-craft-tint: #F2EAF3;

  --e-agent:           var(--e-iris-600);   --e-agent-tint: #EDEAF7;

  --e-actor-a:         var(--e-steel-600);
  --e-actor-b:         var(--e-clay-600);

  --e-shadow-1: 0 1px 2px rgb(34 31 27 / 0.06), 0 1px 1px rgb(34 31 27 / 0.04);
  --e-shadow-2: 0 2px 4px -1px rgb(34 31 27 / 0.06), 0 6px 14px -4px rgb(34 31 27 / 0.08);
  --e-shadow-3: 0 8px 24px -8px rgb(34 31 27 / 0.16), 0 2px 6px -2px rgb(34 31 27 / 0.08);
  --e-shadow-4: 0 24px 60px -16px rgb(34 31 27 / 0.28), 0 4px 12px -6px rgb(34 31 27 / 0.12);
  --e-shadow-inset-top: inset 0 1px 0 rgb(255 255 255 / 0.6);

  color-scheme: light;
}
```

`--e-surface-2` из исходной спеки удалён: он был `#FFFFFF`, то есть побайтовым дубликатом
`--e-surface`. Вместо него `--e-surface-raised`, у которого в светлой теме **другое**
значение.

**Правило `--e-fg-muted`** переписано: он допустим **только** для текста ≥ 24px обычного
начертания или ≥ 18.66px полужирного (порог «крупного текста» WCAG), либо для иконок.
На 16px это провал AA — исходная спека разрешала его «≥16px», что неверно.

**Выполненная задача** рисуется `--e-fg-2` (9.13) + зачёркивание, а не `--e-fg-3` и не
`--e-fg-muted`.

## 11.4 Семантика — тёмная тема

Тёмная тема не инверсия: поверхности разделяются светимостью и hairline-границами, тени
почти не работают, акценты приглушены.

**Каждый `color-mix` сопровождается статическим hex-фолбэком строкой выше.** iOS Safari
до 16.4 отбрасывает объявление с `color-mix` целиком — без фолбэка все тинты (агент, списки,
danger) на iPhone просто исчезают, а тёмная тема на iPhone это основной сценарий.

```css
/* packages/ui/src/tokens/semantic.dark.css */
[data-theme='dark'] {
  --e-bg:              var(--e-ink-900);
  --e-bg-sunken:       var(--e-ink-950);
  --e-surface:         var(--e-ink-850);
  --e-surface-raised:  var(--e-ink-800);
  --e-surface-hover:   var(--e-ink-800);
  --e-surface-active:  var(--e-ink-700);
  --e-scrim:           rgb(0 0 0 / 0.56);

  --e-fg:          var(--e-ink-100);
  --e-fg-2:        var(--e-ink-300);
  --e-fg-3:        var(--e-ink-400);
  --e-fg-muted:    var(--e-ink-500);
  --e-fg-on-solid: var(--e-ink-950);

  --e-line:         var(--e-ink-700);
  --e-line-soft:    var(--e-ink-800);
  --e-line-control: var(--e-ink-550);
  --e-line-focus:   var(--e-blue-300);

  --e-solid:        var(--e-ink-100);
  --e-solid-hover:  #FFFFFF;
  --e-solid-active: var(--e-ink-200);
  --e-solid-fg:     var(--e-ink-950);

  --e-accent:    var(--e-blue-300);
  --e-accent-fg: var(--e-ink-950);

  /* Каждая пара: сначала статический фолбэк, затем color-mix. */
  --e-accent-tint: #232B36;
  --e-accent-tint: color-mix(in oklab, var(--e-blue-300) 16%, var(--e-surface));

  --e-success: var(--e-green-300); --e-success-tint: #1E2A23;
  --e-success-tint: color-mix(in oklab, var(--e-green-300) 14%, var(--e-surface));
  --e-warning: var(--e-amber-300); --e-warning-tint: #2A2620;
  --e-warning-tint: color-mix(in oklab, var(--e-amber-300) 14%, var(--e-surface));
  --e-danger:  var(--e-red-300);   --e-danger-tint:  #2B2020;
  --e-danger-tint:  color-mix(in oklab, var(--e-red-300) 14%, var(--e-surface));

  --e-list-work:  var(--e-steel-300); --e-list-work-tint:  #1F252C;
  --e-list-work-tint:  color-mix(in oklab, var(--e-steel-300) 14%, var(--e-surface));
  --e-list-home:  var(--e-clay-300);  --e-list-home-tint:  #292321;
  --e-list-home-tint:  color-mix(in oklab, var(--e-clay-300) 14%, var(--e-surface));
  --e-list-hobby: var(--e-moss-300);  --e-list-hobby-tint: #202722;
  --e-list-hobby-tint: color-mix(in oklab, var(--e-moss-300) 14%, var(--e-surface));
  --e-list-craft: var(--e-plum-300);  --e-list-craft-tint: #26222A;
  --e-list-craft-tint: color-mix(in oklab, var(--e-plum-300) 14%, var(--e-surface));

  --e-agent: var(--e-iris-300); --e-agent-tint: #23222E;
  --e-agent-tint: color-mix(in oklab, var(--e-iris-300) 14%, var(--e-surface));

  --e-actor-a: var(--e-steel-300);
  --e-actor-b: var(--e-clay-300);

  --e-shadow-1: 0 1px 2px rgb(0 0 0 / 0.4);
  --e-shadow-2: 0 2px 6px rgb(0 0 0 / 0.44);
  --e-shadow-3: 0 10px 28px -10px rgb(0 0 0 / 0.6);
  --e-shadow-4: 0 28px 70px -20px rgb(0 0 0 / 0.72);
  --e-shadow-inset-top: inset 0 1px 0 rgb(255 255 255 / 0.04);

  color-scheme: dark;
}
```

Блок для `@media (prefers-color-scheme: dark) :root:not([data-theme='light'])` генерируется
postcss-плагином из того же исходника — руками не дублируется.

**Тема — свойство устройства, не документа.** `data-theme` на `<html>` (`light|dark|auto`),
значение в `localStorage['e.theme']`, применяется инлайн-скриптом в `<head>` до первого
пейнта (хеш скрипта в CSP, §13.4). `<meta name="theme-color">` обновляется из `tokens.ts`
(`#FCFBF9` / `#131417`). В документе поля `settings.theme` **нет** — иначе тема
синхронизируется партнёру и дерётся с локальной.

## 11.5 Типографика

```css
/* packages/ui/src/tokens/typography.css */
@font-face {
  font-family: 'Golos Text';
  src: url('/fonts/golos-text-vf.cyrillic.woff2') format('woff2-variations');
  font-weight: 400 700; font-style: normal;
  font-display: optional;      /* НЕ swap: шрифт убран с критического пути (§11.9) */
  unicode-range: U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116;
}
@font-face {
  font-family: 'Golos Text';
  src: url('/fonts/golos-text-vf.latin.woff2') format('woff2-variations');
  font-weight: 400 700; font-style: normal; font-display: optional;
  unicode-range: U+0000-00FF, U+2000-206F, U+2190-21BB, U+2212;
}

/* Метрические фолбэки — по одному на платформу.
   Один общий фейс с src: local('Helvetica Neue'), local('Arial'), local('Roboto')
   на Android и Windows не находит ничего, и size-adjust не применяется именно там,
   где он нужен. */
@font-face { font-family: 'Golos FB'; src: local('Helvetica Neue');
  size-adjust: 101.5%; ascent-override: 96%; descent-override: 24%; line-gap-override: 0%; }
@font-face { font-family: 'Golos FB'; src: local('Segoe UI');
  size-adjust: 100.0%; ascent-override: 97%; descent-override: 23%; line-gap-override: 0%; }
@font-face { font-family: 'Golos FB'; src: local('Roboto');
  size-adjust: 99.5%;  ascent-override: 95%; descent-override: 25%; line-gap-override: 0%; }

:root {
  --e-font-sans: 'Golos Text', 'Golos FB', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  --e-font-mono: ui-monospace, 'SF Mono', 'Cascadia Mono', 'Roboto Mono', monospace;

  --e-size-2xs: 0.6875rem;  /* 11px — микрометки, только капсом с трекингом */
  --e-size-xs:  0.75rem;    /* 12px — подписи, счётчики */
  --e-size-sm:  0.875rem;   /* 14px — второстепенный текст */
  --e-size-md:  1rem;       /* 16px — база, текст задачи, ПОЛЯ ВВОДА */
  --e-size-lg:  1.125rem;   /* 18px */
  --e-size-xl:  1.375rem;   /* 22px */
  --e-size-2xl: 1.75rem;    /* 28px */
  --e-size-3xl: 2.25rem;    /* 36px — только пустые состояния */

  --e-leading-tight: 1.15; --e-leading-snug: 1.3;
  --e-leading-normal: 1.5; --e-leading-relaxed: 1.62;

  --e-tracking-tight: -0.014em;  /* ≥22px */
  --e-tracking-snug:  -0.006em;  /* 16–18px */
  --e-tracking-none:  0;
  --e-tracking-wide:  0.02em;    /* 12–14px */
  --e-tracking-caps:  0.07em;    /* 11px капсом */

  --e-weight-regular: 400; --e-weight-medium: 500; --e-weight-semi: 600;
  --e-numeric: tabular-nums lining-nums;
}
```

| роль | размер / интерлиньяж | вес | трекинг | применение |
|---|---|---|---|---|
| `.e-display` | 36 / 1.15 | 600 | tight | пустые состояния |
| `.e-title` | 28 / 1.2 | 600 | tight | заголовок экрана (десктоп) |
| `.e-heading` | 22 / 1.25 | 600 | tight | заголовок экрана (мобильный), шапка шита |
| `.e-subhead` | 18 / 1.35 | 500 | snug | название проекта, заголовок секции |
| `.e-body` | 16 / 1.5 | 400 | snug | текст задачи, поля ввода |
| `.e-body-strong` | 16 / 1.5 | 500 | snug | задача с датой «сегодня» |
| `.e-body-sm` | 14 / 1.45 | 400 | wide | заметка, вторая строка |
| `.e-caption` | 12 / 1.35 | 500 | wide | счётчики, метки времени |
| `.e-overline` | 11 / 1.2 | 600 | caps, uppercase | «ПРЕДЛОЖЕНО АГЕНТОМ» |
| `.e-num` | наследует | — | — | `font-variant-numeric: var(--e-numeric)` |

Правила: не более трёх размеров на экране; вес 600 — только заголовки; курсив **не
используется нигде** (у Golos Text нет настоящего курсива, наклон делать нельзя);
минимум 16px на всех полях ввода — иначе iOS Safari зумит страницу при фокусе.

## 11.6 Пространство, раскладка, движение

```css
/* packages/ui/src/tokens/layout.css */
:root {
  --e-space-1: 2px;  --e-space-2: 4px;  --e-space-3: 6px;  --e-space-4: 8px;
  --e-space-5: 12px; --e-space-6: 16px; --e-space-7: 20px; --e-space-8: 24px;
  --e-space-9: 32px; --e-space-10: 40px; --e-space-11: 48px; --e-space-12: 64px;
  --e-space-13: 80px; --e-space-14: 96px;

  --e-radius-xs: 4px; --e-radius-sm: 6px; --e-radius-md: 10px;
  --e-radius-lg: 14px; --e-radius-xl: 20px; --e-radius-2xl: 28px; --e-radius-full: 999px;

  --e-tap-min: 44px; --e-tap-comfortable: 48px;
  --e-row-h-mobile: 52px; --e-row-h-desktop: 40px;
  --e-control-h-sm: 32px; --e-control-h-md: 44px; --e-control-h-lg: 52px;

  --e-rail-w: 240px; --e-detail-w: 400px; --e-content-max: 720px;
  --e-tabbar-h: 56px; --e-topbar-h: 52px;

  --e-safe-top: env(safe-area-inset-top, 0px);
  --e-safe-bottom: env(safe-area-inset-bottom, 0px);
  --e-safe-left: env(safe-area-inset-left, 0px);
  --e-safe-right: env(safe-area-inset-right, 0px);
  /* Высота клавиатуры, выставляется из useVisualViewport (§12.4). */
  --e-kb-inset: 0px;

  --e-z-base: 0; --e-z-sticky: 10; --e-z-rail: 20; --e-z-tabbar: 30;
  --e-z-scrim: 40; --e-z-sheet: 50; --e-z-menu: 60; --e-z-toast: 70; --e-z-tooltip: 80;

  --e-bp-sm: 480px; --e-bp-md: 768px; --e-bp-lg: 1024px; --e-bp-xl: 1280px;
}
```

Брейкпоинты в JS — из `tokens.ts`: `export const bp = { sm: 480, md: 768, lg: 1024, xl: 1280 } as const`.

```css
/* packages/ui/src/tokens/motion.css */
:root {
  --e-dur-instant: 80ms;   --e-dur-fast: 130ms;  --e-dur-base: 200ms;
  --e-dur-slow: 320ms;     --e-dur-sheet: 380ms; --e-dur-toast: 6000ms;

  --e-ease-standard: cubic-bezier(0.2, 0, 0, 1);
  --e-ease-out:      cubic-bezier(0.16, 1, 0.3, 1);
  --e-ease-in:       cubic-bezier(0.4, 0, 1, 1);
  --e-ease-inout:    cubic-bezier(0.65, 0, 0.35, 1);
  --e-ease-snap:     cubic-bezier(0.34, 1.4, 0.64, 1);   /* только галочка */

  --e-stagger: 40ms;   /* шаг каскада, максимум 6 элементов */
}

@media (prefers-reduced-motion: reduce) {
  :root {
    --e-dur-instant: 1ms; --e-dur-fast: 1ms; --e-dur-base: 1ms;
    --e-dur-slow: 1ms; --e-dur-sheet: 1ms; --e-stagger: 0ms; --e-ease-snap: linear;
  }
  *, *::before, *::after {
    animation-duration: 1ms !important; animation-iteration-count: 1 !important;
    transition-duration: 1ms !important; scroll-behavior: auto !important;
  }
  .e-crossfade { transition-duration: 80ms !important; }  /* кроссфейд остаётся */
}
```

`prefers-reduced-motion` не отключает обратную связь, а **сжимает** её: движение → 1 мс,
кроссфейды остаются 80 мс. Полное отключение делает интерфейс дёрганым, а не спокойным.
Drag-to-dismiss шита продолжает работать — это жест, а не анимация.

### Таблица движения

| что | свойство | длительность | кривая |
|---|---|---|---|
| hover, смена цвета | `background-color`, `color`, `border-color` | instant | standard |
| нажатие кнопки/строки | `transform: scale(0.98)` | fast | standard |
| галочка чекбокса | `stroke-dashoffset`, `background` | fast | snap |
| появление строки | `opacity`, `translateY(-4px→0)` | base | out |
| удаление строки | `opacity 1→0`, `scale 1→0.98`, затем FLIP-схлопывание | fast + base | in |
| перестановка списка | FLIP по `transform` | base | inout |
| выполнение задачи | заливка → 120 мс пауза → уезжает в «Сделано» | ~420 мс суммарно | — |
| смена вкладки | кроссфейд + `translateX(±8px)` | slow | standard |
| открытие шита | `translateY` | sheet | out |
| открытие диалога | `opacity` + `scale 0.97→1` | base | out |
| scrim | `opacity` | base | standard |
| тост | `translateY(8px→0)` + `opacity` | base | out |
| каскад предложений агента | задержка stagger × i, максимум 6 | base | out |
| подсветка правки партнёра | `background` вспышка tint → прозрачный | 1200 мс | out |

**Запрещено:** анимировать `height`, `width`, `top`, `left`, `margin`; параллакс; анимации
дольше 400 мс; повторяющиеся анимации вне загрузки; `transition: all`.

**Обязательно:** `will-change` ставится только на время анимации и снимается по
`transitionend`; на строках списка `contain: layout style`; FLIP — `getBoundingClientRect`
до/после и один `requestAnimationFrame`.

## 11.7 Доступность

**Контраст.** Целевые значения и гейт — §11.2. Декоративные hairline (`--e-line`) сознательно
ниже 3:1: они не несут смысла, границы поля и кнопки всегда `--e-line-control`.

**Фокус.**

```css
:where(a, button, input, textarea, select, [tabindex]):focus-visible {
  outline: 2px solid var(--e-line-focus);
  outline-offset: 2px;
  /* border-radius: inherit НЕ ставится: это меняло бы радиус самого элемента,
     а не обводки. Скругление outline следует радиусу элемента автоматически. */
}
.e-on-solid:focus-visible {
  outline: 2px solid var(--e-solid-fg);
  box-shadow: 0 0 0 4px var(--e-line-focus);   /* двойное кольцо на цветной заливке */
}
```

`:focus` без `-visible` не стилизуется никогда. Порядок фокуса = порядок DOM; положительный
`tabindex` запрещён; скрытая ссылка «К содержимому» — первый фокусируемый элемент.

**Тач-цели.** Минимум 44×44 CSS-px, первичные 48, между соседними ≥ 8px. Зона нажатия
расширяется псевдоэлементом `::after`, визуальный размер иконки остаётся 20px.

**Скринридер.** Строка задачи объявляется как «Чекбокс, не выполнено, Забрать коробки, быт,
завтра, добавила Аня». Живые области: тосты (`polite`), блок предложений агента (`polite`,
«Агент предложил 7 задач, требуется подтверждение»), появление партнёра **не объявляется**
(шум). Модалка — `role="dialog" aria-modal="true"` + `aria-labelledby`. Иконочные кнопки без
`label` не проходят типизацию.

**Прочее.** `prefers-contrast: more` (границы → `--e-fg-3`, тени → границы); масштаб текста
до 200% без горизонтального скролла (все размеры в rem, кроме hairline); `user-scalable=no`
запрещён.

**Дальтонизм.** Четыре цвета списков при дейтеранопии сближаются попарно (сталь/слива,
глина/мох). Митигация принята сознательно: цвет **никогда** не единственный носитель смысла —
есть подпись и постоянный порядок сегментов. Остаточная потеря скорости считывания принимается.

## 11.8 Компоненты

Общее: Preact + `@preact/signals`. Все компоненты пробрасывают `class`, `id`, `data-*`,
`aria-*`, `ref`. Ни один компонент не имеет внутреннего состояния «открыт/значение», кроме
`Toast` (глобальный стор).

```ts
// packages/ui/src/types.ts
export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
  | 'work' | 'home' | 'hobby' | 'craft' | 'agent'
export type Slot = ComponentChildren
export interface Base { class?: string; id?: string; 'data-testid'?: string }
```

### Button

```ts
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'
export interface ButtonProps extends Base,
  Omit<JSX.HTMLAttributes<HTMLButtonElement>, 'size'|'class'|'id'|'loading'> {
  variant?: ButtonVariant   // 'secondary'
  size?: ButtonSize         // 'md'
  fullWidth?: boolean
  loading?: boolean         // спиннер вместо iconStart, ширина не меняется, aria-busy
  disabled?: boolean
  iconStart?: Slot; iconEnd?: Slot
  tone?: Tone
  type?: 'button' | 'submit'
  onClick?: JSX.MouseEventHandler<HTMLButtonElement>
}
```
Геометрия: sm 32/12px текст-14 (только десктоп), md 44/16px текст-16, lg 52/20px текст-16 medium.
Радиус md. `primary` = `--e-solid` + `--e-solid-fg`; `secondary` = `--e-surface` +
`1px solid --e-line-control`; `ghost` = прозрачный, фон на hover; `danger` = `--e-danger`.
Hover только в `@media (hover: hover) and (pointer: fine)`. `sm` запрещён как единственная
тач-цель — линтер проверяет по `data-tap`.

### IconButton

```ts
export interface IconButtonProps extends Omit<ButtonProps, 'iconStart'|'iconEnd'|'fullWidth'> {
  label: string             // обязателен → aria-label, tooltip на десктопе
  icon: Slot
  shape?: 'square' | 'round'
}
```

### Field

```ts
export interface FieldProps extends Base {
  value: string
  onValueChange: (value: string) => void
  label?: string; ariaLabel?: string
  placeholder?: string; hint?: string; error?: string
  size?: 'md' | 'lg'
  multiline?: boolean | { minRows?: number; maxRows?: number }
  clearable?: boolean
  prefix?: Slot; suffix?: Slot
  disabled?: boolean; readOnly?: boolean; required?: boolean; autoFocus?: boolean
  maxLength?: number
  inputMode?: JSX.HTMLAttributes<HTMLInputElement>['inputMode']
  enterKeyHint?: 'done' | 'go' | 'next' | 'send'
  autoCapitalize?: 'none' | 'sentences'
  spellcheck?: boolean
  onEnter?: (value: string) => void
  onEscape?: () => void
  inputRef?: Ref<HTMLInputElement | HTMLTextAreaElement>
}
```
`font-size: 16px` всегда; фон `--e-bg-sunken`, граница `--e-line-control`; ошибка под полем
14px `--e-danger`, поле не трясётся; авторост textarea — через скрытый measurer, не через
`scrollHeight` в rAF-петле.

### Checkbox

```ts
export interface CheckboxProps extends Base {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  label?: Slot; ariaLabel?: string; description?: Slot
  indeterminate?: boolean; disabled?: boolean
  tone?: Tone
  size?: 'md' | 'lg'        // визуально 20 / 24, зона нажатия 44
}
```
Нативный `<input type="checkbox">` визуально скрыт, рисуется квадрат `--e-radius-xs`.
Галочка — SVG `stroke-dasharray` 0→24 за 130 мс с `--e-ease-snap`; при снятии исчезает
мгновенно (обратное движение читается как неуверенность).

### ListView и Row

```ts
export interface ListViewProps<T> extends Base {
  items: readonly T[]
  getKey: (item: T) => string
  renderItem: (item: T, index: number) => Slot
  header?: Slot; footer?: Slot; empty?: Slot
  loading?: boolean; skeletonCount?: number       // 5
  dividers?: 'none' | 'inset' | 'full'            // 'inset'
  reorder?: { onReorder: (key: string, beforeKey: string | null) => void; handle?: 'row' | 'grip' }
  flip?: boolean
  ariaLabel: string
}

export interface RowProps extends Base {
  leading?: Slot; title: Slot; subtitle?: Slot; trailing?: Slot
  tone?: Tone                 // левая полоска 2px
  selected?: boolean
  muted?: boolean             // выполненная задача: --e-fg-2 + line-through
  proposed?: boolean          // предложение агента: пунктир + tint агента (наложение, не запись)
  onActivate?: () => void
  swipe?: { right?: SwipeAction; left?: SwipeAction[] }
  href?: string
}
export interface SwipeAction { label: string; icon: Slot; tone: Tone; onAction: () => void; confirm?: boolean }
```
Виртуализации в v1 нет; при `items.length > 300` в dev печатается предупреждение, а холодная
часть (§3.8) вообще не материализуется. `role="list"` + `role="listitem"`; вся строка **не**
превращается в кнопку (иначе ломается выделение текста).

### Card, Overlay, Toast, EmptyState, Skeleton, Menu, Tabs, Avatar, Chip, Divider, Spinner

```ts
export interface CardProps extends Base {
  as?: 'div' | 'article' | 'section' | 'a' | 'button'
  elevation?: 0 | 1 | 2 | 3
  padding?: 'none' | 'sm' | 'md' | 'lg'   // 0 / 12 / 16 / 24
  tone?: Tone
  interactive?: boolean
  header?: Slot; footer?: Slot; children?: Slot
}

export type Presentation = 'auto' | 'dialog' | 'sheet' | 'popover'
export interface OverlayProps extends Base {
  open: boolean
  onClose: (reason: 'backdrop' | 'escape' | 'swipe' | 'action') => void
  presentation?: Presentation           // 'auto': <768px → sheet
  title?: string; description?: string
  size?: 'sm' | 'md' | 'lg'             // dialog: 380 / 520 / 720
  detents?: ('content' | 'full')[]      // 'half' удалён — не было потребителя
  dismissible?: boolean
  anchor?: HTMLElement | null           // обязателен для popover
  primaryAction?: { label: string; onAction: () => void; tone?: Tone; loading?: boolean }
  secondaryAction?: { label: string; onAction: () => void }
  footer?: Slot; children: Slot
}

export interface ToastOptions {
  message: string
  tone?: 'neutral' | 'success' | 'danger'
  action?: { label: string; onAction: () => void }
  duration?: number                     // 6000; 0 = до закрытия вручную
  id?: string                           // одинаковый id → замена, не стопка
}
export interface ToastApi { show(o: ToastOptions): string; dismiss(id: string): void; clear(): void }
export const toast: ToastApi

export interface EmptyStateProps extends Base {
  art?: Slot; title: string; description?: string
  action?: { label: string; onAction: () => void }
  size?: 'inline' | 'page'; tone?: Tone
}
export interface SkeletonProps extends Base {
  variant?: 'text' | 'row' | 'card' | 'circle' | 'block'
  width?: string | number; height?: string | number; lines?: number
}
export interface MenuItem {
  id: string; label: string; icon?: Slot; tone?: Tone; shortcut?: string
  disabled?: boolean; checked?: boolean; onSelect: () => void
}
export interface MenuProps extends Base {
  items: (MenuItem | { type: 'separator' } | { type: 'label'; label: string })[]
  open: boolean; onOpenChange: (open: boolean) => void
  anchor: HTMLElement | null
  placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'
  presentation?: 'auto' | 'popover' | 'sheet'
  ariaLabel: string
}
export interface TabItem { id: string; label: string; icon?: Slot; badge?: number | 'dot'; tone?: Tone }
export interface TabsProps extends Base {
  items: TabItem[]; value: string; onValueChange: (id: string) => void
  variant?: 'segmented' | 'underline'; scrollable?: boolean; ariaLabel: string
}
export interface AvatarProps extends Base {
  name: string; color: 'a' | 'b' | 'agent'; size?: 16 | 20 | 24 | 32
  presence?: 'here' | 'away' | 'offline'; title?: string
}
export interface ChipProps extends Base {
  label: string; tone?: Tone; icon?: Slot
  selected?: boolean; onSelect?: () => void; onRemove?: () => void; size?: 'sm' | 'md'
}
export interface DividerProps extends Base { inset?: boolean; vertical?: boolean }
export interface SpinnerProps extends Base { size?: 16 | 20 | 24; label?: string }
```

Overlay: фокус-ловушка, возврат фокуса на триггер, `Esc`, `inert` на остальном приложении,
`overscroll-behavior: contain`, блокировка скролла body без прыжка (`scrollbar-gutter: stable`).
Sheet: ручка 36×4px, закрытие при смещении > 30 % высоты или скорости > 0.5 px/ms, резина
вверх; нижний паддинг = `--e-space-8 + var(--e-safe-bottom) + var(--e-kb-inset)`.

Toast: максимум 3 одновременно; позиция на мобильном — над таббаром
(`bottom: calc(var(--e-tabbar-h) + var(--e-safe-bottom) + var(--e-space-5))`), на десктопе —
снизу слева; `role="status" aria-live="polite"`, для `danger` — `role="alert"`; таймер
останавливается на hover и на фокусе внутри. **Тост — единственное место для Undo.**

Skeleton: анимация — не шиммер, а дыхание (`opacity 0.55 → 0.85`, 1400 мс, `alternate`);
показывается только если ожидание превысило 180 мс; при `reduce` — статичная плашка;
геометрия совпадает с будущим контентом.

Spinner: дуга 270°, 900 мс `linear`, `stroke-width: 2`; при `reduce` — три пульсирующие точки.

## 11.9 Компоненты оболочки (`@elementar/shell`)

Не в `ui`, потому что знают про документы (§2.3):

* `AppShell` — раскладка `TopBar` + контент + (`TabBar` | `Rail`), safe-area, `data-corpus`.
* `TopBar` — заголовок, до двух действий, слот присутствия, липкость с hairline при скролле.
* `TabBar` / `Rail` — общая структура пунктов, разная проекция.
* `ShareSheet` — QR + приглашение + постоянная ссылка + пароль + «сменить ссылку» (§12.8).
* `ModelSlotSettings` — провайдер, ключ, модель, транспорт, «проверить связь».
* `AgentProposal` — контейнер предложений (наложение поверх списка, §10.4).
* `CatchupDigest` — шит «Пока вас не было» (§6.12).
* `TrashScreen` — «Недавно удалённые».
* `LinkSaveSheet` — «Сохраните ссылку» (§5.2).

## 11.10 Шрифт вне критического пути

60 КБ шрифтов противоречат LCP ≤ 1.2 с. Решение:

* `font-display: optional` — браузер либо успел взять шрифт из кэша, либо рисует фолбэком
  и **не перерисовывает**; скачка вёрстки нет;
* шрифт precache в install-фазе SW (второй визит и все запуски PWA — уже свой шрифт);
* метрический фолбэк per-platform (§11.5) — макет не сдвигается;
* `<link rel="preload">` шрифта **не ставится** на первом визите.

Остаточный риск: первый визит с холодным кэшем показывает системный шрифт. Принимается.

**Решено против чего.**
Против выдуманного контраста 6.17 (design §5) — ревью 2 п.19а: введён CI-скрипт.
Против `--e-fg-muted` «≥16px» — ревью 2 п.19б. Против `color-mix` без фолбэков — ревью 2
п.19в: iOS < 16.4. Против `border-radius: inherit` в фокусе — ревью 2 п.19г. Против
одного фолбэк-фейса — ревью 2 п.19д. Против `--e-surface-2 = #FFFFFF` — ревью 2 п.18е.
Против `detents: half` — ревью 2 п.18г. Против `settings.theme` в документе — ревью 2 п.22е.

---

# 12. Планер — первая дверь

## 12.1 Что это

Четыре списка (работа, быт, хобби, творчество), проекты (карточка, группирующая задачи
отдельно от четырёх списков), календарь, мобильный вид, парный режим. Планер ничего не
измеряет, ничем не управляет и не является трекером.

## 12.2 Схема — единственный источник модели

`apps/web/src/corpus/planer/schema.ts`. Никаких `PlanerDoc`, `Task`, `Project`, объявленных
руками, не существует.

```ts
import { defineCorpus, f, type CorpusData } from '@elementar/core'

export const LISTS = ['work', 'home', 'hobby', 'craft'] as const
export type ListKey = (typeof LISTS)[number]

export const PLANER = defineCorpus({
  id: 'planer',
  schemaVersion: 1,
  meta: {
    title:      f.text({ max: 120 }),
    weekStart:  f.enum(['1', '7'] as const, { default: '1' }),
    listTitles: f.json<Record<ListKey, string>>(),   // переименовать можно, удалить нельзя
  },
  collections: {
    task: {
      ordered: true,
      groupBy: 'bucket',
      label: (t) => t.title,
      softDeleteDays: 30,
      cold: (t, now) => t.done && t.doneAt != null && now - t.doneAt > 90 * 864e5,
      fields: {
        title:  f.text({ max: 400 }),
        note:   f.text({ long: true }),                 // keepConflicts = true по умолчанию
        /** ЕДИНСТВЕННЫЙ контейнер: 'list:work' | … | 'proj:<recordId>' (§3.4). */
        bucket: f.tagged(
          { list: {}, proj: { ref: 'project' } },
          { default: 'list:work', onDangling: 'orphan' },
        ),
        done:   f.bool(false),
        doneAt: f.nullable(f.number()),                 // epoch ms; для «Сделано сегодня» и cold
        date:   f.nullable(f.date()),                   // LocalDate 'YYYY-MM-DD', без зоны
        time:   f.nullable(f.time()),                   // 'HH:MM', необязательное
        repeat: f.nullable(f.json<Repeat>()),
        seriesId:        f.nullable(f.ref('task', { onDangling: 'keep' })),
        occurrenceIndex: f.nullable(f.number()),        // для детерминированного id (§6.9)
      },
    },
    project: {
      ordered: true,
      label: (p) => p.title,
      fields: {
        title:    f.text({ max: 200 }),
        note:     f.text({ long: true }),
        tint:     f.enum([...LISTS, 'neutral'] as const, { default: 'neutral' }),
        due:      f.nullable(f.date()),
        archived: f.bool(false),
      },
    },
  },
})

export interface Repeat {
  every: 'day' | 'week' | 'month'
  interval: number        // 1..30
  weekdays?: number[]     // 1..7 (пн..вс), только для every: 'week'
}

export type Planer  = CorpusData<typeof PLANER>
export type Task    = Planer['task']
export type Project = Planer['project']
```

### Чего в схеме нет и почему

**Убрано из спеки ядра:** `event` и `rrule` (планер про дни, а не про встречи; RFC 5545
«разворачивается на клиенте» — это отдельная библиотека класса rrule.js на 4+ КБ и обвал
крайних случаев с зонами); `tags` и весь OR-Set в v1-схеме (четыре списка и есть теги,
только фиксированные и осмысленные); `project: f.ref` (заменён вариантом внутри `bucket`);
`meta.tz`; `f.counter`.

**Убрано из дизайн-спеки:** `draft` (предложения — наложение, §10.4); `createdBy`/`updatedBy`
как поля (авторство читается из `actor` в HLC-метке ячейки — не надо хранить дважды и не надо
чинить при слиянии); `settings.theme` (свойство устройства, §11.4); `actors` внутри
`PlanerDoc` (это служебная коллекция ядра `_actors`, §3.9).

**Отвергнуто с обоснованием:** подзадачи (воспроизводятся проектом); приоритеты (ручной порядок
и есть приоритет); `status: 'in-progress'` (промежуточный статус не меняет ни одного решения);
вложения, комментарии, чек-листы, оценки времени (это трекер); `assignee` (пара из двух людей
с общим списком; поле немедленно превращает планер в систему поручений и в источник обид);
`remindAt` (уведомлений в v1 нет — хранить поле, которое ничего не делает, нельзя);
`deletedAt` руками (мягкое удаление — механизм ядра); цвет и иконка у задачи (цвет задаётся
контейнером, иначе список превращается в ёлку).

**Оставлено, потому что без него не работает:** `doneAt` (правило «выполненное скрывается
через сутки» и порог холодной части); `date` + `time` раздельно (подавляющее большинство
задач датированы без времени); `repeat` + `seriesId` + `occurrenceIndex` (быт без «мусор по
вторникам» неработоспособен, а детерминированный id — минимальная цена за корректность при
одновременном выполнении, §6.9).

## 12.3 Производные выборки

```ts
export function todayTasks(doc: DocHandle<typeof PLANER.collections>, today: LocalDate): {
  overdue: Task[]; today: Task[]; doneToday: Task[]
}
export function listTasks(doc, list: ListKey): { open: Task[]; doneToday: Task[] }
export function projectTasks(doc, projectId: RecordId): Task[]
export function orphanTasks(doc): Task[]                  // bucket указывает на мёртвый проект
export function calendarMonth(doc, month: string): Map<LocalDate, Task[]>
export function counts(doc): Record<ListKey, number>      // только открытые
```

Сортировка внутри контейнера: сначала невыполненные по `order`, затем выполненные сегодня по
`doneAt` убывая. Внутри «Сейчас»: просроченные → сегодня по `time` (без времени — после) →
выполненные сегодня.

## 12.4 Мобильный вид (приоритет: iPhone / PWA)

```
┌─────────────────────────────┐  ← safe-area-top
│  Наш планер          ⓐⓑ  ⋯ │  TopBar 52px
├─────────────────────────────┤
│ [Работа] Быт  Хобби  Творч. │  сегменты 40px, свайп между ними
├─────────────────────────────┤
│ ☐  Позвонить в транспортную │  строка ≥52px
│    завтра                ⬤ │  вторая строка 14px; ⬤ = непрочитанная правка партнёра
│ ☐  Собрать коробки на кухне │
│ ─────────────────────────── │
│ Сделано сегодня · 3      ⌄ │
│ Без проекта · 2          ⌄ │  секция ORPHAN (§3.5), только если непусто
├─────────────────────────────┤
│ ✎ Новая задача          ✧  │  композер
├─────────────────────────────┤
│  Сейчас  Списки  Проекты  📅│  TabBar 56px + safe-area-bottom
└─────────────────────────────┘
```

Четыре вкладки снизу; четыре списка — сегментами внутри «Списки». Пять и более вкладок
ломают достижимость большим пальцем.

### Композер и клавиатура iOS — отдельное требование

Композер — главный элемент главного экрана, и `position: sticky; bottom: 0` при открытой
клавиатуре в iOS Safari **уезжает под неё**. Атрибута `interactive-widget=resizes-content`
в iOS Safari нет.

**Требование:** композер позиционируется по `window.visualViewport`, а не `sticky`.

```ts
// packages/ui/src/hooks/useVisualViewport.ts
/**
 * Подписывается на visualViewport.resize и visualViewport.scroll.
 * Выставляет --e-kb-inset и возвращает offset для transform: translateY(...).
 * Обновление — в rAF, не чаще кадра.
 */
export function useVisualViewport(): { kbInset: number; offsetTop: number; height: number }
```

Композер: `position: fixed; bottom: 0; transform: translateY(calc(-1 * var(--e-kb-inset)))`.
На iOS при фокусе в поле таббар скрывается. Тестируется **на реальном устройстве** —
на симуляторе проблема не воспроизводится.

### Жесты

| жест | действие |
|---|---|
| свайп вправо (порог 96px, **старт не ближе 24px от левого края**) | выполнить / вернуть; фон `--e-success-tint` |
| свайп влево | «На завтра» (`--e-accent`) и «Удалить» (`--e-danger`, с Undo) |
| долгое нажатие 400 мс | взять строку для перестановки; `scale(1.02)` + `--e-shadow-3` |
| тап | открыть задачу шитом |
| потянуть шит вниз | закрыть |
| свайп по сегментам | переключение между четырьмя списками |
| двойной тап по дате в календаре | создать задачу на этот день |

24px от края — иначе жест съедает системный edge-swipe «назад» в iOS PWA.
**Все жесты дублируются меню `⋯` в строке.** Жест не является единственным способом ничего.

**Pull-to-search удалён** (был в дизайн-спеке): недоказуемый жест в продукте, который
принципиально отказался от онбординга, и он дерётся с нативной резинкой. Поиск — иконка в
`TopBar` и `/` на десктопе.

Композер разбирает префиксы на лету: `завтра`, `пн`, `12.09` → дата. Восклицательный знак
ничего не делает (приоритетов нет, специально).

## 12.5 Десктоп (≥ 1024px)

```
┌────────────┬──────────────────────────────┬──────────────────┐
│ Наш планер │  Быт                    12   │  Задача          │
│ ● Сейчас 5 │  ☐ Позвонить в транспортную  │  Собрать коробки │
│ Списки     │  ☐ Собрать коробки на кухне  │  Быт  ·  завтра  │
│ ▪ Работа 4 │  ┄ ✧ ПРЕДЛОЖЕНО · 7      ┄  │  Повтор: нет     │
│ ▪ Быт   12 │  Сделано сегодня · 3      ⌄  │  Заметка…        │
│ ▪ Хобби  2 │  Без проекта · 2          ⌄  │  ⚑ версия Ани    │
│ ▪ Творч. 1 │  ✎ Новая задача              │  Изменил Виктор  │
│ Проекты    │                              │  [Удалить]       │
│ Календарь  │                              │                  │
│ Корзина    │                              │                  │
│ ⓐ ⓑ  ⚙    │                              │                  │
└────────────┴──────────────────────────────┴──────────────────┘
  240px            максимум 720px               400px
```

Рельс фиксирован; активный пункт — заливка `--e-surface-hover` + 2px полоска цвета списка.
Средняя колонка ≤ 720px и центрирована. Правая панель появляется при выбранной задаче
(`translateX(8px)` + fade, 200 мс), закрывается `Esc`. 768–1023px: рельс сворачивается в
иконки 64px, панель задачи становится диалогом. Перестановка мышью — за ручку слева от
чекбокса (появляется на hover), а не за всю строку.

### Клавиатура

| клавиша | действие |
|---|---|
| `n` | новая задача в текущем контейнере |
| `Enter` | открыть карточку / подтвердить ввод |
| `Space` или `x` | переключить выполнение |
| `e` | редактировать название в строке |
| `↑ ↓` | перемещение по списку |
| `Alt + ↑ / ↓` | переместить задачу в порядке |
| `1 2 3 4` | работа / быт / хобби / творчество |
| `t` / `p` / `c` | сейчас / проекты / календарь |
| `/` | поиск |
| `Cmd/Ctrl + Z`, `+ Shift + Z` | отменить / вернуть (с проверкой владения, §6.10) |
| `Esc` | закрыть шит, снять выделение, выйти из редактирования |

## 12.6 Экраны

**Сейчас.** Секции сверху вниз: **Просрочено** (заголовок `--e-danger`, без нагнетания),
**Сегодня**, **Сделано сегодня** (свёрнуто). Каждая строка несёт точку 6px цвета своего
контейнера — единственное место, где контейнеры смешаны, поэтому цвет нужен.
Пусто: «На сегодня ничего. Это нормально» + «Посмотреть списки».

**Списки.** Четыре сегмента. В конце — «Сделано сегодня» и, если непусто, «Без проекта»
(§3.5).

**Проекты.** Сетка карточек (мобильный — одна колонка, десктоп 2–3). Карточка: название
18/500, полоска `tint` сверху 3px, прогресс тонкой линией (`3/12`), дата, до трёх ближайших
задач 14px `--e-fg-3`. Экран проекта: шапка, список задач проекта (со своим ручным порядком —
это работает благодаря `groupBy: 'bucket'` по `f.tagged`), композер. Никакой доски, никаких
стадий. Архив прячет карточку и убирает задачи из «Сейчас»; задачи не удаляются.

**Календарь.** Мобильный — вертикальная лента недель: строка недели с семью числами, под ней
дни с задачами списком; текущий день — заливка `--e-solid`; бесконечная прокрутка; кнопка
«Сегодня» появляется, когда сегодняшний день ушёл из вида. Десктоп — месячная сетка 7×5/6,
в ячейке до трёх задач цветными строками 18px, дальше «+4»; перетаскивание между днями
меняет `date`. Никаких часовых сеток. Точки под числом — до четырёх, дублируются числом в
`aria-label`.

**Недавно удалённые.** `ListView` со строками «что, когда, кем» и пометками «партнёр правил
после удаления». Кнопки «Вернуть» и «Стереть навсегда». Приёмочный критерий парного режима
(§6.13).

**Настройки.** Тема, имя (пишется в `_actors`), переименование четырёх списков, начало недели,
слот модели, «сменить ссылку», «серверная копия истечёт …», экспорт.

## 12.7 Карточка задачи

Шит (мобильный) / панель (десктоп). Поля сверху вниз:

1. название — многострочный автоввод 18/500;
2. заметка — плейсхолдер «Заметка»; **под ней чип «версия Ани»**, если в `cell.c[]` есть
   проигравшая версия (§6.6a). Тап → обе версии рядом, выбор пишет операцию и чистит `c`.
   Этот чип обязателен: без него офлайн-правка заметки молча исчезает;
3. контейнер — чип с цветом → меню переноса (четыре списка + активные проекты);
4. дата — чипы «Сегодня / Завтра / Пн / Убрать» + календарик;
5. время — появляется после «Добавить время»;
6. повтор — скрыт за «Повторять»;
7. внизу `--e-fg-3`: «Добавила Аня · 12 августа», «Изменил Виктор · 5 минут назад», «Удалить».

Сохранение по мере ввода с дебаунсом **1500 мс** простоя (§7.4) и коалесценцией; кнопки
«Сохранить» нет; закрытие шита фиксирует немедленно.

## 12.8 Шаринг

```
┌───────────────────────────┐
│  Поделиться планером      │
│      ▓▓ ▓  ▓▓▓ ▓  ▓       │  QR 232×232, SVG, локально, ECC M, тихая зона 4 модуля
│      ▓  ▓▓ ▓   ▓▓▓        │  тёмные модули --e-fg, поле --e-surface
│                           │
│  [ Отправить приглашение ]│  ← ОСНОВНОЕ действие: одноразовая ссылка, 15 минут (§5.3)
│  Приглашение можно открыть│
│  один раз и только сегодня│
│                           │
│  Постоянная ссылка     ⌄  │  свёрнуто; при раскрытии — текст про невозможность отзыва
│  Пароль на ссылку     [○] │
│  Правили: 2 устройства    │  ← считается по локальному логу, не спрашивается у сервера
│  ─────────────────────────│
│  Сменить ссылку           │  --e-danger, с подтверждением
└───────────────────────────┘
```

QR кодирует **постоянную** ссылку целиком с фрагментом (сканируется лично, глазами).
«Отправить приглашение» использует `navigator.share` с одноразовым URL.
Пароль включается переключателем: генерируется фраза из 5 слов, показывается крупно,
кнопка «Скопировать», ниже — «Без пароля ссылку откроет любой, у кого она есть».
«Сменить ссылку» — диалог: «Старая ссылка перестанет работать. У Ани планер исчезнет,
пока вы не пришлёте новую».

Уровней доступа нет: только полный. Read-only требовал бы второго ключа и второго объяснения
пользователю, и всё равно не мешал бы читателю форкнуть локально.

## 12.9 Парный режим в интерфейсе

* Присутствие: до двух аватаров 24px (инициал на `--e-actor-a`/`-b`). Онлайн → полная
  насыщенность + точка `--e-success` 6px; офлайн → `opacity: 0.45`, `title` = «Аня была час назад».
  Имя — из `_actors` (§6.14).
* Где партнёр: на десктопе микроподпись под аватаром («Быт»); на мобильном — поповер по тапу.
* Что правит: строка получает фон `color-mix(in oklab, var(--e-actor-b) 10%, transparent)`
  (со статическим фолбэком, §11.4), 2px полоску его цвета слева и микроаватар 16px справа.
* Авторство: своё — никогда; чужое непрочитанное — точка 6px (гаснет через 1 с на экране);
  чужое прочитанное — только в карточке.
* Новые задачи от партнёра появляются со вспышкой tint 1200 мс, **не сдвигая скролл**
  (вставка выше видимой области компенсируется `scrollTop`).
* Никаких живых курсоров, «печатает…», ленты активности, счётчика «онлайн 2».
* Конфликты: тост в сессии (§6.12 п.1), шит «Пока вас не было» после офлайна (п.2),
  корзина всегда (п.3), чип «версия партнёра» на заметке (§12.7).

## 12.10 Агент в планере

Кнопка `✧` в композере и в шапке проекта. Одна кнопка, без меню промптов. Если ключ модели
не задан или нет сети — кнопки **нет вовсе** (не заглушка, не апселл).

Ход: тап → шит «Что нужно сделать?» с примерами серым → «Предложить» → 3 скелетон-строки в
тоне агента + «Отменить» → предложения появляются каскадом (`--e-stagger`) **наложением**
поверх текущего списка:

```
✧ ПРЕДЛОЖЕНО · 7                    Убрать все   Оставить все
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
✧  Заказать коробки и скотч              ✕
✧  Составить опись мебели                ✕
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
                       [ Оставить 7 задач ]
```

* Строки рисуются из `ProposalChange` (§10.4), а **не** из записей `task`: пунктирная граница
  1px `--e-agent`, фон `--e-agent-tint`, вместо чекбокса `✧`.
* Тап открывает редактирование **предложения** (`ProposalStore.edit`), а не задачи.
* `✕` убирает одно предложение сразу.
* «Оставить N задач» — одна атомарная транзакция: `accept(id, indices)`. Тост
  «7 задач добавлено» + «Вернуть» (6 с).
* Предложения видны партнёру с пометкой «Виктор попросил агента»; подтвердить может любой.
* Предложения не попадают в счётчики, «Сейчас», календарь, поиск и экспорт **по построению**:
  они не записи.
* Истечение 24 ч — фильтр представления, не операция (§10.4).

Инструменты планера:

```ts
export const PLANER_TOOLS: AgentTool<Planer>[] = [
  { name: 'list_tasks', effect: 'read', description: 'Задачи с фильтром', input: { /* JsonSchema */ },
    run: async ({ bucket, done }, ctx) => ctx.doc.task.where({ bucket, done }).slice(0, 100) },
  { name: 'propose_tasks', effect: 'propose', description: 'Предложить новые задачи', input: { /* … */ },
    plan: async ({ items }, ctx) => draft({
      title: 'Разбить переезд на задачи',
      changes: items.map(toCreateChange),
    }) },
]
```

## 12.11 Бюджеты и ленивые чанки

Один общий бюджет заменён на измеряемые по входам, с гейтом `size-limit` в CI:

| Вход | Бюджет gzip | Что внутри |
|---|---|---|
| **Первая отрисовка** | **≤ 35 КБ** | preact + signals + core (доc, apply, storage, sync-автомат) + ui-минимум + экран «Списки» |
| `chunk/calendar` | ≤ 8 КБ | календарь, лента недель, месячная сетка |
| `chunk/share` | ≤ 10 КБ | ShareSheet + QR-энкодер |
| `chunk/agent` | ≤ 14 КБ | `@elementar/llm`, адаптеры, шит агента, ProposalStore UI |
| `chunk/settings` | ≤ 6 КБ | настройки, слот модели |
| `chunk/exchange` | ≤ 6 КБ | экспорт/импорт, zip |
| `chunk/argon2` | ≤ 22 КБ | wasm, только при пароле |
| `chunk/trash` | ≤ 3 КБ | корзина, сводка |
| **Итого со всеми чанками** | ≤ 110 КБ | |

Бюджет ядра честно ставится **20–22 КБ** и **измеряется**, а не декларируется: цифра 14 КБ
из исходной спеки ничем не подкреплена при том, что внутри живут движок запросов, автомат
синка, IDB-слой, крипта, дробный индекс, undo и proposals. Первым делом собирается скелет
ядра и меряется (§14, шаг 0).

**Решено против чего.**
Против `PlanerDoc`/`Task` руками (design §6) — ревью 2 п.1. Против `event`/`rrule`/`tags`
(client-core §2.4) — ревью 2 п.18. Против `sticky` композера (design §7.2) — ревью 2 п.20.
Против pull-to-search — ревью 2 п.18д. Против единого бюджета 55 КБ (client-core §0) и
90 КБ (design §9) — ревью 2 п.12.

---

# 13. PWA

## 13.1 Один манифест, один scope

Девять манифестов = девять установок на iOS = девять **раздельных** storage-контейнеров и
кэшей SW. Прихожая, установленная на домашний экран, физически не увидит документы планера,
а общая оболочка скачивается заново для каждого корпуса — то есть главная ставка проекта
(«продаётся скорость появления нового корпуса на общей оболочке») на iOS не выполняется.

```json
{
  "id": "/",
  "name": "Элементар",
  "short_name": "Элементар",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#FCFBF9",
  "theme_color": "#FCFBF9",
  "icons": [
    { "src": "/i/app-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/i/app-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/i/app-mask.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ],
  "shortcuts": [
    { "name": "Новая задача", "url": "/p/last?new=1" },
    { "name": "Сегодня", "url": "/p/last?view=today" }
  ],
  "share_target": { "action": "/share", "method": "GET", "params": { "text": "text", "url": "url" } }
}
```

Маршруты: `/` прихожая, `/p/:docId` планер, `/f/:docId` финансер, `/i/:iid` погашение
приглашения, `/share` приём расшаренной ссылки.

Отдельные манифесты для отдельных дверей — максимум будущая опция через `manifest id`
для тех, кто хочет иконку планера отдельно, **с явным предупреждением, что это отдельное
хранилище**. `orientation` не фиксируется.

`docs/adr/0007-single-origin.md` фиксирует это решение, потому что соблазн «сделаем красивые
отдельные иконки» будет возникать регулярно.

## 13.2 index.html

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="apple-touch-icon" href="/i/app-180.png">
<meta name="theme-color" content="#FCFBF9" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#131417" media="(prefers-color-scheme: dark)">
<script>/* инлайн-скрипт темы, ~200 байт; его sha256 попадает в CSP (§13.4) */</script>
```

`interactive-widget=resizes-content` ставится, но на iOS Safari его нет — поэтому композер
всё равно позиционируется по `visualViewport` (§12.4).

## 13.3 Сервис-воркер

Пишется руками (`packages/devkit/src/sw-template.ts`, ~140 строк), при сборке подставляются
`__PRECACHE__` (список хешированных файлов **с их sha256**) и `__VERSION__`.

```
install:  precache оболочки (index.html, JS, CSS, шрифты, иконки). НЕ skipWaiting.
activate: удалить чужие версии кэша → clients.claim()
fetch:
  не-GET, кросс-ориджин, /v1/*, ws:      → сеть, НИКОГДА не кэшировать
  navigate                               → CACHE-FIRST из precache('index.html')
  хешированные ассеты /assets/*          → cache-first, immutable
  иконки, шрифты                         → stale-while-revalidate
  всё остальное                          → сеть; при офлайне 504 без «страницы ошибки»
message: 'SKIP_WAITING' → self.skipWaiting()
```

**Навигация — cache-first, а не network-first с таймаутом 2.5 с.** Исходная спека давала до
2.5 секунд белого экрана на каждом холодном запуске при плохой (не отсутствующей) мобильной
сети — при том что оболочка уже в precache, а обновление и так обеспечено явным потоком
`updateReady`. Network-first здесь не добавляет ничего и стоит 2.5 секунды.

Ответы `/v1/*` **никогда** не попадают в Cache Storage. Данные пользователя SW не трогает:
он про оболочку, данные живут в IndexedDB.

## 13.4 CSP и инлайн-скрипт темы

Требование «CSP без `unsafe-inline` для скриптов» и требование «инлайн-скрипт темы в `<head>`
до первого пейнта» противоречат друг другу только при небрежной реализации.

Решение: `packages/devkit/src/pwa-plugin.ts` на сборке считает `sha256` инлайн-скрипта темы и
подставляет его в `script-src 'self' 'sha256-…'` в `_headers` (Cloudflare Pages) и в
заголовки Worker'а. `unsafe-inline` не вводится. Ровно один инлайн-скрипт разрешён, его хеш
проверяется тестом.

## 13.5 Целостность деплоя и защита сервис-воркера

SW — самый ценный и наименее защищённый актив: он читает `client.url` **целиком, вместе с
фрагментом** (§4.7.2 п.9). Меры (смягчение, не устранение):

1. `navigator.serviceWorker.register(url, { updateViaCache: 'none' })`.
2. Неизменяемые версионированные бандлы; `/assets/*` — immutable, имена с хешем.
3. **SW проверяет sha256 каждого precache-ассета по вшитому в него манифесту** перед тем,
   как отдать его странице, и **отказывается устанавливаться**, если хеш не совпал.
4. Публикация SHA-256 сборок (страница «Как это устроено» + git-тег).
5. Кнопка «Сбросить установленное приложение» в настройках: `registration.unregister()` +
   очистка Cache Storage (IndexedDB **не** трогается).
6. Жёсткий CSP (§4.8), `require-trusted-types-for 'script'`, ноль сторонних скриптов,
   ноль аналитики.
7. В модели угроз (§4.7.2 п.9) прямым текстом написано, что это не устраняется.

## 13.6 Обновление версии

Молчаливого обновления нет.

```ts
export interface PwaState {
  updateReady: ReadonlySignal<boolean>
  version: string
  installState: ReadonlySignal<'installed' | 'installable' | 'ios-manual' | 'unsupported'>
  promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'>
  applyUpdate(): Promise<void>
  dismissUpdate(): void
}
export function registerPwa(opts?: { swUrl?: string; checkEveryMs?: number }): PwaState
```

Проверка обновления при `visibilitychange` и раз в 30 минут. Новый воркер → `updateReady` →
тонкая плашка внизу «Новая версия · Обновить». Человек жмёт → ядро принудительно сбрасывает
состояние на диск, **дожидается опустошения outbox** (`sync.flush()`) или предупреждает,
что часть правок ещё не ушла, и только потом `SKIP_WAITING` + `reload`.

Причина строгости: на iPhone молчаливая перезагрузка в открытой вкладке читается как
«приложение потеряло мою работу».

## 13.7 iPhone

* Установка только вручную (Поделиться → На экран «Домой»). `beforeinstallprompt` в Safari
  нет → `installState: 'ios-manual'`, своя карточка-подсказка на **втором** визите, не чаще
  раза в 30 дней. Установочного баннера нет; в настройках — текстовая строка.
* Пока сайт не установлен, Safari может стереть IndexedDB после 7 дней без визитов —
  вместе со стором `secrets`. Меры: `navigator.storage.persist()`, честная плашка
  «поставьте на экран Домой, иначе Safari может почистить данные», **автоматический** экспорт
  раз в 7 дней при `persist() === false` (§5.2), синк включён по умолчанию.
* `env(safe-area-inset-*)` во всех фиксированных панелях; `overscroll-behavior: none`;
  `-webkit-touch-callout: none` на карточках; высота через `100dvh`.
* **Перенос между Safari и установленным PWA.** У них раздельные хранилища. Ядро предлагает
  «перенести документы» — но **не «сканом QR»**: своим телефоном свой же экран не сканируют.
  Правильный текст: «Скопируйте ссылку в Safari → откройте установленное приложение →
  вставьте». Плюс кнопка «Скопировать все ссылки» в настройках Safari-версии.

## 13.8 Производительность

* `content-visibility: auto` на секциях ниже сгиба, `contain: layout style` на строках.
* Никаких теней на анимируемых элементах.
* Холодная часть документа не материализуется в сигналы (§3.8).
* Целевые числа: LCP ≤ 1.2 с на iPhone 12 из кэша; «тап по чекбоксу → отрисовка» ≤ 50 мс;
  открытие документа на 10 000 записей ≤ 400 мс при дросселе 4×.

**Решено против чего.**
Против девяти манифестов (client-core §8.1, design §9) — ревью 2 п.13. Против network-first
на навигации (client-core §8.2) — ревью 2 п.15. Против CSP-конфликта — ревью 2 п.15:
хеш инлайн-скрипта. Против «переноса сканом QR» (client-core §8.4) — ревью 2 п.13.

---

# 14. Порядок реализации и что осознанно не делаем в v1

## 14.1 Порядок

Правило: каждый шаг заканчивается зелёными тестами и измеренным размером. Шаг, на котором
захочется написать что-то «в обход ядра», — сигнал доработать ядро, а не обойти.

**Шаг 0 — измерить, а не поверить (0.5 дня).**
Скелет `proto` + `core` с пустыми реализациями и настоящими зависимостями; `size-limit`
в CI. Цель — получить честную нижнюю границу веса до того, как бюджеты станут обещанием.

**Шаг 1 — `proto` (1 день).**
`consts.ts`, `codes.ts`, `frames.ts`, `canon.ts`, `keys.ts`, `env.ts`. Тесты: кодек
round-trip, битые кадры, канонизация подписи. `scripts/check-protocol.ts` в CI.

**Шаг 2 — фундамент ядра (1 день).**
`id.ts` (включая `seriesRecordId`), `hlc.ts` (включая переполнение `ctr`), `frac.ts`,
`b32.ts`. Property-тесты.

**Шаг 3 — сердце: слияние (3 дня, торопиться нельзя).**
`schema/*`, `doc/state.ts`, `doc/apply.ts`, `doc/merge.ts` (`mergeState`), `doc/purge.ts`.
Все десять property-тестов §6.13. **До зелёного здесь дальше не идти:** ошибка в `apply`
даёт молчаливое расхождение у супругов, обнаруживаемое через неделю.

**Шаг 4 — представление и запись (2 дня).**
`doc/tx.ts`, `doc/view.ts`, `doc/query.ts`, `doc/undo.ts` (с проверкой владения),
сигналы, `ChangeSet`, холодная часть.

**Шаг 5 — хранилище (2 дня).**
`storage/*` + фейковый IndexedDB в тестах, снапшоты, компактизация, `persist`, авто-экспорт.

**Шаг 6 — крипта и ссылки (2 дня).**
`crypto/*`: b32, HKDF-дерево, конверт EL1 + AAD, `nonce.ts` (сессионный), `sign.ts`
(канонизация с методом и путём), `password.ts` (wrap + wrapVer + клампы), `link.ts`
(ссылка + приглашение), `exportRecovery`. Замороженные векторы деривации.

**Шаг 7 — бэкэнд (4 дня, параллельно с 8).**
`apps/api`: роутер, `exists`-кэш, LimiterDO с двумя бакетами, DocDO (лог, снапшоты,
sig_nonces, acks, safeCompactSeq), InviteDO, D1-миграции, кроны, WS с хибернацией.
Тесты §8.13, включая `enumeration`, `replay`, `undelete`, `blindness`.

**Шаг 8 — sync-движок (3 дня).**
`sync/machine.ts` как чистая функция (тесты без сети), затем `transport`, `outbox`,
`http.ts` (keepalive-флаш), `chain.ts`, `session.ts`, `presence.ts`, `digest.ts`.

**Шаг 9 — дизайн-система (2 дня).**
Токены + `contrast.test.ts` в CI + компоненты из §11.8. `packages/shell` следом.

**Шаг 10 — планер (4 дня).**
Схема, экраны, композер по `visualViewport`, жесты, корзина, шаринг.

**Шаг 11 — PWA (1 день).**
Единый манифест, SW с проверкой хешей, поток обновления, `installState`.

**Шаг 12 — приёмка парного режима (1 день).**
Сценарий из §6.13: два браузера, офлайн, по 20 правок, включить сеть, `stateHash` совпал,
корзина и сводка объяснили человеку, что произошло. **Только после этого** — шаг 13.

**Шаг 13 — агент (2 дня).**
`@elementar/llm`, адаптеры, `_proposals`, наложение в списке, слот модели.
Правило: агент включается только после того, как планер отработал в паре сутки
без расхождений.

Итого ~28 рабочих дней до планера, работающего в паре с агентом.

## 14.2 Чего осознанно НЕ делаем в первой версии

**Продукт.**

1. Аккаунтов, входа, восстановления доступа.
2. Уведомлений и напоминаний (push, локальные, e-mail). Поле `date` уже есть, механизм
   можно добавить позже; сейчас планер не напомнит про дату, и это надо сказать вслух.
3. Подзадач, тегов, приоритетов, статуса «в работе», оценок времени, вложений, комментариев.
4. Назначения задач на человека.
5. Read-only ссылок и уровней доступа.
6. Импорта календарей (ICS), синхронизации с Google/Apple Calendar — зона «связного».
7. Поиска с фильтрами и операторами: одно поле, по названию, среди неархивных.
8. Досок, канбана, диаграмм, статистики, «продуктивности», серий выполнения.
9. Более двух участников: модель допускает, интерфейс рассчитан на двоих, больше не
   тестируем и не обещаем.
10. Живых курсоров, «печатает…», ленты активности.
11. Богатого текста, markdown, чек-листов в заметке: plain text и автолинк.
12. Кастомизации: пятого списка, своих цветов, своих тем. Переименовать четыре можно.
13. Виртуализации списка (порог 300 строк зафиксирован тестом; холодная часть §3.8 снимает
    основной риск).
14. Локализации: только русский, все строки в `strings.ts`.
15. Онбординга, туров, коачмарков.
16. Аналитики любого рода. Телеметрии нет.
17. Экрана истории версий. **Корзина есть** — это изменение формулировки относительно
    исходной дизайн-спеки, и оно обязательно (§6.12).
18. Часовых поясов: локальные даты, «сегодня» определяется устройством.

**Техника.**

19. Посимвольного слияния текста (LWW + чип «версия партнёра»; RGA-плагин в v2).
20. `f.counter` и PN-счётчиков — до появления реального потребителя.
21. Коллекции `event` и RRULE — планер про дни.
22. OR-Set в схеме планера (механизм в ядре остаётся для будущих корпусов).
23. Proof-of-work — заменён Turnstile и квотами (§9.7).
24. Отдельных манифестов на дверь (§13.1).
25. Отдельных пакетов `apps/planer`, `apps/finanser` — маршруты внутри `apps/web`.
26. Мостов почтера и одинэсера — им нужна другая модель доверия (§1.5), сначала ADR 0006.
27. Вложений и R2-блобов на клиенте — до постера.
28. Serverside-поиска, серверных напоминаний и пушей по содержимому — они невозможны при
    слепом сервере, и это ограничение продукта, а не техники.

## 14.3 Остаточные риски, которые остаются в v1

Их надо перечитать перед релизом, а не после.

1. **Свой CRDT — код, который нельзя «почти правильно».** Ошибка в `apply` даёт молчаливое
   расхождение, обнаруживаемое через неделю. Митигация: property-тесты §6.13 до релиза
   парного режима, `stateHash` на экране отладки, приёмочный сценарий.
2. **Компакция зависит от клиента.** Телефон потерян, ноутбук партнёра офлайн месяц → лог
   упирается в 4 MiB → документ read-only до появления любого клиента. Смягчено мягким
   порогом на 200 дельтах и `safeCompactSeq`, но не устранено.
3. **Durable Object живёт в одном датацентре.** Для пары в одном городе идеально; для
   трансконтинентальной пары один получит +150–250 мс на подтверждение. Локальные правки
   применяются оптимистично, заметно только в чужом присутствии. `locationHint` при создании
   частично лечит.
4. **iOS Safari чистит IndexedDB неустановленных сайтов через 7 дней.** Меры в §5.2 и §13.7
   снижают, но остаточный риск реален и написан в интерфейсе.
5. **Потеря ссылки = потеря данных.** По построению. Первый же потерянный планер убьёт
   доверие, поэтому шит «Сохраните ссылку» настойчив.
6. **XSS = полная компрометация.** Ключ документа и ключи LLM в IndexedDB. Строгий CSP,
   Trusted Types, ноль сторонних скриптов, аудит любой зависимости с рантайм-кодом.
7. **Скомпрометированный деплой / SW.** §13.5 — смягчение, не устранение.
8. **Кривые часы** смещают LWW: у человека с отстающими часами правки систематически
   проигрывают до первого контакта. HLC частично лечит, предупреждение о дрейфе показывается.
9. **Дробные индексы деградируют** при массовых вставках в одну точку; ребаланс приезжает
   партнёру пачкой и перетряхивает список.
10. **CGNAT.** Даже с challenge-вместо-блока агрессивный сосед по NAT создаёт стену на 10 минут.
11. **Провайдеры LLM без CORS.** Тогда «без нашего сервера как посредника» ломается, и нужен
    релей — Worker, видящий содержимое запроса. Противоречие проговаривается в интерфейсе,
    а не прячется; авто-фолбэка нет (§10.1).
12. **Дальтонизм:** четыре цвета списков сближаются попарно. Цвет никогда не единственный
    носитель смысла, но скорость считывания теряется.
13. **Мосты вне модели** (§1.5). Заявка «одна оболочка на девять корпусов» в v1 честно
    звучит как «семь на общей оболочке и два на отдельной».

## 14.4 Открытые вопросы, требующие решения владельца

Каждый попадёт в интерфейс, поэтому это не технические вопросы.

1. **Домен.** Нужен реальный короткий ASCII-домен (§1.3, помечен ЗАГЛУШКА). Всё остальное
   от него зависит: ссылки, QR, CORS, CSP.
2. **Ретенция 365 дней** без обращений — цифра предложена здесь, попадёт в текст
   «серверная копия истечёт …».
3. **Имя партнёра**: спрашивать при первом входе по ссылке (трение на первом экране) или
   жить с «А» и «Б» до захода в настройки? Сейчас предполагается второе плюс мягкое
   предложение в шите «Пока вас не было».
4. **Календарь на мобильном**: лента недель (в спеке) или месячная сетка? Сетка красивее в
   скриншотах, лента полезнее в руке — нужно решение на макете.
5. **Архив выполненных** как отдельный экран или достаточно «Сделано сегодня» + холодная
   часть? Сейчас второе.
6. **Локальные напоминания** через SW по расписанию (ненадёжно на iOS) или честно сказать,
   что напоминаний нет? Сейчас второе (§14.2 п.2).
7. **Свайп влево**: сразу «на завтра» или меню из трёх пунктов? Сейчас две кнопки.
8. **Экспорт**: только `.elementar` или ещё `.ics`/`.csv` для чужих программ? Сейчас первое.
9. **Корпусный токен-слой** (`@elementar/ui/themes/planer.css`) уже сейчас или девять корпусов
   делят одну палитру? Сейчас второе.

---

## Приложение А. Карта разрешённых противоречий

| # | Расхождение | Решение | Основание |
|---|---|---|---|
| 1 | docId: 96 бит CSPRNG vs 128 бит HKDF(S) | 96 бит CSPRNG, Crockford base32, независимо от ключа | §4.3, офлайн-оракул |
| 2 | Пароль: обёртка ключа vs `S = Argon2id(pw)` | Только обёртка, второй фактор | §5.4 |
| 3 | Чтение: readToken / без авторизации / подпись | Подпись на всё, readToken удалён | §4.5 |
| 4 | Nonce: персистентный счётчик vs сессионный тег | Сессионный, ничего не персистится | §4.4 |
| 5 | sigInput без метода и пути | С методом и путём, длины префиксированы | §4.5 |
| 6 | Антиреплей в памяти DO | Персистентная таблица + alarm | §4.5 |
| 7 | Wrap без версии | `wrapVer` + запрет понижения + клампы KDF | §5.5 |
| 8 | Лог без цепочки | Хеш-цепочка + сверка через presence | §6.11 |
| 9 | Компактор по клиентскому `since` | `safeCompactSeq` по серверным ack + корзина R2 | §8.9 |
| 10 | Мгновенный DELETE, 1 поколение | Тумбстон 7 дней, 3 поколения, undelete | §8.5, §8.10 |
| 11 | Единый бакет со штрафом 640 | Два бакета, штраф только для неаутентифицированных | §9.2 |
| 12 | PoW 18 бит | Удалён, Turnstile + квоты | §9.7 |
| 13 | `create_ip_hash` + индекс | Удалён, перец ротируется по дням | §8.2 |
| 14 | Серверный `ts` в порядке | Только HLC, `ts` — метаданное | §6.3 |
| 15 | Две модели планера | Одна: `defineCorpus` | §12.2 |
| 16 | `bucket` + `project` двумя полями | `f.tagged`, одна ячейка | §3.4 |
| 17 | Даты с зоной | `LocalDate` без зоны, `f.datetime` отдельно | §3.2 |
| 18 | Присутствие: только число vs имена | `_actors` + шифрованный presence-блоб | §6.14 |
| 19 | Тосты vs корзина | Тост + сводка + корзина | §6.12 |
| 20 | Чистка надгробий по часам | Водяной знак `purgedBefore` | §6.7 |
| 21 | Дедуп повторов в слиянии | Детерминированный `seriesRecordId` | §6.9 |
| 22 | Два механизма предложений | Только `_proposals`, наложение | §10.4 |
| 23 | `mergeState` отсутствует | Добавлена, property-тест | §6.8 |
| 24 | Бюджеты 55 vs 90 КБ | По входам: 35 первая отрисовка, 110 всё | §12.11 |
| 25 | Девять манифестов | Один scope `/`, маршруты | §13.1 |
| 26 | `ui` знает про документы | `packages/shell` | §2.3 |
| 27 | Авто-фолбэк LLM на релей | Только явный выбор человека | §10.1 |
| 28 | Кириллический домен в ссылках | ASCII-домен, кириллица — редирект | §1.3 |
| 29 | Network-first на навигации | Cache-first | §13.3 |
| 30 | Undo без проверки владения | Проверка `actor` в `cell.t` | §6.10 |

## Приложение Б. Константы одним списком

```ts
// packages/proto/src/consts.ts — единственное место, где живут эти числа
export const C = {
  // крипта
  DOC_ID_BYTES: 12, DOC_ID_CHARS: 20,
  LINK_SECRET_BYTES: 32, FRAGMENT_BYTES: 33, FRAGMENT_CHARS: 53,
  NONCE_BYTES: 12, SESSION_TAG_BYTES: 8, GCM_TAG_BYTES: 16,
  HEADER_BYTES: 16, AAD_BYTES: 16, CHAIN_HASH_BYTES: 32,
  SIG_SKEW_MS: 120_000, SIG_NONCE_TTL_MS: 300_000, SIG_NONCE_BYTES: 12,
  INVITE_TTL_MS: 900_000, INVITE_USES: 1,
  // транспорт
  MAX_DELTA_BYTES: 65_536, MAX_PACKET_BYTES: 1_048_576, MAX_FRAMES: 256,
  MAX_SNAPSHOT_BYTES: 2_097_152, INLINE_SNAPSHOT_BYTES: 262_144,
  WS_FRAME_MAX: 131_072, WS_BATCH_OPS: 64, KEEPALIVE_BODY_MAX: 61_440,
  // лог
  LOG_SOFT_COUNT: 200, LOG_SOFT_BYTES: 524_288,
  LOG_HARD_COUNT: 1_200, LOG_HARD_BYTES: 2_621_440,
  LOG_CEIL_COUNT: 2_000, LOG_CEIL_BYTES: 4_194_304,
  DOC_TOTAL_BYTES: 12_582_912, SNAPSHOT_GENERATIONS: 3,
  TRASH_TTL_DAYS: 7, ACK_WINDOW_DAYS: 30,
  // жизненный цикл
  TTL_ACTIVE_DAYS: 365, TTL_EMPTY_DAYS: 7, TOMBSTONE_DAYS: 7,
  SOFT_DELETE_DAYS: 30, COLD_AFTER_DAYS: 90,
  // клиент
  SNAPSHOT_AFTER_OPS: 400, SNAPSHOT_AFTER_BYTES: 262_144, SNAPSHOT_DEBOUNCE_MS: 2_000,
  TEXT_DEBOUNCE_MS: 1_500, COALESCE_WINDOW_MS: 30_000,
  HEARTBEAT_MS: 25_000, HEARTBEAT_TIMEOUT_MS: 10_000,
  PRESENCE_TTL_MS: 30_000, PRESENCE_BEAT_MS: 15_000,
  BACKOFF_MAX_MS: 60_000, BACKOFF_JITTER: 0.3,
  HIDDEN_DISCONNECT_MS: 60_000, DIGEST_THRESHOLD: 5,
  UNDO_STACK: 50, CONFLICT_RING: 3, MAX_PEERS: 8, CLIENT_LRU: 16,
  // лимиты
  AUTH_BUCKET_CAPACITY: 240, AUTH_BUCKET_REFILL: 4,
  MISS_BUCKET_CAPACITY: 20, MISS_BUCKET_REFILL: 0.2,
  MISS_BASE: 5, MISS_COST_CAP_EXP: 4, MISS_STREAK_BLOCK: 20,
  BLOCK_MAX_MS: 900_000, CHALLENGE_MS: 600_000,
  LIMITER_SHARDS: 256, EXISTS_CACHE_POS_S: 300, EXISTS_CACHE_NEG_S: 60,
  MIN_404_MS: 25,
  // пароль
  ARGON2_M_KIB: 65_536, ARGON2_T: 3, ARGON2_P: 1,
  PBKDF2_ITERATIONS: 600_000, KDF_SALT_BYTES: 16, KDF_TARGET_MS: 700,
  PASSPHRASE_WORDS: 5, PASSPHRASE_BITS: 55, PASSWORD_MIN_BITS: 40,
} as const
```

---

*Конец документа. Изменения — только через PR с обновлением соответствующего блока
«Решено против чего» и, если решение архитектурное, с новым ADR в `docs/adr/`.*
