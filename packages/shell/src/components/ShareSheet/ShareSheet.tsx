/**
 * Шаринг (§12.8). Порядок действий — не косметика:
 * основное — одноразовое приглашение (15 минут, одно открытие, §5.3),
 * постоянная ссылка спрятана под раскрытие и снабжена честным предупреждением.
 */
import type { JSX } from 'preact'
import { useCallback, useState } from 'preact/hooks'
import { Button, Checkbox, Divider, IconButton, Overlay, cx, toast } from '@elementar/ui'
import type { Base, OverlayCloseReason } from '@elementar/ui'
import { generatePassphrase } from '@elementar/core'
import type { Invite } from '@elementar/core'
import { QrCode } from '../QrCode/QrCode.js'
import { copyText, shareLink } from '../../share.js'
import { DEVICES, withCount } from '../../text.js'

export type ShareMethod = 'invite' | 'copy' | 'share' | 'file' | 'qr'

export interface ShareSheetProps extends Base {
  open: boolean
  onClose: (reason: OverlayCloseReason) => void
  /** Постоянная ссылка целиком, с фрагментом: именно её кодирует QR. */
  link: string
  /** «Поделиться планером». */
  title?: string
  /** Считается по локальному логу, у сервера не спрашивается. */
  editors?: number
  hasPassword?: boolean
  /** Одноразовое приглашение: TTL 15 минут, одно открытие. */
  onInvite: () => Promise<Invite>
  onSetPassword?: (passphrase: string) => Promise<void>
  onRemovePassword?: () => Promise<void>
  /** «Сменить ссылку» — с подтверждением. */
  onRotateLink?: () => Promise<void>
  /** Файл-ключ (§5.6). */
  onDownloadKey?: () => void | Promise<void>
  /** Любое сохранение ссылки разрешает убрать фрагмент из адреса (§5.2). */
  onLinkSaved?: (method: ShareMethod) => void
}

