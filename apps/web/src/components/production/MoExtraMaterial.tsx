'use client'

import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Loader2, PackagePlus, Undo2, XCircle } from 'lucide-react'
import { api, ApiError, can, currentUser } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { ReasonDialog } from '@/components/ui/ReasonDialog'

/**
 * Extra material on an MO (multi-brand phase 5): more of a material than the
 * plan allows, or one the plan does not call for, asked for with a reason
 * and approved by a production manager other than whoever asked. Only an
 * approved extra lets the store issue past the plan; an earmark of stock for
 * the brand never does.
 */

interface Extra {
  id: string
  number: string
  itemName: string
  unit: string
  qty: number
  reason: string
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN'
  requestedAt: string
  requestedBy: { id: string; name: string }
  decidedBy: { id: string; name: string } | null
  decidedAt: string | null
  rejectReason: string | null
  selfApproved: boolean
  overrideReason: string | null
}

interface ItemHit {
  id: string
  code: string
  name: string
  type: string
  designNo?: string | null
  color?: string | null
  uom?: { symbol: string } | null
}

const STATUS: Record<Extra['status'], string> = { PENDING: 'Waiting for approval', APPROVED: 'Approved', REJECTED: 'Turned down', WITHDRAWN: 'Withdrawn' }
const qty = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 3 })
const shade = (i: { designNo?: string | null; color?: string | null }) => [i.designNo, i.color].filter(Boolean).join(' · ')

