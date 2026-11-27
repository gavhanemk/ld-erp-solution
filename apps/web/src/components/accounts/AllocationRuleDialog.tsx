'use client'

import { useMemo, useState } from 'react'
import { Split, X } from 'lucide-react'
import { api, apiErrorMessage } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { MultiFilter } from '@/components/ui/MultiFilter'

export interface AllocationRule {
  id: string
  name: string
  basis: string
  basisWords: string
  typed: boolean
  ledgers: Array<{ id: string; name: string }>
  departments: Array<{ id: string; name: string }>
  brands: Array<{ id: string; name: string }>
  shares: Array<{ costCentreId: string; name: string; percent: number }>
  sortOrder: number
  isActive: boolean
  notes: string | null
  usedInRuns: number
}

export interface AllocationChoices {
  brands: Array<{ id: string; name: string }>
  ledgers: Array<{ id: string; name: string; group: string }>
  departments: Array<{ id: string; name: string }>
  bases: Array<{ value: string; label: string; typed: boolean }>
}

/** What a basis means in practice, under the box. */
const BASIS_HINT: Record<string, string> = {
  REVENUE: 'Each brand’s share of the month’s sales (net of returns), from the books.',
  PRODUCTION_QTY: 'Pieces each brand’s manufacturing orders packed into finished goods that month.',
  MATERIAL_CONSUMPTION: 'Value of material issued to each brand’s manufacturing orders that month, less returns.',
  MACHINE_HOURS: 'Hours typed for each brand when the month is worked out.',
  FIXED_PERCENT: 'The same percentages every month, set here. They must make exactly 100%.',
  MANUAL: 'Percentages typed for each brand when the month is worked out. They must make exactly 100%.',
}

const round4 = (n: number) => Math.round(n * 10000) / 10000

/**
 * A rule for splitting shared expenses: which expense ledgers and
 * departments it covers, which brands share them, and on what basis.
 */
