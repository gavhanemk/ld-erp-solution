'use client'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { CheckCircle2, ChevronLeft, ChevronRight, Save, Send } from 'lucide-react'
import type {
  SampleItemOption,
  SampleRequestStyle,
  SampleSpecContext,
  SampleSpecification,
} from '@ld-erp/shared'
import { keyLabel, matches } from '@/lib/keys'
import { cn } from '@/lib/utils'
import { ReasonDialog } from '@/components/ui/ReasonDialog'
import type { Lookups } from './types'
import {
  changedTabs,
  fromSpec,
  gapsByTab,
  mergeItems,
  releaseGaps,
  SPEC_TABS,
  toSpec,
  type LiveMasters,
  type SpecDraft,
  type SpecTab,
} from './specRules'
import { StyleColoursTab } from './spec/StyleColoursTab'
import { MeasurementsTab } from './spec/MeasurementsTab'
import { MaterialsTab } from './spec/MaterialsTab'
import { RouteTab } from './spec/RouteTab'
import { ReviewTab } from './spec/ReviewTab'

// The labelled box the sampling screens share; it lives with the editor's parts.
export { Field } from './spec/parts'

/**
 * A draft round's specification, in five tabs: style and colours (with the
 * colour × size grid), measurements, the sample BOM, the making route, and the
 * review that releases it. The draft is saved as a whole from any tab (Ctrl+S,
 * or Save draft), and a dot on a tab marks changes there not saved yet.
 *
 * What is typed is held as the editor's own draft (specRules) and sent as the
 * specification the server keeps; the gaps and quantities on screen come from
 * the shared rules the server applies, so what the review lists is what a
 * release would be refused for.
 */
