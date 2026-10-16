'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle,
  ArrowLeftRight,
  CheckCircle2,
  History,
  Loader2,
  MapPin,
  MoreHorizontal,
  PackageMinus,
  Plus,
  Printer,
  Scissors,
  Trash2,
} from 'lucide-react'
import { api, ApiError, can } from '@/lib/api'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { QrCode } from './QrCode'
import { RackInput } from './RackInput'
import { STATUS, openPrintTab, packLabel, printLabels, printOutward, qtyText, type OutwardRef, type PackageDetail } from './packageTypes'

/** What an action prints: a label for stock that went out, and the stickers that changed. */
type Prints = (d: PackageDetail) => { out?: OutwardRef | null; ids: string[] }

type Action = 'issue' | 'move' | 'split' | 'history' | 'more'

const MOVE_LABEL: Record<string, string> = {
  CREATED: 'Labelled',
  ISSUED: 'Issued',
  TRANSFERRED: 'Moved',
  SPLIT: 'Split',
  SPLIT_FROM: 'Cut from another package',
  CORRECTED: 'Quantity corrected',
  VOIDED: 'Label withdrawn',
  RACKED: 'Rack',
}

const day = (d: string | null) =>
  d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'
const when = (d: string) =>
  new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })

/**
 * One scanned package and what can be done with it.
 *
 * Nothing moves because a sticker was scanned. Each action asks for its
 * quantity, shows what will be left, and saves only when confirmed.
 */
