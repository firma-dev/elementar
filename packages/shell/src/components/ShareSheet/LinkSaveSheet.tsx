/**
 * «Сохраните ссылку» (§5.2). Показывается сразу после открытия документа по ссылке
 * и повторяется при каждом запуске, пока человек не сохранил ключ:
 * фрагмент остаётся в адресной строке ровно до этого момента.
 */
import type { JSX } from 'preact'
import { useCallback, useState } from 'preact/hooks'
import { Button, Overlay, cx, toast } from '@elementar/ui'
import type { Base, OverlayCloseReason } from '@elementar/ui'
import { copyText, shareLink } from '../../share.js'

export type LinkSaveMethod = 'copy' | 'share' | 'file'

export interface LinkSaveSheetProps extends Base {
  open: boolean
  /** «Позже» — шит закрывается, фрагмент остаётся, в следующий раз спросим снова. */
  onClose: (reason: OverlayCloseReason) => void
  link: string
  title?: string
  /** Скачивание файла-ключа: тело готовит вызывающий (exportRecovery). */
  onDownloadKey?: () => void | Promise<void>
  /** Любое из трёх действий → sealAddressBar(), состояние 'saved'. */
  onSaved: (method: LinkSaveMethod) => void
}

export function LinkSaveSheet({
  open,
  onClose,
  link,
  title = 'Сохраните ссылку',
  onDownloadKey,
  onSaved,
  class: cls,
  ...rest
}: LinkSaveSheetProps): JSX.Element {
  const [busy, setBusy] = useState(false)

  const copy = useCallback(async () => {
    const ok = await copyText(link)
    if (ok) {
      toast.show({ message: 'Ссылка скопирована', tone: 'success' })
      onSaved('copy')
    } else toast.show({ message: 'Буфер обмена недоступен', tone: 'danger' })
  }, [link, onSaved])

  const share = useCallback(async () => {
    const outcome = await shareLink({ url: link, title: 'Ссылка на документ' })
    if (outcome === 'failed') toast.show({ message: 'Не получилось поделиться', tone: 'danger' })
    else onSaved('share')
  }, [link, onSaved])

  const download = useCallback(async () => {
    setBusy(true)
    try {
      await onDownloadKey?.()
      onSaved('file')
    } catch {
      toast.show({ message: 'Файл-ключ не сохранился', tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }, [onDownloadKey, onSaved])

  return (
    <Overlay
      {...rest}
      class={cx('e-linksave', cls)}
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      dismissible
    >
      <p class="e-body e-linksave__why">
        Документ живёт на этом устройстве, а ключ — в ссылке. Если браузер очистит хранилище,
        вернуть записи можно будет только по ней. Пока ссылка не сохранена, она остаётся
        в адресной строке.
      </p>
      <div class="e-linksave__actions">
        <Button variant="primary" fullWidth onClick={() => void copy()}>
          Скопировать
        </Button>
        <Button fullWidth onClick={() => void share()}>
          Поделиться
        </Button>
        {onDownloadKey !== undefined ? (
          <Button fullWidth loading={busy} onClick={() => void download()}>
            Скачать файл-ключ
          </Button>
        ) : null}
        <Button
          class="e-linksave__later"
          variant="ghost"
          size="sm"
          onClick={() => onClose('action')}
        >
          Позже
        </Button>
      </div>
    </Overlay>
  )
}
