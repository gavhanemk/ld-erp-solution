'use client'

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, BookPlus, Info, Loader2, Save, X } from 'lucide-react'
import { api, apiErrorMessage } from '@/lib/api'
import { useEscape } from '@/lib/useEscape'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { NATURE_LABEL, r2, type Group, type Ledger } from './books'

/**
 * A ledger made or changed by hand: its group, its opening balance on the
 * day the books start, and whether its bills are kept one by one.
 *
 * A party's ledger is named after its customer, supplier, broker or bank and
 * switched on and off with it, so those two are shown but not offered here.
 */
export function LedgerDialog({
  ledger,
  groups,
  booksStart,
  onClose,
  onSaved,
}: {
  /** The ledger to change, or null for a new one; undefined keeps the window shut. */
  ledger: Ledger | null | undefined
  groups: Group[]
  booksStart: string | null
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const open = ledger !== undefined
  const [name, setName] = useState('')
  const [groupId, setGroupId] = useState('')
  const [opening, setOpening] = useState('')
  const [side, setSide] = useState<'DR' | 'CR'>('DR')
  const [billWise, setBillWise] = useState(false)
  const [pan, setPan] = useState('')
  const [gstin, setGstin] = useState('')
  const [notes, setNotes] = useState('')
  const [isActive, setIsActive] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  useEscape(() => {
    if (!saving) onClose()
  }, open)

  useEffect(() => {
    if (!open) return
    setError(null)
    setName(ledger?.name ?? '')
    setGroupId(ledger?.groupId ?? '')
    const ob = ledger?.openingBalance ?? 0
    setOpening(ob ? String(Math.abs(ob)) : '')
    setSide(ob < 0 ? 'CR' : 'DR')
    setBillWise(ledger?.billWise ?? false)
    setPan(ledger?.pan ?? '')
    setGstin(ledger?.gstin ?? '')
    setNotes(ledger?.notes ?? '')
    setIsActive(ledger?.isActive ?? true)
  }, [open, ledger])

  const party = !!ledger?.partyType
  const group = groups.find((g) => g.id === groupId)
  // A ledger that stands for a party or that the posting rules use keeps its nature.
  const fixedNature = ledger && (ledger.partyType || ledger.systemKey) ? ledger.nature : null
  const groupOptions = useMemo(() => {
    const byParent = new Map<string | null, Group[]>()
    for (const g of groups) byParent.set(g.parentId, [...(byParent.get(g.parentId) ?? []), g])
    const out: Array<{ g: Group; depth: number }> = []
    const walk = (parent: string | null, depth: number) => {
      for (const g of (byParent.get(parent) ?? []).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))) {
        out.push({ g, depth })
        walk(g.id, depth + 1)
      }
    }
    walk(null, 0)
    return out.filter((o) => !fixedNature || o.g.nature === fixedNature)
  }, [groups, fixedNature])

  if (!open || !mounted) return null

  const save = async () => {
    if (!party && name.trim().length < 2) return setError('Give the ledger a name')
    if (!groupId) return setError('Say which group it belongs to')
    setSaving(true)
    setError(null)
    const amount = r2(Number(opening) || 0)
    const body: Record<string, unknown> = {
      groupId,
      openingBalance: side === 'CR' ? -amount : amount,
      billWise,
      pan: pan.trim() || null,
      gstin: gstin.trim() || null,
      notes: notes.trim() || null,
    }
    if (!party) {
      body.name = name.trim()
      body.isActive = isActive
    }
    try {
      if (ledger) await api.patch(`/accounts/ledgers/${ledger.id}`, body)
      else await api.post('/accounts/ledgers', body)
      onSaved(ledger ? `${party ? ledger.name : name.trim()} saved` : `Ledger ${name.trim()} made`)
      onClose()
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save the ledger.'))
    } finally {
      setSaving(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="glass-card flex max-h-full w-full max-w-xl flex-col overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="led-title" onClick={(e) => e.stopPropagation()}>
        <div className="border-border flex items-center justify-between gap-3 border-b px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="bg-primary/10 border-primary/20 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border">
              <BookPlus size={17} className="text-primary" />
            </div>
            <h2 id="led-title" className="text-foreground truncate text-lg font-semibold">
              {ledger ? ledger.name : 'New ledger'}
            </h2>
          </div>
          <button onClick={onClose} className="btn-ghost p-2" aria-label="Close" disabled={saving}>
            <X size={18} />
          </button>
        </div>
        <div className="space-y-3 overflow-y-auto px-5 py-4">
          {error && (
            <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
              <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
              <p className="text-destructive text-sm">{error}</p>
            </div>
          )}
          {party && (
            <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
              <Info size={13} className="mt-px shrink-0" />
              This is the ledger of {ledger?.partyLabel?.toLowerCase()} {ledger?.partyCode ?? ledger?.name}. Its name and whether it is in use follow that record; rename or switch it off there.
            </p>
          )}
          {ledger?.systemKey && (
            <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
              <Info size={13} className="mt-px shrink-0" />
              The automatic postings use this ledger. It can be renamed and moved to another {NATURE_LABEL[ledger.nature].toLowerCase()} group, but not switched off.
            </p>
          )}
          <div>
            <label className="form-label" htmlFor="led-name">
              Name<span className="text-destructive ml-0.5">*</span>
            </label>
            <input id="led-name" className="form-input" maxLength={80} value={name} disabled={party} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="form-label" htmlFor="led-group">
              Under group<span className="text-destructive ml-0.5">*</span>
            </label>
            <SmartSelect id="led-group" className="form-input" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              <option value="">Choose a group</option>
              {groupOptions.map(({ g, depth }) => (
                <option key={g.id} value={g.id} data-sub={NATURE_LABEL[g.nature]}>
                  {`${'— '.repeat(depth)}${g.name}`}
                </option>
              ))}
            </SmartSelect>
            {group && <p className="text-muted-foreground mt-1 text-[11px]">{group.nature === 'INCOME' || group.nature === 'EXPENSE' ? 'Shows in profit and loss' : 'Shows on the balance sheet'}</p>}
          </div>
          <div>
            <label className="form-label" htmlFor="led-opening">
              Opening balance{booksStart ? ` on ${booksStart.split('-').reverse().join('-')}` : ''}
            </label>
            <div className="flex gap-2">
              <StepInput id="led-opening" decimals className="form-input flex-1 text-right tabular-nums" value={opening} placeholder="0.00" onValueChange={setOpening} />
              <SmartSelect className="form-input w-24" value={side} onChange={(e) => setSide(e.target.value as 'DR' | 'CR')} aria-label="Debit or credit">
                <option value="DR">Dr</option>
                <option value="CR">Cr</option>
              </SmartSelect>
            </div>
            <p className="text-muted-foreground mt-1 text-[11px]">As the old books showed it the day before the books start here.</p>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" checked={billWise} onChange={(e) => setBillWise(e.target.checked)} />
            <span>
              Keep bills one by one
              <span className="text-muted-foreground block text-xs">For a party: each payment says which bills it settles, and outstanding is listed bill by bill.</span>
            </span>
          </label>
          {!party && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="form-label" htmlFor="led-pan">
                  PAN
                </label>
                <input id="led-pan" className="form-input font-mono uppercase" maxLength={10} value={pan} onChange={(e) => setPan(e.target.value)} />
              </div>
              <div>
                <label className="form-label" htmlFor="led-gstin">
                  GSTIN
                </label>
                <input id="led-gstin" className="form-input font-mono uppercase" maxLength={15} value={gstin} onChange={(e) => setGstin(e.target.value)} />
              </div>
            </div>
          )}
          <div>
            <label className="form-label" htmlFor="led-notes">
              Notes
            </label>
            <textarea id="led-notes" className="form-input min-h-[56px]" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          {!party && ledger && !ledger.systemKey && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
              In use
            </label>
          )}
        </div>
        <div className="border-border flex justify-end gap-2 border-t px-5 py-3">
          <button className="btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn-primary" onClick={() => void save()} disabled={saving} data-hotkey="save">
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Save ledger
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
