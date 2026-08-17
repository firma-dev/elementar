/**
 * Экран восстановления (§5.6, §5.2 п.6): документ вернулся с файлом-ключом
 * или с сохранённой ссылкой. Ничего не спрашивает у сервера — ключ целиком локальный.
 */
import type { JSX } from 'preact'
import { useCallback, useRef, useState } from 'preact/hooks'
import { Button, Card, Divider, Field, cx } from '@elementar/ui'
import type { Base } from '@elementar/ui'
import { importRecovery, tryParseLink } from '@elementar/core'
import type { ParsedLink } from '@elementar/core'
import { RECOVERY_FILE_ACCEPT, recoveryKind } from './recovery.js'

export interface RecoveryScreenProps extends Base {
  onRecovered: (link: ParsedLink) => void | Promise<void>
  onCancel?: () => void
  title?: string
}

type Stage =
  | { kind: 'idle' }
  | { kind: 'need-passphrase'; body: string }
  | { kind: 'busy' }
  | { kind: 'error'; message: string }

export function RecoveryScreen({
  onRecovered,
  onCancel,
  title = 'Восстановить документ',
  class: cls,
  ...rest
}: RecoveryScreenProps): JSX.Element {
  const fileRef = useRef<HTMLInputElement>(null)
  const [stage, setStage] = useState<Stage>({ kind: 'idle' })
  const [passphrase, setPassphrase] = useState('')
  const [link, setLink] = useState('')

  const finish = useCallback(
    async (parsed: ParsedLink) => {
      setStage({ kind: 'busy' })
      try {
        await onRecovered(parsed)
      } catch {
        setStage({ kind: 'error', message: 'Не удалось открыть документ' })
      }
    },
    [onRecovered],
  )

  const useBody = useCallback(
    async (body: string, phrase?: string) => {
      const kind = recoveryKind(body)
      if (kind === 'not-recovery') {
        setStage({ kind: 'error', message: 'Это не файл-ключ элементара' })
        return
      }
      if (kind === 'sealed' && (phrase === undefined || phrase === '')) {
        setStage({ kind: 'need-passphrase', body })
        return
      }
      setStage({ kind: 'busy' })
      try {
        const parsed = await importRecovery(body, phrase)
        await finish(parsed)
      } catch {
        setStage(
          kind === 'sealed'
            ? { kind: 'error', message: 'Фраза не подошла или файл повреждён' }
            : { kind: 'error', message: 'Файл-ключ повреждён' },
        )
      }
    },
    [finish],
  )

  const onFile = useCallback(
    async (file: File | null | undefined) => {
      if (file === null || file === undefined) return
      setPassphrase('')
      const body = await file.text()
      await useBody(body)
    },
    [useBody],
  )

  const openLink = useCallback(() => {
    const parsed = tryParseLink(link.trim())
    if (parsed === null) {
      setStage({ kind: 'error', message: 'Ссылка не похожа на ссылку элементара' })
      return
    }
    void finish(parsed)
  }, [finish, link])

  return (
    <div {...rest} class={cx('e-recovery', cls)}>
      <h1 class="e-title">{title}</h1>
      <p class="e-body e-recovery__lead">
        Записи хранятся на устройстве, а ключ — в ссылке или в файле-ключе. Дайте одно из двух,
        и документ вернётся.
      </p>

      <Card padding="lg" class="e-recovery__drop">
        <p class="e-body-strong">Файл-ключ</p>
        <p class="e-body-sm">Файл вида elementar-…-recovery.txt из «Загрузок».</p>
        <input
          ref={fileRef}
          class="e-sr-only"
          type="file"
          accept={RECOVERY_FILE_ACCEPT}
          onChange={(e) => void onFile((e.currentTarget as HTMLInputElement).files?.[0])}
        />
        <Button onClick={() => fileRef.current?.click()} loading={stage.kind === 'busy'}>
          Выбрать файл
        </Button>
      </Card>

      {stage.kind === 'need-passphrase' ? (
        <Card padding="lg" tone="accent" class="e-recovery__phrase">
          <p class="e-body-strong">Файл защищён парольной фразой</p>
          <Field
            label="Парольная фраза"
            value={passphrase}
            onValueChange={setPassphrase}
            autoCapitalize="none"
            spellcheck={false}
            autoFocus
            onEnter={() => void useBody(stage.body, passphrase)}
          />
          <Button
            variant="primary"
            disabled={passphrase.trim() === ''}
            onClick={() => void useBody(stage.body, passphrase)}
          >
            Открыть
          </Button>
        </Card>
      ) : null}

      <Divider />

      <div class="e-recovery__link">
        <Field
          label="Или вставьте ссылку"
          value={link}
          onValueChange={setLink}
          placeholder="https://…/p/XXXXXXXXXXXXXXXXXXXX#…"
          autoCapitalize="none"
          spellcheck={false}
          onEnter={openLink}
        />
        <Button onClick={openLink} disabled={link.trim() === ''}>
          Открыть по ссылке
        </Button>
      </div>

      {stage.kind === 'error' ? (
        <p class="e-body-sm e-recovery__error" role="alert">
          {stage.message}
        </p>
      ) : null}

      {onCancel !== undefined ? (
        <Button variant="ghost" onClick={onCancel}>
          Отмена
        </Button>
      ) : null}
    </div>
  )
}
