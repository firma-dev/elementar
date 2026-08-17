/**
 * Слот под модель (§11.9, §10.1). Провайдер, ключ, модель, транспорт, «проверить связь».
 *
 * Отдельно оговорено поведение при CORS-обрыве: авто-переключения на релей элементара
 * нет. Показываются три варианта, и переключение происходит только по нажатию человека.
 */
import type { JSX } from 'preact'
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks'
import { Button, Card, Divider, Field, Spinner, cx, toast } from '@elementar/ui'
import type { Base } from '@elementar/ui'
import {
  OWN_RELAY_TEMPLATE,
  PROVIDER_PRESETS,
  configFromPreset,
  describeLlmError,
  presetOf,
  relayable,
} from '@elementar/llm'
import type { LlmErrorCode, LlmSlot, LlmTransportConfig, ModelInfo, ProviderConfig } from '@elementar/llm'
import { useSignalValue } from '../../hooks.js'
import { copyText } from '../../share.js'

export interface ModelSlotSettingsProps extends Base {
  registry: LlmSlot
  /** Заглушка без сети — в списке только когда её явно просят. */
  showEcho?: boolean
  onSaved?: (c: ProviderConfig) => void
}

type ProbeState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'ok'; models: ModelInfo[] }
  | { kind: 'fail'; code: LlmErrorCode }

const TRANSPORTS: ReadonlyArray<{ mode: LlmTransportConfig['mode']; label: string; note: string }> = [
  {
    mode: 'direct',
    label: 'Напрямую из браузера',
    note: 'Запрос идёт вашим ключом мимо нас: нам нечего логировать и нечего терять.',
  },
  {
    mode: 'own-relay',
    label: 'Через свой релей',
    note: 'Для провайдеров без CORS. Шаблон Worker’а — в один клик, мы не на пути вообще.',
  },
  {
    mode: 'elm-relay',
    label: 'Через релей элементара',
    note: 'Ваш ключ провайдера пойдёт через сервер элементара.',
  },
]

