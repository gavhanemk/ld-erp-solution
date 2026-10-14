'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { AlertCircle, AlertTriangle, ArrowLeft, Ban, CheckCircle2, ClipboardCheck, Loader2, PackageSearch, RefreshCw, ScanLine, Undo2, X } from 'lucide-react'
import { api, ApiError, can } from '@/lib/api'
import { KpiTile, TONE } from '@/components/dashboard/DashKit'
import { Scanner } from '@/components/packages/Scanner'
import { StepInput } from '@/components/ui/StepInput'
import { ReasonDialog } from '@/components/ui/ReasonDialog'
import {
  ADJ_STATUS,
  COUNT_STATUS,
  SCAN_LOOK,
  clock,
  isOpen,
  qty,
  when,
  type CountDetail,
  type CountLine,
  type CountScan,
  type DoneCount,
  type Effect,
  type OpenCount,
} from './countTypes'

/**
 * One stock count. While it is open: scan stickers one after another — each
 * scan says at once whether it was found, belongs elsewhere or is not ours —
 * see what is still to find, count stock without stickers by hand, and finish.
 * Once finished: the adjustment it raised and what became of the stickers not found.
 */
export function StockCountScreen({ id, onBack }: { id: string; onBack: () => void }) {
  const [count, setCount] = useState<CountDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const latest = useRef(0)

  const load = useCallback(async () => {
    const ticket = ++latest.current
    try {
      const res = await api.get<{ data: CountDetail }>(`/stock-counts/${id}`)
      if (ticket === latest.current) setCount(res.data)
    } catch (err) {
      if (ticket === latest.current) setError(err instanceof ApiError ? err.message : 'Could not open the count.')
    }
  }, [id])
  useEffect(() => {
    void load()
  }, [load])

  if (!count) {
    return (
      <div className="space-y-4">
        <BackLink onBack={onBack} />
        {error ? <Problem text={error} /> : <p className="text-muted-foreground flex items-center gap-2 text-sm"><Loader2 size={14} className="animate-spin" /> Opening the count…</p>}
      </div>
    )
  }
  const st = COUNT_STATUS[count.status]
  return (
    <div className="space-y-4">
      <BackLink onBack={onBack} />
      <div className="glass-card flex flex-wrap items-start gap-3 p-4">
        <span className="bg-primary/10 text-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-lg">
          <ClipboardCheck size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-primary font-mono text-xl font-bold">{count.countNumber}</span>
            <span className={st.cls}>{st.label}</span>
          </div>
          <p className="text-foreground mt-0.5 text-sm font-medium">
            {count.status === 'OPEN' ? 'Counting' : 'Count of'} {count.warehouse.name}
          </p>
          <p className="text-muted-foreground text-xs">
            Started {when(count.startedAt)}
            {count.startedBy ? ` by ${count.startedBy}` : ''}
            {count.notes ? ` · ${count.notes}` : ''}
            {count.cancelReason ? ` · Cancelled: ${count.cancelReason}` : ''}
          </p>
        </div>
        <button type="button" className="btn-ghost" onClick={() => void load()} aria-label="Refresh" title="Read the count again — someone else may be scanning too">
          <RefreshCw size={15} />
        </button>
      </div>
      {error && <Problem text={error} />}
      {message && (
        <div className="border-primary/40 bg-primary/5 rounded-lg border p-3">
          <p className="text-primary text-sm">{message}</p>
        </div>
      )}
      {isOpen(count) ? (
        <Counting
          count={count}
          reload={load}
          onError={setError}
          onFinished={(m) => {
            setMessage(m)
            setError(null)
            void load()
          }}
        />
      ) : (
        <Finished count={count} />
      )}
    </div>
  )
}

function BackLink({ onBack }: { onBack: () => void }) {
  return (
    <button type="button" className="btn-ghost -ml-2 h-8 px-2 text-sm" onClick={onBack}>
      <ArrowLeft size={15} /> All counts
    </button>
  )
}
function Problem({ text }: { text: string }) {
  return (
    <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
      <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
      <p className="text-destructive text-sm">{text}</p>
    </div>
  )
}

// ── While counting ──────────────────────────────────────────────────────────

type Tab = 'find' | 'items' | 'check' | 'scans' | 'loose'

