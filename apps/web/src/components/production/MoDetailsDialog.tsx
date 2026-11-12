'use client'

import { useEffect, useMemo, useState } from 'react'
import { CalendarDays, ClipboardList, Loader2, Lock, Pencil, Save, Scissors } from 'lucide-react'
import { api, ApiError, can } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { ContractorPicker, type KnownContractor } from './floor/ContractorPicker'

/**
 * A manufacturing order's details, after its plan is fixed and until cutting
 * is complete.
 *
 * Once the store has issued material, the order's pieces, sizes and routing
 * are what the floor is working to and stay as they are. What was only written
 * down — the dates and note, each job card's lot no., metres, ratio and the
 * like — can still be put right here, and so can a lay still with its cutting
 * contractor: who has it, its lot, layers, fabric, fabric given, and the
 * pieces of each size on it, within what is left to cut. All of it until
 * every piece is cut and no lay is still out. Saved all together.
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
  /** Its pieces by size, beside what each size is to make and has had cut. */
  sizes: Array<{ sizeId: string; code: string; toMake: number; cut: number; qty: number }>
  /** A colour without sizes: its totals, for a lay counted in pieces only. */
  line: { toMake: number; cut: number } | null
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
  /**
   * Each lay's pieces as typed: by size, or one number for a colour without
   * sizes (under the key ''). Sent only for a lay whose pieces were changed —
   * one issued with a manager's allowance would otherwise be checked again.
   */
  const [layQty, setLayQty] = useState<Record<string, Record<string, string>>>({})
  const [piecesTouched, setPiecesTouched] = useState<Record<string, boolean>>({})
  const [allowExcess, setAllowExcess] = useState<Record<string, boolean>>({})
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
        setLayQty(
          Object.fromEntries(
            x.cuttingIssues.map((i) => [
              i.id,
              i.sizes.length ? Object.fromEntries(i.sizes.map((z) => [z.sizeId, String(z.qty)])) : { '': String(i.plannedPieces) },
            ]),
          ),
        )
        setPiecesTouched({})
        setAllowExcess({})
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
  const setPieces = (id: string, sizeId: string, v: string) => {
    setLayQty((p) => ({ ...p, [id]: { ...p[id], [sizeId]: v } }))
    setPiecesTouched((p) => ({ ...p, [id]: true }))
  }
  const manager = can('production', 'approve')
  const n = (v: string | undefined) => Number(v) || 0
  /**
   * What the colour's other lays still out hold of a size (key '' for a colour
   * without sizes) — as typed here, so pieces can move from one lay to another
   * in one save. The server checks them the same way.
   */
  const othersOf = (i: IssueRow, sizeId: string) =>
    (d?.cuttingIssues ?? []).filter((j) => j.id !== i.id && j.moLineId === i.moLineId).reduce((s, j) => s + n(layQty[j.id]?.[sizeId]), 0)
  /** What is left of a size for this lay: to make, less cut, less what the other lays hold. */
  const leftOf = (i: IssueRow, sizeId: string, x: { toMake: number; cut: number }) => Math.max(0, x.toMake - x.cut - othersOf(i, sizeId))
  /** What is wrong with a lay's pieces as typed, or null: too many of a size, or none at all. */
  const piecesProblem = (i: IssueRow): string | null => {
    if (!piecesTouched[i.id]) return null
    const q = layQty[i.id] ?? {}
    const excess = allowExcess[i.id] && manager
    if (i.sizes.length) {
      const total = i.sizes.reduce((s, z) => s + n(q[z.sizeId]), 0)
      if (!total) return 'Enter the pieces of each size on this lay.'
      const over = i.sizes.find((z) => n(q[z.sizeId]) > leftOf(i, z.sizeId, z))
      if (over && !excess) return `Size ${over.code}: only ${leftOf(i, over.sizeId, over)} left to cut.`
      return null
    }
    const pieces = n(q[''])
    if (!pieces) return 'Enter the pieces on this lay.'
    const left = i.line ? leftOf(i, '', i.line) : Infinity
    if (pieces > left && !excess) return `Only ${left} left to cut.`
    return null
  }

  // The lays this window shows: one, when opened from a lay's Edit; else every lay still out.
  const lays = d ? (issueId ? d.cuttingIssues.filter((i) => i.id === issueId) : d.cuttingIssues) : []
  const oneLay = issueId ? (lays[0] ?? null) : null

  /** Why nothing here can be saved at all — not something a box can put right. */
  const locked = !d ? null : issueId && !oneLay ? 'This lay has come back cut or been cancelled, so it can no longer be changed.' : d.detailsBlock

  /**
   * What is wrong with the boxes as filled, each shown under its own box. Save
   * stays enabled: pressing it with any of these goes to the first one.
   */
  const problems: Array<{ at: string; text: string }> = !d
    ? []
    : [
        ...(!issueId && order.start && order.end && order.end < order.start ? [{ at: 'mo-details-dates', text: 'The planned finish cannot be before the planned start.' }] : []),
        ...lays.flatMap((i) => {
          const pieces = piecesProblem(i)
          return [
            ...(!issues[i.id]?.cutterName.trim() ? [{ at: `lay-${i.id}-cutter`, text: 'Name the cutting contractor.' }] : []),
            ...(pieces ? [{ at: `lay-${i.id}-pieces`, text: pieces }] : []),
          ]
        }),
      ]
  const problemAt = (at: string) => {
    const p = problems.find((x) => x.at === at)
    return p ? <span className="warn-text mt-1 block text-xs">{p.text}</span> : null
  }

  const save = async () => {
    if (!d || locked) return
    if (problems.length) {
      const el = document.getElementById(problems[0].at)
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      el?.querySelector<HTMLElement>('input, select, button')?.focus({ preventScroll: true })
      return
    }
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
        // Its pieces, only when changed: by size, or one number for a colour without sizes.
        ...(piecesTouched[i.id]
          ? {
              ...(i.sizes.length
                ? { planned: i.sizes.map((z) => ({ sizeId: z.sizeId, qty: n(layQty[i.id]?.[z.sizeId]) })) }
                : { pieces: n(layQty[i.id]?.['']) }),
              allowExcess: !!(allowExcess[i.id] && manager),
            }
          : {}),
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
        <label className="block sm:col-span-2" id={`lay-${i.id}-cutter`}>
          <span className="form-label">Cutting contractor</span>
          <ContractorPicker value={f.cutterName} onChange={set('cutterName')} known={knownFor(i.cutterName ?? '')} resetTo={i.cutterName ?? ''} ariaLabel={`Cutting contractor for ${i.cutOrderNumber}`} />
          {problemAt(`lay-${i.id}-cutter`)}
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
        <div className="sm:col-span-2 lg:col-span-4">{piecesTable(i)}</div>
      </div>
    )
  }

  /**
   * The lay's pieces, by size, beside what each size has left for it: to make,
   * less cut, less what the other lays still have. "Left" here counts this
   * lay's own pieces back in — they are the ones being changed.
   */
  const piecesTable = (i: IssueRow) => {
    const q = layQty[i.id] ?? {}
    const pcs = (v: number) => v.toLocaleString('en-IN')
    const excess = !!(allowExcess[i.id] && manager)
    return (
      <div id={`lay-${i.id}-pieces`}>
        <span className="form-label">Pieces on this lay</span>
        {i.sizes.length ? (
          <div className="border-border overflow-x-auto rounded-lg border">
            <table className="data-table table-totals w-full">
              <thead>
                <tr className="bg-secondary">
                  <th>Size</th>
                  <th style={{ textAlign: 'right' }}>To make</th>
                  <th style={{ textAlign: 'right' }}>Cut</th>
                  <th style={{ textAlign: 'right' }}>On other lays</th>
                  <th style={{ textAlign: 'right' }}>Left for this lay</th>
                  <th style={{ textAlign: 'right' }}>This lay</th>
                </tr>
              </thead>
              <tbody>
                {i.sizes.map((z) => {
                  const left = leftOf(i, z.sizeId, z)
                  return (
                    <tr key={z.sizeId}>
                      <td className="text-xs font-medium">{z.code}</td>
                      <td className="text-right text-xs tabular-nums">{pcs(z.toMake)}</td>
                      <td className="text-right text-xs tabular-nums">{pcs(z.cut)}</td>
                      <td className="text-right text-xs tabular-nums">{pcs(othersOf(i, z.sizeId))}</td>
                      <td className={`text-right text-xs tabular-nums ${n(q[z.sizeId]) > left && !excess ? 'text-destructive font-semibold' : ''}`}>{pcs(left)}</td>
                      <td className="w-28">
                        <StepInput
                          className="form-input h-8 text-right text-xs tabular-nums"
                          value={q[z.sizeId] ?? ''}
                          max={excess ? undefined : left}
                          placeholder="0"
                          onValueChange={(v) => setPieces(i.id, z.sizeId, v)}
                          aria-label={`Size ${z.code} on ${i.cutOrderNumber}`}
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="bg-secondary">
                  <td className="text-xs font-medium">Total</td>
                  <td className="text-right text-xs tabular-nums">{pcs(i.sizes.reduce((s, z) => s + z.toMake, 0))}</td>
                  <td className="text-right text-xs tabular-nums">{pcs(i.sizes.reduce((s, z) => s + z.cut, 0))}</td>
                  <td className="text-right text-xs tabular-nums">{pcs(i.sizes.reduce((s, z) => s + othersOf(i, z.sizeId), 0))}</td>
                  <td className="text-right text-xs tabular-nums">{pcs(i.sizes.reduce((s, z) => s + leftOf(i, z.sizeId, z), 0))}</td>
                  <td className="text-right text-xs font-semibold tabular-nums">{pcs(i.sizes.reduce((s, z) => s + n(q[z.sizeId]), 0))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <StepInput
              className="form-input h-9 w-36 text-right tabular-nums"
              value={q[''] ?? ''}
              max={excess || !i.line ? undefined : leftOf(i, '', i.line)}
              placeholder="0"
              onValueChange={(v) => setPieces(i.id, '', v)}
              aria-label={`Pieces on ${i.cutOrderNumber}`}
            />
            {i.line && (
              <span className="text-muted-foreground text-xs">
                {pcs(i.line.toMake)} to make · {pcs(i.line.cut)} cut · {pcs(othersOf(i, ''))} on other lays · {pcs(leftOf(i, '', i.line))} left for this lay
              </span>
            )}
          </div>
        )}
        {problemAt(`lay-${i.id}-pieces`)}
        {manager && (
          <label className="text-muted-foreground mt-2 inline-flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={!!allowExcess[i.id]} onChange={(e) => setAllowExcess((p) => ({ ...p, [i.id]: e.target.checked }))} />
            Allow cutting more than the order (an allowance)
          </label>
        )}
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
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || !d || !!locked}>
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} {issueId ? 'Save' : 'Save details'}
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      }
      footerNote={
        locked ? (
          <span className="warn-text">{locked}</span>
        ) : problems.length ? (
          <span className="warn-text">
            {problems.length === 1 ? 'One box needs putting right before saving — see the note under it.' : `${problems.length} boxes need putting right before saving — see the notes under them.`}
          </span>
        ) : issueId ? (
          'Changes this lay only — its pieces too, until it comes back cut.'
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
        ) : (
          <p className="text-muted-foreground flex items-start gap-1.5 p-2 text-sm">
            <Lock size={14} className="mt-0.5 shrink-0" />
            <span>{locked}</span>
          </p>
        )
      ) : (
        <>
          {d.planBlock && (
            <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
              <Lock size={13} className="mt-0.5 shrink-0" />
              <span>
                The order&rsquo;s pieces, sizes and routing are fixed: {d.planBlock.replace(/, so its plan can no longer be changed\.$/, '.')} Everything below —
                the pieces on each lay still with a contractor too — can still be changed until cutting is complete.
              </span>
            </p>
          )}

          <Section icon={CalendarDays} title="The order">
            <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="block">
                <span className="form-label">Planned start</span>
                <input type="date" className="form-input" value={order.start ?? ''} onChange={(e) => setOrder((o) => ({ ...o, start: e.target.value }))} />
              </label>
              <label className="block" id="mo-details-dates">
                <span className="form-label">Planned finish</span>
                <input type="date" className="form-input" value={order.end ?? ''} onChange={(e) => setOrder((o) => ({ ...o, end: e.target.value }))} />
                {problemAt('mo-details-dates')}
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
                      {i.cutOrderNumber} <span className="text-muted-foreground font-normal">· {i.plannedPieces.toLocaleString('en-IN')} pcs issued, not yet received</span>
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
