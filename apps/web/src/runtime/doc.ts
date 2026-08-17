import { ORIGIN, isDocId } from '@elementar/proto'
import type { SigAlg, WrapRecord } from '@elementar/proto'
import {
  createDoc as createDocRemote,
  createDocCore,
  createInvite as createInviteRemote,
  createInviteMaterial,
  createNonceSource,
  createSession,
  createSigner,
  createDocumentKeys,
  deriveLinkIdentity,
  documentKeysFrom,
  buildLink,
  generateDocKey,
  getDocMeta,
  preferredSigAlg,
  putWrap as putWrapRemote,
  randomBytes,
  setPassword as setPasswordWrap,
  tryParseLink,
  unwrapDocKey,
  wrapDocKey,
} from '@elementar/core'
import type {
  CollectionsDef,
  CorpusDef,
  DocCore,
  DocRepo,
  DocumentKeys,
  HttpEnv,
  Invite,
  NonceSource,
  SecretsRow,
  Session,
  Signer,
  Tx,
} from '@elementar/core'
import { deviceActor, repo } from './db.js'

export type DocOpenReason =
  | 'need-link'
  | 'need-password'
  | 'bad-password'
  | 'network'
  | 'not-found'
  | 'unsupported'

export class DocOpenError extends Error {
  override readonly name = 'DocOpenError'
  readonly reason: DocOpenReason
  constructor(reason: DocOpenReason, message: string) {
    super(message)
    this.reason = reason
  }
}

/** Код приложения в CreateDocRequest.app: сервер им ничего не решает, это подсказка. */
const APP_CODE: Record<string, number> = { planer: 1, finanser: 2 }

export interface DocHandle<S extends CollectionsDef> extends DocCore<S> {
  readonly session: Session
  readonly repo: DocRepo
  readonly keys: DocumentKeys
  readonly docKey: Uint8Array
  readonly signer: Signer
  readonly nonce: NonceSource
  readonly http: HttpEnv
  /** Постоянная ссылка с фрагментом: её показывает шаринг и кодирует QR. */
  readonly link: string
  readonly hasPassword: boolean
  readonly sync: boolean
  /** Ссылку уже сохранили человеческим жестом (§5.6). */
  readonly linkSaved: boolean
  setSync(on: boolean): Promise<void>
  invite(): Promise<Invite>
  setPassword(password: string): Promise<void>
  /** Снять пароль: K_doc уже в памяти, поэтому старый пароль спрашивать не за чем. */
  clearPassword(): Promise<void>
  markLinkSaved(): Promise<void>
  close(): Promise<void>
}

interface Material {
  keys: DocumentKeys
  docKey: Uint8Array
  wrap: WrapRecord
  wrapVer: number
  sigAlg: SigAlg
  clientId: Uint8Array
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length)
  copy.set(bytes)
  return copy.buffer
}

async function signerFor(keys: DocumentKeys, alg: SigAlg): Promise<Signer> {
  const identity = await deriveLinkIdentity(keys.docId, keys.linkSecret)
  return createSigner(identity.signSeed, alg)
}

function httpEnvOf(keys: DocumentKeys, signer: Signer, clientId: Uint8Array): HttpEnv {
  return { docId: keys.docId, docIdBytes: keys.docIdBytes, signer, clientId }
}

async function loadSecrets(r: DocRepo, docId: string): Promise<SecretsRow | undefined> {
  return r.getSecrets(docId)
}

async function persistSecrets(r: DocRepo, m: Material, remember: boolean): Promise<void> {
  const row: SecretsRow = {
    docId: m.keys.docId,
    mode: m.wrap.kdf.alg === 'none' ? 'plain' : 'password',
    wrap: m.wrap,
    wrapVer: m.wrapVer,
    sigAlg: m.sigAlg,
    clientId: toBuffer(m.clientId),
  }
  if (remember) row.linkSecret = toBuffer(m.keys.linkSecret)
  await r.putSecrets(row)
}