export function AllocationRuleDialog({
  rule,
  choices,
  onClose,
  onSaved,
}: {
  rule: AllocationRule | null
  choices: AllocationChoices
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const [name, setName] = useState(rule?.name ?? '')
  const [basis, setBasis] = useState(rule?.basis ?? 'REVENUE')
  const [sortOrder, setSortOrder] = useState(String(rule?.sortOrder ?? 0))
  const [ledgerIds, setLedgerIds] = useState<string[]>(rule?.ledgers.map((l) => l.id) ?? [])
  const [departmentIds, setDepartmentIds] = useState<string[]>(rule?.departments.map((d) => d.id) ?? [])
  const [brandIds, setBrandIds] = useState<string[]>(rule?.brands.map((b) => b.id) ?? [])
  const [shares, setShares] = useState<Record<string, string>>(Object.fromEntries((rule?.shares ?? []).map((s) => [s.costCentreId, String(s.percent)])))
  const [isActive, setIsActive] = useState(rule?.isActive ?? true)
  const [notes, setNotes] = useState(rule?.notes ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const ledgerName = useMemo(() => new Map(choices.ledgers.map((l) => [l.id, l.name])), [choices.ledgers])
  const deptName = useMemo(() => new Map(choices.departments.map((d) => [d.id, d.name])), [choices.departments])
  const brandName = useMemo(() => new Map(choices.brands.map((b) => [b.id, b.name])), [choices.brands])
  // A rule saved earlier may name something no longer offered; keep it visible by its old name.
  for (const l of rule?.ledgers ?? []) if (!ledgerName.has(l.id)) ledgerName.set(l.id, l.name)
  for (const d of rule?.departments ?? []) if (!deptName.has(d.id)) deptName.set(d.id, d.name)
  for (const b of rule?.brands ?? []) if (!brandName.has(b.id)) brandName.set(b.id, b.name)

  const sharing = brandIds.length ? brandIds : choices.brands.map((b) => b.id)
  const fixed = basis === 'FIXED_PERCENT'
  const total = round4(sharing.reduce((t, id) => t + (Number(shares[id]) || 0), 0))

  const problem = (() => {
    if (name.trim().length < 2) return 'Give the rule a name'
    if (!sharing.length) return 'There is no own brand to share between'
    if (fixed && total !== 100) return `The percentages make ${total}%. They must make exactly 100%`
    return null
  })()

  const save = async () => {
    if (problem) {
      setError(problem)
      return
    }
    setBusy(true)
    setError(null)
    const body = {
      name: name.trim(),
      basis,
      ledgerIds,
      departmentIds,
      costCentreIds: brandIds,
      shares: fixed ? sharing.map((id) => ({ costCentreId: id, percent: Number(shares[id]) || 0 })).filter((s) => s.percent > 0) : [],
      sortOrder: Number(sortOrder) || 0,
      isActive,
      notes: notes.trim() || null,
    }
    try {
      const res = rule
        ? await api.patch<{ message: string }>(`/accounts/allocation/rules/${rule.id}`, body)
        : await api.post<{ message: string }>('/accounts/allocation/rules', body)
      onSaved(res.message)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save the rule.'))
    } finally {
      setBusy(false)
    }
  }

  const chips = (ids: string[], names: Map<string, string>, drop: (id: string) => void, none: string) =>
    ids.length ? (
      <div className="mt-1.5 flex flex-wrap gap-1">
        {ids.map((id) => (
          <span key={id} className="badge-neutral">
            {names.get(id) ?? '(removed)'}
            <button type="button" className="hover:text-foreground" onClick={() => drop(id)} aria-label={`Take off ${names.get(id) ?? ''}`}>
              <X size={11} />
            </button>
          </span>
        ))}
      </div>
    ) : (
      <p className="text-muted-foreground mt-1.5 text-xs">{none}</p>
    )

  return (
    <FormFrame
      icon={Split}
      title={rule ? `Rule: ${rule.name}` : 'New allocation rule'}
      subtitle="Which shared expenses it covers, which brands share them, and how"
      width="max-w-3xl"
      busy={busy}
      error={error}
      onClose={onClose}
      primary={
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={busy}>
          {busy ? 'Saving…' : 'Save rule'}
        </button>
      }
      footer={
        <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
          Cancel
        </button>
      }
      footerNote={problem ? <span className="text-amber-600">{problem}</span> : rule ? 'A run not yet posted that used the old rule will need working out again.' : undefined}
    >
      <div className="grid gap-4 sm:grid-cols-[1fr_200px_110px]">
        <label className="block">
          <span className="form-label">Name</span>
          <input className="form-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Factory power by sales" maxLength={80} />
        </label>
        <label className="block">
          <span className="form-label">Split by</span>
          <SmartSelect className="form-input" value={basis} onChange={(e) => setBasis(e.target.value)} aria-label="Split by">
            {choices.bases.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </SmartSelect>
        </label>
        <label className="block">
          <span className="form-label">Order</span>
          <StepInput className="form-input" value={sortOrder} onValueChange={setSortOrder} min={0} max={9999} aria-label="Order" />
        </label>
      </div>
      <p className="text-muted-foreground -mt-2 text-xs">{BASIS_HINT[basis]}</p>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <div className="flex items-center justify-between gap-2">
            <span className="form-label mb-0">Expense ledgers it covers</span>
            <MultiFilter
              label="Ledgers"
              options={choices.ledgers.map((l) => ({ value: l.id, label: l.name, sub: l.group }))}
              selected={ledgerIds}
              onChange={setLedgerIds}
            />
          </div>
          {chips(ledgerIds, ledgerName, (id) => setLedgerIds(ledgerIds.filter((x) => x !== id)), 'None ticked: every shared expense ledger.')}
        </div>
        <div>
          <div className="flex items-center justify-between gap-2">
            <span className="form-label mb-0">Departments it covers</span>
            <MultiFilter label="Departments" options={choices.departments.map((d) => ({ value: d.id, label: d.name }))} selected={departmentIds} onChange={setDepartmentIds} />
          </div>
          {chips(departmentIds, deptName, (id) => setDepartmentIds(departmentIds.filter((x) => x !== id)), 'None ticked: any department.')}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between gap-2">
          <span className="form-label mb-0">Brands that share</span>
          <MultiFilter label="Brands" options={choices.brands.map((b) => ({ value: b.id, label: b.name }))} selected={brandIds} onChange={setBrandIds} />
        </div>
        {chips(brandIds, brandName, (id) => setBrandIds(brandIds.filter((x) => x !== id)), `None ticked: every own brand in use (${choices.brands.map((b) => b.name).join(', ') || 'none'}).`)}
      </div>

      {fixed && (
        <div className="border-border rounded-lg border">
          <table className="data-table table-compact w-full">
            <thead>
              <tr>
                <th>Brand</th>
                <th className="w-40 text-right">Share %</th>
              </tr>
            </thead>
            <tbody>
              {sharing.map((id) => (
                <tr key={id}>
                  <td>{brandName.get(id) ?? '(removed)'}</td>
                  <td className="text-right">
                    <StepInput
                      className="form-input h-8 text-right"
                      value={shares[id] ?? ''}
                      onValueChange={(v) => setShares({ ...shares, [id]: v })}
                      min={0}
                      max={100}
                      decimals
                      aria-label={`Share for ${brandName.get(id) ?? ''}`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className="text-right">Makes</td>
                <td className={`text-right tabular-nums ${total === 100 ? 'text-primary' : 'text-amber-600'}`}>
                  {total}%{total !== 100 ? ` — ${round4(100 - total)}% ${total < 100 ? 'left to give' : 'too many'}` : ''}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
        <label className="block">
          <span className="form-label">Note</span>
          <input className="form-input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Why this split (optional)" maxLength={500} />
        </label>
        <label className="flex h-10 items-center gap-2 text-sm">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
          In use
        </label>
      </div>
      <p className="text-muted-foreground text-xs">
        Each shared expense goes to the first rule in order that covers its ledger and department. Stock purchases are never shared: stock stays central until it moves to a brand.
      </p>
    </FormFrame>
  )
}
