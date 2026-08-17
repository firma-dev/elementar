import type { JSX } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { EmptyState, Spinner } from '@elementar/ui'
import { API_ORIGIN, PATHS } from '@elementar/proto'
import { openInviteBlob, parseInviteUrl } from '@elementar/core'
import { H } from './strings.js'
import { navigate } from '../routes.js'
import { keysToPath } from './link.js'

/**
 * Погашение приглашения (§5.3): секрет живёт во фрагменте, сервер отдаёт только
 * шифроблоб. Ссылка одноразовая — второй заход честно упирается в отказ.
 */
export function InviteScreen({ iid }: { iid: string }): JSX.Element {
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const parsed = parseInviteUrl(globalThis.location.href)
    if (parsed === null || parsed.iid !== iid) {
      setFailed(true)
      return
    }
    void (async (): Promise<void> => {
      try {
        const res = await fetch(`${API_ORIGIN}${PATHS.inviteById(iid)}`, {
          method: 'GET',
          headers: { accept: 'application/json' },
        })
        if (!res.ok) throw new Error(String(res.status))
        const body = (await res.json()) as { blob?: unknown }
        if (typeof body.blob !== 'string') throw new Error('blob')
        const link = await openInviteBlob(parsed.secret, body.blob)
        navigate(await keysToPath(link.docId, link.linkSecret), { replace: true })
      } catch {
        setFailed(true)
      }
    })()
  }, [iid])

  if (failed)
    return (
      <main class="h-hall e-content">
        <EmptyState
          size="page"
          title={H.invite.failed}
          description={H.invite.failedHint}
          action={{ label: H.notFound.home, onAction: () => navigate('/') }}
        />
      </main>
    )

  return (
    <main class="h-hall e-content">
      <Spinner label={H.invite.title} />
    </main>
  )
}
