'use client'
import { useEffect, useState } from 'react'
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  Plus,
  Trash2,
} from 'lucide-react'
import {
  STYLE_STAGE_LABEL,
  type SampleRequestStyle,
  type SampleSpecification,
} from '@ld-erp/shared'
import type { Lookups } from './types'
import { SmartSelect } from '@/components/ui/SmartSelect'

export function Field({
  label,
  children,
  hint,
  required,
}: {
  label: string
  children: React.ReactNode
  hint?: string
  required?: boolean
}) {
  return (
    <label className="block min-w-0">
      <span className="form-label">
        {label}
        {required && (
          <span className="text-primary ml-1" aria-label="required">
            *
          </span>
        )}
      </span>
      {children}
      {hint && (
        <span className="text-muted-foreground mt-1.5 block text-xs leading-relaxed">{hint}</span>
      )}
    </label>
  )
}
export function SampleSpecEditor({
  initial,
  lookups,
  save,
  release,
  busy,
  onDirtyChange,
  requestStyle,
  onChooseStyle,
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
}) {
  const [s, setS] = useState<SampleSpecification>(() => {
    const draft = structuredClone(initial)
    // The server fits drafts to the request's style when the style is set, so
    // this only catches a draft saved before that: it takes the request's style.
    if (requestStyle && draft.styleId !== requestStyle.id) {
      const sizeIds = new Set(
        lookups.sizes.filter((z) => z.sizeGroupId === requestStyle.sizeGroupId).map((z) => z.id)
      )
      draft.styleId = requestStyle.id
      draft.color =
        requestStyle.colors.find((c) => c.toLowerCase() === draft.color.toLowerCase()) ?? ''
      draft.sizes = draft.sizes.filter((z) => !z.sizeId || sizeIds.has(z.sizeId))
      draft.measurements = draft.measurements.filter((m) => !m.sizeId || sizeIds.has(m.sizeId))
    }
    return draft
  })
  const [step, setStep] = useState(initial.styleId && initial.techPackRef ? 3 : 0)
  const saveDraft = async () => {
    const saved = await save(s)
    if (saved) setS(structuredClone(saved))
  }
  useEffect(() => {
    onDirtyChange(JSON.stringify(s) !== JSON.stringify(initial))
  }, [s, initial, onDirtyChange])
  const sections = [
    'Style & construction',
    'Sizes & measurements',
    'Materials & making route',
    'Review & release',
  ]
  const gaps = [
    [
      !s.milestone.trim() && 'Name the sample milestone',
      !requestStyle && 'Create or choose the style in Request & tech pack',
      !s.color && 'Choose a colour',
      !s.techPackRef.trim() && 'Add the tech-pack reference',
      !s.patternRef.trim() && 'Add the pattern reference',
      !s.construction.trim() && 'Describe the construction',
    ].filter(Boolean),
    [
      (!s.sizes.length ||
        s.sizes.some((x) => !x.sizeId || !Number.isInteger(x.qty) || x.qty < 1 || x.qty > 1000)) &&
        'Add sizes with 1–1,000 whole pieces each',
      new Set(s.sizes.map((x) => x.sizeId)).size !== s.sizes.length && 'Choose each size once',
      (!s.measurements.length ||
        s.measurements.some(
          (x) =>
            !x.name.trim() ||
            !s.sizes.some((z) => z.sizeId === x.sizeId) ||
            x.target < 0 ||
            x.tolerance < 0
        )) &&
        'Complete each measurement point',
      s.sizes.some((x) => !s.measurements.some((m) => m.sizeId === x.sizeId)) &&
        'Add a measurement for every size',
      new Set(s.measurements.map((x) => `${x.sizeId}:${x.name.trim().toLowerCase()}`)).size !==
        s.measurements.length && 'Use each measurement point once per size',
    ].filter(Boolean),
    [
      (!s.materials.length || s.materials.some((x) => !x.itemId || !x.warehouseId || x.qty <= 0)) &&
        'Add materials, stores and positive quantities',
      new Set(s.materials.map((x) => `${x.itemId}:${x.warehouseId}:${x.ownership}`)).size !==
        s.materials.length && 'Combine duplicate material lines',
      (s.stages.length < 2 ||
        s.stages.some((x) => !x.trim()) ||
        s.stages[0].trim().toLowerCase() !== 'cutting' ||
        !s.stages.some((x) => x.trim().toLowerCase() === 'stitching')) &&
        'Start with Cutting and include Stitching',
      new Set(s.stages.map((x) => x.trim().toLowerCase())).size !== s.stages.length &&
        'Give every making step a distinct name',
    ].filter(Boolean),
  ]
  const ready = gaps.every((g) => !g.length)
  const set = <K extends keyof SampleSpecification>(k: K, v: SampleSpecification[K]) =>
    setS((x) => ({ ...x, [k]: v }))
  // Colours and sizes come from the request's style only, never another one.
  const style = requestStyle ? lookups.styles.find((x) => x.id === requestStyle.id) : undefined
  const sizes = lookups.sizes.filter((x) => x.sizeGroupId === style?.sizeGroupId)
  const input = (
    k: 'milestone' | 'construction' | 'techPackRef' | 'patternRef' | 'notes',
    label: string
  ) => (
    <Field label={label} required={k !== 'notes'}>
      {k === 'construction' || k === 'notes' ? (
        <textarea
          rows={3}
          className="form-input"
          value={s[k]}
          onChange={(e) => set(k, e.target.value)}
        />
      ) : (
        <input
          className="form-input"
          placeholder={
            k === 'milestone'
              ? 'e.g. Fit sample, size set, pre-production'
              : 'Document name, version or reference'
          }
          value={s[k]}
          onChange={(e) => set(k, e.target.value)}
        />
      )}
    </Field>
  )
  return (
    <fieldset disabled={busy} className="glass-card min-w-0 overflow-hidden">
      <div className="border-border bg-muted/30 border-b p-4">
        <nav aria-label="Specification setup" className="grid gap-2 sm:grid-cols-2 2xl:grid-cols-4">
          {sections.map((label, i) => (
            <button
              key={label}
              type="button"
              aria-current={step === i ? 'step' : undefined}
              onClick={() => setStep(i)}
              className={`flex items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm ${i === step ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-current text-xs">
                {i < 3 && !gaps[i].length ? <CheckCircle2 size={14} /> : i + 1}
              </span>
              {label}
            </button>
          ))}
        </nav>
      </div>
      <div className="space-y-5 p-5">
        <div>
          <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
            Setup {step + 1} of 4
          </p>
          <h3 className="mt-1 text-lg font-semibold">{sections[step]}</h3>
          <p className="text-muted-foreground mt-1 text-sm">
            {
              [
                'Identify what you are making and the technical documents to follow.',
                'Specify how many pieces to make and what QC must measure.',
                'Plan the fabric and trims, then arrange the work in the order it will happen.',
                'Check the complete specification. Release locks this version and opens material issue.',
              ][step]
            }
          </p>
        </div>
        <div hidden={step !== 0} className="space-y-4">
          {!requestStyle && (
            <div className="border-primary/25 bg-primary/5 rounded-lg border p-4">
              <p className="font-medium">Create or choose the style in Request & tech pack first</p>
              <p className="text-muted-foreground mt-1 text-sm">
                Every round samples the request’s own style; its colours and size run fill the
                choices below. If you have typed anything here, save the draft first.
              </p>
              <button type="button" className="btn-secondary mt-3" onClick={onChooseStyle}>
                Go to Request & tech pack <ArrowRight size={15} />
              </button>
            </div>
          )}
          <div className="grid gap-3 md:grid-cols-3">
            {input('milestone', 'Sample milestone')}
            <Field
              label="Style"
              required
              hint={
                requestStyle
                  ? 'Every round of this request samples this style. It is set in Request & tech pack.'
                  : 'Not set yet.'
              }
            >
              <span className="form-input flex min-w-0 items-center gap-2">
                {requestStyle ? (
                  <>
                    <span className="truncate">
                      <span className="font-mono">{requestStyle.code}</span> · {requestStyle.name}
                    </span>
                    <span
                      className={`ml-auto shrink-0 ${requestStyle.stage === 'DEVELOPMENT' ? 'badge-warning' : 'badge-success'}`}
                    >
                      {STYLE_STAGE_LABEL[requestStyle.stage]}
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground">No style yet</span>
                )}
              </span>
            </Field>
            <Field
              label="Colour"
              required
              hint={requestStyle ? undefined : 'The colours come from the request’s style.'}
            >
              <SmartSelect
                className="form-input"
                value={s.color}
                disabled={!style}
                onChange={(e) => set('color', e.target.value)}
              >
                <option value="">Pick a colour</option>
                {style?.colors.map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </SmartSelect>
            </Field>
            {input('techPackRef', 'Tech pack / document reference')}
            {input('patternRef', 'Pattern version / file reference')}
          </div>
          {input('construction', 'Construction instructions')}
          {input('notes', 'Technical review notes (optional)')}
        </div>
        <div hidden={step !== 1} className="space-y-5">
          <div className="glass-card space-y-3 p-3">
            <p className="font-semibold">Pieces by size</p>
            <p className="text-muted-foreground text-xs">
              Choose each size once. Measurement points must cover every size.
            </p>
            {s.sizes.map((r, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
                <Field label="Size">
                  <SmartSelect
                    className="form-input"
                    value={r.sizeId}
                    onChange={(e) =>
                      set(
                        'sizes',
                        s.sizes.map((x, j) => (j === i ? { ...x, sizeId: e.target.value } : x))
                      )
                    }
                  >
                    <option value="">Pick size</option>
                    {sizes.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.code}
                      </option>
                    ))}
                  </SmartSelect>
                </Field>
                <Field label="Pieces">
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    className="form-input"
                    value={r.qty}
                    onChange={(e) =>
                      set(
                        'sizes',
                        s.sizes.map((x, j) => (j === i ? { ...x, qty: Number(e.target.value) } : x))
                      )
                    }
                  />
                </Field>
                <button
                  className="btn-ghost"
                  onClick={() =>
                    set(
                      'sizes',
                      s.sizes.filter((_, j) => i !== j)
                    )
                  }
                >
                  Remove size
                </button>
              </div>
            ))}
            {!s.sizes.length && (
              <p className="border-border text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
                {style
                  ? 'Add the sizes and piece quantities required for this round.'
                  : 'Set the request’s style in Request & tech pack to load its size run.'}
              </p>
            )}
            <button
              className="btn-secondary"
              disabled={!style}
              onClick={() => set('sizes', [...s.sizes, { sizeId: '', qty: 1 }])}
            >
              Add size
            </button>
          </div>
          <div className="glass-card space-y-3 p-3">
            <p className="font-semibold">Measurements and tolerances</p>
            {s.measurements.map((r, i) => {
              const patch = (v: Partial<typeof r>) =>
                set(
                  'measurements',
                  s.measurements.map((x, j) => (j === i ? { ...x, ...v } : x))
                )
              return (
                <div
                  key={i}
                  className="border-border grid items-end gap-3 rounded-lg border p-3 sm:grid-cols-3"
                >
                  <Field label="Point">
                    <input
                      className="form-input"
                      value={r.name}
                      onChange={(e) => patch({ name: e.target.value })}
                    />
                  </Field>
                  <Field label="Size">
                    <SmartSelect
                      className="form-input"
                      value={r.sizeId}
                      onChange={(e) => patch({ sizeId: e.target.value })}
                    >
                      <option value="">Pick size</option>
                      {sizes
                        .filter((x) => s.sizes.some((z) => z.sizeId === x.id))
                        .map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.code}
                          </option>
                        ))}
                    </SmartSelect>
                  </Field>
                  <Field label="Target">
                    <input
                      type="number"
                      step="0.01"
                      className="form-input"
                      value={r.target}
                      onChange={(e) => patch({ target: Number(e.target.value) })}
                    />
                  </Field>
                  <Field label="Tolerance ±">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      className="form-input"
                      value={r.tolerance}
                      onChange={(e) => patch({ tolerance: Number(e.target.value) })}
                    />
                  </Field>
                  <Field label="Unit">
                    <select
                      className="form-input"
                      value={r.unit}
                      onChange={(e) => patch({ unit: e.target.value as 'cm' | 'in' })}
                    >
                      <option>cm</option>
                      <option>in</option>
                    </select>
                  </Field>
                  <button
                    className="btn-ghost"
                    onClick={() =>
                      set(
                        'measurements',
                        s.measurements.filter((_, j) => i !== j)
                      )
                    }
                  >
                    Remove point
                  </button>
                </div>
              )
            })}
            <button
              className="btn-secondary"
              disabled={!s.sizes.some((x) => x.sizeId)}
              onClick={() =>
                set('measurements', [
                  ...s.measurements,
                  {
                    name: '',
                    sizeId: s.sizes[0]?.sizeId ?? '',
                    target: 0,
                    tolerance: 0,
                    unit: 'cm',
                  },
                ])
              }
            >
              Add measurement
            </button>
          </div>
        </div>
        <div hidden={step !== 2} className="space-y-5">
          <div className="glass-card space-y-3 p-3">
            <p className="font-semibold">Material plan</p>
            {s.materials.map((r, i) => {
              const patch = (v: Partial<typeof r>) =>
                set(
                  'materials',
                  s.materials.map((x, j) => (i === j ? { ...x, ...v } : x))
                )
              return (
                <div
                  key={i}
                  className="border-border grid items-end gap-3 rounded-lg border p-3 md:grid-cols-2"
                >
                  <Field label="Material">
                    <SmartSelect
                      className="form-input"
                      value={r.itemId}
                      onChange={(e) => patch({ itemId: e.target.value })}
                    >
                      <option value="">Pick material</option>
                      {lookups.items.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.code} · {x.name} ({x.uom?.symbol})
                        </option>
                      ))}
                    </SmartSelect>
                  </Field>
                  <Field label="Store">
                    <SmartSelect
                      className="form-input"
                      value={r.warehouseId}
                      onChange={(e) => patch({ warehouseId: e.target.value })}
                    >
                      <option value="">Pick store</option>
                      {lookups.warehouses.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                    </SmartSelect>
                  </Field>
                  <Field label="Quantity">
                    <input
                      className="form-input"
                      type="number"
                      step="0.001"
                      min="0.001"
                      value={r.qty}
                      onChange={(e) => patch({ qty: Number(e.target.value) })}
                    />
                  </Field>
                  <Field label="Whose material">
                    <select
                      className="form-input"
                      value={r.ownership}
                      onChange={(e) => patch({ ownership: e.target.value as typeof r.ownership })}
                    >
                      <option value="OWNED">Our own</option>
                      <option value="CUSTOMER_OWNED">This buyer’s</option>
                    </select>
                  </Field>
                  <button
                    className="btn-ghost"
                    onClick={() =>
                      set(
                        'materials',
                        s.materials.filter((_, j) => j !== i)
                      )
                    }
                  >
                    Remove material
                  </button>
                </div>
              )
            })}
            <button
              className="btn-secondary"
              onClick={() =>
                set('materials', [
                  ...s.materials,
                  {
                    itemId: '',
                    warehouseId: lookups.warehouses[0]?.id ?? '',
                    qty: 1,
                    ownership: 'OWNED',
                  },
                ])
              }
            >
              Add material
            </button>
          </div>
          <section className="space-y-3">
            <h4 className="font-semibold">Making route</h4>
            <p className="text-muted-foreground text-sm">
              Cutting starts the route. Add washing, printing, embroidery or other operations where
              they belong.
            </p>
            {s.stages.map((name, i) => (
              <div key={i} className="border-border flex items-center gap-2 rounded-lg border p-3">
                <span className="text-primary w-5 text-sm font-semibold">{i + 1}</span>
                <input
                  aria-label={`Making step ${i + 1}`}
                  className="form-input min-w-0 flex-1"
                  disabled={i === 0}
                  value={name}
                  onChange={(e) =>
                    set(
                      'stages',
                      s.stages.map((v, j) => (j === i ? e.target.value : v))
                    )
                  }
                />
                <button
                  type="button"
                  className="btn-ghost px-2"
                  aria-label={`Move ${name || 'step'} up`}
                  disabled={i < 2}
                  onClick={() => {
                    const a = [...s.stages]
                    ;[a[i - 1], a[i]] = [a[i], a[i - 1]]
                    set('stages', a)
                  }}
                >
                  <ArrowUp size={15} />
                </button>
                <button
                  type="button"
                  className="btn-ghost px-2"
                  aria-label={`Move ${name || 'step'} down`}
                  disabled={i === 0 || i === s.stages.length - 1}
                  onClick={() => {
                    const a = [...s.stages]
                    ;[a[i + 1], a[i]] = [a[i], a[i + 1]]
                    set('stages', a)
                  }}
                >
                  <ArrowDown size={15} />
                </button>
                <button
                  type="button"
                  className="btn-ghost px-2"
                  aria-label={`Remove ${name || 'step'}`}
                  disabled={i === 0 || name.trim().toLowerCase() === 'stitching'}
                  onClick={() =>
                    set(
                      'stages',
                      s.stages.filter((_, j) => j !== i)
                    )
                  }
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="btn-secondary"
              onClick={() => set('stages', [...s.stages, ''])}
            >
              <Plus size={15} /> Add operation
            </button>
          </section>
        </div>
        {step === 3 && (
          <div className="space-y-4">
            {gaps.map((items, i) => (
              <div key={i} className="border-border rounded-lg border p-4">
                <div className="flex items-center justify-between gap-3">
                  <h4 className="flex items-center gap-2 font-medium">
                    {items.length ? (
                      <Circle size={16} className="text-muted-foreground" />
                    ) : (
                      <CheckCircle2 size={16} className="text-primary" />
                    )}
                    {sections[i]}
                  </h4>
                  <button type="button" className="btn-ghost text-sm" onClick={() => setStep(i)}>
                    Edit
                  </button>
                </div>
                {items.length ? (
                  <ul className="text-muted-foreground mt-2 list-inside list-disc space-y-1 text-sm">
                    {items.map((gap, j) => (
                      <li key={j}>{gap}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground mt-2 text-sm">
                    {i === 0
                      ? `${s.milestone} · ${style?.code} · ${s.color}`
                      : i === 1
                        ? `${s.sizes.map((x) => `${sizes.find((z) => z.id === x.sizeId)?.code}: ${x.qty} pcs`).join(' · ')} · ${s.measurements.length} measurement points`
                        : `${s.materials.length} material lines · ${s.stages.join(' → ')}`}
                  </p>
                )}
              </div>
            ))}
            <p className="bg-muted/40 rounded-lg p-4 text-sm leading-relaxed">
              {ready
                ? 'The required details are filled in. Save a draft to keep editing, or release it to begin sampling. Changes after release require a new round.'
                : 'You can save this incomplete draft and return later. Complete the items above before releasing it for sampling.'}
            </p>
          </div>
        )}
      </div>
      <div className="border-border bg-muted/20 flex flex-wrap items-center justify-between gap-3 border-t p-4">
        <button
          type="button"
          className="btn-secondary"
          disabled={step === 0}
          onClick={() => setStep(step - 1)}
        >
          <ChevronLeft size={15} /> Back
        </button>
        <div className="flex flex-wrap items-center gap-2">
          {JSON.stringify(s) !== JSON.stringify(initial) && (
            <span className="text-muted-foreground mr-2 text-xs">Unsaved changes</span>
          )}
          <button
            type="button"
            className="btn-secondary"
            disabled={busy || JSON.stringify(s) === JSON.stringify(initial)}
            data-hotkey="save"
            onClick={() => void saveDraft()}
          >
            {busy ? 'Saving…' : 'Save draft'}
          </button>
          {step < 3 ? (
            <button type="button" className="btn-primary" onClick={() => setStep(step + 1)}>
              {step === 2 ? 'Review specification' : 'Continue'}
              <ChevronRight size={15} />
            </button>
          ) : (
            <>
              {release && (
                <button
                  type="button"
                  className="btn-primary"
                  disabled={!ready}
                  onClick={() => release(s)}
                >
                  Release for sampling
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </fieldset>
  )
}