export function SampleSpecEditor({
  initial,
  lookups,
  save,
  release,
  busy,
  onDirtyChange,
  requestStyle,
  onChooseStyle,
  requestId,
  hasBuyer,
  roundItems,
  onItemsFound,
}: {
  initial: SampleSpecification
  lookups: Lookups
  save: (value: SampleSpecification) => Promise<SampleSpecification | null>
  release?: (value: SampleSpecification) => void
  busy: boolean
  onDirtyChange: (dirty: boolean) => void
  /** Every round samples the request's own style, set in Request & tech pack. */
  requestStyle: SampleRequestStyle | null
  /** Opens Request & tech pack, where the style is made or chosen. */
  onChooseStyle: () => void
  /** The request the round is on: its style's routings are offered for the route. */
  requestId: string
  /** Whether the request names a buyer, who can send material for the sample. */
  hasBuyer: boolean
  /** The materials the round's own lines name that are still in use (roundItems). */
  roundItems: SampleItemOption[]
  /**
   * Materials found or added from a line, kept with the page's lists so they
   * stay offered when the editor opens again (a style change, another round,
   * the request reopened).
   */
  onItemsFound: (items: SampleItemOption[]) => void
}) {
  // The style's size run, in its own order: the grid's columns.
  const sizeGroupId = requestStyle?.sizeGroupId ?? null
  const runSizeIds = useMemo(
    () =>
      sizeGroupId
        ? lookups.sizes.filter((z) => z.sizeGroupId === sizeGroupId).map((z) => z.id)
        : [],
    [lookups.sizes, sizeGroupId]
  )
  // A step's department is its process's (fitRoute), however it was saved.
  const operations = lookups.operations
  const [draft, setDraft] = useState<SpecDraft>(() => {
    const d = fromSpec(initial, { runSizeIds, operations })
    // The server refits a draft whenever the request's style changes, so this
    // catches only a draft saved before requests had a style of their own: it
    // takes the request's style, and the gaps say what no longer fits it.
    return requestStyle && d.styleId !== requestStyle.id ? { ...d, styleId: requestStyle.id } : d
  })
  const update = useCallback((change: (d: SpecDraft) => SpecDraft) => setDraft(change), [])
  const spec = useMemo(() => toSpec(draft), [draft])
  // The specification as saved, read the same way, so opening a draft is no change.
  const saved = useMemo(
    () => toSpec(fromSpec(initial, { runSizeIds, operations })),
    [initial, runSizeIds, operations]
  )
  const changed = useMemo(() => changedTabs(spec, saved), [spec, saved])
  const dirty = useMemo(() => JSON.stringify(spec) !== JSON.stringify(saved), [spec, saved])
  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])

  const ctx = useMemo<SampleSpecContext>(
    () => ({
      style: requestStyle ? { colors: requestStyle.colors, sizeIds: runSizeIds } : null,
      sizes: lookups.sizes,
      hasBuyer,
    }),
    [requestStyle, runSizeIds, lookups.sizes, hasBuyer]
  )
  // The materials offered: the page's list (with any found or added from a
  // line), and the round's own, so a line never shows an item in use as gone.
  const items = useMemo(() => mergeItems(lookups.items, roundItems), [lookups.items, roundItems])
  const itemName = (id: string) => items.find((i) => i.id === id)?.name ?? ''
  const live = useMemo<LiveMasters>(
    () => ({
      items,
      operations: lookups.operations,
      departments: lookups.departments,
      contractors: lookups.contractors,
      jobWorkers: lookups.jobWorkers,
    }),
    [items, lookups.operations, lookups.departments, lookups.contractors, lookups.jobWorkers]
  )
  const gaps = useMemo(() => releaseGaps(spec, ctx, live), [spec, ctx, live])
  const byTab = gapsByTab(gaps)
  // A draft opens where there is something left to do.
  const [tab, setTab] = useState<SpecTab>(
    () => SPEC_TABS.find((t) => byTab[t.key].length)?.key ?? 'review'
  )
  const at = SPEC_TABS.findIndex((t) => t.key === tab)

  const [confirming, setConfirming] = useState(false)
  const saveDraft = async () => {
    const result = await save(spec)
    if (result) setDraft((d) => fromSpec(result, { runSizeIds, previous: d, operations }))
  }

  /*
   * Alt+A on a tab with lines, from a box outside the lines (the keyboard
   * layer handles it inside them): the tab's own add, then its new line's
   * first box.
   */
  const panelRef = useRef<HTMLDivElement>(null)
  const onFormKey = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.defaultPrevented || !matches(e, 'alt+a')) return
    const panel = panelRef.current
    if (!panel || (e.target as HTMLElement).closest('[data-grid]')) return
    const add = [...panel.querySelectorAll<HTMLButtonElement>('[data-grid-add]')].find(
      (b) => !b.disabled
    )
    if (!add) return
    e.preventDefault()
    const rows = () => [...panel.querySelectorAll<HTMLElement>('[data-grid] [data-grid-row]')]
    const before = rows().length
    add.click()
    setTimeout(() => {
      const now = rows()
      if (now.length <= before) return
      now
        .at(-1)
        ?.querySelector<HTMLElement>('input:not([disabled]), [role="combobox"]:not([disabled])')
        ?.focus()
    }, 60)
  }

  const current = SPEC_TABS[at]
  return (
    <fieldset disabled={busy} className="glass-card min-w-0 overflow-hidden">
      <form
        noValidate
        onSubmit={(e) => e.preventDefault()}
        onKeyDown={onFormKey}
        className="min-w-0"
      >
        <div
          role="tablist"
          aria-label="Specification"
          className="border-border bg-muted/30 flex gap-1 overflow-x-auto border-b px-3 pt-3"
        >
          {SPEC_TABS.map((t, i) => {
            const open = byTab[t.key].length
            const active = t.key === tab
            return (
              <button
                key={t.key}
                type="button"
                role="tab"
                id={`spec-tab-${t.key}`}
                aria-selected={active}
                aria-controls="spec-panel"
                tabIndex={active ? 0 : -1}
                onClick={() => setTab(t.key)}
                className={cn(
                  'flex shrink-0 items-center gap-2 rounded-t-lg border border-b-0 px-3 py-2 text-sm',
                  active
                    ? 'border-border bg-card text-foreground font-medium'
                    : 'text-muted-foreground hover:text-foreground border-transparent'
                )}
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-current text-xs">
                  {t.key !== 'review' && !open ? <CheckCircle2 size={13} /> : i + 1}
                </span>
                {t.title}
                {changed[t.key] && (
                  <span
                    className="bg-primary h-1.5 w-1.5 shrink-0 rounded-full"
                    role="img"
                    aria-label="changes not saved yet"
                    title="Changes not saved yet"
                  />
                )}
                {t.key !== 'review' && open > 0 && (
                  <span className="badge-warning" title={`${open} still to finish`}>
                    {open}
                  </span>
                )}
                {t.key === 'review' && !gaps.length && <span className="badge-success">Ready</span>}
              </button>
            )
          })}
        </div>

        <div
          ref={panelRef}
          role="tabpanel"
          id="spec-panel"
          aria-labelledby={`spec-tab-${tab}`}
          className="min-w-0 space-y-4 p-4 sm:p-5"
        >
          <div>
            <p className="text-muted-foreground text-xs font-medium">
              Specification {at + 1} of {SPEC_TABS.length}
            </p>
            <h3 className="mt-0.5 text-lg font-semibold">{current.title}</h3>
            <p className="text-muted-foreground mt-0.5 text-sm">{current.hint}</p>
          </div>
          {tab === 'style' && (
            <StyleColoursTab
              draft={draft}
              update={update}
              lookups={lookups}
              requestStyle={requestStyle}
              runSizeIds={runSizeIds}
              gaps={byTab.style}
              itemName={itemName}
              onChooseStyle={onChooseStyle}
            />
          )}
          {tab === 'measurements' && (
            <MeasurementsTab
              draft={draft}
              update={update}
              lookups={lookups}
              gaps={byTab.measurements}
            />
          )}
          {tab === 'materials' && (
            <MaterialsTab
              draft={draft}
              update={update}
              spec={spec}
              lookups={lookups}
              items={items}
              onItemsFound={onItemsFound}
              hasBuyer={hasBuyer}
              gaps={byTab.materials}
            />
          )}
          {tab === 'route' && (
            <RouteTab
              draft={draft}
              update={update}
              lookups={lookups}
              requestId={requestId}
              styleCode={requestStyle?.code ?? null}
              gaps={byTab.route}
            />
          )}
          {tab === 'review' && (
            <ReviewTab
              spec={spec}
              gaps={gaps}
              lookups={lookups}
              canRelease={!!release}
              onGo={setTab}
            />
          )}
        </div>

        <div className="border-border bg-muted/20 flex flex-wrap items-center justify-between gap-3 border-t p-4">
          <button
            type="button"
            className="btn-secondary"
            disabled={at === 0}
            onClick={() => setTab(SPEC_TABS[at - 1].key)}
          >
            <ChevronLeft size={15} /> Back
          </button>
          <div className="flex flex-wrap items-center gap-2">
            {dirty && <span className="text-muted-foreground mr-2 text-xs">Unsaved changes</span>}
            <button
              type="button"
              className="btn-secondary"
              disabled={busy || !dirty}
              data-hotkey="save"
              title={`Save the draft (${keyLabel('mod+s')})`}
              onClick={() => void saveDraft()}
            >
              <Save size={15} /> {busy ? 'Saving…' : 'Save draft'}
            </button>
            {tab !== 'review' ? (
              <button
                type="button"
                className="btn-primary"
                onClick={() => setTab(SPEC_TABS[at + 1].key)}
              >
                {SPEC_TABS[at + 1].key === 'review'
                  ? 'Review specification'
                  : `Next: ${SPEC_TABS[at + 1].title}`}
                <ChevronRight size={15} />
              </button>
            ) : (
              release && (
                <button
                  type="button"
                  className="btn-primary"
                  disabled={gaps.length > 0}
                  title={gaps.length ? 'Finish the items listed above first' : undefined}
                  onClick={() => setConfirming(true)}
                >
                  <Send size={15} /> Release for sampling
                </button>
              )
            )}
          </div>
        </div>
      </form>
      {confirming && release && (
        <ReasonDialog
          title="Release this round for sampling?"
          description="Release freezes this round’s colours and pieces, measurements, materials and making route, and sets up the making steps from the route. Any change after this needs a new round."
          confirmLabel="Release for sampling"
          cancelLabel="Go back"
          requireReason={false}
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false)
            release(spec)
          }}
        />
      )}
    </fieldset>
  )
}
