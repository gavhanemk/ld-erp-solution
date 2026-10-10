'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, ArrowRight, CheckCircle2, ChevronDown, Clock, Factory, FileCheck2, Inbox, Info,
  Loader2, Lock, PackageCheck, ShoppingBag, ShoppingCart, Wallet, Warehouse, XCircle,
} from 'lucide-react'
import { api, ApiError, currentUser } from '@/lib/api'
import { TONE, inr } from '@/components/dashboard/DashKit'
import { HealthRing, MODULE, SLATE, moduleOf } from './HomeCharts'
import type { Approval, Check, HomeData } from './types'

/**
 * The parts of the home dashboard that are not charts: the mill drawn as one
 * flow from buying to cash, what needs a look, what is waiting for a
 * signature, and who has just done what.
 */

const TONE_HEX: Record<Check['tone'] | 'emerald' | 'slate', string> = {
  rose: TONE.rose,
  amber: TONE.amber,
  violet: TONE.violet,
  blue: TONE.blue,
  emerald: TONE.emerald,
  slate: SLATE,
}

/** "3 hours ago", "yesterday", "2 Oct". */
export function ago(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  if (s < 172800) return 'yesterday'
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} days ago`
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/* ═════════════════════════════ the mill as one flow ═════════════════════════════ */

interface Stage {
  key: string
  step: string
  title: string
  icon: React.ElementType
  colour: string
  href: string
  /** Null when the role may not see this module. */
  body: null | {
    value: string
    caption: string
    lines: string[]
    status: { tone: keyof typeof TONE_HEX; text: string }
  }
}

function stagesOf(d: HomeData): Stage[] {
  const p = d.purchase
  const inv = d.inventory
  const pr = d.production
  const s = d.sales
  const m = d.money
  return [
    {
      key: 'buy',
      step: 'Buy',
      title: 'Purchase',
      icon: ShoppingBag,
      colour: MODULE.purchase.colour,
      href: '/purchase/dashboard',
      body: p && {
        value: inr(p.ordered.value),
        caption: `ordered · ${plural(p.ordered.orders, 'order')}`,
        lines: [`${inr(p.received)} of goods received`, `${plural(p.openOrders, 'order')} still open · ${inr(p.openValue)}`],
        status: p.late
          ? { tone: 'rose', text: `${p.late} late · ${inr(p.lateValue)}` }
          : p.drafts
            ? { tone: 'amber', text: `${p.drafts} not yet sent` }
            : p.unbilled
              ? { tone: 'amber', text: `${p.unbilled} waiting for a bill` }
              : { tone: 'emerald', text: 'On track' },
      },
    },
    {
      key: 'store',
      step: 'Store',
      title: 'Stores',
      icon: Warehouse,
      colour: MODULE.inventory.colour,
      href: '/inventory/dashboard',
      body: inv && {
        value: inr(inv.stockValue),
        caption: `in stock · ${plural(inv.items, 'item')}`,
        lines: [`${inr(inv.period.received)} received in`, `${inr(inv.period.issued)} issued to the floor`],
        status: inv.toReorder
          ? { tone: 'amber', text: `${inv.toReorder} to reorder` }
          : inv.mrToIssue
            ? { tone: 'blue', text: `${inv.mrToIssue} to issue` }
            : { tone: 'emerald', text: 'Stock healthy' },
      },
    },
    {
      key: 'make',
      step: 'Make',
      title: 'Production',
      icon: Factory,
      colour: MODULE.production.colour,
      href: '/production/orders',
      body: pr && {
        value: pr.made.pieces.toLocaleString('en-IN'),
        caption: 'pieces made',
        lines: [
          `${plural(pr.activeOrders, 'order')} on the floor`,
          pr.today.target ? `today ${pr.today.achieved.toLocaleString('en-IN')} of ${pr.today.target.toLocaleString('en-IN')}` : 'no target set today',
        ],
        status: pr.lateOrders
          ? { tone: 'rose', text: `${pr.lateOrders} behind plan` }
          : pr.today.efficiency != null
            ? { tone: pr.today.efficiency >= 90 ? 'emerald' : 'amber', text: `${pr.today.efficiency}% today` }
            : { tone: 'slate', text: 'No output yet' },
      },
    },
    {
      key: 'sell',
      step: 'Sell',
      title: 'Sales',
      icon: ShoppingCart,
      colour: MODULE.sales.colour,
      href: '/sales/orders',
      body: s && {
        value: inr(s.booked.value),
        caption: `booked · ${plural(s.booked.orders, 'order')}`,
        lines: [`${plural(s.openOrders, 'order')} open · ${inr(s.openValue)}`, s.dueWeek ? `${s.dueWeek} due this week` : 'nothing due this week'],
        status: s.late
          ? { tone: 'rose', text: `${s.late} late` }
          : s.openOrders
            ? { tone: 'blue', text: `${s.openOrders} in hand` }
            : { tone: 'slate', text: 'No open orders' },
      },
    },
    {
      key: 'cash',
      step: 'Collect',
      title: 'Money',
      icon: Wallet,
      colour: MODULE.accounts.colour,
      href: '/reports/supplier-outstanding',
      body: m && {
        value: inr(m.collected.value),
        caption: `collected · ${inr(m.invoiced.value)} invoiced`,
        lines: [`${inr(m.receivable.total)} to collect`, `${inr(m.payable.total)} to pay suppliers`],
        status: m.receivable.overdue
          ? { tone: 'rose', text: `${inr(m.receivable.overdue)} overdue` }
          : m.payable.overdue
            ? { tone: 'rose', text: `${inr(m.payable.overdue)} we owe, late` }
            : m.payable.dueWeek
              ? { tone: 'amber', text: `${inr(m.payable.dueWeek)} to pay this week` }
              : { tone: 'emerald', text: 'Nothing overdue' },
      },
    },
  ]
}

/** An arrow from one stage to the next; it moves unless the reader asked for stillness. */
function Connector({ still }: { still: boolean }) {
  return (
    <div className="flex shrink-0 items-center justify-center text-primary/60 xl:w-10" aria-hidden>
      <svg className="hidden xl:block" width="40" height="14" viewBox="0 0 40 14">
        <line x1="0" y1="7" x2="31" y2="7" stroke="currentColor" strokeWidth="2" strokeDasharray="4 4">
          {!still && <animate attributeName="stroke-dashoffset" from="8" to="0" dur="0.9s" repeatCount="indefinite" />}
        </line>
        <path d="M30 2 L37 7 L30 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <svg className="xl:hidden" width="14" height="24" viewBox="0 0 14 24">
        <line x1="7" y1="0" x2="7" y2="16" stroke="currentColor" strokeWidth="2" strokeDasharray="4 4">
          {!still && <animate attributeName="stroke-dashoffset" from="8" to="0" dur="0.9s" repeatCount="indefinite" />}
        </line>
        <path d="M2 15 L7 22 L12 15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  )
}

/**
 * The mill from buying to cash, one stage after another: what moved through
 * each in the period, where it stands, and whether it needs a look. Each stage
 * opens its own module.
 */
export function MillFlow({ data }: { data: HomeData }) {
  const [still, setStill] = useState(true)
  useEffect(() => {
    setStill(window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  }, [])
  const stages = stagesOf(data)
  return (
    <div className="flex flex-col items-stretch xl:flex-row">
      {stages.map((st, i) => (
        <div key={st.key} className="contents">
          {i > 0 && <Connector still={still} />}
          <StageCard stage={st} n={i + 1} />
        </div>
      ))}
    </div>
  )
}

function StageCard({ stage: st, n }: { stage: Stage; n: number }) {
  const Icon = st.icon
  const inner = (
    <>
      <span className="absolute inset-x-0 top-0 h-1 rounded-t-xl" style={{ background: st.colour }} />
      <div className="flex items-center gap-2.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" style={{ background: `${st.colour}1f`, color: st.colour }}>
          <Icon size={18} />
        </span>
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {n} · {st.step}
          </p>
          <p className="truncate text-sm font-semibold text-foreground">{st.title}</p>
        </div>
        {st.body && <ArrowRight size={14} className="ml-auto shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />}
      </div>
      {st.body ? (
        <>
          <p className="mt-3 truncate text-xl font-bold tabular-nums text-foreground">{st.body.value}</p>
          <p className="truncate text-[11px] text-muted-foreground">{st.body.caption}</p>
          <div className="mt-2 space-y-0.5">
            {st.body.lines.map((l) => (
              <p key={l} className="truncate text-[11px] text-foreground/80">
                {l}
              </p>
            ))}
          </div>
          <span
            className="mt-3 inline-flex max-w-full items-center gap-1.5 self-start rounded-full px-2 py-0.5 text-[11px] font-medium"
            style={{ background: `${TONE_HEX[st.body.status.tone]}1f`, color: TONE_HEX[st.body.status.tone] }}
          >
            <span className="relative flex h-1.5 w-1.5 shrink-0">
              {st.body.status.tone === 'rose' && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75" style={{ background: TONE_HEX.rose }} />
              )}
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full" style={{ background: TONE_HEX[st.body.status.tone] }} />
            </span>
            <span className="truncate">{st.body.status.text}</span>
          </span>
        </>
      ) : (
        <div className="mt-4 flex flex-1 flex-col items-start gap-1 text-[11px] text-muted-foreground">
          <Lock size={14} />
          Your role does not include {st.title.toLowerCase()}.
        </div>
      )}
    </>
  )
  const cls = 'group relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card p-4 pt-5 transition-all'
  return st.body ? (
    <Link href={st.href} className={`${cls} hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md`}>
      {inner}
    </Link>
  ) : (
    <div className={`${cls} opacity-70`}>{inner}</div>
  )
}

/* ═════════════════════════════ what needs a look ═════════════════════════════ */

const TONE_ORDER: Record<Check['tone'], number> = { rose: 0, violet: 1, amber: 2, blue: 3 }
const TONE_ICON: Record<Check['tone'], React.ElementType> = { rose: AlertTriangle, violet: FileCheck2, amber: Clock, blue: Info }

/**
 * Every check the dashboard runs, the failing ones first and loudest, each
 * opening the screen where it is put right. The ones that pass fold away
 * behind a line, so a quiet day reads as one.
 */
export function AttentionPanel({ checks, onApprovals }: { checks: Check[]; onApprovals: () => void }) {
  const [showClear, setShowClear] = useState(false)
  const open = checks.filter((c) => c.count > 0).sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone] || b.count - a.count)
  const clear = checks.filter((c) => c.count === 0)
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-4">
        <HealthRing clear={clear.length} total={checks.length} />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">
            {open.length === 0 ? 'All clear' : open.length === 1 ? 'One thing needs a look' : `${open.length} things need a look`}
          </p>
          <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
            {open.length === 0
              ? 'Nothing is late, overdue or waiting on anybody.'
              : open.some((c) => c.tone === 'rose')
                ? `${open.filter((c) => c.tone === 'rose').length} urgent, at the top · the rest can wait for today's round.`
                : "Nothing urgent — these can wait for today's round."}
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-1.5">
        {open.map((c) => {
          const Icon = TONE_ICON[c.tone]
          const body = (
            <>
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg" style={{ background: `${TONE_HEX[c.tone]}1f`, color: TONE_HEX[c.tone] }}>
                <Icon size={14} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs text-foreground">{c.label}</span>
                <span className="text-[11px] text-muted-foreground">
                  {c.module === 'approvals' ? 'Approvals' : moduleOf(c.module).label}
                  {c.value ? ` · ${inr(c.value)}` : ''}
                </span>
              </span>
              <span className="rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums" style={{ background: `${TONE_HEX[c.tone]}1f`, color: TONE_HEX[c.tone] }}>
                {c.count}
              </span>
            </>
          )
          const cls = 'flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-secondary'
          if (c.key === 'approvals')
            return (
              <button key={c.key} type="button" onClick={onApprovals} className={cls}>
                {body}
              </button>
            )
          return c.href ? (
            <Link key={c.key} href={c.href} className={cls}>
              {body}
            </Link>
          ) : (
            <div key={c.key} className={cls}>
              {body}
            </div>
          )
        })}
      </div>

      {clear.length > 0 && (
        <div className="mt-auto pt-3">
          <button
            type="button"
            onClick={() => setShowClear((s) => !s)}
            className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <CheckCircle2 size={14} className="text-emerald-500" />
            {clear.length} {clear.length === 1 ? 'check is' : 'checks are'} clear
            <ChevronDown size={13} className={`ml-auto transition-transform ${showClear ? 'rotate-180' : ''}`} />
          </button>
          {showClear && (
            <div className="mt-1 flex flex-wrap gap-1.5 px-2">
              {clear.map((c) => (
                <span key={c.key} className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-500">
                  <CheckCircle2 size={11} /> {c.clear}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* ═════════════════════════════ waiting for a signature ═════════════════════════════ */

const TYPE: Record<Approval['type'], { label: string; colour: string; href: string }> = {
  PO: { label: 'Purchase order', colour: MODULE.purchase.colour, href: '/purchase/orders' },
  SO: { label: 'Sales order', colour: MODULE.sales.colour, href: '/sales/orders' },
  MR: { label: 'Requisition', colour: MODULE.inventory.colour, href: '/inventory/requisitions' },
}

/**
 * Documents waiting for a sign-off, approved or refused from here. The same
 * rules as before: a reason to refuse, a confirm to approve, and nobody
 * approves what they raised themselves.
 */
export function useApprovals() {
  const [approvals, setApprovals] = useState<Approval[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => {
    try {
      const res = await api.get<{ data: Approval[] }>('/dashboard/pending-approvals?limit=20')
      setApprovals(res.data)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load what is waiting for approval.')
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  return { approvals, error, setError, reload: load }
}

export function ApprovalsPanel({
  approvals,
  error,
  setError,
  reload,
}: {
  approvals: Approval[] | null
  error: string | null
  setError: (e: string | null) => void
  reload: () => Promise<void>
}) {
  const [busyId, setBusyId] = useState<string | null>(null)
  const me = currentUser()

  const decide = async (a: Approval, decision: 'approve' | 'reject') => {
    let reason = ''
    if (decision === 'reject') {
      const input = window.prompt(`Why are you rejecting ${a.number}?`)
      if (input === null) return
      reason = input.trim()
      if (!reason) {
        setError('A reason is required when rejecting.')
        return
      }
      // The requisition screen asks for a reason somebody can act on, and the
      // server holds this door to the same bar.
      if (a.type === 'MR' && reason.length < 5) {
        setError('Say why it is being refused, in a few words.')
        return
      }
    } else if (!window.confirm(`Approve ${a.number} (${TYPE[a.type].label})?`)) {
      return
    }
    setBusyId(a.id)
    setError(null)
    try {
      await api.post(`/approvals/${a.type}/${a.id}/${decision}`, decision === 'reject' ? { reason } : {})
      // Refetch rather than splice: approving one document can change what else is waiting.
      await reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Could not ${decision} ${a.number}.`)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div>
      {error && <p className="mb-3 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">{error}</p>}
      {!approvals && !error && <div className="skeleton h-32 w-full rounded-lg" />}
      {approvals && approvals.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
          <Inbox size={24} className="text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Nothing is waiting for approval.</p>
        </div>
      )}
      {approvals && approvals.length > 0 && (
        <div className="max-h-[22rem] divide-y divide-border/60 overflow-y-auto pr-1">
          {approvals.map((a) => {
            const t = TYPE[a.type]
            const mine = Boolean(a.raisedById && a.raisedById === me?.id)
            return (
              <div key={`${a.type}-${a.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[10px] font-bold" style={{ background: `${t.colour}1f`, color: t.colour }} title={t.label}>
                  {a.type}
                </span>
                <div className="min-w-0 flex-1 basis-40">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                    <Link href={t.href} className="whitespace-nowrap font-mono font-semibold text-primary hover:underline">
                      {a.number}
                    </Link>
                    {a.urgent && <span className="whitespace-nowrap rounded-full bg-rose-500/15 px-1.5 py-px text-[10px] font-semibold text-rose-500">Waiting long</span>}
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {t.label} · {a.description} · raised {ago(a.date)}
                  </p>
                </div>
                <span className="text-xs font-semibold tabular-nums text-foreground">{a.amount != null && a.amount > 0 ? inr(a.amount) : ''}</span>
                <div className="ml-auto flex items-center gap-1.5">
                  {mine ? (
                    <span className="text-[11px] text-muted-foreground" title="You raised it, so somebody else has to approve it">
                      Yours — someone else approves
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={busyId === a.id}
                      onClick={() => void decide(a, 'approve')}
                      className="flex items-center gap-1 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-500 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
                    >
                      {busyId === a.id ? <Loader2 size={12} className="animate-spin" /> : <PackageCheck size={12} />}
                      Approve
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busyId === a.id}
                    onClick={() => void decide(a, 'reject')}
                    title="Refuse"
                    className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-400 disabled:opacity-50"
                  >
                    <XCircle size={15} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ═════════════════════════════ who has just done what ═════════════════════════════ */

const VERB: Record<string, string> = {
  CREATE: 'added',
  UPDATE: 'changed',
  DELETE: 'removed',
  APPROVE: 'approved',
  REJECT: 'refused',
  CANCEL: 'cancelled',
  RESTORE: 'restored',
}

const THING: Record<string, string> = {
  PurchaseOrder: 'purchase order',
  PurchaseOrderAttachment: 'a file on purchase order',
  GRN: 'goods receipt',
  GRNAttachment: 'a file on goods receipt',
  PurchaseInvoice: 'purchase bill',
  PurchaseNote: 'note',
  PurchaseEnquiry: 'enquiry',
  PurchaseEnquiryQuote: 'quote',
  PurchaseEnquiryAttachment: 'a file on enquiry',
  PurchaseReturn: 'purchase return',
  SupplierPayment: 'supplier payment',
  MaterialRequisition: 'requisition',
  StockTransfer: 'stock transfer',
  StockAdjustment: 'stock count',
  JobWorkChallan: 'job work challan',
  JobWorkReturn: 'job work return',
  CustomerGRN: 'customer material',
  SalesOrder: 'sales order',
  ManufacturingOrder: 'manufacturing order',
  ItemCategory: 'item category',
  BOM: 'bill of materials',
  HsnCode: 'HSN code',
  Warehouse: 'store',
  Unit: 'unit',
  User: 'user',
  Role: 'role',
}
const thing = (t: string) => THING[t] ?? t.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()

/** The latest entries across the system, newest first, in the modules this role may see. */
export function LiveFeed({ feed }: { feed: HomeData['activity']['feed'] }) {
  if (!feed.length)
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
        <Clock size={24} className="text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Nothing has been entered yet.</p>
      </div>
    )
  return (
    // As tall as the card beside it, scrolling for the rest, so a short
    // approvals queue does not leave that card half empty.
    <div className="relative h-full min-h-64">
    <ol className="absolute inset-0 space-y-3 overflow-y-auto pr-1">
      <span className="absolute left-3.5 top-2 h-full w-px bg-border" aria-hidden />
      {feed.map((f) => {
        const m = moduleOf(f.module)
        const initials = f.user
          .split(/\s+/)
          .slice(0, 2)
          .map((w) => w.charAt(0))
          .join('')
          .toUpperCase()
        return (
          <li key={f.id} className="relative flex gap-3">
            <span
              className="relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white ring-4 ring-card"
              style={{ background: m.colour }}
              title={m.label}
            >
              {initials}
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <p className="text-xs leading-snug text-foreground">
                <span className="font-semibold">{f.user}</span> {VERB[f.action] ?? f.action.toLowerCase()} {thing(f.entityType)}
                {f.label && <span className="font-mono text-primary"> {f.label}</span>}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {m.label} · {ago(f.at)}
              </p>
            </div>
          </li>
        )
      })}
    </ol>
    </div>
  )
}
