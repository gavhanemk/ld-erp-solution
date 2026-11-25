'use client'

import Link from 'next/link'
import { Boxes, Printer } from 'lucide-react'
import { QrCode } from '@/components/packages/QrCode'
import { openPrintTab } from '@/components/packages/packageTypes'
import { printCartons, sizesLine, STATUS_LABEL, type Carton } from './cartonTypes'

/** A carton code as typed or scanned: CT-0012, ct12, "CT 12". */
export const looksLikeCarton = (t: string) => /^CT-?\s?\d{1,8}$/i.test(t.trim())

const day = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—')

/** A scanned carton: what is in it, for whom, where it is, and its challan. */
export function CartonCard({ c }: { c: Carton }) {
  const st = STATUS_LABEL[c.status]
  return (
    <div className="glass-card overflow-hidden p-0" aria-label={`Carton ${c.code}`}>
      <div className="flex flex-col gap-4 border-b border-border p-4 sm:flex-row sm:items-start">
        <div className="mx-auto w-28 shrink-0 rounded-lg bg-white p-1.5 sm:mx-0">
          <QrCode text={c.code} />
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-lg font-bold tracking-wide text-primary">{c.code}</span>
            <span className={`badge ${st.cls}`}>{st.label}</span>
            <span className="badge badge-neutral">
              <Boxes size={12} className="mr-1 inline" /> Carton
            </span>
          </div>
          <h2 className="text-xl font-semibold leading-tight text-foreground">
            {c.pieces} pcs{c.order ? ` for ${c.order.customer ?? c.order.soNumber}` : ''}
          </h2>
          <p className="text-sm text-muted-foreground">
            {c.order ? (
              <>
                Order <span className="font-mono">{c.order.soNumber}</span>
                {c.order.poRef ? ` · PO ${c.order.poRef}` : ''} ·{' '}
              </>
            ) : (
              'For any buyer · '
            )}
            {c.store.name} · packed {day(c.createdAt)}
            {c.packedBy ? ` by ${c.packedBy}` : ''}
          </p>
          {c.challan && (
            <p className="text-sm">
              {c.status === 'DISPATCHED' ? 'Dispatched on' : 'Loaded on'}{' '}
              <Link href={`/print/delivery-challan/${c.challan.id}`} target="_blank" className="font-mono text-primary hover:underline">
                {c.challan.dcNumber}
              </Link>
              {c.dispatchedAt ? ` · ${day(c.dispatchedAt)}` : ''}
            </p>
          )}
          {c.status === 'OPENED' && (
            <p className="text-sm text-muted-foreground">
              Opened {day(c.openedAt)}
              {c.openReason ? `: ${c.openReason}` : ''}. Its pieces are loose in the store.
            </p>
          )}
        </div>
        {c.status === 'PACKED' && (
          <button type="button" className="btn-secondary shrink-0 self-start" onClick={() => printCartons([c.id], openPrintTab())}>
            <Printer size={15} /> Print sticker
          </button>
        )}
      </div>
      <div className="overflow-x-auto p-4">
        <table className="data-table table-compact min-w-full">
          <thead>
            <tr className="bg-secondary">
              <th>Style</th>
              <th>Item Code</th>
              <th>Item Name</th>
              <th>Item Description</th>
              <th>Sizes</th>
              <th style={{ textAlign: 'right' }}>Pcs</th>
            </tr>
          </thead>
          <tbody>
            {c.items.map((it) => (
              <tr key={`${it.itemId}|${it.grade}`}>
                <td className="font-mono text-sm">{it.style ?? '—'}</td>
                <td className="font-mono text-sm text-teal-400">{it.code}</td>
                <td className="text-sm">
                  {it.name}
                  {it.grade === 'B' && <span className="badge-purple ml-1.5">B-grade</span>}
                </td>
                <td className="text-sm text-muted-foreground">{it.description ?? '—'}</td>
                <td className="font-mono text-sm">{sizesLine(it.sizes)}</td>
                <td className="text-right font-semibold tabular-nums">{it.pieces}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
