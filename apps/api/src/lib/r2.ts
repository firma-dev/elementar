/**
 * R2 (§8.6): снапшоты крупнее 256 KiB и корзина срезанных при компакции дельт.
 *   doc/{docId}/snap/{gen}.bin
 *   doc/{docId}/trash/{fromSeq}-{toSeq}.bin
 * Содержимое — шифротекст, сервер его не разбирает.
 */
export function snapKey(docId: string, gen: number): string {
  return `doc/${docId}/snap/${gen}.bin`
}

export function trashKey(docId: string, fromSeq: number, toSeq: number): string {
  return `doc/${docId}/trash/${fromSeq}-${toSeq}.bin`
}

export function docPrefix(docId: string): string {
  return `doc/${docId}/`
}

export interface SnapshotMeta {
  seq: number
  gen: number
  bytes: number
  sha256: string
}

export interface BlobStore {
  putSnapshot(docId: string, gen: number, body: Uint8Array, meta: SnapshotMeta): Promise<void>
  getSnapshot(docId: string, gen: number): Promise<Uint8Array | null>
  deleteSnapshot(docId: string, gen: number): Promise<void>
  putTrash(docId: string, fromSeq: number, toSeq: number, body: Uint8Array): Promise<void>
  /** Удаляет всё под doc/{docId}/ — вызывается дренажом gc_queue. */
  deleteDoc(docId: string): Promise<void>
  /** Ключи под префиксом, отсортированные R2; нужен ночному крону. */
  list(prefix: string, limit: number): Promise<Array<{ key: string; uploaded: number }>>
  delete(keys: readonly string[]): Promise<void>
}

export class R2Blobs implements BlobStore {
  constructor(private readonly bucket: R2Bucket) {}

  async putSnapshot(
    docId: string,
    gen: number,
    body: Uint8Array,
    meta: SnapshotMeta,
  ): Promise<void> {
    await this.bucket.put(snapKey(docId, gen), body as unknown as ArrayBufferView, {
      customMetadata: {
        seq: String(meta.seq),
        gen: String(meta.gen),
        bytes: String(meta.bytes),
        sha256: meta.sha256,
      },
    })
  }

  async getSnapshot(docId: string, gen: number): Promise<Uint8Array | null> {
    const obj = await this.bucket.get(snapKey(docId, gen))
    if (obj === null) return null
    return new Uint8Array(await obj.arrayBuffer())
  }

  async deleteSnapshot(docId: string, gen: number): Promise<void> {
    await this.bucket.delete(snapKey(docId, gen))
  }

  async putTrash(docId: string, fromSeq: number, toSeq: number, body: Uint8Array): Promise<void> {
    await this.bucket.put(trashKey(docId, fromSeq, toSeq), body as unknown as ArrayBufferView)
  }

  async deleteDoc(docId: string): Promise<void> {
    let cursor: string | undefined
    do {
      const page = await this.bucket.list({ prefix: docPrefix(docId), limit: 1000, cursor })
      if (page.objects.length > 0) await this.bucket.delete(page.objects.map((o) => o.key))
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor !== undefined)
  }

  async list(prefix: string, limit: number): Promise<Array<{ key: string; uploaded: number }>> {
    const page = await this.bucket.list({ prefix, limit })
    return page.objects.map((o) => ({ key: o.key, uploaded: o.uploaded.getTime() }))
  }

  async delete(keys: readonly string[]): Promise<void> {
    if (keys.length > 0) await this.bucket.delete([...keys])
  }
}