function Counting({ count, reload, onError, onFinished }: { count: OpenCount; reload: () => Promise<void>; onError: (e: string | null) => void; onFinished: (m: string) => void }) {
  const r = count.review
  const t = r.totals
  const [busy, setBusy] = useState(false)
  const [last, setLast] = useState<CountScan | null>(null)
  const [refused, setRefused] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('find')
  const [finishing, setFinishing] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const mayCount = can('inventory', 'create')
  const stickered = r.lines.filter((l) => l.packages > 0 || l.scanned > 0)
  const loose = r.lines.filter((l) => l.looseBook !== 0 || l.looseCounted != null)

  const scan = async (code: string) => {
    setBusy(true)
    setRefused(null)
    onError(null)
    try {
      const res = await api.post<{ data: CountScan }>(`/stock-counts/${count.id}/scan`, { code })
      setLast(res.data)
      // A buzz on a phone when a scan needs a second look.
      if (res.data.result !== 'FOUND') navigator.vibrate?.(200)
      void reload()
    } catch (err) {
      setLast(null)
      setRefused(err instanceof ApiError ? err.message : 'Could not record that scan.')
      navigator.vibrate?.([80, 60, 80])
    } finally {
      setBusy(false)
    }
  }
  const undo = async (s: CountScan) => {
    try {
      await api.delete(`/stock-counts/${count.id}/scans/${s.id}`)
      if (last?.id === s.id) setLast(null)
      void reload()
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Could not take the scan back.')
    }
  }
  const cancel = async (reason: string) => {
    try {
      const res = await api.post<{ message: string }>(`/stock-counts/${count.id}/cancel`, { reason })
      setCancelling(false)
      onFinished(res.message)
    } catch (err) {
      setCancelling(false)
      onError(err instanceof ApiError ? err.message : 'Could not cancel the count.')
    }
  }

  const TABS: Array<{ key: Tab; label: string; n: number }> = [
    { key: 'find', label: 'Still to find', n: t.toFind },
    { key: 'items', label: 'By item', n: stickered.length },
    { key: 'check', label: 'To check', n: t.problems },
    { key: 'scans', label: 'Every scan', n: t.scans },
    { key: 'loose', label: 'Without stickers', n: loose.length },
  ]

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile icon={CheckCircle2} tone={TONE.emerald} label="Stickers found" value={`${t.found} of ${t.expected}`} sub="in stock in this store" />
        <KpiTile icon={PackageSearch} tone={TONE.amber} label="Still to find" value={qty(t.toFind)} sub={t.toFind ? 'not scanned yet' : 'every sticker found'} />
        <KpiTile icon={AlertTriangle} tone={TONE.rose} label="To check" value={qty(t.problems)} sub="booked elsewhere, empty or unknown" />
        <KpiTile icon={ClipboardCheck} tone={TONE.violet} label="Items that differ" value={qty(t.differences)} sub="from the book, as it stands" />
      </div>

      {mayCount && (
        <div className="glass-card space-y-3 p-4">
          <Scanner onCode={(c) => void scan(c)} busy={busy} placeholder="Scan a sticker, or type its number" />
          {refused && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600" />
              <p className="text-foreground text-sm">{refused}</p>
            </div>
          )}
          {last && <LastScan s={last} onUndo={() => void undo(last)} />}
        </div>
      )}

      <div className="glass-card overflow-hidden p-0">
        <div className="border-border flex gap-1 overflow-x-auto border-b px-2 pt-2" role="tablist">
          {TABS.map((x) => (
            <button
              key={x.key}
              type="button"
              role="tab"
              aria-selected={tab === x.key}
              onClick={() => setTab(x.key)}
              className={`-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3 py-2 text-sm ${tab === x.key ? 'border-primary text-primary font-semibold' : 'text-muted-foreground hover:text-foreground border-transparent'}`}
            >
              {x.label}
              <span className="bg-secondary text-foreground rounded-full px-1.5 text-[11px] font-semibold tabular-nums">{x.n}</span>
            </button>
          ))}
        </div>
        {tab === 'find' && <StillToFind count={count} />}
        {tab === 'items' && <ByItem lines={stickered} />}
        {tab === 'check' && <ScanList scans={r.problems} empty="Nothing to check: every scan was a sticker of this store." onUndo={mayCount ? undo : undefined} />}
        {tab === 'scans' && <ScanList scans={r.scans} empty="Nothing scanned yet." onUndo={mayCount ? undo : undefined} />}
        {tab === 'loose' && <Loose count={count} lines={loose} editable={mayCount} reload={reload} onError={onError} />}
      </div>

      {mayCount && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button type="button" className="btn-ghost text-muted-foreground hover:text-destructive" onClick={() => setCancelling(true)}>
            <Ban size={15} /> Cancel the count
          </button>
          <button type="button" className="btn-primary" onClick={() => setFinishing(true)} disabled={!t.scans && !t.handCounted}>
            <ClipboardCheck size={15} /> Finish the count
          </button>
        </div>
      )}

      {finishing && <FinishDialog count={count} onClose={() => setFinishing(false)} onDone={(m) => { setFinishing(false); onFinished(m) }} />}
      {cancelling && (
        <ReasonDialog
          title={`Cancel ${count.countNumber}?`}
          description="What was scanned is kept on the count, but nothing in stock changes and no sticker is withdrawn."
          confirmLabel="Cancel the count"
          danger
          onCancel={() => setCancelling(false)}
          onConfirm={(reason) => void cancel(reason)}
        />
      )}
    </>
  )
}

