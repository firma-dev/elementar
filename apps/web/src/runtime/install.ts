import { setCorpusRuntime } from '@elementar/core'
import type { CollectionsDef, CorpusDef, DocCard, Tx } from '@elementar/core'
import { repo } from './db.js'

/**
 * Подключение рантайма к схемам (§7.7). Тяжёлая часть (крипта, сессия, синк) грузится
 * ленивым импортом: прихожая не должна тащить её в первую отрисовку (§12.11).
 */
export function installRuntime(): void {
  setCorpusRuntime({
    async create(def, init) {
      const { createDocument } = await import('./doc.js')
      const seed = init?.seed as ((t: Tx<CollectionsDef>) => void) | undefined
      return createDocument(def, {
        title: init?.title ?? '',
        ...(seed === undefined ? {} : { seed }),
      })
    },
    async open(def, ref, opts) {
      const { openDocument } = await import('./doc.js')
      return openDocument(def, ref, {
        ...(opts?.password === undefined ? {} : { password: opts.password }),
        ...(opts?.sync === undefined ? {} : { sync: opts.sync }),
      })
    },
    async list(def: CorpusDef): Promise<DocCard[]> {
      const cards = await (await repo()).listDocs()
      return cards.filter((c) => c.corpus === def.id)
    },
    async forget(_def: CorpusDef, docId: string): Promise<void> {
      await (await repo()).forgetDoc(docId)
    },
  })
}