/** Разбор того, что нам дали открыть: docId, полная ссылка или объект. */
function refToLink(ref: string | { docId: string }): { docId: string; linkSecret: Uint8Array | null } {
  if (typeof ref !== 'string') return { docId: ref.docId, linkSecret: null }
  const parsed = tryParseLink(ref)
  if (parsed !== null) return { docId: parsed.docId, linkSecret: parsed.linkSecret }
  const bare = ref.includes('#') ? (ref.split('#')[0] ?? '') : ref
  return { docId: bare, linkSecret: null }
}

async function buildHandle<S extends CollectionsDef>(args: {
  def: CorpusDef<S>
  material: Material
  sync: boolean
  seed?: (t: Tx<S>) => void
  title?: string
}): Promise<DocHandle<S>> {
  const r = await repo()
  const actor = await deviceActor()
  const m = args.material
  const docId = m.keys.docId

  const row = await r.ensureDoc({
    docId,
    corpus: args.def.id,
    title: args.title ?? '',
    schemaVersion: args.def.schemaVersion,
    app: APP_CODE[args.def.id] ?? 0,
    sync: args.sync,
  })

  const core = createDocCore<S>({ def: args.def, docId, actor })
  const signer = await signerFor(m.keys, m.sigAlg)
  const nonce = createNonceSource()
  const session = createSession<S>({
    core,
    repo: r,
    docId,
    docIdBytes: m.keys.docIdBytes,
    key: m.docKey,
    nonce,
    signer,
    clientId: m.clientId,
    sync: row.sync,
  })

  await session.start()
  if (args.seed !== undefined) core.tx(args.seed, { label: 'Создание', undoable: false })

  // заголовок живёт в meta документа, карточка в базе — его отражение
  const applyTitle = (): void => {
    const value = core.meta.value['title']
    const text = typeof value === 'string' ? value : ''
    if (text === core.title.value) return
    core.title.value = text
    void r.patchDoc(docId, { title: text })
  }
  applyTitle()
  const offTitle = core.onChange((changes) => {
    if (changes.meta.includes('title')) applyTitle()
  })

  let sync = row.sync
  let linkSaved = row.linkPersistState === 'saved'
  let secrets = m

  // спред, а не Object.assign: геттеры ниже должны остаться геттерами
  const handle: DocHandle<S> = {
    ...core,
    session,
    repo: r,
    keys: m.keys,
    docKey: m.docKey,
    signer,
    nonce,
    http: httpEnvOf(m.keys, signer, m.clientId),
    link: buildLink(ORIGIN, m.keys, args.def.id === 'finanser' ? '/f' : '/p'),

    get hasPassword(): boolean {
      return secrets.wrap.kdf.alg !== 'none'
    },
    get sync(): boolean {
      return sync
    },
    get linkSaved(): boolean {
      return linkSaved
    },

    async setSync(on: boolean): Promise<void> {
      sync = on
      await r.patchDoc(docId, { sync: on })
      session.setEnabled(on)
    },

    async invite(): Promise<Invite> {
      const material = await createInviteMaterial(secrets.keys)
      await createInviteRemote(handle.http, { iid: material.iid, blob: material.blobB32 })
      return { iid: material.iid, url: material.url, expiresAt: material.expiresAt }
    },

    async setPassword(password: string): Promise<void> {
      const wrap = await setPasswordWrap(
        { linkSecret: secrets.keys.linkSecret, docIdBytes: secrets.keys.docIdBytes, wrap: secrets.wrap },
        password,
      )
      await pushWrap(wrap)
    },

    async clearPassword(): Promise<void> {
      const wrap = await wrapDocKey({
        docKey: m.docKey,
        linkSecret: secrets.keys.linkSecret,
        docIdBytes: secrets.keys.docIdBytes,
        wrapVer: secrets.wrapVer + 1,
        kdf: { alg: 'none' },
      })
      await pushWrap(wrap)
    },

    async markLinkSaved(): Promise<void> {
      linkSaved = true
      await r.patchDoc(docId, { linkPersistState: 'saved' })
    },

    async close(): Promise<void> {
      offTitle()
      await session.close()
    },
  }

  async function pushWrap(wrap: WrapRecord): Promise<void> {
    secrets = { ...secrets, wrap, wrapVer: wrap.wrapVer }
    await persistSecrets(r, secrets, true)
    if (!sync) return
    await putWrapRemote(handle.http, wrap).catch(() => undefined)
  }

  return handle
}