/** The scan just made, large: what it is and what to do about it. */
function LastScan({ s, onUndo }: { s: CountScan; onUndo: () => void }) {
  const look = SCAN_LOOK[s.result]
  const Icon = s.result === 'FOUND' ? CheckCircle2 : s.result === 'UNKNOWN' ? AlertCircle : AlertTriangle
  return (
    <div className={`flex items-start gap-3 rounded-lg border p-3 ${look.box}`} role="status" aria-live="polite">
      <Icon size={22} className={`mt-0.5 shrink-0 ${look.text}`} />
      <div className="min-w-0 flex-1">
        <p className="text-foreground text-sm">
          <span className="font-mono font-semibold">{s.code}</span> <span className={`font-semibold ${look.text}`}>· {look.label}</span>
        </p>
        <p className="text-foreground mt-0.5 text-sm">{s.note}</p>
        {(s.lotNo || s.owner) && (
          <p className="text-muted-foreground text-xs">
            {[s.lotNo ? `Lot ${s.lotNo}` : null, s.owner ? `${s.owner}'s` : null].filter(Boolean).join(' · ')}
          </p>
        )}
      </div>
      <button type="button" className="btn-ghost h-8 shrink-0 px-2 text-xs" onClick={onUndo} title="Scanned by mistake: take it back">
        <Undo2 size={13} /> Undo
      </button>
    </div>
  )
}

