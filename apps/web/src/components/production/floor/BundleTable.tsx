'use client'

import { Fragment, useState } from 'react'
import { ChevronDown, ChevronRight, Undo2 } from 'lucide-react'
import { formatDate } from '@/lib/utils'
import { pcs, type FlowBundle, type FlowStep } from './types'
import type { SheetRow } from './StageSheet'

/** A tagged piece, as the sheet lists it. */
export interface SheetPiece {
  id: string
  code: string
  status: string
  grade: string
  printCount: number
  bundleId: string | null
  size: { code: string } | null
  bundle: { code: string } | null
  warehouse?: { name: string } | null
}

const STATUS = (s: string) =>
  ({
    'Not here yet': 'badge-neutral',
    'On the way here': 'badge-info',
    'At the unit': 'badge-info',
    'In hand': 'badge-warning',
    'In rework': 'badge-warning',
    'To decide': 'badge-danger',
    'Done, ready to send': 'badge-info',
    'Ready for finished goods': 'badge-info',
    Done: 'badge-success',
  })[s] ?? 'badge-neutral'

/** What one entry did, in a few words: "Counted in 10", "Into finished goods 10". */
const said = (r: SheetRow, check: boolean, last: boolean) =>
  [
    r.in ? `In ${pcs(r.in)}` : '',
    r.processed ? `${check ? 'Passed' : 'Processed'} ${pcs(r.processed)}` : '',
    r.out ? `${last ? 'Into finished goods' : 'Out'} ${pcs(r.out)}` : '',
    r.damaged + r.rejected ? `${check ? 'Failed / damaged' : 'Damaged'} ${pcs(r.damaged + r.rejected)}` : '',
    r.rework ? `Rework ${pcs(r.rework)}` : '',
  ]
    .filter(Boolean)
    .join(' · ')

/**
 * The stage, one line per bundle: how many pieces it has, what came in, what
 * was done, what went on, what is here now and where it stands. A line opens
 * to that bundle's entries here — each one undoable where the floor allows —
 * and its pieces, each one opening its own history.
 */
