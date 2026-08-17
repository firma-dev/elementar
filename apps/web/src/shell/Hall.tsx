import type { JSX } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { Button, Card, EmptyState, Field, ListView, Row, Spinner, toast } from '@elementar/ui'
import { APP_PREFIX } from '@elementar/proto'
import type { DocCard } from '@elementar/core'
import { H } from './strings.js'
import { navigate } from '../routes.js'
import { keysToPath, linkToPath } from './link.js'
import { repo } from '../runtime/db.js'

function prefixOf(corpus: string): string {
  return corpus === 'finanser' ? APP_PREFIX.finanser : APP_PREFIX.planer
}

function formatWhen(at: number): string {
  const days = Math.floor((Date.now() - at) / 864e5)
  if (days <= 0) return 'сегодня'
  if (days === 1) return 'вчера'
  return `${days} дн. назад`
}

/**
 * Прихожая (§13.1): один ориджин, одно хранилище, все двери видны отсюда.
 * Схемы корпусов грузятся лениво — прихожая не тянет за собой планер.
 */
export function Hall(): JSX.Element {
  const [cards, setCards] = useState<DocCard[] | null>(null)
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)

  const reload = (): void => {
    void repo()
      .then((r) => r.listDocs())
      .then(setCards)
      .catch(() => setCards([]))
  }

  useEffect(reload, [])

  const create = async (): Promise<void> => {
    setBusy(true)
    try {
      const [{ PLANER }, { createDocument }] = await Promise.all([
        import('../corpus/planer/schema.js'),
        import('../runtime/doc.js'),
      ])
      const handle = await createDocument(PLANER, { title: 'Наш планер' })
      const path = await keysToPath(handle.keys.docId, handle.keys.linkSecret)
      await handle.close()
      navigate(path)
    } catch (e: unknown) {
      toast.show({ message: String(e), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  const openLink = (): void => {
    void linkToPath(link).then((path) => {
      if (path === null) toast.show({ message: H.hall.badLink, tone: 'danger' })
      else navigate(path)
    })
  }

  const forget = (card: DocCard): void => {
    void repo()
      .then((r) => r.forgetDoc(card.docId))
      .then(reload)
  }

  return (
    <main class="h-hall e-content e-stack">
      <header class="h-hall__head">
        <h1 class="e-display">{H.hall.title}</h1>
        <p class="e-body-sm">{H.hall.subtitle}</p>
      </header>

      {cards === null ? (
        <Spinner label={H.hall.docs} />
      ) : cards.length === 0 ? (
        <EmptyState
          size="page"
          title={H.hall.empty}
          description={H.hall.emptyHint}
          action={{ label: H.hall.createPlaner, onAction: () => void create() }}
        />
      ) : (
        <ListView
          items={cards}
          getKey={(c: DocCard) => c.docId}
          ariaLabel={H.hall.docs}
          header={<div class="e-overline">{H.hall.docs}</div>}
          renderItem={(c: DocCard) => (
            <Row
              title={c.title === '' ? H.hall.corpus[c.corpus] ?? c.corpus : c.title}
              subtitle={`${H.hall.corpus[c.corpus] ?? c.corpus} · ${H.hall.lastOpened} ${formatWhen(c.lastOpenedAt)}`}
              onActivate={() => navigate(`${prefixOf(c.corpus)}/${c.docId}`)}
              swipe={{
                left: [
                  { label: H.hall.forget, icon: '✕', tone: 'danger', onAction: () => forget(c), confirm: true },
                ],
              }}
            />
          )}
        />
      )}

      <Card padding="md">
        <div class="e-stack">
          <Button variant="primary" fullWidth loading={busy} onClick={() => void create()}>
            {busy ? H.hall.creating : H.hall.createPlaner}
          </Button>
          <Field
            value={link}
            onValueChange={setLink}
            label={H.hall.openByLink}
            placeholder={H.hall.linkPlaceholder}
            onEnter={openLink}
          />
          <Button onClick={openLink}>{H.hall.openByLink}</Button>
          <Button variant="ghost" onClick={() => navigate('/recovery')}>
            {H.hall.recovery}
          </Button>
        </div>
      </Card>
    </main>
  )
}