export function ShareSheet({
  open,
  onClose,
  link,
  title = 'Поделиться планером',
  editors,
  hasPassword = false,
  onInvite,
  onSetPassword,
  onRemovePassword,
  onRotateLink,
  onDownloadKey,
  onLinkSaved,
  class: cls,
  ...rest
}: ShareSheetProps): JSX.Element {
  const [inviting, setInviting] = useState(false)
  const [permanentOpen, setPermanentOpen] = useState(false)
  const [passphrase, setPassphrase] = useState<string | null>(null)
  const [passBusy, setPassBusy] = useState(false)
  const [confirmRotate, setConfirmRotate] = useState(false)
  const [rotating, setRotating] = useState(false)

  const invite = useCallback(async () => {
    setInviting(true)
    try {
      const made = await onInvite()
      const outcome = await shareLink({
        url: made.url,
        title,
        text: 'Приглашение действует 15 минут и открывается один раз',
      })
      if (outcome === 'failed') toast.show({ message: 'Не удалось отправить приглашение', tone: 'danger' })
      else {
        toast.show({
          message: outcome === 'copied' ? 'Приглашение скопировано' : 'Приглашение отправлено',
          tone: 'success',
        })
        onLinkSaved?.('invite')
      }
    } catch {
      toast.show({ message: 'Приглашение не создалось — нет связи', tone: 'danger' })
    } finally {
      setInviting(false)
    }
  }, [onInvite, onLinkSaved, title])

  const copyPermanent = useCallback(async () => {
    const ok = await copyText(link)
    toast.show({
      message: ok ? 'Постоянная ссылка скопирована' : 'Буфер обмена недоступен',
      tone: ok ? 'success' : 'danger',
    })
    if (ok) onLinkSaved?.('copy')
  }, [link, onLinkSaved])

  const togglePassword = useCallback(
    async (checked: boolean) => {
      setPassBusy(true)
      try {
        if (checked) {
          const generated = generatePassphrase(5)
          await onSetPassword?.(generated.text)
          setPassphrase(generated.text)
        } else {
          await onRemovePassword?.()
          setPassphrase(null)
        }
      } catch {
        toast.show({ message: 'Не удалось изменить пароль ссылки', tone: 'danger' })
      } finally {
        setPassBusy(false)
      }
    },
    [onRemovePassword, onSetPassword],
  )

  const rotate = useCallback(async () => {
    setRotating(true)
    try {
      await onRotateLink?.()
      setConfirmRotate(false)
      toast.show({ message: 'Ссылка сменена', tone: 'success' })
    } catch {
      toast.show({ message: 'Не удалось сменить ссылку', tone: 'danger' })
    } finally {
      setRotating(false)
    }
  }, [onRotateLink])

  return (
    <>
      <Overlay
        {...rest}
        class={cx('e-share', cls)}
        open={open}
        onClose={onClose}
        title={title}
        size="sm"
      >
        <div class="e-share__qr">
          <QrCode value={link} label="QR с постоянной ссылкой на документ" />
          <p class="e-caption e-share__qr-hint">Наведите камеру со второго устройства</p>
        </div>

        <Button variant="primary" fullWidth loading={inviting} onClick={() => void invite()}>
          Отправить приглашение
        </Button>
        <p class="e-body-sm e-share__note">Приглашение можно открыть один раз и только сегодня</p>

        <Divider inset />

        <button
          type="button"
          class="e-share__disclosure"
          aria-expanded={permanentOpen}
          onClick={() => setPermanentOpen(!permanentOpen)}
        >
          <span class="e-body">Постоянная ссылка</span>
          <span class={cx('e-share__chevron', permanentOpen && 'is-open')} aria-hidden="true">
            ⌄
          </span>
        </button>
        {permanentOpen ? (
          <div class="e-share__permanent">
            <p class="e-body-sm e-share__warning">
              Эта ссылка работает всегда. Если она попадёт в чужие руки — отозвать её нельзя.
            </p>
            <div class="e-share__link e-mono e-truncate" title={link}>
              {link}
            </div>
            <div class="e-share__row">
              <Button size="sm" onClick={() => void copyPermanent()}>
                Скопировать
              </Button>
              {onDownloadKey !== undefined ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    void onDownloadKey()
                    onLinkSaved?.('file')
                  }}
                >
                  Скачать файл-ключ
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        <Divider inset />

        <Checkbox
          checked={hasPassword || passphrase !== null}
          disabled={passBusy || (onSetPassword === undefined && onRemovePassword === undefined)}
          onCheckedChange={(v) => void togglePassword(v)}
          label="Пароль на ссылку"
          description="Без пароля ссылку откроет любой, у кого она есть"
        />
        {passphrase !== null ? (
          <div class="e-share__passphrase">
            <p class="e-display e-share__phrase">{passphrase}</p>
            <Button
              size="sm"
              onClick={() => {
                void copyText(passphrase).then((ok) =>
                  toast.show({ message: ok ? 'Пароль скопирован' : 'Буфер недоступен', tone: ok ? 'success' : 'danger' }),
                )
              }}
            >
              Скопировать
            </Button>
            <p class="e-caption e-share__note">
              Запишите её: восстановить пароль невозможно, документ зашифрован им.
            </p>
          </div>
        ) : null}

        {editors !== undefined ? (
          <p class="e-body-sm e-share__editors">Правили: {withCount(editors, DEVICES)}</p>
        ) : null}

        {onRotateLink !== undefined ? (
          <>
            <Divider inset />
            <Button variant="danger" fullWidth onClick={() => setConfirmRotate(true)}>
              Сменить ссылку
            </Button>
          </>
        ) : null}
      </Overlay>

      <Overlay
        open={confirmRotate}
        onClose={() => setConfirmRotate(false)}
        presentation="dialog"
        size="sm"
        title="Сменить ссылку?"
        primaryAction={{ label: 'Сменить', onAction: () => void rotate(), tone: 'danger', loading: rotating }}
        secondaryAction={{ label: 'Отмена', onAction: () => setConfirmRotate(false) }}
      >
        <p class="e-body">
          Старая ссылка перестанет работать. У того, кому вы её давали, документ исчезнет, пока вы не пришлёте новую.
        </p>
      </Overlay>
    </>
  )
}

/** Кнопка «Поделиться» в шапке: отдельный экспорт, чтобы не тянуть весь шит. */
export interface ShareButtonProps extends Base {
  onClick: () => void
  label?: string
}

export function ShareButton({ onClick, label = 'Поделиться', ...rest }: ShareButtonProps): JSX.Element {
  return <IconButton {...rest} label={label} icon="↗" onClick={onClick} />
}