export function PackageCard({
  pkg,
  onChange,
  onDone,
}: {
  pkg: PackageDetail
  /** The package as it stands after an action. */
  onChange: (pkg: PackageDetail) => void
  /** A short message to show after an action. */
  onDone: (message: string) => void
}) {
  const live = pkg.status === 'IN_STOCK'
  const [action, setAction] = useState<Action | null>(live ? 'issue' : 'history')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The rack box, open while the rack is being changed.
  const [rack, setRack] = useState<string | null>(null)

  const st = STATUS[pkg.status] ?? { label: pkg.status, cls: 'badge-neutral' }
  const editable = can('inventory', 'edit')

  /** Saves an action. `prints` names what it prints, in a tab opened on the click. True once saved. */
  const run = async (path: string, body: unknown, prints?: Prints) => {
    setBusy(true)
    setError(null)
    const tab = prints ? openPrintTab() : null
    try {
      const res = await api.post<{ message: string; data: PackageDetail }>(`/packages/${pkg.id}/${path}`, body)
      onChange(res.data)
      onDone(res.message)
      if (prints) {
        const p = prints(res.data)
        printOutward(p.out ?? null, p.ids, tab)
      }
      return true
    } catch (err) {
      tab?.close()
      setError(err instanceof ApiError ? err.message : 'Could not save. Is the API running?')
      return false
    } finally {
      setBusy(false)
    }
  }

  const saveRack = async (value: string | null) => {
    if (await run('rack', { rack: value })) setRack(null)
  }

  const tabs: Array<{ key: Action; label: string; icon: typeof History; show: boolean }> = [
    { key: 'issue', label: 'Issue', icon: PackageMinus, show: live && editable },
    { key: 'move', label: 'Move', icon: ArrowLeftRight, show: live && editable },
    { key: 'split', label: 'Split / Repack', icon: Scissors, show: live && editable },
    { key: 'history', label: 'History', icon: History, show: true },
    { key: 'more', label: 'More', icon: MoreHorizontal, show: editable && pkg.status !== 'VOID' },
  ]

  return (
    <div className="glass-card overflow-hidden p-0">
      {/* What it is, readable at arm's length. */}
      <div className="flex flex-col gap-4 border-b border-border p-4 sm:flex-row sm:items-start">
        <div className="mx-auto w-28 shrink-0 rounded-lg bg-white p-1.5 sm:mx-0">
          <QrCode text={pkg.code} />
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-lg font-bold tracking-wide text-primary">{pkg.code}</span>
            <span className={`badge ${st.cls}`}>{st.label}</span>
            <span className="badge badge-neutral">{packLabel(pkg.packType)}</span>
            {pkg.ownerCustomer && <span className="badge badge-purple">Customer material · {pkg.ownerCustomer.name}</span>}
          </div>
          <h2 className="text-xl font-semibold leading-tight text-foreground">{pkg.item.name}</h2>
          <p className="text-sm text-muted-foreground">
            <span className="font-mono">{pkg.item.code}</span>
            {pkg.item.category ? ` · ${pkg.item.category.name}` : ''}
            {pkg.lotNo ? ` · Lot ${pkg.lotNo}` : ''}
          </p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 pt-1 text-sm sm:grid-cols-3">
            <Fact label="In it now">
              <span className="text-2xl font-bold text-foreground">{qtyText(pkg.qty)}</span>{' '}
              <span className="text-muted-foreground">{pkg.unit}</span>
            </Fact>
            <Fact label="Store">{pkg.warehouse.name}</Fact>
            <Fact label="Rack">
              {pkg.rack ? <span className="font-semibold">{pkg.rack}</span> : <span className="text-muted-foreground">Not on a rack</span>}
              {live && editable && rack === null && (
                <button type="button" className="ml-2 text-xs font-semibold text-primary hover:underline" onClick={() => setRack(pkg.rack ?? '')}>
                  {pkg.rack ? 'Change' : 'Put on a rack'}
                </button>
              )}
            </Fact>
            <Fact label="Labelled with">
              {qtyText(pkg.initialQty)} {pkg.unit}
            </Fact>
            {pkg.grn && (
              <Fact label="Received on">
                {pkg.grn.grnNumber} · {day(pkg.grn.grnDate)}
                {pkg.grn.po?.supplier ? ` · ${pkg.grn.po.supplier.name}` : ''}
              </Fact>
            )}
            {pkg.parent && (
              <Fact label="Cut from">
                <Link href={`/inventory/scan?code=${pkg.parent.code}`} className="font-mono text-primary hover:underline">
                  {pkg.parent.code}
                </Link>
              </Fact>
            )}
          </div>
          {rack !== null && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <RackInput value={rack} onChange={setRack} racks={pkg.racks} autoFocus className="form-input h-10 w-36" onEnter={() => rack.trim() && void saveRack(rack)} />
              <button type="button" className="btn-primary h-10" disabled={busy || !rack.trim()} onClick={() => void saveRack(rack)}>
                {busy ? <Loader2 size={15} className="animate-spin" /> : <MapPin size={15} />} Save rack
              </button>
              {pkg.rack && (
                <button type="button" className="btn-ghost h-10" disabled={busy} onClick={() => void saveRack(null)}>
                  Take off rack
                </button>
              )}
              <button type="button" className="btn-ghost h-10" disabled={busy} onClick={() => setRack(null)}>
                Cancel
              </button>
            </div>
          )}
          {/* The packages claim more than the store holds: something left unscanned. */}
          {pkg.position.loose < -0.0005 && (
            <p className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-sm warn-text">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              The packages of this item in {pkg.warehouse.name} add up to {qtyText(pkg.position.inPackages)} {pkg.unit}, but the store holds{' '}
              {qtyText(pkg.position.inStore)}. Some was issued without scanning. Scan each package and correct its quantity.
            </p>
          )}
        </div>
        <button type="button" className="btn-secondary shrink-0 self-start" onClick={() => printLabels([pkg.id])}>
          <Printer size={15} /> Print label
        </button>
      </div>

      {/* The actions this package allows. */}
      {/* Wraps on a phone rather than scrolling, so no action is hidden off the edge. */}
      <div className="flex flex-wrap gap-1 border-b border-border bg-secondary/40 px-2 pt-2">
        {tabs
          .filter((t) => t.show)
          .map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => {
                setAction(t.key)
                setError(null)
              }}
              className={`flex shrink-0 items-center gap-2 rounded-t-lg px-4 py-2.5 text-sm font-semibold transition-colors ${
                action === t.key ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <t.icon size={16} /> {t.label}
            </button>
          ))}
      </div>

      <div className="p-4">
        {error && (
          <p className="mb-3 flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/5 p-3 text-sm text-red-400">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {error}
          </p>
        )}
        {!live && action !== 'history' && action !== 'more' && pkg.status === 'SPLIT' && (
          <p className="text-sm text-muted-foreground">
            This sticker is retired: its roll was split when part of it went.{' '}
            {pkg.replacedBy?.length ? (
              <>
                What is left of it now carries{' '}
                {pkg.replacedBy.map((r, i) => (
                  <span key={r.code}>
                    {i > 0 && ', '}
                    <Link href={`/inventory/scan?code=${r.code}`} className="font-mono text-primary hover:underline">
                      {r.code}
                    </Link>{' '}
                    ({qtyText(r.qty)} {pkg.unit})
                  </span>
                ))}
                . Scan that sticker instead.
              </>
            ) : (
              'Nothing of it is left in stock.'
            )}
          </p>
        )}
        {!live && action !== 'history' && action !== 'more' && pkg.status !== 'SPLIT' && (
          <p className="text-sm text-muted-foreground">This package has nothing in it, so it cannot be issued, moved or split.</p>
        )}
        {live && action === 'issue' && (
          <IssuePanel
            pkg={pkg}
            busy={busy}
            // A label for what goes to the floor, and a fresh sticker for what stays in the package.
            onIssue={(b) =>
              run('issue', b, (d) => ({
                out: { type: 'MR', id: b.mrId, q: `${b.lineId}:${b.qty}:${pkg.warehouse.id}` },
                ids: d.status === 'IN_STOCK' && d.qty > 0 ? [d.id] : [],
              }))
            }
          />
        )}
        {live && action === 'move' && (
          <MovePanel
            pkg={pkg}
            busy={busy}
            // Part of it: the new package that went, and a fresh sticker for what stayed.
            onMove={(b) => run('transfer', b, b.qty < pkg.qty - 1e-9 ? (d) => ({ ids: d.newPackage ? [d.newPackage.id, d.id] : [] }) : undefined)}
          />
        )}
        {live && action === 'split' && (
          <SplitPanel pkg={pkg} busy={busy} onSplit={(b) => run('split', b, (d) => ({ ids: (d.newPackages ?? []).map((p) => p.id) }))} />
        )}
        {action === 'history' && <HistoryPanel pkg={pkg} />}
        {action === 'more' && (
          <MorePanel pkg={pkg} busy={busy} onCorrect={(b) => run('correct', b)} onVoid={(b) => run('void', b)} />
        )}
      </div>
    </div>
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="truncate text-foreground">{children}</div>
    </div>
  )
}

/** The quantity box with the two quick choices people actually use. */
function QtyBox({
  value,
  onChange,
  max,
  unit,
  label,
}: {
  value: string
  onChange: (v: string) => void
  max: number
  unit: string
  label: string
}) {
  const n = Number(value) || 0
  const left = Math.round((max - n) * 1000) / 1000
  return (
    <div className="space-y-2">
      <label className="form-label">{label}</label>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-44">
          <StepInput
            className="form-input h-12 pr-12 text-xl font-semibold"
            value={value}
            onValueChange={onChange}
            max={max}
            decimals
            aria-label={label}
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">{unit}</span>
        </div>
        <button type="button" className="btn-secondary h-12" onClick={() => onChange(String(max))}>
          All of it ({qtyText(max)})
        </button>
      </div>
      <p className={`text-sm font-medium ${n > max ? 'text-red-400' : 'text-muted-foreground'}`}>
        {n > max
          ? `Only ${qtyText(max)} ${unit} in this package.`
          : n > 0
            ? left > 0
              ? `${qtyText(left)} ${unit} will be left: it goes on a new sticker, and this one is retired.`
              : 'The package will be empty.'
            : `${qtyText(max)} ${unit} in the package.`}
      </p>
    </div>
  )
}

function IssuePanel({ pkg, busy, onIssue }: { pkg: PackageDetail; busy: boolean; onIssue: (b: { mrId: string; lineId: string; qty: number }) => void }) {
  // One requisition waiting: it is chosen, with what it still wants (or all the package has).
  const only = pkg.requisitions.length === 1 ? pkg.requisitions[0] : null
  const [lineId, setLineId] = useState(only?.lineId ?? '')
  const [qty, setQty] = useState(only ? String(Math.min(only.owed, pkg.qty)) : '')
  const line = pkg.requisitions.find((r) => r.lineId === lineId)
  const n = Number(qty) || 0

  if (!pkg.requisitions.length) {
    return (
      <div className="rounded-lg border border-dashed border-border p-5 text-center text-sm text-muted-foreground">
        No approved requisition is waiting for {pkg.item.name}.{' '}
        <Link href="/inventory/requisitions" className="font-semibold text-primary hover:underline">
          Material Requisitions
        </Link>{' '}
        is where one is raised and approved.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="form-label">Issue against</p>
        <div className="grid gap-2 md:grid-cols-2">
          {pkg.requisitions.map((r) => (
            <button
              key={r.lineId}
              type="button"
              onClick={() => {
                setLineId(r.lineId)
                if (!qty) setQty(String(Math.min(r.owed, pkg.qty)))
              }}
              className={`rounded-lg border p-3 text-left transition-colors ${
                lineId === r.lineId ? 'border-primary bg-primary/10 ring-2 ring-primary/30' : 'border-border hover:border-primary/50'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono font-semibold text-foreground">{r.mrNumber}</span>
                <span className="text-sm font-semibold text-foreground">
                  wants {qtyText(r.owed)} {pkg.unit}
                </span>
              </div>
              <div className="mt-0.5 text-sm text-muted-foreground">
                {r.department}
                {r.moNumber ? ` · ${r.moNumber}` : ''}
                {r.soNumber ? ` · ${r.soNumber}` : ''}
                {r.styleNo ? ` · Style ${r.styleNo}` : ''}
                {r.requiredDate ? ` · by ${day(r.requiredDate)}` : ''}
              </div>
            </button>
          ))}
        </div>
      </div>
      {line && (
        <>
          <QtyBox value={qty} onChange={setQty} max={pkg.qty} unit={pkg.unit} label="How much to issue" />
          {n > line.owed + 1e-9 && (
            <p className="text-sm text-red-400">
              {line.mrNumber} only wants {qtyText(line.owed)} {pkg.unit} more.
            </p>
          )}
          <button
            type="button"
            className="btn-primary h-12 w-full justify-center text-base sm:w-auto"
            disabled={busy || !(n > 0) || n > pkg.qty + 1e-9 || n > line.owed + 1e-9}
            onClick={() => onIssue({ mrId: line.mrId, lineId: line.lineId, qty: n })}
          >
            {busy ? <Loader2 size={18} className="animate-spin" /> : <CheckCircle2 size={18} />}
            Issue {n > 0 ? `${qtyText(n)} ${pkg.unit}` : ''} to {line.department || line.mrNumber}
          </button>
        </>
      )}
    </div>
  )
}

