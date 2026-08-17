# Протокол

Спецификация интерфейсов: публичный API ядра и сетевой протокол между клиентом и синк-API.
Справочник. Читается по месту, не подряд.

Владелец файла — агент `architect`. Заведён решением Д-008.

**Чем это не является.** Здесь нет запретов, обоснований и инвариантов — они в
`ARCHITECTURE.md`. Здесь нет истории решений — она в `DECISIONS.md`. Если правка задевает
границу, запрет или модель доверия, она делается в `ARCHITECTURE.md`, а сюда приезжает
уже как описание провода.

**Частота изменения.** Спецификация меняется вместе с кодом, в том же PR. Контракт меняется
решением. Это и есть причина, по которой файлы разные.

---

## Как читать

**Номера разделов сохранены от `ARCHITECTURE.md`.** §7.7, §8.4, §8.5, §8.7, §8.9 — это те же
номера, что были до Д-008, потому что на них ссылается код: JSDoc в `packages/proto/src/*.ts`,
комментарии в `apps/api/src`, имена тестов. Номер раздела здесь — идентификатор, а не позиция
в файле. Ссылка вида «§4.5» без имени файла означает `ARCHITECTURE.md`.

**Числа и типы здесь не дублируются.** Единственный источник:

| Что | Где |
|---|---|
| Все числа протокола: размеры, пороги, TTL, окна | `packages/proto/src/consts.ts` (`C`, `MS`) |
| Коды ошибок и их HTTP-статусы | `packages/proto/src/codes.ts` (`ELM_ERROR_CODES`, `ERROR_STATUS`) |
| Типы тел запросов и ответов, имена заголовков, пути | `packages/proto/src/http.ts` (`HDR`, `CORS`, `PATHS`) |
| Типы WS-сообщений, разбор субпротокола | `packages/proto/src/ws.ts` |
| Кодек транспортного кадра | `packages/proto/src/frames.ts` |
| Канонизация подписи | `packages/proto/src/canon.ts` |
| Домены и происхождение | `packages/proto/src/env.ts` |
| Схема D1 | `apps/api/migrations/*.sql` |
| Привязки Worker'а | `apps/api/wrangler.toml` |

Правило: если значение объявлено в одном из этих файлов, документ называет его именем
константы, а не цифрой. Цифра, написанная в двух местах, расходится на третьей правке.

---

# Часть I. API ядра

## §7.7 Публичный API ядра

Контракт между корпусом и `@elementar/core`. Фасада в коде пока нет
(`packages/core/src/index.ts` — временный реэкспорт), поэтому объявления ниже нормативны.
Когда фасад появится, блок заменяется ссылкой на файл по правилу «Как читать».

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

У агента мутирующего API нет: всё, что он создаёт, идёт в `proposals` (§10.4). `tx` вызывает
только код корпуса в ответ на жест человека.

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

---

# Часть II. Сетевой протокол

## Порядок вызовов

Полный жизненный цикл документа со стороны провода. Каждый шаг подробно — ниже.

```
создание      POST /v1/docs (docId + sigPub + wrap [+ первый снапшот])
открытие      GET /v1/docs/{id}  →  GET /snapshot?gen=  →  GET /deltas?since=
работа онлайн GET /ws  →  welcome  →  бинарные кадры в обе стороны  →  ack
работа офлайн накопление в outbox  →  POST /deltas при возврате сети
уход в фон    POST /deltas (keepalive), тело ≤ C.KEEPALIVE_BODY_MAX
компакция     compact-request  →  PUT /snapshot с X-Elm-Base-Seq  →  broadcast snapshot
смена пароля  PUT /wrap со строго большим wrapVer
передача      POST /v1/invite  →  получатель GET /v1/invite/{iid} (одноразово)
удаление      DELETE  →  окно C.TOMBSTONE_DAYS  →  POST /undelete
```

Инвариант порядка применения — не транспортный: транспорт не гарантирует порядок доставки,
порядок задают гибридные логические часы внутри шифротекста (§6.2, §6.3). Серверный `seq` —
это только курсор дочитывания лога.

## §8.4 Транспортный кадр

Один формат на HTTP-тело `POST /deltas`, `GET /deltas` и на бинарные кадры WebSocket.

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

