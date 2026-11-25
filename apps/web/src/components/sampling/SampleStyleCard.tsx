'use client'
import { useState } from 'react'
import { Link2, LockKeyhole, Pencil, Plus, Shirt, X } from 'lucide-react'
import { STYLE_STAGE_LABEL, type StyleStage } from '@ld-erp/shared'
import { focusNextBox } from '@/lib/keys'
import { FormFrame } from '@/components/ui/FormFrame'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { SuggestInput } from '@/components/ui/SuggestInput'
import { NextStyleCode } from '@/components/masters/NextStyleCode'
import { ReasonDialog } from '@/components/ui/ReasonDialog'
import { Field } from './SampleSpecEditor'
import { addColours, distinctValues, draftLoss, refitText, styleRules } from './samplingFlow'
import type { Lookups, SampleRequest } from './types'

/** In sampling reads as waiting (amber), production as done (green), as the badge colours mean. */
export function StageBadge({ stage }: { stage: StyleStage }) {
  return (
    <span className={stage === 'DEVELOPMENT' ? 'badge-warning' : 'badge-success'}>
      {STYLE_STAGE_LABEL[stage]}
    </span>
  )
}

type Opened = 'create' | 'edit' | 'colour' | 'link' | null
type Post = (action: string, data: unknown) => Promise<SampleRequest>

/**
 * The style a request samples. The buyer's style is usually new to us, so it
 * is made here as a development style, kept off orders and production until
 * its sample is handed over; a re-sample uses a style we already have.
 *
 * Every change goes through the request's own actions (CREATE_STYLE,
 * LINK_STYLE, UPDATE_STYLE), which refit the draft specification to the
 * style. That is why they wait while the specification has unsaved changes:
 * the refit would be drawn over them.
 */
