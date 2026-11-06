'use client'

import { useEffect, useState } from 'react'
import { AlertCircle, AlertTriangle, ArrowLeft, CheckCircle2, ClipboardCheck, Info, Loader2 } from 'lucide-react'
import { api, ApiError, can, type Paginated } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { BomDetail } from './BomDetail'
import type { Bom } from './BomFormDialog'

/**
 * A draft BOM looked over before it is approved: what would stop the approval,
 * what is worth a second look, what approving changes (which BOM it replaces,
 * and that orders already made keep theirs), and the whole BOM as the list
 * shows it. Approve makes it the BOM new orders and MOs use.
 */
export function BomReviewDialog({
  bomId,
  onClose,
  onApproved,
  onEdit,
}: {
  bomId: string
  onClose: () => void
  /** After approving, with the server's word on it. */
  onApproved: (message: string) => void
  /** Back to the BOM's own window, to change something first. */
  onEdit?: () => void
}) {
  const [bom, setBom] = useState<Bom | null>(null)
  /** The BOM approved for this style and colour now, which approving retires. */
  const [inUse, setInUse] = useState<Bom | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const canApprove = can('masters', 'approve')

  useEffect(() => {
    let off = false
    api
      .get<{ data: Bom }>(`/masters/bom/${bomId}`)
      .then(async (r) => {
        if (off) return
        setBom(r.data)
        const q = new URLSearchParams({ styleId: r.data.styleId, status: 'APPROVED', limit: '20' })
        if (r.data.color) q.set('color', r.data.color)
        const approved = await api.get<Paginated<Bom>>(`/masters/bom?${q.toString()}`).catch(() => null)
        if (!off) setInUse(approved?.data.find((b) => b.id !== r.data.id && (b.color ?? null) === (r.data.color ?? null)) ?? null)
      })
      .catch((err) => !off && setError(err instanceof ApiError ? err.message : 'Could not open the BOM.'))
    return () => {
      off = true
    }
  }, [bomId])

  // What the server would refuse, and what is only worth a look.
  const lines = bom?.lines ?? []
  const names = (ls: typeof lines) => ls.map((l) => l.componentItem?.name ?? 'a component').join(', ')
  const blockers: string[] = []
  const warnings: string[] = []
  if (bom) {
    if (bom.status === 'APPROVED') blockers.push('It is already approved.')
    if (bom.status === 'OBSOLETE') blockers.push('It is retired. Copy it to a new version to use it again.')
    if (lines.length === 0) blockers.push('It has no components. Add what one piece uses first.')
    const rateless = lines.filter((l) => l.unitCost == null || Number(l.unitCost) === 0)
    if (rateless.length) {
      blockers.push(
        `${rateless.length} component${rateless.length === 1 ? ' has' : 's have'} no rate: ${names(rateless)}. Set a rate on the item, or type one on the line.`,
      )
    }
    const noProcess = lines.filter((l) => !l.departmentId)
    if (noProcess.length) {
      warnings.push(
        `${noProcess.length} component${noProcess.length === 1 ? ' has' : 's have'} no process: ${names(noProcess)}. The MO will not know which department asks the store for ${noProcess.length === 1 ? 'it' : 'them'}.`,
      )
    }
    if (bom.sellingPrice === null) warnings.push('No selling price yet, so sales orders and quotations will not fill a rate from it. Set it on the Pricing step.')
    if (bom.labourCost !== undefined && Number(bom.labourCost ?? 0) === 0) warnings.push('No labour entered, so its cost is materials only.')
  }

  const who = bom ? `${bom.style?.code ?? 'this style'}${bom.color ? ` in ${bom.color}` : ''}` : ''

  const approve = async () => {
    if (!bom) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.patch<{ message?: string }>(`/masters/bom/${bom.id}/approve`, {})
      onApproved(res.message ?? `${who} v${bom.version} is approved.`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not approve it. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <FormFrame
      icon={ClipboardCheck}
      title={bom ? `Review ${who} v${bom.version}` : 'Review the BOM'}
      subtitle="Check it over before it becomes the BOM new orders and MOs use."
      width="max-w-6xl"
      busy={busy}
      error={error}
      onClose={onClose}
      primary={
        <button
          type="button"
          className="btn-primary"
          onClick={() => void approve()}
          disabled={busy || !bom || blockers.length > 0 || !canApprove}
          title={!canApprove ? 'Only someone who may approve masters approves a BOM' : undefined}
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />} Approve
        </button>
      }
      footer={
        onEdit ? (
          <button type="button" className="btn-secondary" onClick={onEdit} disabled={busy}>
            <ArrowLeft size={15} /> Back to edit
          </button>
        ) : (
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Close
          </button>
        )
      }
      footerNote={
        !canApprove
          ? 'Someone who may approve masters approves it.'
          : blockers.length
            ? `Put ${blockers.length === 1 ? 'that' : 'those'} right before approving.`
            : 'Approving makes it the BOM new orders and MOs use.'
      }
    >
      {!bom && !error && <div className="skeleton h-64 w-full rounded-xl" />}
      {bom && (
        <>
          {/* What stops it, what is worth a look, or that it is ready. */}
          <div className="rounded-xl border border-border bg-card p-4">
            <p className="mb-2 text-sm font-semibold text-foreground">Before approving</p>
            <ul className="space-y-1.5 text-sm">
              {blockers.map((b) => (
                <li key={b} className="flex items-start gap-2 text-foreground">
                  <AlertCircle size={15} className="mt-0.5 shrink-0 text-red-500" /> {b}
                </li>
              ))}
              {warnings.map((w) => (
                <li key={w} className="flex items-start gap-2 text-foreground">
                  <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-500" /> {w}
                </li>
              ))}
              {blockers.length === 0 && warnings.length === 0 && (
                <li className="flex items-start gap-2 text-foreground">
                  <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-emerald-500" /> Every component has a rate and a process, and it is costed and priced.
                </li>
              )}
              <li className="flex items-start gap-2 text-muted-foreground">
                <Info size={15} className="mt-0.5 shrink-0 text-primary" />
                {inUse
                  ? `Approving it retires v${inUse.version}, the BOM ${who} uses now. Orders and MOs already made keep v${inUse.version}'s rates and materials; new ones use v${bom.version}.`
                  : `Approving it makes it the BOM for ${who}. New sales orders take its price, and new MOs its materials.`}
              </li>
            </ul>
          </div>

          <div className="rounded-xl border border-border bg-card">
            <BomDetail bom={bom} />
          </div>
        </>
      )}
    </FormFrame>
  )
}