Валидация при разборе: `magic` и `ver` совпадают; `count ≤ C.MAX_FRAMES`;
`len ≤ C.MAX_DELTA_BYTES`; сумма по пакету `≤ C.MAX_PACKET_BYTES`; `payload` начинается с
`'EL1'`; в направлении `c2s` дополнительно `seq === 0` и `ts === 0`; хвостовых байт нет.
Любое нарушение → `ELM_BAD_FRAME`, ни одного исключения наружу.

Кодек — `packages/proto/src/frames.ts`, один и тот же код на клиенте и на сервере. Причины
общего пакета — §2.4.

## §8.5 REST API

База — `API_BASE` из `env.ts`. Пути строятся только через `PATHS` оттуда же: ровно эти
строки уходят в канонизацию подписи, поэтому клиент и сервер обязаны собирать их одним кодом.

**Все эндпоинты, кроме `/health` и `/challenge`, требуют подписи (§4.5).** Список
исключений — `UNSIGNED_PATHS`. Анонимного чтения не существует.

### Общие заголовки ответа

```
Cache-Control: no-store
Cross-Origin-Resource-Policy: same-origin
X-Content-Type-Options: nosniff
Access-Control-Allow-Origin: <ALLOWED_ORIGIN из env.ts — ASCII-литерал, НИКОГДА не эхо Origin>
Access-Control-Allow-Headers: <CORS.allowHeaders>
Access-Control-Expose-Headers: <CORS.exposeHeaders>
Access-Control-Max-Age: <CORS.maxAge>
```

Имена заголовков запроса и ответа — константы `HDR` в `http.ts`, сравнение всегда по
нижнему регистру. `X-Elm-Quota` присутствует на каждом ответе, формат — `formatQuotaHeader`.

### Ошибки

Тело ошибки — `ErrorBody` (`http.ts`); у `ELM_STALE_BASE` и `ELM_UNSAFE_BASE` расширенные
тела `StaleBaseBody` и `UnsafeBaseBody`. Список кодов и соответствие HTTP-статусам —
`ERROR_STATUS` в `codes.ts`, он нормативный.

Два ответа особые и описаны в `ARCHITECTURE.md`:

* `404` — единый на «нет документа», «нет подписи», «подпись неверна», «удалён», «протух»,
  «неверный формат»; байт в байт одинаковый, тело `NOT_FOUND_BODY`, выравнивание по
  `C.MIN_404_MS` (§9.4).
* `403 ELM_CHALLENGE` — не блокировка, а требование Turnstile-токена в `HDR.CHALLENGE` (§9.2).

### Таблица эндпоинтов

| Метод | Путь | Подпись | Успех | Типичные ошибки |
|---|---|---|---|---|
| `GET` | `/v1/health` | — | `200 HealthResponse` | — |
| `GET` | `/v1/challenge` | — | `200 ChallengeResponse` | `429` |
| `POST` | `/v1/docs` | да | `201 DocMeta` | `409 ELM_EXISTS`, `403 ELM_CHALLENGE`, `413` |
| `GET` | `/v1/docs/{id}` | да | `200 DocMeta` | `404` |
| `GET` | `/v1/docs/{id}/snapshot?gen=` | да | `200` binary | `404` |
| `PUT` | `/v1/docs/{id}/snapshot` | да | `200 SnapshotResult` | `409 ELM_UNSAFE_BASE`, `413`, `423 ELM_FROZEN` |
| `GET` | `/v1/docs/{id}/deltas?since=&limit=` | да | `200` binary | `409 ELM_STALE_BASE` |
| `POST` | `/v1/docs/{id}/deltas` | да | `200 PushResult` | `400 ELM_BAD_FRAME`, `413`, `507 ELM_QUOTA_LOG_FULL`, `429` |
| `PUT` | `/v1/docs/{id}/wrap` | да | `200 PutWrapResponse` | `409 ELM_WRAP_STALE` |
| `DELETE` | `/v1/docs/{id}` | да | `204` | `404` |
| `POST` | `/v1/docs/{id}/undelete` | да | `200 DocMeta` | `404` |
| `GET` | `/v1/docs/{id}/ws` | да, в субпротоколе | `101` | `404`, `429` |
| `POST` | `/v1/invite` | да | `201 CreateInviteResponse` | `413` |
| `GET` | `/v1/invite/{iid}` | нет | `200` binary, одноразово | `404` |
| `POST` | `/v1/llm/{provider}` | нет, Turnstile | стрим | `400`, `403`, `429` |

