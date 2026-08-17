import type { JSX } from 'preact'
import { ShareSheet } from '@elementar/shell'
import type { OverlayCloseReason } from '@elementar/ui'
import { exportRecovery } from '@elementar/core'
import { downloadFile } from '@elementar/shell'
import { S } from './strings.js'
import type { PlanerStore } from './store.js'

export interface PlanerShareSheetProps {
  store: PlanerStore
  open: boolean
  onClose(reason?: OverlayCloseReason): void
}

/**
 * Шаринг планера (§12.8). QR кодирует постоянную ссылку целиком, «Отправить приглашение» —
 * одноразовый URL на 15 минут. Уровней доступа нет: только полный.
 */
export function PlanerShareSheet({ store, open, onClose }: PlanerShareSheetProps): JSX.Element {
  const handle = store.doc
  // «правили N устройств» считается по локальному логу, у сервера не спрашивается
  const editors = handle.actors.value.length

  return (
    <ShareSheet
      open={open}
      onClose={onClose}
      link={handle.link}
      title={S.share.title}
      editors={editors}
      hasPassword={handle.hasPassword}
      onInvite={() => handle.invite()}
      onSetPassword={(passphrase) => handle.setPassword(passphrase)}
      onRemovePassword={() => handle.clearPassword()}
      onDownloadKey={async () => {
        const file = await exportRecovery(handle.keys, { protect: { mode: 'plain' }, route: '/p' })
        downloadFile(file.filename, file.body, 'text/plain')
      }}
      onLinkSaved={() => {
        void handle.markLinkSaved()
      }}
    />
  )
}

export default PlanerShareSheet