export function BundleTable({
  bundles,
  rows,
  step,
  pieces,
  canUndo,
  onUndo,
  onPiece,
}: {
  bundles: FlowBundle[]
  rows: SheetRow[]
  step: FlowStep
  pieces: SheetPiece[]
  canUndo: (r: SheetRow) => boolean
  onUndo: (r: SheetRow) => void
  onPiece: (code: string) => void
}) {
  const [open, setOpen] = useState<string | null>(null)
  const check = step.isQcStep || step.kind === 'QC'
  const last = Boolean(step.last)
  const piecesOf = (bundleId: string) => pieces.filter((p) => p.bundleId === bundleId)

  const lines = bundles.map((b) => {
    const mine = rows.filter((r) => r.bundleId === b.id)
    const at = (bucket: string, vendor?: boolean) =>
      b.places.filter((p) => p.stepId === step.id && p.bucket === bucket && (vendor === undefined || (vendor ? !!p.vendorId : !p.vendorId))).reduce((s, p) => s + p.qty, 0)
    const transit = at('TRANSIT')
    const unit = at('WIP', true) + at('REWORK', true)
    const hand = at('WIP', false)
    const rework = at('REWORK', false)
    const damaged = at('DAMAGED') + at('REJECTED')
    const waiting = at('DONE')
    const status = !mine.length && !transit
      ? 'Not here yet'
      : transit
        ? 'On the way here'
        : unit
          ? 'At the unit'
          : hand
            ? 'In hand'
            : rework
              ? 'In rework'
              : damaged
                ? 'To decide'
                : waiting
                  ? last
                    ? 'Ready for finished goods'
                    : 'Done, ready to send'
                  : 'Done'
    const sum = (k: 'in' | 'processed' | 'out' | 'damaged' | 'rejected' | 'rework') => mine.reduce((s, r) => s + r[k], 0)
    const latest = mine[mine.length - 1]
    return {
      b,
      mine,
      status,
      in: sum('in'),
      processed: sum('processed'),
      out: sum('out'),
      damaged: sum('damaged') + sum('rejected'),
      reworked: sum('rework'),
      here: hand + unit + waiting + rework + damaged,
      latest,
    }
  })

  if (!lines.length) return <p className="text-muted-foreground p-4 text-sm">No bundles cut for this job card yet.</p>

  return (
    <div className="border-border max-h-[60vh] overflow-auto rounded-lg border">
      <table className="data-table w-full min-w-[900px]">
        <thead className="sticky top-0 z-10 [&_th]:bg-secondary">
          <tr>
            <th style={{ width: 28 }} />
            <th>Bundle</th>
            <th>Size</th>
            <th style={{ textAlign: 'right' }}>Pieces</th>
            <th style={{ textAlign: 'right' }}>In</th>
            <th style={{ textAlign: 'right' }}>{check ? 'Passed' : 'Processed'}</th>
            <th style={{ textAlign: 'right' }}>{last ? 'Into finished goods' : 'Sent on'}</th>
            <th style={{ textAlign: 'right' }} className="warn-text">
              {check ? 'Failed / damaged' : 'Damaged'}
            </th>
            <th style={{ textAlign: 'right' }}>Here now</th>
            <th>Status</th>
            <th>Last entry</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const expanded = open === l.b.id
            const tags = piecesOf(l.b.id)
            return (
              <Fragment key={l.b.id}>
                <tr className={l.status === 'Not here yet' ? 'opacity-60' : ''}>
                  <td>
                    <button
                      type="button"
                      className="btn-ghost p-1"
                      onClick={() => setOpen(expanded ? null : l.b.id)}
                      aria-expanded={expanded}
                      aria-label={`${expanded ? 'Hide' : 'Show'} ${l.b.code}`}
                    >
                      {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                  </td>
                  <td className="whitespace-nowrap font-mono text-xs">{l.b.code}</td>
                  <td className="text-sm font-semibold">{l.b.size?.code ?? '—'}</td>
                  <td className="text-right tabular-nums">{pcs(l.b.qty)}</td>
                  <td className="text-right tabular-nums">{l.in ? pcs(l.in) : <span className="text-muted-foreground">—</span>}</td>
                  <td className="text-right tabular-nums">{l.processed ? pcs(l.processed) : <span className="text-muted-foreground">—</span>}</td>
                  <td className="text-right tabular-nums">{l.out ? pcs(l.out) : <span className="text-muted-foreground">—</span>}</td>
                  <td className="warn-text text-right tabular-nums">
                    {l.damaged ? pcs(l.damaged) : <span className="text-muted-foreground">—</span>}
                    {l.reworked ? <span className="text-muted-foreground text-xs"> ({pcs(l.reworked)} rework)</span> : null}
                  </td>
                  <td className="text-right font-semibold tabular-nums">{pcs(l.here)}</td>
                  <td className="whitespace-nowrap">
                    <span className={STATUS(l.status)}>{l.status}</span>
                  </td>
                  <td className="text-muted-foreground whitespace-nowrap text-xs">{l.latest ? `${formatDate(l.latest.date)} · ${l.latest.sign}` : '—'}</td>
                </tr>
                {expanded && (
                  <tr>
                    <td colSpan={11} className="bg-secondary/40 !p-3">
                      <div className="grid gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                        <div className="border-border bg-card overflow-hidden rounded-lg border">
                          <p className="border-border text-foreground border-b px-3 py-1.5 text-xs font-semibold">
                            Entries at {step.name} for {l.b.code}
                          </p>
                          {!l.mine.length ? (
                            <p className="text-muted-foreground px-3 py-2 text-xs">Nothing recorded here for this bundle yet.</p>
                          ) : (
                            <table className="subtable w-full">
                              <thead>
                                <tr>
                                  <th>Date</th>
                                  <th>What</th>
                                  <th>Sign</th>
                                  <th>Document</th>
                                  <th />
                                </tr>
                              </thead>
                              <tbody>
                                {l.mine.map((r) => (
                                  <tr key={r.key}>
                                    <td className="whitespace-nowrap text-xs">{formatDate(r.date)}</td>
                                    <td className="text-xs">{said(r, check, last)}</td>
                                    <td className="text-muted-foreground text-xs">{r.sign}</td>
                                    <td className="text-muted-foreground font-mono text-[11px]">{r.document ?? ''}</td>
                                    <td className="w-8">
                                      {canUndo(r) && (
                                        <button type="button" className="btn-ghost text-muted-foreground p-1" title="Undo this entry" aria-label="Undo" onClick={() => onUndo(r)}>
                                          <Undo2 size={12} />
                                        </button>
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                        <div className="border-border bg-card overflow-hidden rounded-lg border">
                          <p className="border-border text-foreground border-b px-3 py-1.5 text-xs font-semibold">Its pieces</p>
                          {tags.length ? (
                            <div className="flex flex-wrap gap-1.5 p-2">
                              {tags.map((p) => (
                                <button
                                  key={p.id}
                                  type="button"
                                  onClick={() => onPiece(p.code)}
                                  className="border-border hover:border-primary hover:text-primary rounded border px-1.5 py-0.5 font-mono text-[11px] text-foreground"
                                  title={`${p.code}: see its history`}
                                >
                                  {p.code}
                                </button>
                              ))}
                            </div>
                          ) : (
                            <p className="text-muted-foreground px-3 py-2 text-xs">
                              Each piece gets its own tag when it goes into finished goods. Until then the {pcs(l.b.qty)} pieces are tracked as this bundle.
                            </p>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
