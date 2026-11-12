'use client'

import { useEffect, useMemo, useState } from 'react'
import { CalendarDays, ClipboardList, Loader2, Lock, Pencil, Save, Scissors } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { ContractorPicker, type KnownContractor } from './floor/ContractorPicker'

/**
 * A manufacturing order's details, after its plan is fixed and until cutting
 * is complete.
 *
 * Once the store has issued material, the pieces, sizes and routing are what
 * the floor is working to and stay as they are. What was only written down —
 * the dates and note, each job card's lot no., metres, ratio and the like,
 * and a lay still with its cutting contractor (who has it, its lot, layers,
 * fabric and fabric given) — can still be put right here, until every piece
 * is cut and no lay is still out. Saved all together.
 */

interface JobCardRow {
  id: string
  jobCardNumber: string
  orderNo: string | null
  projectId: string | null
  description: string | null
  fabricQuality: string | null
  designNo: string | null
  lotNo: string | null
  meters: string | number | null
  average: string | number | null
  ratio: string | null
  notes: string | null
  moLine: { color: string | null; style: { code: string } | null }
}

interface IssueRow {
  id: string
  cutOrderNumber: string
  moLineId: string | null
  cutterName: string | null
  issuedOn: string
  lotNo: string | null
  ratio: string | null
  noOfLayers: string | number | null
  fabricItemId: string | null
  fabricGiven: string | number | null
  plannedPieces: number
  notes: string | null
}

interface Details {
  id: string
  moNumber: string
  plannedStartDate: string | null
  plannedEndDate: string | null
  notes: string | null
  planBlock: string | null
  detailsBlock: string | null
  jobCards: JobCardRow[]
  cuttingIssues: IssueRow[]
  fabrics: Array<{ itemId: string; code: string; name: string; uom: string | null }>
}

type Form = Record<string, string>

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '')
/** A stored number for its box: "120.000" from the database reads as 120. */
const str = (v: string | number | null | undefined) => (v == null || v === '' ? '' : String(Number(v)))
const num = (v: string) => (v.trim() === '' ? null : Number(v))