function MovePanel({ pkg, busy, onMove }: { pkg: PackageDetail; busy: boolean; onMove: (b: { toWarehouseId: string; qty: number }) => void }) {
  const others = pkg.stores.filter((s) => s.id !== pkg.warehouse.id)
  const [to, setTo] = useState(others.length === 1 ? others[0].id : '')
  const [qty, setQty] = useState(String(pkg.qty))
  const n = Number(qty) || 0
  const whole = Math.abs(n - pkg.qty) < 1e-9
  const dest = others.find((s) => s.id === to)
  return (
    <div className="space-y-4">
      <div className="max-w-sm">
        <label className="form-label">Move to</label>
        <SmartSelect className="form-input h-12" value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">Choose the store…</option>
          {others.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </SmartSelect>
      </div>
      <QtyBox value={qty} onChange={setQty} max={pkg.qty} unit={pkg.unit} label="How much moves" />
      {n > 0 && !whole && n < pkg.qty && (
        <p className="text-sm text-muted-foreground">
          The part that moves and the part that stays each get a new sticker, which open for printing. This sticker is retired.
        </p>
      )}
      <button
        type="button"
        className="btn-primary h-12 w-full justify-center text-base sm:w-auto"
        disabled={busy || !to || !(n > 0) || n > pkg.qty + 1e-9}
        onClick={() => onMove({ toWarehouseId: to, qty: n })}
      >
        {busy ? <Loader2 size={18} className="animate-spin" /> : <ArrowLeftRight size={18} />}
        {whole ? `Move the package` : `Move ${n > 0 ? qtyText(n) : ''} ${pkg.unit}`} {dest ? `to ${dest.name}` : ''}
      </button>
    </div>
  )
}

function SplitPanel({ pkg, busy, onSplit }: { pkg: PackageDetail; busy: boolean; onSplit: (b: { qtys: number[] }) => void }) {
  const [rows, setRows] = useState<string[]>(['', ''])
  const qtys = rows.map((r) => Number(r) || 0)
  const total = Math.round(qtys.reduce((s, q) => s + q, 0) * 1000) / 1000
  const left = Math.round((pkg.qty - total) * 1000) / 1000
  const filled = qtys.filter((q) => q > 0)
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Each new package gets its own label, and so does whatever is not put into one. {pkg.code} is retired.
      </p>
      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {rows.map((r, i) => (
          <div key={i} className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-muted-foreground">#{i + 1}</span>
            <StepInput
              className="form-input h-11 pl-9 pr-12 text-lg"
              value={r}
              onValueChange={(v) => setRows((p) => p.map((x, j) => (j === i ? v : x)))}
              decimals
              aria-label={`New package ${i + 1}`}
            />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">{pkg.unit}</span>
          </div>
        ))}
        <button type="button" className="btn-ghost h-11 justify-center border border-dashed border-border" onClick={() => setRows((p) => [...p, ''])}>
          <Plus size={15} /> Another
        </button>
      </div>
      <p className={`text-sm font-medium ${left < -1e-9 ? 'text-red-400' : 'text-muted-foreground'}`}>
        {left < -1e-9
          ? `The new packages add up to ${qtyText(total)} ${pkg.unit}, more than the ${qtyText(pkg.qty)} in ${pkg.code}.`
          : `${filled.length} new ${filled.length === 1 ? 'package' : 'packages'}, ${qtyText(total)} ${pkg.unit}. ${left > 0 ? `The ${qtyText(left)} ${pkg.unit} left gets a new sticker too.` : ''}`}
      </p>
      <button
        type="button"
        className="btn-primary h-12 w-full justify-center text-base sm:w-auto"
        disabled={busy || !filled.length || left < -1e-9}
        onClick={() => onSplit({ qtys: filled })}
      >
        {busy ? <Loader2 size={18} className="animate-spin" /> : <Scissors size={18} />}
        Split into {filled.length || ''} and print labels
      </button>
    </div>
  )
}