export function SampleStyleCard({
  request,
  lookups,
  canEdit,
  held,
  post,
  notify,
}: {
  request: SampleRequest
  lookups: Lookups
  /** Sampling edit permission on a request that is neither cancelled nor handed over. */
  canEdit: boolean
  /** Why style changes wait, while the specification has unsaved changes. */
  held: string
  post: Post
  notify: (message: string) => void
}) {
  const [opened, setOpened] = useState<Opened>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const style = request.style
  const rules = styleRules(request)
  const changeBlocked = rules.fixed || held
  const editBlocked = rules.editBlocked || held
  // A draft saved before requests had a style of their own may already name
  // one; a request released before then was made in one, and may still take
  // that one (and only that one) as its style.
  const latest = request.rounds[0]
  const namedId =
    rules.releasedStyleId || (latest.state === 'DRAFT' ? latest.specification.styleId : '')
  const draftStyle =
    !style && namedId
      ? lookups.styles.find((s) => s.id === namedId && s.brandId === request.brandId)
      : undefined
  const draftLinkBlocked = rules.releasedStyleId ? rules.closed || held : changeBlocked
  const run = async (action: string, data: unknown, said: (r: SampleRequest) => string) => {
    setBusy(true)
    setError('')
    try {
      const updated = await post(action, data)
      setOpened(null)
      // What the refit cleared from the draft, as the server counted it in the new event.
      const latestEvent = updated.events.find((e) => e.action === action)
      const cleared = refitText(latestEvent?.detail.data?.refit)
      notify(cleared ? `${said(updated)} ${cleared}` : said(updated))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the style. Try again.')
    } finally {
      setBusy(false)
    }
  }
  const open = (next: Opened) => {
    setError('')
    setOpened(next)
  }
  const close = () => {
    if (busy) return
    setError('')
    setOpened(null)
  }
  const notes = [...new Set([style ? rules.editBlocked : '', rules.fixed, held].filter(Boolean))]
  return (
    <section className="glass-card space-y-4 p-5" aria-labelledby="sample-style-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h3 id="sample-style-title" className="flex items-center gap-2 font-semibold">
            <Shirt size={16} /> Style for this sample
          </h3>
          <p className="text-muted-foreground mt-1 text-sm">
            {style
              ? 'Every round of this request samples this style. The specification takes its colours and size run from here.'
              : 'Usually the buyer’s style is new to us: create a development style from the tech pack. For a re-sample, use a style we already have.'}
          </p>
        </div>
        {canEdit && style && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-secondary"
              disabled={!!editBlocked}
              onClick={() => open('colour')}
            >
              <Plus size={15} /> Add colour
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={!!editBlocked}
              onClick={() => open('edit')}
            >
              <Pencil size={15} /> Edit style
            </button>
            <button
              type="button"
              className="btn-ghost"
              disabled={!!changeBlocked}
              onClick={() => open('link')}
            >
              <Link2 size={15} /> Change style
            </button>
          </div>
        )}
      </div>
      {style ? (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <div className="min-w-0">
              <p className="text-muted-foreground text-xs">Style</p>
              <p className="mt-1 font-medium">
                <span className="font-mono">{style.code}</span> · {style.name}
              </p>
              <div className="mt-1.5">
                <StageBadge stage={style.stage} />
              </div>
            </div>
            <div className="min-w-0">
              <p className="text-muted-foreground text-xs">Size run</p>
              <p className="mt-1 font-medium">{runName(lookups, style.sizeGroupId)}</p>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {runSizes(lookups, style.sizeGroupId).join(', ')}
              </p>
            </div>
            <div className="min-w-0">
              <p className="text-muted-foreground text-xs">Garment category</p>
              <p className="mt-1 font-medium">{style.category || 'Not set'}</p>
            </div>
            <div className="min-w-0">
              <p className="text-muted-foreground text-xs">Season</p>
              <p className="mt-1 font-medium">{style.season || 'Not set'}</p>
            </div>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Colours</p>
            {style.colors.length ? (
              <ul className="mt-1.5 flex flex-wrap gap-1.5">
                {style.colors.map((c) => (
                  <li key={c} className="badge-neutral">
                    {c}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-sm">
                No colours yet. Add the colours the buyer wants sampled.
              </p>
            )}
          </div>
          {style.stage === 'DEVELOPMENT' && (
            <p className="text-muted-foreground text-xs">
              In sampling: kept off sales orders, BOMs and production until its sample is approved
              and handed over.
            </p>
          )}
          {!style.isActive && (
            <p className="warn-text text-sm">
              This style has been switched off in Masters → Styles.
            </p>
          )}
        </div>
      ) : (
        <div className="border-border rounded-lg border border-dashed p-4">
          <p className="font-medium">No style yet</p>
          <p className="text-muted-foreground mt-1 text-sm">
            {canEdit
              ? 'The specification is prepared on the request’s style, so set it before the specification.'
              : 'The style is set from the tech pack before the specification is prepared.'}
          </p>
          {canEdit && (
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-primary"
                disabled={!!changeBlocked}
                onClick={() => open('create')}
              >
                <Plus size={15} /> Create development style
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={!!changeBlocked}
                onClick={() => open('link')}
              >
                <Link2 size={15} /> Use an existing style
              </button>
            </div>
          )}
          {canEdit && draftStyle && !draftLinkBlocked && (
            <p className="mt-3 text-sm">
              {rules.releasedStyleId
                ? 'Earlier rounds were made in'
                : 'The draft specification already names'}{' '}
              <span className="font-mono">{draftStyle.code}</span> · {draftStyle.name}.{' '}
              <button
                type="button"
                className="text-primary font-medium hover:underline"
                disabled={busy}
                onClick={() =>
                  void run(
                    'LINK_STYLE',
                    { styleId: draftStyle.id },
                    () => `${draftStyle.code} is now this request’s style.`
                  )
                }
              >
                Use {draftStyle.code} for this request
              </button>
            </p>
          )}
        </div>
      )}
      {canEdit &&
        notes.map((note) => (
          <p key={note} className="text-muted-foreground flex items-start gap-2 text-xs">
            <LockKeyhole size={13} className="mt-0.5 shrink-0" /> {note}
          </p>
        ))}
      {error && !opened && (
        <p role="alert" className="warn-text text-sm">
          {error}
        </p>
      )}
      {(opened === 'create' || opened === 'edit' || opened === 'colour') && (
        <StyleWindow
          mode={opened}
          request={request}
          lookups={lookups}
          sampledColours={rules.sampledColours}
          sizeRunFixed={rules.sizeRunFixed}
          busy={busy}
          error={error}
          onClose={close}
          onSave={(data) =>
            void run(opened === 'create' ? 'CREATE_STYLE' : 'UPDATE_STYLE', data, (r) =>
              opened === 'create'
                ? `${r.style?.code ?? 'The style'} was created in sampling. The specification now follows it.`
                : opened === 'colour'
                  ? `Colours added to ${r.style?.code ?? 'the style'}.`
                  : `${r.style?.code ?? 'The style'} was updated. The draft specification keeps what still fits.`
            )
          }
        />
      )}
      {opened === 'link' && (
        <LinkWindow
          request={request}
          lookups={lookups}
          initialId={draftStyle?.id ?? ''}
          busy={busy}
          error={error}
          onClose={close}
          onLink={(styleId) =>
            void run('LINK_STYLE', { styleId }, (r) =>
              r.style
                ? `${r.style.code} is now this request’s style. The draft specification keeps what fits it.`
                : 'The style was taken off this request. Create or choose another before preparing the specification.'
            )
          }
        />
      )}
    </section>
  )
}

const runName = (lookups: Lookups, id: string | null) =>
  lookups.sizeGroups.find((g) => g.id === id)?.name ?? (id ? 'Size run' : 'Not set')
const runSizes = (lookups: Lookups, id: string | null) =>
  id ? lookups.sizes.filter((s) => s.sizeGroupId === id).map((s) => s.code) : []

/**
 * Making a development style, changing it, or adding colours to it. Opens on
 * the first box; Enter goes from box to box and Ctrl+S saves.
 */
function StyleWindow({
  mode,
  request,
  lookups,
  sampledColours,
  sizeRunFixed,
  busy,
  error,
  onClose,
  onSave,
}: {
  mode: 'create' | 'edit' | 'colour'
  request: SampleRequest
  lookups: Lookups
  sampledColours: string[]
  sizeRunFixed: string
  busy: boolean
  error: string
  onClose: () => void
  onSave: (data: Record<string, unknown>) => void
}) {
  const style = mode === 'create' ? null : request.style
  const [name, setName] = useState(
    style?.name ?? (request.buyerStyleRef || request.title).slice(0, 200)
  )
  const [category, setCategory] = useState(
    (mode === 'create' ? request.garmentCategory : style?.category) ?? ''
  )
  const [season, setSeason] = useState((mode === 'create' ? request.season : style?.season) ?? '')
  const [sizeGroupId, setSizeGroupId] = useState(style?.sizeGroupId ?? '')
  const [colours, setColours] = useState<string[]>(style?.colors ?? [])
  const [typed, setTyped] = useState('')
  const [problem, setProblem] = useState('')
  // A change that would clear part of the draft, waiting for a yes.
  const [pending, setPending] = useState<{ data: Record<string, unknown>; loss: string } | null>(
    null
  )
  // The draft is refitted to the style as saved: say first what that clears.
  const save = (data: Record<string, unknown>, list: string[]) => {
    const loss = draftLoss(request, { colors: list, sizeGroupId }, lookups.sizes)
    if (loss) setPending({ data, loss })
    else onSave(data)
  }
  // In "Add colour" every colour already on the style stays; in "Edit style"
  // only the ones a released round was made in.
  const kept = mode === 'colour' ? (style?.colors ?? []) : sampledColours
  const keptNote =
    mode === 'colour'
      ? 'Already on the style'
      : 'Sampled in a released round, so it stays on the style'
  const runs =
    sizeGroupId && !lookups.sizeGroups.some((g) => g.id === sizeGroupId)
      ? [...lookups.sizeGroups, { id: sizeGroupId, name: runName(lookups, sizeGroupId) }]
      : lookups.sizeGroups
  const submit = () => {
    setProblem('')
    // A colour typed but not yet added is meant to be on the list.
    let list = colours
    if (typed.trim()) {
      const added = addColours(colours, typed)
      if (added.problem) return setProblem(added.problem)
      list = added.colours
      setColours(list)
      setTyped('')
    }
    if (mode === 'colour') {
      if (list.length === (style?.colors.length ?? 0))
        return setProblem('Type a new colour, then add it.')
      return onSave({ colors: list })
    }
    if (!name.trim()) return setProblem('Name the style. The buyer’s style name or number will do.')
    if (mode === 'create' && !category.trim())
      return setProblem(
        'Name the garment. Its first letters go into the style code, which cannot change later.'
      )
    if (!sizeGroupId) return setProblem('Choose the size run the sample is cut in.')
    if (!list.length) return setProblem('Add at least one colour.')
    // Sent as typed: a box the person emptied stays empty rather than being
    // filled again from the request.
    if (mode === 'create')
      return save(
        {
          name: name.trim(),
          category: category.trim(),
          season: season.trim() || null,
          sizeGroupId,
          colors: list,
        },
        list
      )
    if (!style) return
    // Only what changed: the server checks each change against what was sampled.
    const data: Record<string, unknown> = {}
    if (name.trim() !== style.name) data.name = name.trim()
    if ((category.trim() || null) !== (style.category || null))
      data.category = category.trim() || null
    if ((season.trim() || null) !== (style.season || null)) data.season = season.trim() || null
    if (sizeGroupId !== style.sizeGroupId) data.sizeGroupId = sizeGroupId
    if (list.join('\n') !== style.colors.join('\n')) data.colors = list
    if (!Object.keys(data).length) return setProblem('Nothing has been changed yet.')
    save(data, list)
  }
  const title =
    mode === 'create' ? 'Create development style' : mode === 'edit' ? 'Edit style' : 'Add colour'
  const sizes = runSizes(lookups, sizeGroupId)
  return (
    <FormFrame
      icon={mode === 'edit' ? Pencil : mode === 'colour' ? Plus : Shirt}
      title={title}
      subtitle={
        style
          ? `${style.code} · ${style.name}`
          : `${request.brand.name} · for ${request.number} ${request.title}`
      }
      width="max-w-3xl"
      primaryInHeader={false}
      busy={busy}
      error={problem || error}
      onClose={onClose}
      primary={
        <button type="submit" form="sample-style-form" className="btn-primary" disabled={busy}>
          {busy
            ? 'Saving…'
            : mode === 'create'
              ? 'Create development style'
              : mode === 'edit'
                ? 'Save style changes'
                : 'Add colours'}
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
          Cancel
        </button>
      }
      footerNote={
        mode === 'create'
          ? 'Made in sampling for this request. It reaches orders and production only after its sample is approved and handed over.'
          : 'The draft specification keeps what still fits the style; a colour or size it no longer has is cleared, with the material lines for that colour only.'
      }
    >
      <form
        id="sample-style-form"
        onSubmit={(e) => {
          e.preventDefault()
          // Opened over the workspace: the submit stays with this window.
          e.stopPropagation()
          submit()
        }}
      >
        <fieldset disabled={busy} className="grid gap-5 p-2 md:grid-cols-2">
          {mode !== 'colour' && (
            <>
              <Field
                label="Style name"
                required
                hint={
                  mode === 'create'
                    ? 'Taken from the buyer’s style reference or the request title. Change it if needed.'
                    : undefined
                }
              >
                <input
                  className="form-input"
                  required
                  maxLength={200}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Field
                label="Garment category"
                required={mode === 'create'}
                hint={
                  mode === 'create'
                    ? 'Its first letters go into the style code (SH for Shirt), which cannot change later.'
                    : undefined
                }
              >
                <SuggestInput
                  className="form-input"
                  maxLength={100}
                  placeholder="e.g. Shirt"
                  value={category}
                  onValueChange={setCategory}
                  suggestions={distinctValues(lookups.styles.map((s) => s.category)).map(
                    (value) => ({
                      value,
                    })
                  )}
                />
              </Field>
              <Field label="Season">
                <SuggestInput
                  className="form-input"
                  maxLength={50}
                  placeholder="e.g. SS-27"
                  value={season}
                  onValueChange={setSeason}
                  suggestions={distinctValues(lookups.styles.map((s) => s.season)).map((value) => ({
                    value,
                  }))}
                />
              </Field>
              <Field
                label="Size run"
                required
                hint={
                  mode === 'edit' && sizeRunFixed
                    ? sizeRunFixed
                    : sizes.length
                      ? `Sizes: ${sizes.join(', ')}`
                      : 'The sizes the sample can be cut in, from Masters → Size runs.'
                }
              >
                <SmartSelect
                  className="form-input"
                  value={sizeGroupId}
                  disabled={mode === 'edit' && !!sizeRunFixed}
                  onChange={(e) => setSizeGroupId(e.target.value)}
                >
                  <option value="">Pick a size run</option>
                  {runs.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </SmartSelect>
              </Field>
              {mode === 'create' && (
                <div className="min-w-0">
                  <span className="form-label">Style code</span>
                  {/* Asked of the request, so sampling rights are enough to see it. */}
                  <NextStyleCode
                    endpoint={`/sampling/${request.id}/next-style-code`}
                    brandId={request.brandId}
                    category={category}
                    season={season}
                  />
                  <span className="text-muted-foreground mt-1.5 block text-xs">
                    From the brand, garment category and season, the way Masters → Styles codes a
                    style. It cannot be changed once the style is saved.
                  </span>
                </div>
              )}
            </>
          )}
          <div className="md:col-span-2">
            <ColourChips
              value={colours}
              onChange={setColours}
              typed={typed}
              onTyped={setTyped}
              kept={kept}
              keptNote={keptNote}
              onProblem={setProblem}
            />
          </div>
        </fieldset>
      </form>
      {pending && (
        <ReasonDialog
          title="Clear part of the draft specification?"
          description={`${pending.loss} The style as saved does not have those colours or sizes.`}
          confirmLabel={mode === 'create' ? 'Create and clear them' : 'Save and clear them'}
          cancelLabel="Go back"
          danger
          requireReason={false}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const data = pending.data
            setPending(null)
            onSave(data)
          }}
        />
      )}
    </FormFrame>
  )
}

/**
 * Colours as chips: typed into the box and added with Enter or the button,
 * several at once with commas, each removed with its own cross. Enter in an
 * empty box goes on to the next box, as everywhere else.
 */
function ColourChips({
  value,
  onChange,
  typed,
  onTyped,
  kept,
  keptNote,
  onProblem,
}: {
  value: string[]
  onChange: (colours: string[]) => void
  typed: string
  onTyped: (text: string) => void
  /** Colours that cannot be taken off here. */
  kept: string[]
  keptNote: string
  onProblem: (message: string) => void
}) {
  const isKept = (c: string) => kept.some((k) => k.toLowerCase() === c.toLowerCase())
  const add = () => {
    const result = addColours(value, typed)
    onProblem(result.problem)
    if (result.problem) return
    onChange(result.colours)
    onTyped('')
  }
  return (
    <div className="space-y-2">
      <span className="form-label">
        Colours
        <span className="text-primary ml-1" aria-label="required">
          *
        </span>
      </span>
      {value.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Colours on the style">
          {value.map((c) => (
            <li key={c} className="badge-neutral">
              {c}
              {isKept(c) ? (
                <span title={keptNote}>
                  <LockKeyhole size={12} aria-label={keptNote} />
                </span>
              ) : (
                <button
                  type="button"
                  className="btn-ghost p-0.5"
                  aria-label={`Remove ${c}`}
                  onClick={() => onChange(value.filter((x) => x !== c))}
                >
                  <X size={12} />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-xs">
          No colours yet. Add each colour the buyer wants sampled.
        </p>
      )}
      <div className="flex gap-2">
        <input
          className="form-input"
          aria-label="New colour"
          placeholder="e.g. White, Navy"
          maxLength={200}
          // Enter adds the colour here; the form-wide Enter is left out.
          data-enter-own
          value={typed}
          onChange={(e) => onTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return
            e.preventDefault()
            if (typed.trim()) add()
            else focusNextBox(e.currentTarget)
          }}
        />
        <button
          type="button"
          className="btn-secondary shrink-0"
          disabled={!typed.trim()}
          onClick={add}
        >
          <Plus size={15} /> Add colour
        </button>
      </div>
      <p className="text-muted-foreground text-xs">
        Press Enter to add. Separate several colours with commas. Up to 30 colours.
      </p>
    </div>
  )
}

/** A style we already have: a re-sample, or one no open request is developing. */
function LinkWindow({
  request,
  lookups,
  initialId,
  busy,
  error,
  onClose,
  onLink,
}: {
  request: SampleRequest
  lookups: Lookups
  initialId: string
  busy: boolean
  error: string
  onClose: () => void
  onLink: (styleId: string | null) => void
}) {
  // A style in sampling belongs to the open request developing it; the server
  // refuses it to any other, so it is not offered.
  const developedElsewhere = (s: Lookups['styles'][number]) =>
    s.stage === 'DEVELOPMENT' && (s.sampleRequests ?? []).some((r) => r.id !== request.id)
  const options = lookups.styles
    .filter(
      (s) => s.brandId === request.brandId && s.id !== request.styleId && !developedElsewhere(s)
    )
    .sort((a, b) => a.code.localeCompare(b.code))
  const [styleId, setStyleId] = useState(initialId)
  const [problem, setProblem] = useState('')
  // A change that would clear part of the draft, waiting for a yes.
  const [pending, setPending] = useState<{ styleId: string | null; loss: string } | null>(null)
  const picked = options.find((s) => s.id === styleId)
  const current = request.style
  const link = (next: string | null) => {
    const to = next ? lookups.styles.find((s) => s.id === next) : null
    const loss = draftLoss(request, to ?? null, lookups.sizes)
    if (loss) setPending({ styleId: next, loss })
    else onLink(next)
  }
  return (
    <FormFrame
      icon={Link2}
      title={current ? 'Change the style' : 'Use an existing style'}
      subtitle={`${request.brand.name} styles, in sampling or in production`}
      width="max-w-2xl"
      primaryInHeader={false}
      busy={busy}
      error={problem || error}
      onClose={onClose}
      primary={
        <button
          type="submit"
          form="sample-link-style"
          className="btn-primary"
          disabled={busy || !options.length}
        >
          {busy ? 'Saving…' : 'Use this style'}
        </button>
      }
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {current && (
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() => link(null)}
            >
              Take {current.code} off
            </button>
          )}
        </>
      }
      footerNote="The draft keeps its colours, sizes, measurements and material lines where the style has them; anything else is cleared, after you confirm."
    >
      <form
        id="sample-link-style"
        onSubmit={(e) => {
          e.preventDefault()
          e.stopPropagation()
          if (!styleId) {
            setProblem('Pick the style to sample.')
            return
          }
          link(styleId)
        }}
      >
        <fieldset disabled={busy} className="space-y-4 p-2">
          {current && (
            <p className="bg-muted/40 rounded-lg p-3 text-sm">
              Now sampling <span className="font-mono">{current.code}</span> · {current.name}. Take
              it off to move this request to another brand.
            </p>
          )}
          {options.length ? (
            <Field
              label="Style"
              required
              hint="Active styles of this brand. A production style makes this a re-sample. A style another open request is developing is sampled from that request."
            >
              <SmartSelect
                className="form-input"
                value={styleId}
                onChange={(e) => {
                  setStyleId(e.target.value)
                  setProblem('')
                }}
              >
                <option value="">Pick a style</option>
                {options.map((s) => (
                  <option
                    key={s.id}
                    value={s.id}
                    data-sub={`${STYLE_STAGE_LABEL[s.stage]} · ${runName(lookups, s.sizeGroupId)} · ${s.colors.length} colour${s.colors.length === 1 ? '' : 's'}`}
                  >
                    {s.code} · {s.name}
                  </option>
                ))}
              </SmartSelect>
            </Field>
          ) : (
            <p className="border-border text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
              No other active styles for {request.brand.name}. Create a development style from the
              tech pack instead.
            </p>
          )}
          {picked && (
            <div className="border-border space-y-2 rounded-lg border p-3 text-sm">
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{picked.code}</span> · {picked.name}
                <StageBadge stage={picked.stage} />
              </p>
              <p className="text-muted-foreground">
                Size run: {runName(lookups, picked.sizeGroupId)}
                {picked.sizeGroupId ? ` · ${runSizes(lookups, picked.sizeGroupId).join(', ')}` : ''}
              </p>
              <p className="text-muted-foreground">
                Colours: {picked.colors.length ? picked.colors.join(', ') : 'none yet'}
              </p>
              {(!picked.sizeGroupId || !picked.colors.length) && (
                <p className="warn-text">
                  This style has no {!picked.sizeGroupId ? 'size run' : 'colours'} yet, so the
                  specification cannot be completed on it until it has.
                </p>
              )}
              {draftLoss(request, picked, lookups.sizes) && (
                <p className="warn-text">{draftLoss(request, picked, lookups.sizes)}</p>
              )}
            </div>
          )}
        </fieldset>
      </form>
      {pending && (
        <ReasonDialog
          title="Clear part of the draft specification?"
          description={`${pending.loss} ${pending.styleId ? 'The style chosen does not have those colours or sizes.' : 'Without a style the draft cannot keep its colours, sizes, measurements or the material lines for one colour.'}`}
          confirmLabel={pending.styleId ? 'Use this style and clear them' : 'Take the style off'}
          cancelLabel="Go back"
          danger
          requireReason={false}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const next = pending.styleId
            setPending(null)
            onLink(next)
          }}
        />
      )}
    </FormFrame>
  )
}