/** The stickers the store should hold that nobody has scanned yet, item by item — to go and look for. */
function StillToFind({ count }: { count: OpenCount }) {
  const list = count.review.stillToFind
  if (!list.length) {
    return <p className="text-muted-foreground px-4 py-8 text-center text-sm">{count.review.totals.expected ? 'Every sticker this store should have has been found.' : 'This store holds no stock with stickers. Count its loose stock under "Without stickers".'}</p>
  }
  const byItem = [...new Map(list.map((p) => [p.itemId, list.filter((x) => x.itemId === p.itemId)])).values()]
  return (
    <div className="divide-border/60 divide-y">
      {byItem.map((group) => (
        <div key={group[0].itemId} className="px-4 py-3">
          <p className="text-foreground text-sm font-semibold">
            {group[0].item} <span className="text-muted-foreground font-normal">· {group.length} to find, {qty(group.reduce((s, p) => s + p.qty, 0))} {group[0].unit}</span>
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {group.map((p) => (
              <span key={p.id} className="border-border bg-secondary/50 rounded-md border px-2 py-1 text-xs" title={`${p.packType.toLowerCase()}${p.lotNo ? `, lot ${p.lotNo}` : ''}`}>
                <span className="font-mono font-semibold">{p.code}</span> <span className="text-muted-foreground">{qty(p.qty)} {p.unit}{p.lotNo ? ` · lot ${p.lotNo}` : ''}</span>
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/** Item by item: stickers found against those booked, and what the count would make of it. */
function ByItem({ lines }: { lines: CountLine[] }) {
  if (!lines.length) return <p className="text-muted-foreground px-4 py-8 text-center text-sm">No stock with stickers in this store.</p>
  return (
    <div className="overflow-x-auto">
      <table className="data-table table-compact w-full">
        <thead>
          <tr className="bg-secondary">
            <th>Item</th>
            <th style={{ textAlign: 'right' }}>Stickers found</th>
            <th style={{ textAlign: 'right' }}>In them</th>
            <th style={{ textAlign: 'right' }}>Without stickers</th>
            <th style={{ textAlign: 'right' }}>Counted</th>
            <th style={{ textAlign: 'right' }}>Book</th>
            <th style={{ textAlign: 'right' }}>Difference</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.key}>
              <td>
                <span className="text-foreground font-medium">{l.name}</span>
                <span className="text-muted-foreground block text-[11px]">
                  {l.code}
                  {l.owner ? ` · ${l.owner}'s` : ''}
                </span>
              </td>
              <td className="text-right tabular-nums">
                {l.scanned} <span className="text-muted-foreground">of {l.packages}</span>
              </td>
              <td className="whitespace-nowrap text-right tabular-nums">
                {qty(l.scannedQty)} <span className="text-muted-foreground">of {qty(l.inPackages)} {l.unit}</span>
              </td>
              <td className="whitespace-nowrap text-right tabular-nums">
                {l.looseCounted != null ? qty(l.looseCounted) : l.looseBook > 0 ? <span className="text-muted-foreground" title="Not counted by hand: taken as the book has it">{qty(l.looseBook)}</span> : <span className="text-muted-foreground">—</span>}
              </td>
              <td className="whitespace-nowrap text-right font-semibold tabular-nums">
                {qty(l.countedQty)} {l.unit}
              </td>
              <td className="whitespace-nowrap text-right tabular-nums">{qty(l.book)}</td>
              <td className={`whitespace-nowrap text-right font-semibold tabular-nums ${l.difference < 0 ? 'text-red-600' : l.difference > 0 ? 'text-emerald-600' : 'text-muted-foreground'}`}>
                {l.difference > 0 ? '+' : ''}
                {l.difference ? qty(l.difference) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ScanList({ scans, empty, onUndo }: { scans: CountScan[]; empty: string; onUndo?: (s: CountScan) => void }) {
  if (!scans.length) return <p className="text-muted-foreground px-4 py-8 text-center text-sm">{empty}</p>
  return (
    <div className="divide-border/60 max-h-[60vh] divide-y overflow-auto">
      {scans.map((s) => {
        const look = SCAN_LOOK[s.result]
        return (
          <div key={s.id} className="flex items-start gap-3 px-4 py-2.5">
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${s.result === 'FOUND' ? 'bg-emerald-500' : s.result === 'UNKNOWN' ? 'bg-red-500' : s.result === 'GONE' ? 'bg-slate-400' : 'bg-amber-500'}`} aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-foreground text-sm">
                <span className="font-mono font-semibold">{s.code}</span> <span className={`text-xs font-medium ${look.text}`}>{look.label}</span>
              </p>
              <p className="text-muted-foreground text-xs">{s.note}</p>
            </div>
            <span className="text-muted-foreground shrink-0 text-right text-[11px]">
              {clock(s.at)}
              {s.by && <span className="block">{s.by}</span>}
            </span>
            {onUndo && (
              <button type="button" className="btn-ghost h-7 shrink-0 px-1.5" onClick={() => onUndo(s)} aria-label={`Take back ${s.code}`} title="Take this scan back">
                <Undo2 size={13} />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * Stock kept without stickers, counted by hand. Left blank, an item is taken
 * as the book has it; a figure entered is what goes on the count.
 */
function Loose({ count, lines, editable, reload, onError }: { count: OpenCount; lines: CountLine[]; editable: boolean; reload: () => Promise<void>; onError: (e: string | null) => void }) {
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<string | null>(null)
  useEffect(() => {
    setDraft(Object.fromEntries(lines.map((l) => [l.key, l.looseCounted == null ? '' : String(l.looseCounted)])))
    // The saved figures, whenever the count is read again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count])

  const save = async (l: CountLine, value: string) => {
    const was = l.looseCounted == null ? '' : String(l.looseCounted)
    if (value === was) return
    setSaving(l.key)
    try {
      await api.patch(`/stock-counts/${count.id}/loose`, { lines: [{ itemId: l.itemId, ownership: l.ownership, ownerCustomerId: l.ownerCustomerId, qty: value === '' ? null : Number(value) }] })
      await reload()
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Could not save that figure.')
    } finally {
      setSaving(null)
    }
  }

  if (!lines.length) return <p className="text-muted-foreground px-4 py-8 text-center text-sm">Everything in this store is in stickers.</p>
  return (
    <div>
      <p className="text-muted-foreground border-border border-b px-4 py-2.5 text-xs">
        Stock in this store that is not in stickers. Count it on the rack and enter what is there; an item left blank is taken as the book has it.
      </p>
      <div className="divide-border/60 divide-y">
        {lines.map((l) => {
          const counted = l.looseCounted
          const diff = counted == null ? 0 : Math.round((counted - l.looseBook) * 1000) / 1000
          return (
            <div key={l.key} className="grid grid-cols-[minmax(0,1fr)_8rem] items-center gap-x-3 gap-y-1 px-4 py-2.5 sm:grid-cols-[minmax(0,1fr)_9rem_9rem_7rem]">
              <div className="min-w-0">
                <p className="text-foreground truncate text-sm font-medium">{l.name}</p>
                <p className="text-muted-foreground text-[11px]">
                  {l.code}
                  {l.owner ? ` · ${l.owner}'s` : ''}
                  <span className="sm:hidden"> · book {qty(l.looseBook)} {l.unit}</span>
                </p>
              </div>
              <span className="text-muted-foreground hidden text-right text-sm tabular-nums sm:block">
                book {qty(l.looseBook)} {l.unit}
              </span>
              <div className="flex items-center gap-1">
                <StepInput
                  decimals
                  className="form-input h-9 text-right tabular-nums"
                  value={draft[l.key] ?? ''}
                  placeholder="As book"
                  disabled={!editable || saving === l.key}
                  onValueChange={(v) => setDraft((d) => ({ ...d, [l.key]: v }))}
                  onBlur={() => void save(l, draft[l.key] ?? '')}
                  onKeyDown={(e) => e.key === 'Enter' && void save(l, draft[l.key] ?? '')}
                  aria-label={`${l.name} counted`}
                />
                {saving === l.key && <Loader2 size={13} className="text-muted-foreground animate-spin" />}
              </div>
              <span className={`hidden text-right text-sm font-semibold tabular-nums sm:block ${diff < 0 ? 'text-red-600' : diff > 0 ? 'text-emerald-600' : 'text-muted-foreground'}`}>
                {counted == null ? '—' : diff ? `${diff > 0 ? '+' : ''}${qty(diff)}` : 'matches'}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Finishing: the whole store, or only the items scanned — set side by side so
 * the store keeper sees what each would do before choosing.
 */
function FinishDialog({ count, onClose, onDone }: { count: OpenCount; onClose: () => void; onDone: (m: string) => void }) {
  const [scope, setScope] = useState<'STORE' | 'SCANNED'>('STORE')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const finish = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<{ message: string }>(`/stock-counts/${count.id}/submit`, { scope })
      onDone(res.message)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not finish the count.')
      setBusy(false)
    }
  }
  const option = (key: 'STORE' | 'SCANNED', title: string, e: Effect) => (
    <button
      type="button"
      onClick={() => setScope(key)}
      aria-pressed={scope === key}
      className={`rounded-lg border p-3 text-left ${scope === key ? 'border-primary bg-primary/10 ring-primary/30 ring-2' : 'border-border hover:border-primary/50'}`}
    >
      <span className="text-foreground block text-sm font-semibold">{title}</span>
      <span className="text-muted-foreground mt-1 block text-xs">
        {e.items} {e.items === 1 ? 'item' : 'items'} on the count · {e.differences} {e.differences === 1 ? 'differs' : 'differ'} from the book
      </span>
      <span className={`mt-0.5 block text-xs ${e.toFind ? 'font-semibold text-red-600' : 'text-muted-foreground'}`}>
        {e.toFind ? `${e.toFind} ${e.toFind === 1 ? 'sticker' : 'stickers'} not found — withdrawn once approved` : 'No sticker withdrawn'}
      </span>
    </button>
  )

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm sm:left-[var(--sidebar-current-width)]">
      <div className="glass-card w-full max-w-lg p-0" role="dialog" aria-modal="true" aria-labelledby="finish-count-title">
        <div className="flex items-start gap-3 p-5 pb-3">
          <span className="bg-primary/10 text-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-lg">
            <ClipboardCheck size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="finish-count-title" className="text-foreground text-lg font-semibold">
              Finish {count.countNumber}
            </h2>
            <p className="text-muted-foreground mt-0.5 text-sm">
              What does not match the book goes to a store manager as one adjustment. Stock changes only when it is approved.
            </p>
          </div>
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={onClose} aria-label="Close" disabled={busy}>
            <X size={18} />
          </button>
        </div>
        <div className="space-y-3 px-5">
          <p className="text-foreground text-sm font-medium">What did this count cover?</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {option('STORE', `The whole of ${count.warehouse.name}`, count.finish.STORE)}
            {option('SCANNED', 'Only the items scanned', count.finish.SCANNED)}
          </div>
          {count.review.totals.problems > 0 && (
            <p className="text-xs text-amber-600">
              {count.review.totals.problems} {count.review.totals.problems === 1 ? 'scan is' : 'scans are'} under "To check" — booked to another store, empty or unknown. They are not counted here.
            </p>
          )}
          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 p-5">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Keep counting
          </button>
          <button type="button" className="btn-primary" onClick={() => void finish()} disabled={busy}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <ClipboardCheck size={15} />} Finish and send for approval
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// ── Once finished ───────────────────────────────────────────────────────────

function Finished({ count }: { count: DoneCount }) {
  const a = count.adjustment
  const adj = a ? ADJ_STATUS[a.status] : null
  const found = count.scans.filter((s) => s.result === 'FOUND').length
  return (
    <>
      {a && (
        <div className="glass-card overflow-hidden p-0">
          <div className="border-border flex flex-wrap items-center gap-2 border-b px-4 py-3">
            <ClipboardCheck size={16} className="text-primary" />
            <h3 className="text-foreground text-sm font-semibold">Adjustment {a.adjustmentNumber}</h3>
            <span className={adj?.cls ?? 'badge-neutral'}>{adj?.label ?? a.status}</span>
            <span className="text-muted-foreground ml-auto text-xs">
              {a.status === 'PENDING' ? (
                <Link href="/inventory/documents" className="text-primary hover:underline">
                  Approve it in Stock Documents → Adjustments
                </Link>
              ) : a.approvedAt ? (
                `${a.status === 'APPROVED' ? 'Approved' : 'Refused'} ${when(a.approvedAt)}${a.approvedBy ? ` by ${a.approvedBy.name}` : ''}${a.rejectReason ? ` — ${a.rejectReason}` : ''}`
              ) : null}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="data-table table-compact w-full">
              <thead>
                <tr className="bg-secondary">
                  <th>Item</th>
                  <th style={{ textAlign: 'right' }}>Book</th>
                  <th style={{ textAlign: 'right' }}>Counted</th>
                  <th style={{ textAlign: 'right' }}>Difference</th>
                </tr>
              </thead>
              <tbody>
                {a.lines.map((l, i) => (
                  <tr key={i}>
                    <td>
                      <span className="text-foreground font-medium">{l.item}</span>
                      <span className="text-muted-foreground block text-[11px]">
                        {l.code}
                        {l.owner ? ` · ${l.owner}'s` : ''}
                      </span>
                    </td>
                    <td className="whitespace-nowrap text-right tabular-nums">
                      {qty(l.book)} {l.unit}
                    </td>
                    <td className="whitespace-nowrap text-right tabular-nums">
                      {qty(l.counted)} {l.unit}
                    </td>
                    <td className={`whitespace-nowrap text-right font-semibold tabular-nums ${l.difference < 0 ? 'text-red-600' : l.difference > 0 ? 'text-emerald-600' : 'text-muted-foreground'}`}>
                      {l.difference ? `${l.difference > 0 ? '+' : ''}${qty(l.difference)}` : 'matches'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {count.missing.length > 0 && (
        <div className="glass-card overflow-hidden p-0">
          <div className="border-border flex flex-wrap items-center gap-2 border-b px-4 py-3">
            <PackageSearch size={16} className="text-primary" />
            <h3 className="text-foreground text-sm font-semibold">Stickers not found ({count.missing.length})</h3>
            <span className="text-muted-foreground ml-auto text-xs">
              {a?.status === 'APPROVED' ? 'Withdrawn when the adjustment was approved' : a?.status === 'REJECTED' ? 'Left as they were: the adjustment was refused' : 'Withdrawn once the adjustment is approved'}
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5 p-4">
            {count.missing.map((p) => (
              <span key={p.id} className="border-border bg-secondary/50 rounded-md border px-2 py-1 text-xs">
                <span className="font-mono font-semibold">{p.code}</span>{' '}
                <span className="text-muted-foreground">
                  {p.item}
                  {p.status === 'VOID' ? ' · withdrawn' : ` · ${qty(p.qty)} ${p.unit}`}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="glass-card overflow-hidden p-0">
        <div className="border-border flex flex-wrap items-center gap-2 border-b px-4 py-3">
          <ScanLine size={16} className="text-primary" />
          <h3 className="text-foreground text-sm font-semibold">Scans ({count.scans.length})</h3>
          <span className="text-muted-foreground ml-auto text-xs">{found} found in the store</span>
        </div>
        <ScanList scans={count.scans} empty="Nothing was scanned." />
      </div>
    </>
  )
}