Цена каждой операции в auth-бакете — `OP_COST`, `pushDeltasCost`, `putSnapshotCost` в
`consts.ts`; правила списания — §9.2. Квоты и коды при их исчерпании — §8.11.

### `POST /v1/docs`

Тело — `CreateDocRequest`. `docId` генерирует клиент, сервер его не выдаёт.

Порядок обработки: kill-switch → лимитер → (Turnstile, если включён) → валидация формата
`docId` и `sigPub` → **проверка подписи ключом `sigPub` из тела** (доказательство владения
приватным ключом) → `DocDO.init()` → `waitUntil`: `INSERT INTO docs`, метрика.

Идемпотентность: повтор с тем же `docId` и той же `sigPub` → `200` с текущим `DocMeta`;
с другой `sigPub` → `409 ELM_EXISTS`. Это путь «нажал создать, сеть моргнула».

### `GET /v1/docs/{id}/deltas`

Query: `since` (u64, эксклюзивно), `limit` в границах `DELTAS_LIMIT_MIN…MAX`, по умолчанию
`DELTAS_LIMIT_DEFAULT`.

* `since < snapshotSeq` → `409` с телом `StaleBaseBody`, поле `resyncFrom = snapshotSeq`.
  Клиент обязан забрать снапшот и повторить.
* Иначе `200`, тело — транспортный пакет (§8.4), заголовки `HDR.HEAD` и `HDR.MORE` (`0|1`).

### `POST /v1/docs/{id}/deltas`

Тело — транспортный пакет. Заголовок `HDR.CLIENT` — `clientId` в base32. Ответ — `PushResult`;
`assigned` содержит и дубликаты, с их прежним `seq`.

Весь пакет пишется в одной SQLite-транзакции DO: либо приняты все кадры, либо ни один.
Дубли отсекаются по `UNIQUE(client_id, client_seq)` и попадают в `duplicates`, а не в ошибку.

`413` — дельта больше `C.MAX_DELTA_BYTES` или пакет больше `C.MAX_PACKET_BYTES`.
`507 ELM_QUOTA_LOG_FULL` — лог упёрся в потолок; лечится `PUT /snapshot`; чтение и WS при
этом продолжают работать.

### `PUT /v1/docs/{id}/snapshot`

Заголовок `HDR.BASE_SEQ` — граница, на которой собран снапшот. Тело — шифротекст,
не больше `C.MAX_SNAPSHOT_BYTES`. Ответ — `SnapshotResult`; `location` говорит, лёг снапшот
в DO или в R2 (граница — `C.INLINE_SNAPSHOT_BYTES`).

Условие приёма и весь порядок — §8.9.

### `PUT /v1/docs/{id}/wrap`

Тело — `PutWrapRequest`. Сервер принимает только строго больший `wrapVer`, иначе
`409 ELM_WRAP_STALE`. Это отсекает гонку двух устройств и случайный откат; от враждебного
сервера защищает не это, а §5.5.

### `DELETE` и `POST /undelete`

`DELETE` → `state = tombstone`, `deleted_at = now`, `purge_after = now + MS.TOMBSTONE`.
Блобы и лог **не трогаются** до `purge_after`. Подключённые пиры получают `bye`. Любой `GET`
после этого возвращает `404`, но `POST /v1/docs/{id}/undelete` с валидной подписью внутри
окна восстанавливает документ целиком.

### `POST /v1/invite` и `GET /v1/invite/{iid}`

Тело — `CreateInviteRequest`: `iid` (20 симв. b32, генерирует клиент) и `blob` не больше
128 байт. Хранится в отдельном `InviteDO` (`idFromName('inv:' + iid)`), TTL `C.INVITE_TTL_MS`,
счётчик использований `C.INVITE_USES`; отдача и удаление — атомарно, второй `GET` даёт `404`.