export function MoDetailsDialog({
  moId,
  issueId,
  onClose,
  onSaved,
}: {
  moId: string
  /**
   * One lay only — opened from its Edit on the cutting sheet: the window shows
   * and saves just that lay, not the order and its job cards.
   */
  issueId?: string
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const [d, setD] = useState<Details | null>(null)
  const [order, setOrder] = useState<Form>({})
  const [cards, setCards] = useState<Record<string, Form>>({})
  const [issues, setIssues] = useState<Record<string, Form>>({})
  const [everyone, setEveryone] = useState<Array<{ name: string; cuts: number; inMaster?: boolean }>>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api
      .get<{ data: Details }>(`/production/orders/${moId}/details`)
      .then((res) => {
        if (!alive) return
        const x = res.data
        setD(x)
        setOrder({ start: day(x.plannedStartDate), end: day(x.plannedEndDate), notes: x.notes ?? '' })
        setCards(
          Object.fromEntries(
            x.jobCards.map((c) => [
              c.id,
              {
                orderNo: c.orderNo ?? '',
                projectId: c.projectId ?? '',
                description: c.description ?? '',
                fabricQuality: c.fabricQuality ?? '',
                designNo: c.designNo ?? '',
                lotNo: c.lotNo ?? '',
                meters: str(c.meters),
                average: str(c.average),
                ratio: c.ratio ?? '',
                notes: c.notes ?? '',
              },
            ]),
          ),
        )
        setIssues(
          Object.fromEntries(
            x.cuttingIssues.map((i) => [
              i.id,
              {
                cutterName: i.cutterName ?? '',
                issuedOn: day(i.issuedOn),
                lotNo: i.lotNo ?? '',
                ratio: i.ratio ?? '',
                noOfLayers: str(i.noOfLayers),
                fabricItemId: i.fabricItemId ?? '',
                fabricGiven: str(i.fabricGiven),
                notes: i.notes ?? '',
              },
            ]),
          ),
        )
      })
      .catch((err) => alive && setError(err instanceof ApiError ? err.message : 'Could not open this order’s details.'))
    api
      .get<{ data: Array<{ name: string; cuts: number; inMaster?: boolean }> }>('/production/cutting-contractors')
      .then((res) => alive && setEveryone(res.data))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [moId])

  // Each lay's own contractor first, then everyone else from the master and past cuttings.
  const knownFor = useMemo(() => {
    const before = (c: { cuts: number; inMaster?: boolean }) =>
      [c.cuts ? `${c.cuts} ${c.cuts === 1 ? 'cutting' : 'cuttings'} before` : null, c.inMaster ? 'Contractors master' : null].filter(Boolean).join(' · ')
    return (current: string): KnownContractor[] => {
      const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
      return [
        ...(current ? [{ value: current, label: 'has this lay now' }] : []),
        ...everyone.filter((c) => !(current && same(c.name, current))).map((c) => ({ value: c.name, label: before(c) })),
      ]
    }
  }, [everyone])

  const setCard = (id: string, k: string, v: string) => setCards((p) => ({ ...p, [id]: { ...p[id], [k]: v } }))
  const setIssue = (id: string, k: string, v: string) => setIssues((p) => ({ ...p, [id]: { ...p[id], [k]: v } }))

  // The lays this window shows: one, when opened from a lay's Edit; else every lay still out.
  const lays = d ? (issueId ? d.cuttingIssues.filter((i) => i.id === issueId) : d.cuttingIssues) : []
  const oneLay = issueId ? (lays[0] ?? null) : null

  const blocker = !d
    ? null
    : issueId && !oneLay
      ? 'This lay has come back cut or been cancelled, so it can no longer be changed.'
      : d.detailsBlock
        ? d.detailsBlock
        : !issueId && order.start && order.end && order.end < order.start
          ? 'The planned finish cannot be before the planned start.'
          : lays.some((i) => !issues[i.id]?.cutterName.trim())
            ? 'Name the cutting contractor on every lay.'
            : null

  const save = async () => {
    if (!d || blocker) return
    setSaving(true)
    setError(null)
    const layBody = (i: IssueRow) => {
      const f = issues[i.id]
      return {
        id: i.id,
        cutterName: f.cutterName.trim(),
        issuedOn: f.issuedOn || undefined,
        lotNo: f.lotNo.trim() || null,
        ratio: f.ratio.trim() || null,
        noOfLayers: num(f.noOfLayers),
        fabricItemId: f.fabricItemId || null,
        fabricGiven: num(f.fabricGiven),
        notes: f.notes.trim() || null,
      }
    }
    try {
      // One lay: only that lay is sent, so nothing else on the order is touched.
      const body = oneLay
        ? { cuttingIssues: [layBody(oneLay)] }
        : {
            plannedStartDate: order.start || null,
            plannedEndDate: order.end || null,
            notes: order.notes.trim() || null,
            jobCards: d.jobCards.map((c) => {
              const f = cards[c.id]
              return {
                id: c.id,
                orderNo: f.orderNo,
                projectId: f.projectId,
                description: f.description,
                fabricQuality: f.fabricQuality,
                designNo: f.designNo,
                lotNo: f.lotNo,
                meters: num(f.meters),
                average: num(f.average),
                ratio: f.ratio,
                notes: f.notes,
              }
            }),
            cuttingIssues: d.cuttingIssues.map(layBody),
          }
      const res = await api.patch<{ message?: string }>(`/production/orders/${d.id}/details`, body)
      onSaved(res.message ?? 'Saved.')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the details.')
    } finally {
      setSaving(false)
    }
  }

  const text = (value: string, onChange: (v: string) => void, label: string, opts: { placeholder?: string; span?: boolean } = {}) => (
    <label className={`block ${opts.span ? 'sm:col-span-2' : ''}`}>
      <span className="form-label">{label}</span>
      <input className="form-input" value={value} placeholder={opts.placeholder} onChange={(e) => onChange(e.target.value)} aria-label={label} />
    </label>
  )
  const number = (value: string, onChange: (v: string) => void, label: string) => (
    <label className="block">
      <span className="form-label">{label}</span>
      <StepInput decimals className="form-input text-right tabular-nums" value={value} placeholder="0" onValueChange={onChange} aria-label={label} />
    </label>
  )

  /** One lay's boxes: contractor, issued on, lot no., ratio, layers, fabric, fabric given, note. */
  const layFields = (i: IssueRow) => {
    const f = issues[i.id]
    if (!f || !d) return null
    const set = (k: string) => (v: string) => setIssue(i.id, k, v)
    const fabric = d.fabrics.find((x) => x.itemId === f.fabricItemId)
    return (
      <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block sm:col-span-2">
          <span className="form-label">Cutting contractor</span>
          <ContractorPicker value={f.cutterName} onChange={set('cutterName')} known={knownFor(i.cutterName ?? '')} resetTo={i.cutterName ?? ''} ariaLabel={`Cutting contractor for ${i.cutOrderNumber}`} />
        </label>
        <label className="block">
          <span className="form-label">Issued on</span>
          <input type="date" className="form-input" value={f.issuedOn} onChange={(e) => set('issuedOn')(e.target.value)} />
        </label>
        {text(f.lotNo, set('lotNo'), 'Lot no.')}
        {text(f.ratio, set('ratio'), 'Ratio')}
        {number(f.noOfLayers, set('noOfLayers'), 'Layers')}
        <label className="block">
          <span className="form-label">Fabric</span>
          <SmartSelect className="form-input" value={f.fabricItemId} onChange={(e) => set('fabricItemId')(e.target.value)} aria-label={`Fabric for ${i.cutOrderNumber}`}>
            <option value="">—</option>
            {d.fabrics.map((x) => (
              <option key={x.itemId} value={x.itemId}>
                {x.name}
              </option>
            ))}
          </SmartSelect>
        </label>
        {number(f.fabricGiven, set('fabricGiven'), `Fabric given${fabric?.uom ? ` (${fabric.uom})` : ''}`)}
        {text(f.notes, set('notes'), 'Note', { span: true })}
      </div>
    )
  }

  return (
    <FormFrame
      icon={issueId ? Scissors : Pencil}
      title={issueId ? `Edit ${oneLay?.cutOrderNumber ?? 'the lay'}` : 'Edit details'}
      subtitle={
        !d
          ? 'Loading…'
          : issueId
            ? `${d.moNumber} · ${oneLay ? `with ${oneLay.cutterName ?? 'a contractor'} — open until it comes back cut` : 'no longer with a contractor'}`
            : `${d.moNumber} · open until cutting is complete`
      }
      width={issueId ? 'max-w-4xl' : 'max-w-5xl'}
      primary={
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || !d || !!blocker}>
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} {issueId ? 'Save' : 'Save details'}
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      }
      footerNote={
        blocker ? (
          <span className="warn-text">{blocker}</span>
        ) : issueId ? (
          'Changes this lay only. Its sizes and pieces stay as issued: to change those, cancel it and issue again.'
        ) : (
          'Saved all together: the order, its job cards and the lays with contractors.'
        )
      }
      error={error}
      onClose={onClose}
      busy={saving}
    >
      {!d ? (
        <div className="text-muted-foreground flex items-center gap-2 p-6 text-sm">
          <Loader2 size={15} className="animate-spin" /> Loading…
        </div>
      ) : issueId ? (
        oneLay ? (
          <Section icon={Scissors} title="The lay">
            {layFields(oneLay)}
          </Section>
        ) : null
      ) : (
        <>
          {d.planBlock && (
            <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
              <Lock size={13} className="mt-0.5 shrink-0" />
              <span>
                Pieces, sizes and routing are fixed: {d.planBlock.replace(/, so its plan can no longer be changed\.$/, '.')} Everything below can still be
                changed until cutting is complete.
              </span>
            </p>
          )}

          <Section icon={CalendarDays} title="The order">
            <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="block">
                <span className="form-label">Planned start</span>
                <input type="date" className="form-input" value={order.start ?? ''} onChange={(e) => setOrder((o) => ({ ...o, start: e.target.value }))} />
              </label>
              <label className="block">
                <span className="form-label">Planned finish</span>
                <input type="date" className="form-input" value={order.end ?? ''} onChange={(e) => setOrder((o) => ({ ...o, end: e.target.value }))} />
              </label>
              {text(order.notes ?? '', (v) => setOrder((o) => ({ ...o, notes: v })), 'Note', { span: true })}
            </div>
          </Section>

          {d.jobCards.map((c) => {
            const f = cards[c.id]
            if (!f) return null
            const set = (k: string) => (v: string) => setCard(c.id, k, v)
            return (
              <Section key={c.id} icon={ClipboardList} title={`${c.jobCardNumber} · ${c.moLine.style?.code ?? ''} ${c.moLine.color ?? ''}`.trim()}>
                <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
                  {text(f.lotNo, set('lotNo'), 'Lot no.')}
                  {number(f.meters, set('meters'), 'Metres')}
                  {number(f.average, set('average'), 'Average (m per piece)')}
                  {text(f.ratio, set('ratio'), 'Ratio', { placeholder: 'M1 L2 XL2 2XL1' })}
                  {text(f.fabricQuality, set('fabricQuality'), 'Fabric quality', { span: true })}
                  {text(f.designNo, set('designNo'), 'Design no.')}
                  {text(f.orderNo, set('orderNo'), 'Order no.')}
                  {text(f.projectId, set('projectId'), 'Project ID')}
                  {text(f.description, set('description'), 'Description', { span: true })}
                  {text(f.notes, set('notes'), 'Note')}
                </div>
              </Section>
            )
          })}

          {d.cuttingIssues.length > 0 && (
            <Section icon={Scissors} title="With cutting contractors">
              <div className="space-y-4">
                {d.cuttingIssues.map((i) => (
                  <div key={i.id} className="border-border rounded-lg border p-3">
                    <p className="text-foreground mb-2 text-sm font-semibold">
                      {i.cutOrderNumber} <span className="text-muted-foreground font-normal">· {i.plannedPieces.toLocaleString('en-IN')} pcs, not yet received</span>
                    </p>
                    {layFields(i)}
                  </div>
                ))}
              </div>
            </Section>
          )}
        </>
      )}
    </FormFrame>
  )
}