export function MoExtraMaterial({
  moId,
  moNumber,
  live,
  materials,
  onChanged,
}: {
  moId: string
  moNumber: string
  /** Released and not finished: extra can still be asked for. */
  live: boolean
  /** The plan's own materials, offered first. */
  materials: Array<{ id: string; code: string; name: string; unit: string | null; shade: string }>
  onChanged: () => void
}) {
  const [rows, setRows] = useState<Extra[] | null>(null)
  const [mayApprove, setMayApprove] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [itemId, setItemId] = useState('')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [search, setSearch] = useState('')
  const [hits, setHits] = useState<ItemHit[]>([])
  const [shown, setShown] = useState<string | null>(null)
  const [deciding, setDeciding] = useState<{ row: Extra; kind: 'approve' | 'override' | 'reject' } | null>(null)
  const me = currentUser()

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ data: Extra[]; mayApprove: boolean }>(`/production/orders/${moId}/extras`)
      setRows(res.data)
      setMayApprove(res.mayApprove)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the extra material.')
    }
  }, [moId])
  useEffect(() => {
    void load()
  }, [load])

  // Any other material, found by typing: never a finished garment.
  useEffect(() => {
    const term = search.trim()
    if (term.length < 2) return setHits([])
    let live = true
    const t = setTimeout(() => {
      api
        .get<{ data: ItemHit[] }>(`/masters/items?q=${encodeURIComponent(term)}&limit=30&sort=name&order=asc&active=true`)
        .then((r) => live && setHits(r.data.filter((i) => i.type !== 'FINISHED_GOOD' && i.type !== 'FIXED_ASSET')))
        .catch(() => live && setHits([]))
    }, 250)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [search])

  const options = [
    ...materials.map((m) => ({ id: m.id, label: `${m.code} — ${m.name}${m.shade ? ` (${m.shade})` : ''}`, group: 'On the plan' })),
    ...hits.filter((h) => !materials.some((m) => m.id === h.id)).map((h) => ({ id: h.id, label: `${h.code} — ${h.name}${shade(h) ? ` (${shade(h)})` : ''}`, group: 'Not on the plan' })),
  ]

  const missing = [!itemId && 'the material', !(Number(amount) > 0) && 'how much', reason.trim().length < 5 && 'why it is needed'].filter(Boolean) as string[]
  const ask = async () => {
    setShown(missing.length ? `Say ${missing.join(', ')}.` : null)
    if (missing.length) return
    setBusy('ask')
    setError(null)
    try {
      const res = await api.post<{ message?: string }>(`/production/orders/${moId}/extras`, { itemId, qty: Number(amount), reason: reason.trim() })
      setMessage(res.message ?? 'Asked for.')
      setAsking(false)
      setItemId('')
      setAmount('')
      setReason('')
      await load()
      onChanged()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not ask for it.')
    } finally {
      setBusy(null)
    }
  }

  const act = async (row: Extra, path: 'approve' | 'reject' | 'withdraw', body: Record<string, unknown> = {}) => {
    setBusy(row.id)
    setError(null)
    try {
      const res = await api.post<{ message?: string }>(`/production/orders/extras/${row.id}/${path}`, body)
      setMessage(res.message ?? 'Done.')
      setDeciding(null)
      await load()
      onChanged()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not do that.')
    } finally {
      setBusy(null)
    }
  }

  const mayAsk = can('production', 'create')
  return (
    <Section
      icon={PackagePlus}
      title="Extra material"
      actions={
        live && mayAsk && !asking ? (
          <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => setAsking(true)}>
            <PackagePlus size={13} /> Ask for extra
          </button>
        ) : undefined
      }
    >
      <p className="text-muted-foreground mb-2 text-xs">
        More than the plan allows, or a material it does not call for, is issued only once a production manager other than whoever asked approves it here. Earmarking
        stock for the brand does not allow it.
      </p>
      {error && <p className="text-destructive mb-2 text-xs">{error}</p>}
      {message && <p className="text-muted-foreground mb-2 text-xs">{message}</p>}
      {asking && (
        <div className="border-border mb-3 grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_8rem]">
          <div className="sm:col-span-2">
            <label className="form-label" htmlFor="extra-search">
              Material
            </label>
            <div className="flex flex-wrap gap-2">
              <input
                id="extra-search"
                className="form-input w-48"
                placeholder="Find another material…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <SmartSelect aria-label="Material for the extra" className="form-input min-w-[18rem] flex-1" value={itemId} onChange={(e) => setItemId(e.target.value)}>
                <option value="">Pick the material</option>
                {['On the plan', 'Not on the plan'].map((g) => {
                  const list = options.filter((o) => o.group === g)
                  return list.length ? (
                    <optgroup key={g} label={g}>
                      {list.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </optgroup>
                  ) : null
                })}
              </SmartSelect>
            </div>
          </div>
          <div>
            <label className="form-label" htmlFor="extra-reason">
              Why it is needed
            </label>
            <input id="extra-reason" className="form-input" maxLength={500} placeholder="Re-cutting 12 pieces after a shade fault" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div>
            <label className="form-label" htmlFor="extra-qty">
              How much more
            </label>
            <StepInput id="extra-qty" decimals className="form-input text-right tabular-nums" value={amount} onValueChange={setAmount} />
          </div>
          <div className="flex items-center justify-end gap-2 sm:col-span-2">
            {shown && <p className="warn-text mr-auto text-xs">{shown}</p>}
            <button type="button" className="btn-ghost h-8 px-3 text-xs" onClick={() => setAsking(false)} disabled={busy === 'ask'}>
              Cancel
            </button>
            <button type="button" className="btn-primary h-8 px-3 text-xs" onClick={() => void ask()} disabled={busy === 'ask'}>
              {busy === 'ask' ? <Loader2 size={13} className="animate-spin" /> : <PackagePlus size={13} />} Ask for approval
            </button>
          </div>
        </div>
      )}
      {rows === null ? (
        <div className="skeleton h-10 w-full rounded-lg" />
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">None asked for.</p>
      ) : (
        <div className="divide-border divide-y text-sm">
          {rows.map((r) => {
            const mine = r.requestedBy.id === me?.id
            return (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <span className="font-mono text-xs">{r.number}</span>{' '}
                  <span className="text-foreground font-medium">
                    +{qty(r.qty)} {r.unit} {r.itemName}
                  </span>
                  <p className="text-muted-foreground text-xs">
                    {r.reason} · asked by {r.requestedBy.name} on {formatDate(r.requestedAt)}
                    {r.decidedBy && ` · ${r.status === 'REJECTED' ? 'turned down' : 'approved'} by ${r.decidedBy.name}`}
                    {r.selfApproved && r.overrideReason && ` · Admin override: ${r.overrideReason}`}
                    {r.rejectReason && ` · ${r.rejectReason}`}
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className={`text-xs ${r.status === 'APPROVED' ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>{STATUS[r.status]}</span>
                  {r.status === 'PENDING' && mayApprove && !mine && (
                    <>
                      <button type="button" className="btn-secondary h-7 px-2 text-xs" onClick={() => void act(r, 'approve')} disabled={busy === r.id}>
                        <CheckCircle2 size={12} /> Approve
                      </button>
                      <button type="button" className="btn-ghost h-7 px-2 text-xs" onClick={() => setDeciding({ row: r, kind: 'reject' })} disabled={busy === r.id}>
                        <XCircle size={12} /> Turn down
                      </button>
                    </>
                  )}
                  {r.status === 'PENDING' && mine && mayApprove && (me?.superAdmin || me?.role === 'Super Admin' || me?.role === 'Admin') && (
                    <button type="button" className="btn-ghost h-7 px-2 text-xs" onClick={() => setDeciding({ row: r, kind: 'override' })} disabled={busy === r.id}>
                      <CheckCircle2 size={12} /> Approve my own (override)
                    </button>
                  )}
                  {(r.status === 'PENDING' || r.status === 'APPROVED') && mine && (
                    <button type="button" className="btn-ghost h-7 px-2 text-xs" onClick={() => void act(r, 'withdraw')} disabled={busy === r.id}>
                      <Undo2 size={12} /> Withdraw
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
      {deciding && (
        <ReasonDialog
          title={deciding.kind === 'reject' ? `Turn down ${deciding.row.number}?` : `Approve your own ${deciding.row.number}?`}
          description={
            deciding.kind === 'reject'
              ? `${moNumber} will not be issued the extra ${qty(deciding.row.qty)} ${deciding.row.unit}. Say why.`
              : 'You asked for this one. An Admin may approve their own only as an override: say why, in a sentence. It is kept on the request and in the audit trail.'
          }
          confirmLabel={deciding.kind === 'reject' ? 'Turn it down' : 'Approve as an override'}
          requireReason
          busy={busy === deciding.row.id}
          onConfirm={(why) => void act(deciding.row, deciding.kind === 'reject' ? 'reject' : 'approve', deciding.kind === 'reject' ? { reason: why } : { overrideReason: why })}
          onCancel={() => setDeciding(null)}
        />
      )}
    </Section>
  )
}