export interface CreateDocOptions<S extends CollectionsDef> {
  title?: string
  seed?: (t: Tx<S>) => void
  sync?: boolean
}

export async function createDocument<S extends CollectionsDef>(
  def: CorpusDef<S>,
  opts: CreateDocOptions<S> = {},
): Promise<DocHandle<S>> {
  const r = await repo()
  const keys = createDocumentKeys()
  const docKey = generateDocKey()
  const sigAlg = preferredSigAlg()
  const clientId = randomBytes(8)
  const wrap = await wrapDocKey({
    docKey,
    linkSecret: keys.linkSecret,
    docIdBytes: keys.docIdBytes,
    wrapVer: 1,
    kdf: { alg: 'none' },
  })
  const material: Material = { keys, docKey, wrap, wrapVer: 1, sigAlg, clientId }
  await persistSecrets(r, material, true)

  const sync = opts.sync ?? true
  const title = opts.title ?? ''
  const handle = await buildHandle<S>({
    def,
    material,
    sync,
    title,
    seed: (t) => {
      if (title !== '') t.meta({ title })
      opts.seed?.(t)
    },
  })

  if (sync) {
    // документ на сервере — «слепая» полка: если её нет, синк просто подождёт сети
    await createDocRemote(handle.http, {
      docId: keys.docId,
      sigAlg,
      sigPub: handle.signer.publicKeyB32,
      app: APP_CODE[def.id] ?? 0,
      wrap,
    }).catch(async (e: unknown) => {
      await r.journal({
        at: Date.now(),
        kind: 'sync',
        docId: keys.docId,
        message: `Документ не создан на сервере: ${String(e)}`,
      })
    })
  }
  return handle
}

export interface OpenDocOptions {
  password?: string
  sync?: boolean
  /** Не запоминать ключ ссылки на этом устройстве (§5.4). */
  remember?: boolean
}

export async function openDocument<S extends CollectionsDef>(
  def: CorpusDef<S>,
  ref: string | { docId: string },
  opts: OpenDocOptions = {},
): Promise<DocHandle<S>> {
  const r = await repo()
  const { docId, linkSecret: fromLink } = refToLink(ref)
  if (!isDocId(docId)) throw new DocOpenError('not-found', 'Такого адреса не бывает')

  const row = await loadSecrets(r, docId)
  const linkSecret = fromLink ?? (row?.linkSecret === undefined ? null : new Uint8Array(row.linkSecret))
  if (linkSecret === null)
    throw new DocOpenError('need-link', 'Нужна ссылка с ключом: без неё документ не открыть')

  const keys = documentKeysFrom(docId, linkSecret)
  const sigAlg = row?.sigAlg ?? preferredSigAlg()
  const clientId = row?.clientId === undefined ? randomBytes(8) : new Uint8Array(row.clientId)

  let wrap = row?.wrap
  if (wrap === undefined) {
    // первое открытие по ссылке на этом устройстве: wrap лежит на сервере
    const signer = await signerFor(keys, sigAlg)
    const meta = await getDocMeta(httpEnvOf(keys, signer, clientId)).catch((e: unknown) => {
      throw new DocOpenError('network', `Документ не найден на сервере: ${String(e)}`)
    })
    wrap = meta.wrap
  }
  if (wrap.kdf.alg !== 'none' && opts.password === undefined)
    throw new DocOpenError('need-password', 'Ссылка защищена паролем')

  const docKey = await unwrapDocKey({
    wrap,
    linkSecret,
    docIdBytes: keys.docIdBytes,
    password: opts.password ?? null,
  }).catch(() => {
    throw new DocOpenError(
      wrap?.kdf.alg === 'none' ? 'need-link' : 'bad-password',
      'Ключ не подошёл к этому документу',
    )
  })

  const material: Material = { keys, docKey, wrap, wrapVer: wrap.wrapVer, sigAlg, clientId }
  await persistSecrets(r, material, opts.remember !== false)

  const existing = await r.getDoc(docId)
  return buildHandle<S>({
    def,
    material,
    sync: opts.sync ?? existing?.sync ?? true,
    title: existing?.title ?? '',
  })
}