`GET` идёт без подписи: у получателя ещё нет ключа. Поэтому цена высокая и списывается из
miss-бакета (§9.2).

### `POST /v1/llm/{provider}`

Провайдер выбирается из зашитого allowlist, произвольный URL не принимается. Требования к
запросу, гигиена заголовков и лимиты — §10.2; режимы транспорта и запрет авто-фолбэка — §10.1.
Ответ стримится насквозь.

## §8.7 WebSocket

### Открытие

```
GET /v1/docs/{docId}/ws
Sec-WebSocket-Protocol: elm.v1, since.<n>, cl.<clientId b32>, sig.<alg>.<ts>.<nonce b32>.<sig b32>
```

Сервер отвечает единственным токеном `WS_PROTOCOL` (`elm.v1`). Сборка и разбор списка —
`formatWsSubprotocols` / `parseWsSubprotocols` в `ws.ts`; любое отклонение → соединение не
поднимается, ответ `404`.

Подпись покрывает канонизацию `GET` + путь `PATHS.ws(docId)` + пустое тело (§4.5).
**Без валидной подписи соединение не поднимается вообще**; анонимного read-only режима нет.

Base32 без паддинга состоит из валидных `tchar`, поэтому субпротокол-токен легален.

Соединение принимается в режиме хибернации; авто-ответ на пинг — `WS_AUTO_PING` → `WS_AUTO_PONG`
(`'p'` → `'o'`), чтобы keepalive не будил объект. В attachment сокета сохраняются `sessionId`,
`clientId`, `since` — после хибернации других источников этих значений нет.

### Сообщения

Текстовые кадры — управление (JSON), бинарные — пакеты дельт формата §8.4. Разделение ради
отладки: в devtools видна управляющая часть, а данные всё равно шифротекст. Размер текстового
кадра — не больше `C.WS_FRAME_MAX`.

Типы `ClientMsg`, `ServerMsg`, `PeerInfo` и их разбор — `packages/proto/src/ws.ts`. Разбор
тотальный в обе стороны: мусор превращается в `null`, а не в исключение; клиент не доверяет
серверу так же, как сервер клиенту.

Что означает каждое сообщение:

| Сообщение | Кто шлёт | Когда | Что делает получатель |
|---|---|---|---|
| `sub` | клиент | после открытия, если `since` изменился | сервер досылает хвост лога |
| `ack` | клиент | по мере применения | сервер двигает `acks.acked_seq` — от этого зависит `safeCompactSeq` |
| `pres` | клиент | не чаще `C.PRESENCE_BEAT_MS` | сервер кладёт непрозрачный блоб в память, рассылает `peer` |
| `snapshot-ready` | клиент | перед `PUT /snapshot` | сервер знает, что компактор жив, и не переспрашивает |
| `bye` | обе стороны | закрытие | закрыть соединение без бэкоффа |
| `welcome` | сервер | первым кадром | клиент сравнивает `since` с `snapshotSeq` и выбирает ветку |
| `ack` | сервер | на каждый принятый пакет | клиент проставляет серверные `seq` в outbox и чистит его |
| `resync` | сервер | клиент отстал от снапшота | клиент забирает снапшот по HTTP и переподключается |
| `snapshot` | сервер | компакция завершилась | клиент подтягивает новое поколение |
| `peer` | сервер | `join` / `leave` / `pres` | клиент обновляет присутствие |
| `compact-request` | сервер | пороги лога перейдены | адресат собирает снапшот (§8.9) |
| `error` | сервер | ошибка в рамках живого соединения | соединение остаётся |
| `bye` | сервер | соединение прекращается | ждать `retryAfter`, если он есть |

### Сценарии

**Подключение.** `welcome` содержит `head` и `snapshotSeq`. Если `since ≥ snapshotSeq` —
сервер шлёт бинарные кадры пачками по `C.WS_BATCH_OPS`. Иначе `resync`: клиент забирает
снапшот по HTTP (мегабайт через WS-кадры дороже и рискованнее) и переподключается.

**Запись.** Клиент шлёт кадр с `seq = 0, ts = 0`. DO присваивает `seq`, пишет в SQLite, шлёт
отправителю `ack`, остальным — тот же кадр с проставленными `seq` и `ts`. Локально операции
уже применены оптимистично.

