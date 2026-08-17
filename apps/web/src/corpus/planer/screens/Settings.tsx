import type { JSX } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { Button, Checkbox, Chip, Divider, Field, toast } from '@elementar/ui'
import type { ThemeSetting } from '@elementar/ui'
import { ModelSlotSettings, downloadFile } from '@elementar/shell'
import { C } from '@elementar/proto'
import { exportRecovery, storageStatus } from '@elementar/core'
import type { StorageStatus } from '@elementar/core'
import { LISTS } from '../schema.js'
import type { ListKey } from '../schema.js'
import { S, listTitle } from '../strings.js'
import { formatDay, localDate } from '../dates.js'
import { renameList, setMeta } from '../actions.js'
import { customTitles } from './Lists.js'
import { llmSlot } from '../agent/registry.js'
import { setDeviceName } from '../../../runtime/db.js'
import { setTheme, themeSetting } from '../../../theme.js'
import type { PlanerStore } from '../store.js'

export interface SettingsProps {
  store: PlanerStore
  version: string
  installState: 'installed' | 'installable' | 'ios-manual' | 'unsupported'
  onInstall?(): void
  onResetInstall?(): void
}

const THEMES: Array<{ id: ThemeSetting; label: string }> = [
  { id: 'auto', label: S.settings.themeAuto },
  { id: 'light', label: S.settings.themeLight },
  { id: 'dark', label: S.settings.themeDark },
]

export function SettingsPanel({
  store,
  version,
  installState,
  onInstall,
  onResetInstall,
}: SettingsProps): JSX.Element {
  const doc = store.doc
  const me = doc.actors.value.find((a) => a.id === doc.actor)
  const [name, setName] = useState(me?.name ?? '')
  const [storage, setStorage] = useState<StorageStatus | null>(null)
  const titles = customTitles(store)

  useEffect(() => {
    void storageStatus().then(setStorage)
  }, [])

  const saveName = (): void => {
    doc.setActorName(name.trim())
    void setDeviceName(name.trim())
  }

  const exportKey = async (): Promise<void> => {
    const file = await exportRecovery(doc.keys, { protect: { mode: 'plain' }, route: '/p' })
    downloadFile(file.filename, file.body, 'text/plain')
  }

  const exportData = (): void => {
    const body = JSON.stringify(doc._state.value, null, 1)
    downloadFile(`planer-${doc.id}.json`, body, 'application/json')
  }

  const expiresAt = localDate(new Date(Date.now() + C.TTL_ACTIVE_DAYS * 864e5))

  return (
    <div class="p-screen p-settings e-stack">
      <section class="e-stack">
        <h3 class="e-subhead">{S.settings.theme}</h3>
        <div class="p-chips">
          {THEMES.map((t) => (
            <Chip
              key={t.id}
              label={t.label}
              selected={themeSetting.value === t.id}
              onSelect={() => setTheme(t.id)}
            />
          ))}
        </div>
      </section>

      <Divider />

      <section class="e-stack">
        <h3 class="e-subhead">{S.settings.name}</h3>
        <Field
          value={name}
          onValueChange={setName}
          placeholder={S.settings.namePlaceholder}
          hint={S.settings.nameHint}
          onEnter={saveName}
        />
        <Button onClick={saveName}>{S.common.save}</Button>
      </section>

      <Divider />

      <section class="e-stack">
        <h3 class="e-subhead">{S.settings.listTitles}</h3>
        {LISTS.map((key: ListKey) => (
          <Field
            key={key}
            value={listTitle(key, titles)}
            ariaLabel={S.lists[key]}
            onValueChange={(v) => renameList(doc, key, v)}
          />
        ))}
      </section>

      <Divider />

      <section class="e-stack">
        <h3 class="e-subhead">{S.settings.weekStart}</h3>
        <div class="p-chips">
          <Chip
            label={S.settings.weekMonday}
            selected={doc.meta.value['weekStart'] !== '7'}
            onSelect={() => setMeta(doc, { weekStart: '1' })}
          />
          <Chip
            label={S.settings.weekSunday}
            selected={doc.meta.value['weekStart'] === '7'}
            onSelect={() => setMeta(doc, { weekStart: '7' })}
          />
        </div>
      </section>

      <Divider />

      <section class="e-stack">
        <h3 class="e-subhead">{S.settings.model}</h3>
        <ModelSlotSettings registry={llmSlot()} />
      </section>

      <Divider />

      <section class="e-stack">
        <h3 class="e-subhead">{S.settings.sync}</h3>
        <Checkbox
          checked={doc.sync}
          label={doc.sync ? S.settings.syncOn : S.settings.syncOff}
          description={S.settings.syncHint}
          onCheckedChange={(on) => {
            void doc.setSync(on)
          }}
        />
        <p class="e-caption">{S.settings.expires(formatDay(expiresAt))}</p>
      </section>

      <Divider />

      <section class="e-stack">
        <h3 class="e-subhead">{S.settings.export}</h3>
        <p class="e-caption">{S.settings.exportHint}</p>
        <Button
          onClick={() => {
            void exportKey().then(() => toast.show({ message: S.settings.export, tone: 'success' }))
          }}
        >
          {S.settings.export} · ключ
        </Button>
        <Button onClick={exportData}>{S.settings.export} · задачи</Button>
      </section>

      <Divider />

      <section class="e-stack">
        <h3 class="e-subhead">{S.settings.install}</h3>
        {installState === 'ios-manual' ? <p class="e-caption">{S.settings.installIos}</p> : null}
        {installState === 'installable' && onInstall !== undefined ? (
          <Button onClick={onInstall}>{S.settings.installPrompt}</Button>
        ) : null}
        {onResetInstall === undefined ? null : (
          <>
            <Button variant="danger" onClick={onResetInstall}>
              {S.settings.resetInstall}
            </Button>
            <p class="e-caption">{S.settings.resetInstallHint}</p>
          </>
        )}
        <p class="e-caption">{`${S.settings.version}: ${version}`}</p>
        {storage === null ? null : (
          <p class="e-caption">
            {storage.persisted ? S.settings.storagePersisted : S.settings.storageVolatile}
          </p>
        )}
      </section>
    </div>
  )
}

export default SettingsPanel
