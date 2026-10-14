'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Ban,
  ClipboardCheck,
  ClipboardList,
  Gavel,
  Hammer,
  PackageCheck,
  PackageOpen,
  Printer,
  Receipt,
  Scale,
  Send,
  Truck,
  Undo2,
  Wrench,
} from 'lucide-react'
import { api, ApiError, can } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import { Section } from '@/components/purchase/Section'
import { ReasonDialog } from '@/components/ui/ReasonDialog'
import { SheetHeader, SizeTable } from './SheetHeader'
import { NextSteps, type NextStep } from './NextSteps'
import { CountInDialog } from './CountInDialog'
import { SettleDialog } from './SettleDialog'
import { WorkDialog } from './WorkDialog'
import { SendOnDialog } from './SendOnDialog'
import { DecideDialog } from './DecideDialog'
import { ReworkDoneDialog } from './ReworkDoneDialog'
import { VendorReturnDialog } from './VendorReturnDialog'
import { SendBackDialog } from './SendBackDialog'
import { ReturnBillDialog } from './ReturnBillDialog'
import { sendsFromHand } from './useFlow'
import { transferStatus } from './transferStatus'
import { isCheck, pcs, type FlowStep, type FlowTransfer, type JobCardDetail, type JobWorkReturn, type LogEntry } from './types'
import { BundleTable, type SheetPiece } from './BundleTable'
import { PieceList } from './PieceList'

/**
 * A department's sheet for one job card — stitching, finishing, washing, a
 * check — as the paper sheet had it: bundle by bundle and day by day, what
 * came in, what was processed, what went out to the next department, what was
 * damaged, and what is left, with who signed for it. From here the department
 * counts in what was sent to it, records its work, transfers pieces on, and
 * decides on the damaged ones. A stage done outside shows its unit's challans
 * and returns.
 */

type Open =
  | { kind: 'count'; transfer: FlowTransfer }
  | { kind: 'settle'; transfer: FlowTransfer }
  | { kind: 'work' }
  | { kind: 'send' }
  | { kind: 'decide' }
  | { kind: 'rework' }
  | { kind: 'return'; jwoId: string }
  | { kind: 'sendBack'; jwoId: string }
  | { kind: 'bill'; vendor: string; ret: JobWorkReturn }
  | { kind: 'undo'; eventId: string; label: string }
  | { kind: 'cancelTransfer'; transfer: FlowTransfer }

const openWindow = (url: string) => window.open(url, '_blank', 'noopener')
const TERMINAL = ['SCRAPPED', 'PACKED', 'PACKED_B']

export interface SheetRow {
  key: string
  eventId: string
  date: string
  bundleId: string
  bundle: string
  bundleNo: number
  size: string | null
  sizeId: string | null
  in: number
  processed: number
  out: number
  damaged: number
  rejected: number
  rework: number
  balance: number
  sign: string
  document: string | null
  type: string
}