export function ModelSlotSettings({
  registry,
  showEcho = false,
  onSaved,
  class: cls,
  ...rest
}: ModelSlotSettingsProps): JSX.Element {
  const active = useSignalValue(registry.active)
  const presets = useMemo(
    () => PROVIDER_PRESETS.filter((p) => showEcho || p.id !== 'echo'),
    [showEcho],
  )
  const [providerId, setProviderId] = useState<string>(active?.providerId ?? presets[0]?.id ?? 'anthropic')
  const [apiKey, setApiKey] = useState<string>(active?.apiKey ?? '')
  const [model, setModel] = useState<string>(active?.model ?? '')
  const [transport, setTransport] = useState<LlmTransportConfig>(active?.transport ?? { mode: 'direct' })
  const [relayUrl, setRelayUrl] = useState<string>(active?.transport.relayUrl ?? '')
  const [probe, setProbe] = useState<ProbeState>({ kind: 'idle' })
  const [saving, setSaving] = useState(false)

  const preset = presetOf(providerId)

  // Смена провайдера подставляет его умолчания, но не трогает уже введённый ключ другого
  useEffect(() => {
    const existing = registry.configs.value.find((c) => c.providerId === providerId)
    const base = existing ?? (preset !== undefined ? configFromPreset(preset) : null)
    if (base === null) return
    setApiKey(base.apiKey)
    setModel(base.model)
    setTransport(base.transport)
    setRelayUrl(base.transport.relayUrl ?? '')
    setProbe({ kind: 'idle' })
  }, [providerId, preset, registry])

  const draft = useCallback((): ProviderConfig => {
    const t: LlmTransportConfig =
      transport.mode === 'own-relay' ? { mode: 'own-relay', relayUrl } : { mode: transport.mode }
    return {
      providerId,
      apiKey,
      model,
      transport: t,
      ...(preset?.baseUrl !== undefined && preset.baseUrl !== '' ? { baseUrl: preset.baseUrl } : {}),
      ...(preset?.label !== undefined ? { label: preset.label } : {}),
    }
  }, [apiKey, model, preset, providerId, relayUrl, transport.mode])

  const check = useCallback(async () => {
    setProbe({ kind: 'busy' })
    const result = await registry.probe(draft())
    setProbe(result.ok ? { kind: 'ok', models: result.models } : { kind: 'fail', code: result.code })
  }, [draft, registry])

  const save = useCallback(async () => {
    setSaving(true)
    try {
      const config = draft()
      await registry.add(config)
      onSaved?.(config)
      toast.show({ message: 'Слот модели сохранён', tone: 'success' })
    } finally {
      setSaving(false)
    }
  }, [draft, onSaved, registry])

  const needsKey = preset?.local !== true
  const models = probe.kind === 'ok' && probe.models.length > 0 ? probe.models : (preset?.models ?? [])

  return (
    <div {...rest} class={cx('e-slot', cls)}>
      <label class="e-slot__label e-body-strong" for="e-slot-provider">
        Провайдер
      </label>
      <select
        id="e-slot-provider"
        class="e-slot__select"
        value={providerId}
        onChange={(e) => setProviderId((e.currentTarget as HTMLSelectElement).value)}
      >
        {presets.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>

      {needsKey ? (
        <Field
          label="Ключ"
          value={apiKey}
          onValueChange={setApiKey}
          placeholder="sk-…"
          hint={`Ключ хранится только на этом устройстве. ${preset?.keyHint ?? ''}`}
          autoCapitalize="none"
          spellcheck={false}
          inputMode="text"
        />
      ) : (
        <p class="e-body-sm e-slot__hint">{preset?.keyHint}</p>
      )}

      <label class="e-slot__label e-body-strong" for="e-slot-model">
        Модель
      </label>
      <select
        id="e-slot-model"
        class="e-slot__select"
        value={models.some((m) => m.id === model) ? model : '__custom'}
        onChange={(e) => {
          const v = (e.currentTarget as HTMLSelectElement).value
          if (v !== '__custom') setModel(v)
        }}
      >
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
        <option value="__custom">Другая…</option>
      </select>
      <Field ariaLabel="Идентификатор модели" value={model} onValueChange={setModel} size="md" />

      <Divider inset />

      <fieldset class="e-slot__transport">
        <legend class="e-body-strong">Транспорт</legend>
        {TRANSPORTS.map((t) => {
          const disabled = t.mode === 'elm-relay' && !relayable(providerId)
          return (
            <label key={t.mode} class={cx('e-slot__radio', disabled && 'is-disabled')}>
              <input
                type="radio"
                name="e-slot-transport"
                value={t.mode}
                checked={transport.mode === t.mode}
                disabled={disabled}
                onChange={() => setTransport({ mode: t.mode })}
              />
              <span>
                <span class="e-body">{t.label}</span>
                <span class="e-caption e-slot__note">
                  {disabled ? 'Этого провайдера релей элементара не проксирует.' : t.note}
                </span>
              </span>
            </label>
          )
        })}
        {transport.mode === 'own-relay' ? (
          <div class="e-slot__relay">
            <Field
              label="Адрес вашего релея"
              value={relayUrl}
              onValueChange={setRelayUrl}
              placeholder="https://relay.example.workers.dev"
              autoCapitalize="none"
              spellcheck={false}
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void copyText(OWN_RELAY_TEMPLATE).then((ok) =>
                  toast.show({ message: ok ? 'Шаблон скопирован' : 'Буфер недоступен', tone: ok ? 'success' : 'danger' }),
                )
              }}
            >
              Скопировать шаблон Worker’а
            </Button>
          </div>
        ) : null}
      </fieldset>

      <div class="e-slot__actions">
        <Button onClick={() => void check()} loading={probe.kind === 'busy'}>
          Проверить связь
        </Button>
        <Button variant="primary" loading={saving} onClick={() => void save()}>
          Сохранить
        </Button>
      </div>

      {probe.kind === 'busy' ? <Spinner size={16} label="Проверяем связь" /> : null}
      {probe.kind === 'ok' ? (
        <p class="e-body-sm e-slot__ok">
          Связь есть{probe.models.length > 0 ? `, моделей доступно: ${probe.models.length}` : ''}
        </p>
      ) : null}
      {probe.kind === 'fail' ? (
        <CorsChoice
          code={probe.code}
          providerId={providerId}
          onOwnRelay={() => setTransport({ mode: 'own-relay' })}
          onElmRelay={() => setTransport({ mode: 'elm-relay' })}
          onOtherProvider={() => {
            const next = presets.find((p) => p.id !== providerId)
            if (next !== undefined) setProviderId(next.id)
          }}
        />
      ) : null}
    </div>
  )
}

interface CorsChoiceProps {
  code: LlmErrorCode
  providerId: string
  onOwnRelay: () => void
  onElmRelay: () => void
  onOtherProvider: () => void
}

/** Экран выбора при CORS-обрыве: три варианта, ни один не выбирается за человека. */
function CorsChoice({ code, providerId, onOwnRelay, onElmRelay, onOtherProvider }: CorsChoiceProps): JSX.Element {
  if (code !== 'cors') {
    return (
      <p class="e-body-sm e-slot__fail" role="status">
        {describeLlmError(code)}
      </p>
    )
  }
  return (
    <Card class="e-slot__cors" tone="warning" padding="md">
      <p class="e-body-strong">Провайдер не отвечает браузеру напрямую</p>
      <p class="e-body-sm">
        Он не разрешает запрос со страницы. Выберите, что делать — переключить транспорт сами мы не станем.
      </p>
      <div class="e-slot__cors-actions">
        <Button size="sm" onClick={onOwnRelay}>
          Поставить свой релей
        </Button>
        <Button size="sm" onClick={onOtherProvider}>
          Сменить провайдера
        </Button>
        <Button size="sm" variant="ghost" disabled={!relayable(providerId)} onClick={onElmRelay}>
          Использовать релей элементара
        </Button>
      </div>
      <p class="e-caption e-slot__note">
        Последний вариант означает: ваш ключ провайдера пойдёт через сервер элементара.
      </p>
    </Card>
  )
}
