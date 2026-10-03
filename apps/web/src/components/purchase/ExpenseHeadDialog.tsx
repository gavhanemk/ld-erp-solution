'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, Loader2, Receipt, Save, X } from 'lucide-react'
import { api, apiErrorMessage } from '@/lib/api'
import { Section } from '@/components/purchase/Section'
import type { NewItem } from '@/components/purchase/NewItemDialog'

/**
 * Adding or editing an expense head — Electricity, Rent, Repairs.
 *
 * An expense head is stored as an item filed under the "Expenses" category,
 * because that is what a bill line points at. But it is not stock: it has no
 * item type worth choosing, no standard rate and no reorder level, and the
 * full item form asking for all of that made a two-second job look like
 * adding fabric to the master. So this asks only for what a head needs, and
 * the same form is used to add one (from a bill or from Masters) and to edit
 * one, so the two never drift apart.
 *
 * The "Expenses" category is created on the first save if the mill has none
 * yet, rather than sending the buyer off to Masters in the middle of a bill.
 */

interface Category {
  id: string
  name: string
  parentId: string | null
}

interface Uom {
  id: string
  symbol: string
  name: string
}

/** A head being edited, as the item list sends it. */
export interface ExpenseHead {
  id: string
  code: string
  name: string
  hsnCode: string | null
  description: string | null
  isActive: boolean
  category: { id: string; name: string; parentId: string | null } | null
  uom: { id: string; name: string; symbol: string } | null
}

/**
 * The unit a head gets when the buyer leaves it as "Not needed".
 *
 * The item master requires a unit on every item, but most expense bills are one
 * amount — quantity 1 — and asking for a unit there is a question with no
 * answer. So it is optional on this form and filled from this list, best first.
 */
const PREFERRED_UNITS = ['nos', 'job', 'lot', 'each', 'pcs']

/** The unit "Not needed" saves as, from the units the master holds. */
export function plainUnit<U extends { symbol: string }>(uoms: U[]): U | null {
  return (
    PREFERRED_UNITS.map((s) => uoms.find((u) => u.symbol.toLowerCase() === s)).find(Boolean) ??
    uoms[0] ??
    null
  )
}

/** Whether a head's unit is one of the plain ones, i.e. shown as "Not needed". */
export const isPlainUnit = (symbol?: string | null) =>
  Boolean(symbol && PREFERRED_UNITS.includes(symbol.toLowerCase()))