/** The sheet's lines: one per entry and bundle, with each bundle's running balance at the stage. */
export function sheetRows(d: JobCardDetail, step: FlowStep): SheetRow[] {
  const bundleOf = new Map(d.bundles.map((b) => [b.id, b]))
  const mine = d.log.filter((e) => e.stepId === step.id)
  const groups = new Map<string, LogEntry[]>()
  for (const e of mine) {
    const k = `${e.eventId}|${e.bundleId}`
    groups.set(k, [...(groups.get(k) ?? []), e])
  }
  const balance = new Map<string, number>()
  const rows: SheetRow[] = []
  for (const [key, list] of groups) {
    const e0 = list[0]
    const sum = (f: (e: LogEntry) => boolean) => list.filter(f).reduce((s, e) => s + Math.abs(e.qty), 0)
    const sent = (e: LogEntry) => (e.type === 'DISPATCH' || e.type === 'EXCESS') && e.qty < 0 && (e.bucket === 'DONE' || e.bucket === 'WIP') && !e.vendorId
    const row = {
      in: sum((e) => e.qty > 0 && e.bucket === 'WIP' && (['RECEIVE', 'EXCESS', 'SETTLE'].includes(e.type) || (e.type === 'DISPATCH' && !!e.vendorId))),
      processed: sum((e) => (e.qty > 0 && e.bucket === 'DONE' && ['PROCESS', 'REWORK_DONE', 'VENDOR_RETURN', 'DECIDE'].includes(e.type)) || (e.qty < 0 && e.bucket === 'WIP' && ['DISPATCH', 'EXCESS', 'PACK'].includes(e.type) && !e.vendorId)),
      out: sum((e) => sent(e) || (e.type === 'PACK' && e.qty < 0)),
      damaged: sum((e) => e.qty > 0 && e.bucket === 'DAMAGED'),
      rejected: sum((e) => e.qty > 0 && e.bucket === 'REJECTED'),
      rework: sum((e) => e.qty > 0 && e.bucket === 'REWORK'),
    }
    const change = list.filter((e) => !TERMINAL.includes(e.bucket)).reduce((s, e) => s + e.qty, 0)
    const bal = (balance.get(e0.bundleId) ?? 0) + change
    balance.set(e0.bundleId, bal)
    if (!row.in && !row.processed && !row.out && !row.damaged && !row.rejected && !row.rework) continue
    const b = bundleOf.get(e0.bundleId)
    rows.push({
      key,
      eventId: e0.eventId,
      date: e0.date,
      bundleId: e0.bundleId,
      bundle: b?.code ?? '',
      bundleNo: b?.bundleNo ?? 0,
      size: b?.size?.code ?? null,
      sizeId: e0.sizeId,
      ...row,
      balance: bal,
      sign: e0.person ?? e0.by,
      document: e0.document,
      type: e0.type,
    })
  }
  return rows
}

const UNDOABLE = ['PROCESS', 'DECIDE', 'REWORK_DONE', 'VENDOR_RETURN', 'SETTLE']
const EVENT_LABEL: Record<string, string> = {
  RECEIVE: 'Counted in',
  EXCESS: 'Counted over',
  SETTLE: 'Short settled',
  PROCESS: 'Work recorded',
  DECIDE: 'Decision',
  REWORK_DONE: 'Rework put right',
  VENDOR_RETURN: 'Back from unit',
  DISPATCH: 'Transferred',
  PACK: 'Into finished goods',
}