function HistoryPanel({ pkg }: { pkg: PackageDetail }) {
  return (
    <div className="space-y-3">
      {pkg.children.length > 0 && (
        <div className="text-sm">
          <span className="font-semibold text-foreground">Packages cut from this one: </span>
          {pkg.children.map((c, i) => (
            <span key={c.id}>
              {i > 0 && ', '}
              <Link href={`/inventory/scan?code=${c.code}`} className="font-mono text-primary hover:underline">
                {c.code}
              </Link>{' '}
              <span className="text-muted-foreground">({qtyText(Number(c.qty))})</span>
            </span>
          ))}
        </div>
      )}
      <ol className="space-y-2">
        {pkg.moves.map((m) => (
          <li key={m.id} className="flex gap-3 rounded-lg border border-border p-3 text-sm">
            <span className={`mt-0.5 w-20 shrink-0 text-right font-semibold tabular-nums ${m.qty < 0 ? 'text-red-400' : m.qty > 0 ? 'text-emerald-500' : 'text-muted-foreground'}`}>
              {m.qty > 0 ? '+' : ''}
              {m.qty ? qtyText(m.qty) : '—'}
            </span>
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-foreground">
                {MOVE_LABEL[m.type] ?? m.type}
                {m.referenceNumber ? ` · ${m.referenceNumber}` : ''}
                {m.toStore ? ` → ${m.toStore}` : ''}
              </div>
              <div className="text-muted-foreground">
                {when(m.createdAt)}
                {m.by ? ` · ${m.by}` : ''} · {qtyText(m.balanceAfter)} {pkg.unit} after
                {m.notes ? ` · ${m.notes}` : ''}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

function MorePanel({
  pkg,
  busy,
  onCorrect,
  onVoid,
}: {
  pkg: PackageDetail
  busy: boolean
  onCorrect: (b: { qty: number; reason: string }) => void
  onVoid: (b: { reason: string }) => void
}) {
  const [qty, setQty] = useState(String(pkg.qty))
  const [reason, setReason] = useState('')
  const [why, setWhy] = useState('')
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div className="space-y-3">
        <h3 className="font-semibold text-foreground">Correct the quantity</h3>
        <p className="text-sm text-muted-foreground">
          When what is in the package is not what the label says. The store's stock is not changed — for that, record a stock count.
        </p>
        <div className="relative w-44">
          <StepInput className="form-input h-11 pr-12 text-lg" value={qty} onValueChange={setQty} decimals aria-label="Quantity in the package" />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">{pkg.unit}</span>
        </div>
        <input className="form-input" placeholder="Why, e.g. counted 6 in the box" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button
          type="button"
          className="btn-secondary"
          disabled={busy || reason.trim().length < 3 || qty === '' || Number(qty) === pkg.qty}
          onClick={() => onCorrect({ qty: Number(qty) || 0, reason: reason.trim() })}
        >
          Save the correct quantity
        </button>
      </div>
      <div className="space-y-3">
        <h3 className="font-semibold text-foreground">Withdraw this label</h3>
        <p className="text-sm text-muted-foreground">
          For a label printed by mistake, or a package that is not on the rack. Its stock stays in the store, unlabelled.
        </p>
        <input className="form-input" placeholder="Why, e.g. printed twice" value={why} onChange={(e) => setWhy(e.target.value)} />
        <button type="button" className="btn-secondary text-red-400" disabled={busy || why.trim().length < 3} onClick={() => onVoid({ reason: why.trim() })}>
          <Trash2 size={15} /> Withdraw {pkg.code}
        </button>
      </div>
    </div>
  )
}