export function ExpenseHeadDialog({
  head,
  expenseCategory,
  groups,
  onClose,
  onCreated,
  onSaved,
}: {
  /** The head to edit. Left out to add a new one. */
  head?: ExpenseHead | null
  /** The top-level "Expenses" category, or null when the mill has not made one yet. */
  expenseCategory: Category | null
  /** Sub-groups under it (e.g. Utilities, Repairs), if any. */
  groups: Category[]
  onClose: () => void
  /** A new head, plus the "Expenses" category when this created it. */
  onCreated?: (item: NewItem, createdCategory: Category | null) => void
  /** An edited head was saved. */
  onSaved?: () => void
}) {
  const editing = Boolean(head)
  const [name, setName] = useState(head?.name ?? '')
  // A head filed straight under Expenses has no group; one under a group does.
  const [groupId, setGroupId] = useState(
    head?.category?.parentId ? head.category.id : ''
  )
  // A plain unit is shown as "Not needed" (empty), whatever it was saved as.
  const [uomId, setUomId] = useState(
    head?.uom && !isPlainUnit(head.uom.symbol) ? head.uom.id : ''
  )
  const [sacCode, setSacCode] = useState(head?.hsnCode ?? '')
  const [description, setDescription] = useState(head?.description ?? '')
  const [isActive, setIsActive] = useState(head?.isActive ?? true)

  const [uoms, setUoms] = useState<Uom[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<{ data: Uom[] }>('/masters/uoms?limit=100')
      .then((r) => setUoms(r.data))
      .catch(() => setError('Could not load the units. Close and try again.'))
  }, [])

  /** What "Not needed" saves as. */
  const fallbackUnit = useMemo(() => plainUnit(uoms), [uoms])

  const problems = useMemo(() => {
    const out: string[] = []
    if (!name.trim()) out.push('The expense head needs a name')
    if (!uomId && !fallbackUnit) out.push(uoms.length ? 'Pick a unit' : 'Loading the units…')
    if (sacCode && !/^[0-9]{4,8}$/.test(sacCode.trim())) {
      out.push('A SAC / HSN code is 4 to 8 digits, nothing else')
    }
    return out
  }, [name, uomId, uoms, fallbackUnit, sacCode])

  const save = useCallback(async () => {
    if (problems.length) return
    setSaving(true)
    setError(null)
    try {
      let category = expenseCategory
      let created: Category | null = null
      if (!category) {
        const res = await api.post<{ data: Category }>('/masters/item-categories', {
          name: 'Expenses',
        })
        category = created = res.data
      }
      const fields = {
        name: name.trim(),
        categoryId: groupId || category.id,
        uomId: uomId || fallbackUnit?.id,
      }
      if (head) {
        // Blank boxes are sent as null so clearing a code or note sticks.
        await api.patch(`/masters/items/${head.id}`, {
          ...fields,
          hsnCode: sacCode.trim() || null,
          description: description.trim() || null,
          isActive,
        })
        onSaved?.()
      } else {
        const res = await api.post<{ data: NewItem }>('/masters/items', {
          ...fields,
          // Used up, never part of a garment — the closest of the item types.
          type: 'CONSUMABLE',
          ...(sacCode.trim() ? { hsnCode: sacCode.trim() } : {}),
          ...(description.trim() ? { description: description.trim() } : {}),
        })
        onCreated?.(res.data, created)
      }
    } catch (err) {
      setError(
        apiErrorMessage(err, head ? 'Could not save that expense head.' : 'Could not add that expense head.')
      )
    } finally {
      setSaving(false)
    }
  }, [
    problems,
    expenseCategory,
    head,
    name,
    groupId,
    uomId,
    fallbackUnit,
    sacCode,
    description,
    isActive,
    onCreated,
    onSaved,
  ])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm">
      <div
        className="glass-card po-form my-4 flex w-full max-w-3xl flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="head-title"
      >
        <div className="border-border flex shrink-0 items-center justify-between gap-4 border-b px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="bg-primary/10 border-primary/20 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border">
              <Receipt size={19} className="text-primary" />
            </div>
            <div className="min-w-0">
              <h2
                id="head-title"
                className="text-foreground truncate text-xl font-semibold tracking-tight"
              >
                {editing ? 'Edit Expense Head' : 'New Expense Head'}
              </h2>
              <p className="text-muted-foreground mt-0.5 truncate text-[13px]">
                {head
                  ? `${head.code} · changes apply to new bills from now on`
                  : 'What this bill is for — Electricity, Rent, Repairs'}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="btn-ghost p-1.5" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-3 overflow-y-auto px-5 py-4">
          {error && (
            <div className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3">
              <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          {/* Two rows:
                Name ............. | Group | Unit
                SAC / HSN | Note ........................ */}
          <Section icon={Receipt} title="Expense head">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="sm:col-span-2">
                <label className="form-label" htmlFor="eh-name">
                  Name
                </label>
                <input
                  id="eh-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void save()
                  }}
                  placeholder="Electricity"
                  className="form-input"
                  autoFocus
                />
              </div>
              {/* Always shown, so the form is the same shape whether or not the
                mill has grouped its heads yet. Groups are sub-categories under
                Expenses, made in Item Categories. */}
              <div>
                <label className="form-label" htmlFor="eh-group">
                  Group <span className="text-muted-foreground font-normal">(optional)</span>
                </label>
                <select
                  id="eh-group"
                  value={groupId}
                  onChange={(e) => setGroupId(e.target.value)}
                  disabled={groups.length === 0}
                  className="form-input"
                >
                  <option value="">{groups.length ? 'None' : 'No groups yet'}</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
                <p className="form-help">
                  {groups.length
                    ? 'e.g. Utilities, Repairs.'
                    : 'Add groups under Expenses in Masters → Item Categories.'}
                </p>
              </div>
              <div>
                <label className="form-label" htmlFor="eh-uom">
                  Unit <span className="text-muted-foreground font-normal">(optional)</span>
                </label>
                <select
                  id="eh-uom"
                  value={uomId}
                  onChange={(e) => setUomId(e.target.value)}
                  className="form-input"
                >
                  <option value="">Not needed</option>
                  {uoms
                    .filter((u) => u.id !== fallbackUnit?.id)
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.symbol} · {u.name}
                      </option>
                    ))}
                </select>
                <p className="form-help">Only to count usage, e.g. units of power.</p>
              </div>

              <div>
                <label className="form-label" htmlFor="eh-sac">
                  SAC / HSN code
                </label>
                <input
                  id="eh-sac"
                  value={sacCode}
                  onChange={(e) => setSacCode(e.target.value)}
                  placeholder="998714"
                  inputMode="numeric"
                  className="form-input font-mono"
                />
                <p className="form-help">Optional. From the bill, if printed.</p>
              </div>
              <div className="sm:col-span-2 lg:col-span-3">
                <label className="form-label" htmlFor="eh-desc">
                  Note
                </label>
                <input
                  id="eh-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Optional — e.g. MSEDCL, factory meter"
                  className="form-input"
                />
              </div>
            </div>
          </Section>
        </div>

        <div className="border-border flex shrink-0 flex-wrap items-center justify-between gap-3 border-t px-5 py-3.5">
          {editing ? (
            <label className="text-foreground flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
              />
              Active
              <span className="text-muted-foreground text-[11px]">
                {problems[0] ?? 'Available on new bills'}
              </span>
            </label>
          ) : (
            <p className="text-muted-foreground max-w-[22rem] text-[11px]">
              {problems.length > 0
                ? problems[0]
                : expenseCategory
                  ? `Filed under ${expenseCategory.name} in the item master.`
                  : 'Filed under a new "Expenses" category in the item master.'}
            </p>
          )}
          <div className="flex items-center gap-3">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={save}
              disabled={saving || problems.length > 0}
            >
              {saving ? (
                <Loader2 size={15} className="animate-spin" />
              ) : editing ? (
                <Save size={15} />
              ) : (
                <Receipt size={15} />
              )}
              {editing ? 'Save changes' : 'Add expense head'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