export function StageSheet({ d, step, onChanged }: { d: JobCardDetail; step: FlowStep; onChanged: (message: string) => void }) {
  const [open, setOpen] = useState<Open | null>(null)
  const [sizeId, setSizeId] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const live = !['DRAFT', 'CLOSED'].includes(d.mo.status)
  const workable = live && !d.mo.held
  const mayCreate = can('production', 'create') && workable
  const mayEdit = can('production', 'edit') && workable
  const check = isCheck(step)
  const outside = step.execution === 'OUTSOURCED'
  const fromHand = sendsFromHand(step)
  const f = step.figures
  const next = step.next ? d.steps.find((s) => s.id === step.next!.id) : null
  const sizes = d.line?.sizes ?? []
  const fig = (id: string) => d.sizeFigures[id]?.find((x) => x.stepId === step.id)

  const allRows = useMemo(() => sheetRows(d, step), [d, step])
  const rows = sizeId ? allRows.filter((r) => r.sizeId === sizeId) : allRows
  // The job card's own bundles, and the pieces tagged out of them.
  const cardBundles = useMemo(() => {
    const live = d.bundles.filter((b) => !b.cancelled)
    const own = d.line ? live.filter((b) => b.line?.id === d.line!.id) : live
    return (own.length ? own : live).sort((a, b) => (a.size?.sequence ?? 0) - (b.size?.sequence ?? 0) || a.bundleNo - b.bundleNo)
  }, [d.bundles, d.line])
  const shownBundles = sizeId ? cardBundles.filter((b) => b.size?.id === sizeId) : cardBundles
  const [pieces, setPieces] = useState<SheetPiece[]>([])
  const [pieceCode, setPieceCode] = useState<string | null>(null)
  const [tab, setTab] = useState<'bundles' | 'pieces' | 'log' | 'unit' | 'sent'>('bundles')
  const bundleIds = cardBundles.map((b) => b.id).join(',')
  useEffect(() => {
    if (!bundleIds) return setPieces([])
    let live = true
    api
      .get<{ data: SheetPiece[] }>(`/garments?bundles=${bundleIds}&limit=1000`)
      .then((r) => live && setPieces(r.data))
      .catch(() => live && setPieces([]))
    return () => {
      live = false
    }
  }, [bundleIds])
  const shownPieces = sizeId ? pieces.filter((p) => cardBundles.find((b) => b.id === p.bundleId)?.size?.id === sizeId) : pieces
  const tot = (k: keyof Pick<SheetRow, 'in' | 'processed' | 'out' | 'damaged' | 'rejected' | 'rework'>) => rows.reduce((s, r) => s + r[k], 0)

  const incoming = d.transfers.filter((t) => t.toStep.id === step.id && !t.vendor && (t.status === 'DISPATCHED' || t.status === 'PARTLY_RECEIVED'))
  const short = d.transfers.filter((t) => t.toStep.id === step.id && t.status === 'DISCREPANCY')
  const outgoing = d.transfers.filter((t) => t.fromStep.id === step.id && t.status !== 'CANCELLED' && !t.isRework)
  const jwos = d.jobWorkOrders.filter((j) => j.step.id === step.id)
  const toDecide = (f?.damagedNow ?? 0) + (f?.rejectedNow ?? 0)
  const canSend = (f?.waiting ?? 0) + (fromHand ? f?.inHand ?? 0 : 0) > 0

  const post = async (path: string, body: unknown, fallback: string) => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<{ message?: string }>(path, body)
      setOpen(null)
      onChanged(res.message ?? fallback)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that.')
      setOpen(null)
    } finally {
      setBusy(false)
    }
  }
  const done = (message: string) => {
    setOpen(null)
    onChanged(message)
  }

  // What waits here, each with the button that does it.
  const nextName = next ? `${next.name}${next.execution === 'OUTSOURCED' ? ' (outside unit)' : ''}` : ''
  const ready = (f?.waiting ?? 0) + (fromHand ? f?.inHand ?? 0 : 0)
  const steps: NextStep[] = []
  for (const t of incoming) {
    const sent = t.lines.reduce((x, l) => x + l.dispatchedQty, 0)
    const got = t.lines.reduce((x, l) => x + l.receivedQty, 0)
    steps.push({
      key: t.id,
      text: (
        <>
          Count in <span className="font-mono text-xs">{t.transferNumber}</span> from {t.fromStep.name}: {pcs(sent)} pcs in {t.lines.length} {t.lines.length === 1 ? 'bundle' : 'bundles'}
          {got ? `, ${pcs(got)} counted so far` : ''}
          <span className="text-muted-foreground"> — sent {formatDate(t.dispatchDate)}{t.issuedBy ? ` by ${t.issuedBy}` : ''}</span>
        </>
      ),
      actions: [
        ...(mayCreate ? [{ label: 'Count in', icon: ClipboardCheck, primary: true, onClick: () => setOpen({ kind: 'count', transfer: t }) }] : []),
        { label: 'Print', icon: Printer, onClick: () => openWindow(`/print/transfer/${t.id}`) },
      ],
    })
  }
  for (const t of short) {
    steps.push({
      key: t.id,
      tone: 'warn',
      text: `${t.transferNumber} came in short by ${pcs(t.lines.reduce((x, l) => x + l.shortQty - l.settledQty, 0))} pcs — say where they went`,
      actions: mayEdit ? [{ label: 'Settle short', icon: Scale, onClick: () => setOpen({ kind: 'settle', transfer: t }) }] : [],
    })
  }
  for (const j of jwos.filter((x) => x.status === 'OPEN' && x.held > 0)) {
    steps.push({
      key: j.id,
      tone: 'info',
      text: `${pcs(j.held)} pcs with ${j.vendor.name} — record what comes back`,
      actions: mayCreate ? [{ label: 'Back from them', icon: PackageOpen, primary: true, onClick: () => setOpen({ kind: 'return', jwoId: j.id }) }] : [],
    })
  }
  if (!outside && (f?.inHand ?? 0) > 0) {
    steps.push({
      key: 'hand',
      text: check ? `${pcs(f!.inHand)} pcs here to check` : `${pcs(f!.inHand)} pcs here — when worked, transfer them to ${nextName || 'finished goods'}; note any damaged`,
      actions: mayCreate
        ? check
          ? [{ label: 'Record the check', icon: ClipboardList, primary: true, onClick: () => setOpen({ kind: 'work' }) }]
          : [
              ...(next ? [{ label: `Transfer to ${next.name}`, icon: next.execution === 'OUTSOURCED' ? Truck : Send, primary: true, onClick: () => setOpen({ kind: 'send' }) }] : []),
              { label: 'Record work / damaged', icon: Hammer, onClick: () => setOpen({ kind: 'work' }) },
            ]
        : [],
    })
  }
  if ((f?.waiting ?? 0) > 0) {
    steps.push({
      key: 'ready',
      text: `${pcs(f!.waiting)} pcs ${check ? 'passed' : 'done'} and ready ${step.last ? 'to go into finished goods' : `to transfer to ${nextName}`}`,
      actions: step.last
        ? [{ label: 'Into finished goods', icon: PackageCheck, primary: true, onClick: () => window.location.assign(`/inventory/finished-goods?mo=${d.mo.id}`) }]
        : mayCreate && next
          ? [{ label: `Transfer to ${next.name}`, icon: next.execution === 'OUTSOURCED' ? Truck : Send, primary: true, onClick: () => setOpen({ kind: 'send' }) }]
          : [],
    })
  }
  if (step.last && fromHand && (f?.inHand ?? 0) > 0) {
    steps.push({ key: 'pack', text: 'Packed pieces go into finished goods straight from here.', tone: 'info', actions: [{ label: 'Into finished goods', icon: PackageCheck, onClick: () => window.location.assign(`/inventory/finished-goods?mo=${d.mo.id}`) }] })
  }
  if (toDecide > 0) {
    steps.push({
      key: 'decide',
      tone: 'warn',
      text: `${pcs(toDecide)} pcs ${check ? 'failed or damaged' : 'damaged'} — decide: rework, B-grade or write off${jwos.some((j) => j.status === 'OPEN') ? ', or send back to the unit' : ''}`,
      actions: [
        ...(mayEdit ? [{ label: 'Decide', icon: Gavel, onClick: () => setOpen({ kind: 'decide' }) }] : []),
        ...(mayCreate && jwos.some((j) => j.status === 'OPEN') ? [{ label: 'Back to the unit', icon: Undo2, onClick: () => setOpen({ kind: 'sendBack', jwoId: jwos.find((j) => j.status === 'OPEN')!.id }) }] : []),
      ],
    })
  }
  if ((f?.inRework ?? 0) > 0) {
    steps.push({
      key: 'rework',
      tone: 'warn',
      text: `${pcs(f!.inRework)} pcs in rework — mark them when put right`,
      actions: mayCreate ? [{ label: 'Rework done', icon: Wrench, onClick: () => setOpen({ kind: 'rework' }) }] : [],
    })
  }
  const before = d.steps.filter((x) => x.next?.id === step.id).map((x) => x.name)
  const idle =
    f?.state === 'DONE'
      ? `All done at ${step.name} for this job card.`
      : (f?.inTransit ?? 0) > 0
        ? `${pcs(f!.inTransit)} pcs are on their way here.`
        : `Nothing waiting here. Pieces arrive when ${before.join(' / ') || 'the stage before'} transfers them${outside ? ' to the unit' : ''}.`

  return (
    <>
      {error && (
        <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
          <AlertTriangle size={16} className="text-destructive mt-0.5 shrink-0" />
          <p className="text-destructive text-sm">{error}</p>
        </div>
      )}
      <SheetHeader d={d} step={step} />

      <NextSteps items={steps} idle={idle} />

      <Section icon={ClipboardCheck} title="Size details">
        <SizeTable
          d={d}
          rows={[
            { label: 'Order', of: (id) => sizes.find((z) => z.id === id)?.qty ?? 0, tone: 'muted' },
            { label: outside ? 'Sent to unit' : 'Received (in)', of: (id) => fig(id)?.received ?? 0 },
            { label: check ? 'Passed' : 'Processed', of: (id) => fig(id)?.completed ?? 0, tone: 'primary' },
            { label: step.last ? 'Into finished goods' : `Out to ${next?.name ?? 'next'}`, of: (id) => (step.last ? fig(id)?.packed ?? 0 : fig(id)?.sentOn ?? 0) },
            { label: check ? 'Failed / damaged' : 'Damaged', of: (id) => (fig(id)?.damaged ?? 0) + (fig(id)?.rejected ?? 0), tone: 'warn' },
            { label: outside ? 'With the unit' : 'In hand (balance)', of: (id) => (outside ? fig(id)?.atVendor ?? 0 : (fig(id)?.inHand ?? 0) + (fig(id)?.waiting ?? 0)) },
            { label: 'On the way here', of: (id) => fig(id)?.inTransit ?? 0, tone: 'muted' },
          ]}
        />
        {f && (f.inRework > 0 || f.short > 0 || f.bGradeNow > 0 || f.scrapped > 0) && (
          <p className="text-muted-foreground mt-2 text-xs">
            {[f.inRework ? `${pcs(f.inRework)} in rework` : '', f.short ? `${pcs(f.short)} short on a transfer` : '', f.bGradeNow ? `${pcs(f.bGradeNow)} B-grade` : '', f.scrapped ? `${pcs(f.scrapped)} written off` : '']
              .filter(Boolean)
              .join(' · ')}
          </p>
        )}
      </Section>

      {/* Below the sizes, one thing at a time: the bundles, the pieces, the day-by-day entries. */}
      <div className="glass-card overflow-hidden p-0">
        <div className="border-border flex flex-wrap items-center gap-1 border-b px-2 pt-2">
          {(
            [
              ['bundles', `Bundles (${shownBundles.length})`],
              ['pieces', `Pieces (${shownPieces.length})`],
              ['log', `Day by day (${rows.length})`],
              ...(jwos.length ? [['unit', 'Outside unit']] : []),
              ...(outgoing.length ? [['sent', `Transferred from here (${outgoing.length})`]] : []),
            ] as Array<[typeof tab, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`rounded-t-lg px-3 py-2 text-sm font-semibold ${tab === key ? 'bg-card text-primary border-border border border-b-transparent' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {label}
            </button>
          ))}
          {sizes.length > 1 && (tab === 'bundles' || tab === 'pieces' || tab === 'log') && (
            <div className="ml-auto flex flex-wrap items-center gap-1 pb-1">
              <button type="button" className={`h-7 rounded-md px-2 text-xs ${!sizeId ? 'bg-primary/10 text-primary font-semibold' : 'btn-ghost'}`} onClick={() => setSizeId('')}>
                All sizes
              </button>
              {sizes.map((z) => (
                <button key={z.id} type="button" className={`h-7 rounded-md px-2 text-xs ${sizeId === z.id ? 'bg-primary/10 text-primary font-semibold' : 'btn-ghost'}`} onClick={() => setSizeId(z.id)}>
                  {z.code}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="p-3">
          {tab === 'bundles' && (
            <BundleTable
              bundles={shownBundles}
              rows={allRows}
              step={step}
              pieces={pieces}
              canUndo={(r) => mayEdit && UNDOABLE.includes(r.type)}
              onUndo={(r) => setOpen({ kind: 'undo', eventId: r.eventId, label: `${EVENT_LABEL[r.type] ?? 'Entry'} of ${formatDate(r.date)}` })}
              onPiece={(code) => {
                setPieceCode(code)
                setTab('pieces')
              }}
            />
          )}
          {tab === 'pieces' && <PieceList pieces={shownPieces} code={pieceCode} onCode={setPieceCode} />}
          {tab === 'log' && (
            <>
        {!rows.length ? (
          <p className="text-muted-foreground text-sm">Nothing has reached {step.name} yet{sizeId ? ' in this size' : ''}.</p>
        ) : (
          <div className="border-border max-h-[60vh] overflow-auto rounded-lg border">
            <table className="data-table w-full min-w-[820px]">
              <thead className="sticky top-0 z-10 [&_th]:bg-secondary">
                <tr className="bg-secondary">
                  <th>Date</th>
                  <th>Bundle no.</th>
                  <th>Size</th>
                  <th style={{ textAlign: 'right' }}>In</th>
                  <th style={{ textAlign: 'right' }}>{check ? 'Passed' : 'Processed'}</th>
                  <th style={{ textAlign: 'right' }}>Out</th>
                  <th style={{ textAlign: 'right' }} className="warn-text">
                    {check ? 'Failed / damaged' : 'Damaged'}
                  </th>
                  <th style={{ textAlign: 'right' }}>Balance</th>
                  <th>Sign</th>
                  <th>Document</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td className="whitespace-nowrap text-xs">{formatDate(r.date)}</td>
                    <td className="font-mono text-xs">{r.bundle}</td>
                    <td className="text-xs">{r.size ?? '—'}</td>
                    <td className="text-right text-xs tabular-nums">{r.in ? pcs(r.in) : ''}</td>
                    <td className="text-right text-xs tabular-nums">{r.processed ? pcs(r.processed) : ''}</td>
                    <td className="text-right text-xs tabular-nums">{r.out ? pcs(r.out) : ''}</td>
                    <td className="warn-text text-right text-xs tabular-nums">{r.damaged + r.rejected ? pcs(r.damaged + r.rejected) : ''}{r.rework ? <span className="text-muted-foreground"> ({pcs(r.rework)} rework)</span> : null}</td>
                    <td className="text-right text-xs font-medium tabular-nums">{pcs(r.balance)}</td>
                    <td className="text-muted-foreground text-xs">{r.sign}</td>
                    <td className="text-muted-foreground font-mono text-[11px]">{r.document ?? ''}</td>
                    <td className="w-8">
                      {mayEdit && UNDOABLE.includes(r.type) && (
                        <button
                          type="button"
                          className="btn-ghost text-muted-foreground p-1"
                          title="Undo this entry"
                          aria-label="Undo"
                          onClick={() => setOpen({ kind: 'undo', eventId: r.eventId, label: `${EVENT_LABEL[r.type] ?? 'Entry'} of ${formatDate(r.date)}` })}
                        >
                          <Undo2 size={12} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="sticky bottom-0 z-10 [&_td]:bg-secondary">
                <tr className="bg-secondary">
                  <td colSpan={3} className="text-xs font-medium">
                    Total
                  </td>
                  <td className="text-right text-xs font-semibold tabular-nums">{pcs(tot('in'))}</td>
                  <td className="text-right text-xs font-semibold tabular-nums">{pcs(tot('processed'))}</td>
                  <td className="text-right text-xs font-semibold tabular-nums">{pcs(tot('out'))}</td>
                  <td className="warn-text text-right text-xs font-semibold tabular-nums">{pcs(tot('damaged') + tot('rejected'))}</td>
                  <td colSpan={4} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
            </>
          )}
          {tab === 'unit' && jwos.length > 0 && (

          <div className="space-y-2">
            {jwos.map((j) => (
              <div key={j.id} className="border-border bg-card rounded-lg border p-2.5 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p>
                      <span className="text-foreground font-medium">{j.vendor.name}</span>{' '}
                      <span className="text-muted-foreground text-xs">
                        · {j.orderNumber} at ₹{j.rate}/pc{j.expectedBy ? ` · due ${formatDate(j.expectedBy)}` : ''}
                      </span>{' '}
                      <span className={j.status === 'OPEN' ? 'badge-info' : 'badge-neutral'}>{j.status === 'OPEN' ? 'Open' : 'Closed'}</span>
                    </p>
                    <p className="text-muted-foreground mt-0.5 text-xs tabular-nums">
                      Sent {pcs(j.sent)}
                      {j.sentForRework ? ` (+${pcs(j.sentForRework)} to put right)` : ''} · accepted {pcs(j.accepted)}
                      {j.rejected ? ` · failed ${pcs(j.rejected)}` : ''}
                      {j.damaged ? ` · damaged ${pcs(j.damaged)}` : ''} · <span className={j.held ? 'text-foreground font-medium' : ''}>they hold {pcs(j.held)}</span> · charged ₹
                      {j.charged.toLocaleString('en-IN')}
                    </p>
                  </div>
                  <span className="flex items-center gap-1">
                    {mayCreate && j.status === 'OPEN' && j.held > 0 && (
                      <button type="button" className="btn-primary h-7 px-2.5 text-xs" onClick={() => setOpen({ kind: 'return', jwoId: j.id })}>
                        <PackageOpen size={13} /> Back from them
                      </button>
                    )}
                    {mayCreate && j.status === 'OPEN' && toDecide > 0 && (
                      <button type="button" className="btn-ghost h-7 px-2 text-xs" onClick={() => setOpen({ kind: 'sendBack', jwoId: j.id })}>
                        <Undo2 size={13} /> Back to them to put right
                      </button>
                    )}
                    {mayEdit && j.status === 'OPEN' && j.held === 0 && (
                      <button type="button" className="btn-ghost h-7 px-2 text-xs" disabled={busy} onClick={() => void post(`/production/job-work-orders/${j.id}/close`, {}, 'Closed.')}>
                        Close
                      </button>
                    )}
                  </span>
                </div>
                {j.challans.length > 0 && (
                  <p className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 text-[11px]">
                    Challans:
                    {j.challans.map((c) => (
                      <button key={c.id} type="button" className="text-primary font-mono hover:underline" onClick={() => openWindow(`/print/transfer/${c.id}`)}>
                        {c.number}
                        {c.isRework ? ' (rework)' : ''}
                        {c.cancelled ? ' (cancelled)' : ''}
                      </button>
                    ))}
                  </p>
                )}
                {j.returns.length > 0 && (
                  <div className="mt-1 space-y-0.5">
                    {j.returns.map((r) => (
                      <div key={r.eventId} className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span>
                          {formatDate(r.date)} back{r.theirChallanNo ? ` on their challan ${r.theirChallanNo}` : ''}: {pcs(r.accepted)} accepted
                          {r.rejected ? `, ${pcs(r.rejected)} failed` : ''}
                          {r.damaged ? `, ${pcs(r.damaged)} damaged` : ''} · ₹{r.amount.toLocaleString('en-IN')}
                          {r.billNo ? ` · bill ${r.billNo}` : ''}
                        </span>
                        {can('production', 'edit') && (
                          <button type="button" className="btn-ghost h-6 px-2 text-xs" onClick={() => setOpen({ kind: 'bill', vendor: j.vendor.name, ret: r })}>
                            <Receipt size={12} /> {r.billNo ? 'Bill' : 'Note their bill'}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          )}
          {tab === 'sent' && outgoing.length > 0 && (

          <div className="divide-border divide-y text-sm">
            {outgoing.map((t) => {
              const st = transferStatus(t)
              const sent = t.lines.reduce((s, l) => s + l.dispatchedQty, 0)
              return (
                <div key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                  <span className="min-w-0">
                    <span className="font-mono text-xs">{t.transferNumber}</span> <span className={st.cls}>{st.label}</span>
                    <span className="text-muted-foreground block text-xs">
                      {formatDate(t.dispatchDate)} to {t.vendor ? `${t.vendor.name} for ${t.toStep.name}` : t.toStep.name} · {pcs(sent)} pcs
                      {t.issuedBy ? ` · issued by ${t.issuedBy}` : ''}
                      {t.receivedBy ? ` · received by ${t.receivedBy}` : ''}
                    </span>
                  </span>
                  <span className="flex items-center gap-1">
                    <button type="button" className="btn-ghost p-1" title="Print" aria-label={`Print ${t.transferNumber}`} onClick={() => openWindow(`/print/transfer/${t.id}`)}>
                      <Printer size={13} />
                    </button>
                    {mayEdit && t.status === 'DISPATCHED' && !t.lines.some((l) => l.receivedQty > 0) && (
                      <button type="button" className="btn-ghost text-muted-foreground hover:text-destructive p-1" aria-label={`Cancel ${t.transferNumber}`} onClick={() => setOpen({ kind: 'cancelTransfer', transfer: t })}>
                        <Ban size={13} />
                      </button>
                    )}
                  </span>
                </div>
              )
            })}
          </div>
          )}
        </div>
      </div>

      {open?.kind === 'count' && <CountInDialog transfer={open.transfer} moNumber={d.mo.moNumber} onClose={() => setOpen(null)} onSaved={done} />}
      {open?.kind === 'settle' && <SettleDialog transfer={open.transfer} onClose={() => setOpen(null)} onSaved={done} />}
      {open?.kind === 'work' && <WorkDialog flow={d} stepId={step.id} onClose={() => setOpen(null)} onSaved={done} />}
      {open?.kind === 'send' && (
        <SendOnDialog
          flow={d}
          fromStepId={step.id}
          onClose={() => setOpen(null)}
          onSaved={(m, transferId) => {
            done(m)
            openWindow(`/print/transfer/${transferId}`)
          }}
        />
      )}
      {open?.kind === 'decide' && <DecideDialog flow={d} stepId={step.id} onClose={() => setOpen(null)} onSaved={done} />}
      {open?.kind === 'rework' && <ReworkDoneDialog flow={d} stepId={step.id} onClose={() => setOpen(null)} onSaved={done} />}
      {open?.kind === 'return' && <VendorReturnDialog flow={d} jobWorkOrderId={open.jwoId} onClose={() => setOpen(null)} onSaved={done} />}
      {open?.kind === 'sendBack' && (
        <SendBackDialog
          flow={d}
          jobWorkOrderId={open.jwoId}
          onClose={() => setOpen(null)}
          onSaved={(m, transferId) => {
            done(m)
            openWindow(`/print/transfer/${transferId}`)
          }}
        />
      )}
      {open?.kind === 'bill' && <ReturnBillDialog vendor={open.vendor} ret={open.ret} onClose={() => setOpen(null)} onSaved={done} />}
      {open?.kind === 'undo' && (
        <ReasonDialog
          title={`Undo: ${open.label}?`}
          description="The pieces go back to where they were before it. Refused if they have moved on since."
          confirmLabel="Undo it"
          danger
          busy={busy}
          onCancel={() => setOpen(null)}
          onConfirm={(reason) => void post(`/production/events/${open.eventId}/undo`, { reason }, 'Undone.')}
        />
      )}
      {open?.kind === 'cancelTransfer' && (
        <ReasonDialog
          title={`Cancel ${open.transfer.transferNumber}?`}
          description="Nobody has counted it in, so the pieces come back here."
          confirmLabel="Cancel the transfer"
          danger
          busy={busy}
          onCancel={() => setOpen(null)}
          onConfirm={(reason) => void post(`/production/transfers/${open.transfer.id}/cancel`, { reason }, 'Cancelled.')}
        />
      )}
    </>
  )
}