**Офлайн.** Клиент копит операции с монотонным `clientSeq`. При восстановлении — WS или
`POST /deltas`. Дубли отсекаются по `UNIQUE(client_id, client_seq)`.

**Парный режим.** Присутствие живёт только в памяти DO, TTL `C.PRESENCE_TTL_MS`, полезная
нагрузка шифрованная и для сервера непрозрачная. Пиров на документ — не больше `C.MAX_PEERS`,
сверх того `bye ELM_RATE_LIMITED`.

**Разрыв.** Экспоненциальный бэкофф с джиттером: шаги `BACKOFF_STEPS_MS`, разброс
`±C.BACKOFF_JITTER`. При `bye` с `retryAfter` — ждать ровно столько.

**Потеря `clientId`.** Штатное событие (приватное окно, переустановка PWA, выселение
IndexedDB). Клиент обязан пережить его без деградации: новый `clientId`, новый `sessionTag`,
повторная выкачка снапшота, `mergeState`. Серверная сторона — LRU на `C.CLIENT_LRU` активных
`clientId` за сутки с вытеснением, без заморозки (§8.8).

## §8.9 Компакция

Сервер слеп и свернуть лог сам не может — компакция всегда клиентская. Сервер только считает
границу, до которой сворачивать безопасно, и назначает исполнителя.

**Правило безопасности:**

```
safeCompactSeq = min(
  acks.acked_seq по всем clientId, активным за последние MS.ACK_WINDOW,
  head
)
```

`PUT /snapshot` принимается только при `snapshotSeq < baseSeq ≤ safeCompactSeq`, иначе
`409 ELM_UNSAFE_BASE` с телом `UnsafeBaseBody`. Компактор пересобирает снапшот на безопасной
границе. Если единственный активный клиент — сам компактор, `safeCompactSeq = head`. Если
партнёр не появлялся дольше окна, он выпадает из расчёта, и срезанные дельты уходят в корзину
R2 на `C.TRASH_TTL_DAYS`, а не в небытие.

Порядок:

```
1. Пороги лога: soft   = C.LOG_SOFT_COUNT | C.LOG_SOFT_BYTES
                hard   = C.LOG_HARD_COUNT | C.LOG_HARD_BYTES
                потолок = C.LOG_CEIL_COUNT | C.LOG_CEIL_BYTES → 507
2. На soft DO выбирает компактора детерминированно: пир с наибольшим СЕРВЕРНЫМ ack
   (не с клиентским since), при равенстве — подключившийся раньше.
   Шлёт ему compact-request { upto: safeCompactSeq, urgency: 'soft' }.
3. Компактор строит снапшот состояния на upto, шифрует (тип Snapshot, AAD с docId),
   вкладывает chainHead (§6.11), делает PUT /snapshot с X-Elm-Base-Seq: upto.
4. DO проверяет baseSeq ≤ safeCompactSeq, gen = snapshotGen + 1;
   ≤ C.INLINE_SNAPSHOT_BYTES → snap_chunks, иначе R2 doc/{id}/snap/{gen}.bin.
5. Срезанные дельты копируются в R2 doc/{id}/trash/{from}-{to}.bin (TTL C.TRASH_TTL_DAYS),
   затем DELETE FROM deltas WHERE seq <= baseSeq.
6. Поколение gen - C.SNAPSHOT_GENERATIONS ставится в gc_queue.
7. Broadcast 'snapshot' всем пирам. Флаш в D1.
8. Нет ответа за 60 с → запрос следующему пиру. Пиров нет → compactionNeeded: true
   в каждом HTTP-ответе; первый зашедший клиент сделает снапшот.
9. На hard — запрос всем пирам сразу. На потолке — 507 на запись, чтение и WS живут,
   принимается только PUT /snapshot.
```

**Клиент обязан отвергать снапшот, чей `chainHead` не сходится с его цепочкой** — с баннером,
а не тихим принятием. Это единственная защита от подмены состояния сервером (§6.11).

---

*Спецификация. Изменения — вместе с кодом, в том же PR. Если правка задевает запрет,
границу или инвариант — она принадлежит `ARCHITECTURE.md`, а решение о ней — `DECISIONS.md`.*
