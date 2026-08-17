import type { JSX } from 'preact'
import { useState } from 'preact/hooks'
import { Button, Card, Chip, EmptyState, Field, IconButton, ListView, Overlay } from '@elementar/ui'
import type { Tone } from '@elementar/ui'
import type { RecordId } from '@elementar/core'
import { LISTS } from '../schema.js'
import type { Project, Task } from '../schema.js'
import { S, listTitle } from '../strings.js'
import { formatDay } from '../dates.js'
import { Section } from '../components/Section.js'
import { TaskRow } from '../components/TaskRow.js'
import { addProject, removeProject, reorderTask, updateProject } from '../actions.js'
import { projectIndex, projectProgress } from '../select.js'
import { customTitles } from './Lists.js'
import type { PlanerStore } from '../store.js'

export interface ScreenProps {
  store: PlanerStore
}

function toneOf(project: Project): Tone | undefined {
  return project.tint === 'neutral' ? undefined : (project.tint as Tone)
}

function ProjectCard({ store, project }: { store: PlanerStore; project: Project }): JSX.Element {
  const progress = projectProgress(store.doc, project.id)
  const next = store.doc.col.task.all.value
    .filter((t: Task) => t.bucket === `proj:${project.id}` && !t.done)
    .slice(0, 3)

  return (
    <Card
      class="p-project-card"
      as="button"
      interactive
      tone={toneOf(project)}
      padding="md"
      onClick={() => store.openProject(project.id)}
    >
      <div class="p-project-card__title e-body-strong">{project.title}</div>
      <div class="p-project-card__meta e-caption">
        {`${S.project.progress} ${progress.done}/${progress.total}`}
        {project.due == null || project.due === '' ? '' : ` · ${formatDay(project.due)}`}
        {project.archived ? ` · ${S.project.archived}` : ''}
      </div>
      <ul class="p-project-card__list e-caption">
        {next.map((t: Task) => (
          <li key={t.id} class="e-truncate">
            {t.title}
          </li>
        ))}
      </ul>
    </Card>
  )
}

function ProjectScreen({ store, project }: { store: PlanerStore; project: Project }): JSX.Element {
  const buckets = store.projectBuckets.value
  const projects = projectIndex(store.doc)
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(project.title)

  return (
    <div class="p-screen" data-tone={toneOf(project)}>
      <div class="p-project__head">
        <IconButton label={S.common.back} icon="‹" onClick={() => store.openProject(null)} />
        <h2 class="e-heading e-truncate">{project.title}</h2>
        <IconButton label={S.common.more} icon="⋯" onClick={() => setEditing(true)} />
      </div>

      {buckets.open.length === 0 && buckets.doneToday.length === 0 ? (
        <EmptyState size="page" title={S.list.emptyTitle} description={S.list.emptyHint} />
      ) : (
        <>
          <ListView
            items={buckets.open}
            getKey={(t: Task) => t.id}
            ariaLabel={S.project.tasksHeading}
            reorder={{
              onReorder: (key, beforeKey) =>
                reorderTask(store.doc, key as RecordId, beforeKey as RecordId | null),
              handle: 'row',
            }}
            flip
            renderItem={(t: Task) => <TaskRow task={t} store={store} projects={projects} />}
          />
          {buckets.doneToday.length === 0 ? null : (
            <Section title={S.now.doneToday} count={buckets.doneToday.length} collapsible defaultOpen={false}>
              <ListView
                items={buckets.doneToday}
                getKey={(t: Task) => t.id}
                ariaLabel={S.now.doneToday}
                renderItem={(t: Task) => <TaskRow task={t} store={store} projects={projects} />}
              />
            </Section>
          )}
        </>
      )}

      <Overlay
        open={editing}
        title={S.project.titlePlaceholder}
        onClose={() => setEditing(false)}
        primaryAction={{
          label: S.common.save,
          onAction: () => {
            updateProject(store.doc, project.id, { title } as Partial<Project>)
            setEditing(false)
          },
        }}
      >
        <div class="e-stack">
          <Field value={title} onValueChange={setTitle} label={S.project.titlePlaceholder} />
          <div class="p-chips">
            {[...LISTS, 'neutral'].map((tint) => (
              <Chip
                key={tint}
                label={tint === 'neutral' ? S.project.tintNeutral : listTitle(tint as never, customTitles(store))}
                tone={tint === 'neutral' ? 'neutral' : (tint as Tone)}
                selected={project.tint === tint}
                onSelect={() => updateProject(store.doc, project.id, { tint } as Partial<Project>)}
              />
            ))}
          </div>
          <Button
            onClick={() => updateProject(store.doc, project.id, { archived: !project.archived } as Partial<Project>)}
          >
            {project.archived ? S.project.unarchive : S.project.archive}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              removeProject(store.doc, project.id)
              setEditing(false)
              store.openProject(null)
            }}
          >
            {S.project.delete}
          </Button>
        </div>
      </Overlay>
    </div>
  )
}

export function ProjectsScreen({ store }: ScreenProps): JSX.Element {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const selected = store.projectId.value
  const all = store.doc.col.project.all.value
  const project = selected === null ? undefined : all.find((p: Project) => p.id === selected)

  if (project !== undefined) return <ProjectScreen store={store} project={project} />

  const active = all.filter((p: Project) => !p.archived)
  const archived = all.filter((p: Project) => p.archived)

  const create = (): void => {
    const id = addProject(store.doc, draft)
    setDraft('')
    setAdding(false)
    if (id !== null) store.openProject(id)
  }

  return (
    <div class="p-screen">
      <div class="p-project__head">
        <h2 class="e-heading">{S.project.heading}</h2>
        <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
          {S.project.add}
        </Button>
      </div>

      {all.length === 0 ? (
        <EmptyState
          size="page"
          title={S.project.emptyTitle}
          description={S.project.emptyHint}
          action={{ label: S.project.add, onAction: () => setAdding(true) }}
        />
      ) : (
        <div class="p-project-grid">
          {active.map((p: Project) => (
            <ProjectCard key={p.id} store={store} project={p} />
          ))}
        </div>
      )}

      {archived.length === 0 ? null : (
        <Section title={S.project.archived} count={archived.length} collapsible defaultOpen={false}>
          <div class="p-project-grid">
            {archived.map((p: Project) => (
              <ProjectCard key={p.id} store={store} project={p} />
            ))}
          </div>
        </Section>
      )}

      <Overlay
        open={adding}
        title={S.project.add}
        onClose={() => setAdding(false)}
        primaryAction={{ label: S.project.add, onAction: create }}
        secondaryAction={{ label: S.common.cancel, onAction: () => setAdding(false) }}
      >
        <Field
          value={draft}
          onValueChange={setDraft}
          label={S.project.titlePlaceholder}
          autoFocus
          onEnter={create}
        />
      </Overlay>
    </div>
  )
}
