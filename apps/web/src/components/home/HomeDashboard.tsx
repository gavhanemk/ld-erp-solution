'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import {
  Activity, AlertCircle, BookOpen, Boxes, CalendarDays, CheckCircle2, ClipboardList, Factory, FileCheck2,
  History, IndianRupee, Layers, LineChart, Radar as RadarIcon, RefreshCw, Scale, ShoppingBag, ShoppingCart,
  Truck, TrendingUp, Users, Wallet, Warehouse, Workflow,
} from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { DashCard, EmptyChart, Highlights, KpiTile, SplitBar, TONE, inr } from '@/components/dashboard/DashKit'
import { Sparkline } from '@/components/purchase/PurchaseDashboardCharts'
import {
  ActivityHeatmap, AgeingChart, EfficiencyGauge, FortnightBars, IN, ITEM_TYPE, MODULE, ModuleRadar, OUT, PartnerBars,
  SLATE, StageBar, StockDonut, TrendChart, moduleOf, trendViews,
} from './HomeCharts'
import { ApprovalsPanel, AttentionPanel, LiveFeed, MillFlow, useApprovals } from './HomePanels'
import type { Check, HomeData } from './types'

/**
 * The home screen: the whole mill on one page.
 *
 * It opens on what needs doing — the checks that are not clear, the
 * documents waiting for a signature — then follows the mill from buying to
 * cash, then the detail module by module. Where things stand is as of now;
 * what moved is for the chosen period, against the period before. Every
 * figure opens the screen behind it, and a module this role may not see is
 * left out rather than shown at nought.
 */

const PERIODS = [
  { days: 7, label: '7D' },
  { days: 30, label: '30D' },
  { days: 90, label: '90D' },
  { days: 365, label: '1Y' },
]

/** Ageing buckets, calm to alarming; the last a deeper rose than the kit's. */
const LONG_OVERDUE = '#9f1239'
const AGE_COLOURS = [IN, TONE.amber, TONE.orange, TONE.rose, LONG_OVERDUE]

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Up or down on the period before, quietly — more buying is not good or bad by itself. */
function Delta({ change, words }: { change: number | null; words: string }) {
  if (change == null) return null
  return (
    <span title={`Against ${words}`}>
      {' '}
      · {change >= 0 ? '▲' : '▼'} {Math.abs(Math.round(change * 100))}%
    </span>
  )
}

export function HomeDashboard() {
  const [data, setData] = useState<HomeData | null>(null)
  const [days, setDays] = useState(30)
  const [ready, setReady] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState('')
  const [partners, setPartners] = useState<'suppliers' | 'customers' | ''>('')
  const approvals = useApprovals()

  // The period the address asked for, read once.
  useEffect(() => {
    const d = Number(new URLSearchParams(window.location.search).get('days'))
    if (PERIODS.some((p) => p.days === d)) setDays(d)
    setReady(true)
  }, [])

  const latest = useRef(0)
  const load = useCallback(
    async (quiet = false) => {
      const id = ++latest.current
      if (!quiet) setLoading(true)
      try {
        const res = await api.get<{ data: HomeData }>(`/dashboard/overview?days=${days}`)
        if (id !== latest.current) return
        setData(res.data)
        setError(null)
      } catch (err) {
        if (id !== latest.current) return
        setError(err instanceof ApiError ? err.message : 'Could not reach the server. Is the API running?')
      } finally {
        if (id === latest.current) setLoading(false)
      }
    },
    [days],
  )

  useEffect(() => {
    if (!ready) return
    void load()
    window.history.replaceState(null, '', `${window.location.pathname}?days=${days}`)
    // The floor and the stores key in all day, so a screen left open goes
    // stale quickly. A quiet refresh every minute, without the page dimming.
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void load(true)
      void approvals.reload()
    }, 60_000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, load])

  const refresh = () => {
    void load()
    void approvals.reload()
  }

  const periodWords = days === 365 ? 'the last year' : `the last ${days} days`
  const beforeWords = days === 365 ? 'the year before' : `the ${days} days before`
  const updated = data ? new Date(data.generatedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : null

  const header = (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="page-title">Dashboard</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">LD Cotton Mills at a glance · where things stand now, and what moved over {periodWords}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex h-9 items-center gap-2 rounded-lg border border-border bg-card px-3 text-xs text-muted-foreground shadow-sm" title="Refreshes itself every minute">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
          Live{updated ? ` · ${updated}` : ''}
        </span>
        <div className="flex rounded-lg border border-border bg-card p-0.5 shadow-sm" role="tablist" aria-label="Period">
          {PERIODS.map((p) => (
            <button
              key={p.days}
              type="button"
              role="tab"
              aria-selected={days === p.days}
              onClick={() => setDays(p.days)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                days === p.days ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <button className="btn-ghost h-9" onClick={refresh} disabled={loading} title="Refresh">
          <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
        </button>
      </div>
    </div>
  )

  if (!data)
    return (
      <div className="space-y-5">
        {header}
        {error ? (
          <ErrorBox text={error} />
        ) : (
          <>
            <div className="glass-card h-12 animate-pulse rounded-xl" />
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="glass-card h-32 animate-pulse rounded-xl" />
              ))}
            </div>
            <div className="glass-card h-56 animate-pulse rounded-xl" />
            <div className="grid gap-5 xl:grid-cols-3">
              <div className="glass-card h-80 animate-pulse rounded-xl xl:col-span-2" />
              <div className="glass-card h-80 animate-pulse rounded-xl" />
            </div>
          </>
        )}
      </div>
    )

  const { sales: s, purchase: p, inventory: inv, production: pr, money: m } = data

  /* ── what the checks say, with the approvals queue as one more ── */
  const checks: Check[] = [
    ...(approvals.approvals
      ? [
          {
            key: 'approvals',
            module: 'approvals' as const,
            label: 'Documents waiting for approval',
            clear: 'Nothing is waiting for approval',
            count: approvals.approvals.length,
            value: null,
            tone: 'violet' as const,
            href: null,
          },
        ]
      : []),
    ...data.checks,
  ]
  const toApprovals = () => document.getElementById('approvals')?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  /* ── a few plain sentences about the figures ── */
  const highlights: Array<{ icon: React.ElementType; text: React.ReactNode; tone?: string }> = []
  const urgent = checks.filter((c) => c.count && c.tone === 'rose')
  if (!checks.some((c) => c.count)) highlights.push({ icon: CheckCircle2, tone: TONE.emerald, text: `All ${checks.length} checks are clear` })
  else if (urgent.length)
    highlights.push({
      icon: AlertCircle,
      tone: TONE.rose,
      text: (
        <span>
          <b className="font-semibold">{urgent.reduce((n, c) => n + c.count, 0)}</b> urgent: {urgent[0].label.toLowerCase()}
        </span>
      ),
    })
  if (p?.ordered.value) {
    const top = p.suppliers[0]
    highlights.push({
      icon: ShoppingBag,
      tone: MODULE.purchase.colour,
      text:
        top && p.suppliers.length > 1 ? (
          <span>
            <b className="font-semibold">{top.name}</b> takes {Math.round((top.value / p.ordered.value) * 100)}% of the buying
          </span>
        ) : (
          <span>
            <b className="font-semibold">{inr(p.ordered.value)}</b> bought over {periodWords}
          </span>
        ),
    })
  }
  if (inv?.stockValue && inv.byType[0])
    highlights.push({
      icon: Layers,
      tone: MODULE.inventory.colour,
      text: (
        <span>
          <b className="font-semibold">{inv.byType[0].label}</b> is {Math.round((inv.byType[0].value / inv.stockValue) * 100)}% of the stock value
        </span>
      ),
    })
  if (m?.payable.total)
    highlights.push({
      icon: Wallet,
      tone: TONE.amber,
      text: (
        <span>
          <b className="font-semibold">{inr(m.payable.total)}</b> owed to suppliers · {m.payable.dueWeek ? `${inr(m.payable.dueWeek)} due this week` : 'nothing due this week'}
        </span>
      ),
    })
  const busiest = data.activity.modules[0]
  if (busiest)
    highlights.push({
      icon: TrendingUp,
      tone: moduleOf(busiest.module).colour,
      text: (
        <span>
          <b className="font-semibold">{moduleOf(busiest.module).label}</b> was busiest · {busiest.total} entries
        </span>
      ),
    })

  /* ── the figures that matter most, in the order the mill works ── */
  const tiles: React.ReactNode[] = []
  if (s)
    tiles.push(
      <KpiTile key="book" icon={ShoppingCart} tone={IN} label="Order book" value={inr(s.openValue)} sub={`${plural(s.openOrders, 'open order')}${s.late ? ` · ${s.late} late` : ''}`} href="/sales/orders" title="Confirmed and not yet fully dispatched, before GST">
        <Sparkline data={data.trend.map((t) => t.booked ?? 0)} colour={IN} />
      </KpiTile>,
    )
  if (p)
    tiles.push(
      <KpiTile
        key="buy"
        icon={ShoppingBag}
        tone={MODULE.purchase.colour}
        label="Purchases"
        value={inr(p.ordered.value)}
        sub={
          <>
            {plural(p.ordered.orders, 'order')} over {periodWords.replace('the last ', '')}
            <Delta change={p.ordered.change} words={beforeWords} />
          </>
        }
        href="/purchase/dashboard"
        title="Ordered in the period, before GST"
      >
        <Sparkline data={data.trend.map((t) => t.ordered ?? 0)} colour={MODULE.purchase.colour} />
      </KpiTile>,
    )
  if (inv)
    tiles.push(
      <KpiTile
        key="stock"
        icon={Warehouse}
        tone={MODULE.inventory.colour}
        label="Stock value"
        value={inr(inv.stockValue)}
        sub={`${plural(inv.items, 'item')}${inv.toReorder ? ` · ${inv.toReorder} to reorder` : ''}`}
        href="/inventory/dashboard"
      >
        <SplitBar parts={inv.byType.map((t) => ({ value: t.value, colour: ITEM_TYPE[t.type] ?? SLATE, label: `${t.label}: ${inr(t.value)}` }))} />
      </KpiTile>,
    )
  if (pr)
    tiles.push(
      <KpiTile
        key="made"
        icon={Factory}
        tone={MODULE.production.colour}
        label="Made today"
        value={pr.today.achieved.toLocaleString('en-IN')}
        sub={pr.today.target ? `of ${pr.today.target.toLocaleString('en-IN')} target · ${pr.today.efficiency}%` : 'no target set today'}
        href="/production/orders"
      >
        <Sparkline data={pr.fortnight.map((f) => f.achieved)} colour={MODULE.production.colour} />
      </KpiTile>,
    )
  if (m) {
    const ageBar = (a: typeof m.receivable) => (
      <SplitBar parts={a.buckets.map((b, i) => ({ value: b.value, colour: AGE_COLOURS[i], label: `${b.label}: ${inr(b.value)}` }))} />
    )
    tiles.push(
      <KpiTile
        key="collect"
        icon={IndianRupee}
        tone={IN}
        label="To collect"
        value={inr(m.receivable.total)}
        valueClass={m.receivable.overdue ? 'text-rose-500' : 'text-foreground'}
        sub={m.receivable.overdue ? `${inr(m.receivable.overdue)} overdue` : 'nothing overdue'}
      >
        {ageBar(m.receivable)}
      </KpiTile>,
      <KpiTile
        key="pay"
        icon={Wallet}
        tone={OUT}
        label="To pay"
        value={inr(m.payable.total)}
        sub={m.payable.overdue ? `${inr(m.payable.overdue)} overdue` : m.payable.dueWeek ? `${inr(m.payable.dueWeek)} due this week` : 'nothing due this week'}
        href="/reports/supplier-outstanding"
      >
        {ageBar(m.payable)}
      </KpiTile>,
    )
  }
  // Fewer modules, other figures, so the row is never thin.
  if (inv)
    tiles.push(
      <KpiTile key="mr" icon={ClipboardList} tone={TONE.violet} label="Requisitions waiting" value={String(inv.mrPending + inv.mrToIssue)} sub={`${inv.mrPending} to approve · ${inv.mrToIssue} to issue`} href="/inventory/requisitions">
        <SplitBar parts={[{ value: inv.mrPending, colour: TONE.violet, label: 'to approve' }, { value: inv.mrToIssue, colour: TONE.blue, label: 'to issue' }]} />
      </KpiTile>,
      <KpiTile key="jw" icon={Truck} tone={TONE.sky} label="Out at job workers" value={String(inv.jobWorkOpen)} valueClass={inv.jobWorkLate ? 'text-rose-500' : 'text-foreground'} sub={inv.jobWorkLate ? `${inv.jobWorkLate} past the return date` : 'challans still open'} href="/inventory/job-work" />,
    )
  if (p)
    tiles.push(
      <KpiTile key="open-po" icon={ShoppingBag} tone={TONE.sky} label="Open purchase orders" value={String(p.openOrders)} sub={`${inr(p.openValue)} still to arrive`} href="/purchase/dashboard" />,
    )

  /* ── the trend card's views, as far as this role may see ── */
  const views = trendViews(data)
  const current = views.find((v) => v.key === view) ?? views.find((v) => v.series.some((x) => data.trend.some((t) => Number(t[x.key] ?? 0) > 0))) ?? views[0]
  const bucketWord = data.period.bucket === 'day' ? 'day' : data.period.bucket === 'week' ? 'week' : 'month'

  const partnerTab = partners || (p?.suppliers.length || !s ? 'suppliers' : 'customers')
  const productionEmpty = Boolean(pr && !pr.stages.some((st) => st.count) && !pr.fortnight.some((f) => f.target || f.achieved))
  // With nothing on the floor yet, the stock card has the room.
  const stockWide = !pr || productionEmpty

  return (
    <div className="space-y-5">
      {header}
      {error && <ErrorBox text={error} />}

      <div className={`space-y-5 transition-opacity ${loading ? 'opacity-60' : ''}`}>
        <Highlights items={highlights.slice(0, 5)} />

        {tiles.length > 0 && <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">{tiles.slice(0, 6)}</div>}

        {/* ── The mill as one flow ── */}
        <DashCard
          icon={Workflow}
          title="How the mill is flowing"
          hint={`From buying to cash — what moved through each stage over ${periodWords}, and where each stands right now`}
          className="bg-gradient-to-br from-primary/5 via-transparent to-transparent"
        >
          <MillFlow data={data} />
        </DashCard>

        {/* ── What needs a look, and the business over time ── */}
        <div className="grid gap-5 xl:grid-cols-3">
          <DashCard icon={Activity} title="Needs a look" hint="Checks run across every module, as of now">
            <AttentionPanel checks={checks} onApprovals={toApprovals} />
          </DashCard>
          <DashCard className="xl:col-span-2" icon={LineChart} title="The business over time" hint={current ? `${current.hint} · each ${bucketWord}` : undefined}>
            {current ? (
              <>
                <div className="mb-4 inline-flex max-w-full overflow-x-auto rounded-lg border border-border bg-secondary p-0.5 text-xs">
                  {views.map((v) => (
                    <button
                      key={v.key}
                      type="button"
                      onClick={() => setView(v.key)}
                      className={`whitespace-nowrap rounded-md px-3 py-1 font-medium transition-colors ${
                        current.key === v.key ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {v.label}
                    </button>
                  ))}
                </div>
                <TrendChart data={data.trend} view={current} />
              </>
            ) : (
              <EmptyChart h={250} text="Your role does not include any module with a trend to show." />
            )}
          </DashCard>
        </div>

        {/* ── Waiting for a signature, and what just happened ── */}
        <div className="grid gap-5 xl:grid-cols-3">
          <div id="approvals" className="scroll-mt-4 xl:col-span-2">
            <DashCard
              className="h-full"
              icon={FileCheck2}
              title="Waiting for approval"
              hint={
                approvals.approvals
                  ? `${plural(approvals.approvals.length, 'document')} waiting · approve here, or open the document first`
                  : 'Purchase orders, sales orders and requisitions waiting for a sign-off'
              }
            >
              <ApprovalsPanel {...approvals} />
            </DashCard>
          </div>
          <DashCard icon={History} title="Just happened" hint="The latest entries across the system">
            <LiveFeed feed={data.activity.feed} />
          </DashCard>
        </div>

        {/* ── Money either way, order books, partners ── */}
        {(m || s || p) && (
          <div className="grid gap-5 lg:grid-cols-2 xl:grid-cols-3">
            {m && (
              <DashCard icon={Scale} title="Who owes whom" hint="What we owe and what we are owed, by how late it is" href="/reports/supplier-outstanding" hrefLabel="Outstanding">
                <AgeingChart receivable={m.receivable} payable={m.payable} />
              </DashCard>
            )}
            {(s || p) && (
              <DashCard icon={BookOpen} title="Order books" hint="Every order by stage, first to last, with the value in each (before GST)">
                <div className="space-y-5">
                  {s && <StageBar title="Sales orders" stages={s.status} empty="No sales orders yet." />}
                  {p && <StageBar title="Purchase orders" stages={p.status} empty="No purchase orders yet." />}
                  <div className="grid grid-cols-2 gap-3 border-t border-border/60 pt-4">
                    {s && (
                      <Link href="/sales/orders" className="rounded-lg p-2 transition-colors hover:bg-secondary">
                        <p className="text-[11px] text-muted-foreground">Sales in hand</p>
                        <p className="text-base font-semibold tabular-nums text-foreground">{inr(s.openValue)}</p>
                        <p className="text-[11px] text-muted-foreground">{s.dueWeek ? `${s.dueWeek} due this week` : `${plural(s.openOrders, 'order')} open`}</p>
                      </Link>
                    )}
                    {p && (
                      <Link href="/purchase/dashboard" className="rounded-lg p-2 transition-colors hover:bg-secondary">
                        <p className="text-[11px] text-muted-foreground">Goods still to come</p>
                        <p className="text-base font-semibold tabular-nums text-foreground">{inr(p.openValue)}</p>
                        <p className="text-[11px] text-muted-foreground">{p.late ? <span className="text-rose-500">{p.late} late</span> : `${plural(p.openOrders, 'order')} open`}</p>
                      </Link>
                    )}
                  </div>
                </div>
              </DashCard>
            )}
            {(s || p) && (
              <DashCard
                icon={Users}
                title="Biggest partners"
                hint={`By order value over ${periodWords}, before GST`}
              >
                {s && p && (
                  <div className="mb-3 inline-flex rounded-lg border border-border bg-secondary p-0.5 text-xs">
                    {(['suppliers', 'customers'] as const).map((k) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setPartners(k)}
                        className={`rounded-md px-2.5 py-1 font-medium capitalize transition-colors ${partnerTab === k ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                      >
                        {k}
                      </button>
                    ))}
                  </div>
                )}
                {partnerTab === 'suppliers' && p ? (
                  <PartnerBars data={p.suppliers} colour={MODULE.purchase.colour} empty="Nothing was ordered in this period." />
                ) : (
                  <PartnerBars data={s?.customers ?? []} colour={IN} empty="No sales orders were booked in this period." />
                )}
              </DashCard>
            )}
          </div>
        )}

        {/* ── The floor and the stores ── */}
        {(pr || inv) && (
          <div className="grid gap-5 xl:grid-cols-3">
            {pr && (
              <DashCard
                className={productionEmpty ? 'order-last' : inv ? 'xl:col-span-2' : 'xl:col-span-3'}
                icon={Factory}
                title="Production floor"
                hint="Today's efficiency, the last two weeks against target, and where the manufacturing orders are"
                href="/production/orders"
                hrefLabel="Orders"
              >
                {productionEmpty ? (
                  <div className="flex h-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border px-6 py-10 text-center">
                    <span className="flex h-12 w-12 items-center justify-center rounded-xl" style={{ background: `${MODULE.production.colour}1f`, color: MODULE.production.colour }}>
                      <Factory size={22} />
                    </span>
                    <p className="text-sm font-medium text-foreground">Production is not being logged yet</p>
                    <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
                      Once manufacturing orders are released and the floor enters its output, today&apos;s efficiency, line by line, and the last two weeks will show here.
                    </p>
                    <Link href="/production/orders" className="btn-secondary h-8 text-xs">
                      Manufacturing orders
                    </Link>
                  </div>
                ) : (
                  <div className="space-y-5">
                    <div className="grid gap-5 md:grid-cols-3">
                      <div className="flex flex-col items-center justify-center">
                        <EfficiencyGauge efficiency={pr.today.efficiency} achieved={pr.today.achieved} target={pr.today.target} />
                        <div className="mt-3 w-full space-y-1.5">
                          {pr.lines.slice(0, 4).map((l) => (
                            <div key={l.line} className="flex items-center gap-2 text-[11px]">
                              <span className="w-20 truncate text-foreground" title={l.isJobWork ? 'Job work unit' : 'Our own line'}>
                                {l.line}
                              </span>
                              <div className="h-1.5 flex-1 rounded-full bg-secondary">
                                <div className="h-1.5 rounded-full" style={{ width: `${Math.min(100, l.efficiency ?? 0)}%`, background: MODULE.production.colour }} />
                              </div>
                              <span className="w-9 text-right tabular-nums text-muted-foreground">{l.efficiency == null ? '—' : `${l.efficiency}%`}</span>
                            </div>
                          ))}
                          {pr.today.rejection > 0 && (
                            <p className="pt-1 text-center text-[11px] text-rose-500">{pr.today.rejection.toLocaleString('en-IN')} pieces rejected today</p>
                          )}
                        </div>
                      </div>
                      <div className="md:col-span-2">
                        <FortnightBars data={pr.fortnight} />
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-4">
                      {pr.stages
                        .filter((st) => !['DRAFT', 'CLOSED'].includes(st.status))
                        .map((st, i, all) => (
                          <span key={st.status} className="flex items-center gap-1.5">
                            <span
                              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] ${st.count ? 'border-transparent font-semibold text-foreground' : 'border-border text-muted-foreground'}`}
                              style={st.count ? { background: `${MODULE.production.colour}1f` } : undefined}
                            >
                              {st.label}
                              <span className="tabular-nums">{st.count}</span>
                            </span>
                            {i < all.length - 1 && <span className="text-muted-foreground">›</span>}
                          </span>
                        ))}
                    </div>
                  </div>
                )}
              </DashCard>
            )}
            {inv && (
              <DashCard
                className={!pr ? 'xl:col-span-3' : stockWide ? 'xl:col-span-2' : ''}
                icon={Boxes}
                title="What the stock is"
                hint="Value by kind of item, and the lowest stock against its reorder level"
                href="/inventory/dashboard"
                hrefLabel="Stores"
              >
                <div className={stockWide ? 'grid gap-6 md:grid-cols-2' : ''}>
                <StockDonut data={inv.byType} total={inv.stockValue} />
                {inv.reorder.length > 0 && (
                  <div className={stockWide ? 'space-y-2.5 md:border-l md:border-border/60 md:pl-6' : 'mt-4 space-y-2.5 border-t border-border/60 pt-4'}>
                    {stockWide && <p className="text-xs font-medium text-foreground">Lowest stock</p>}
                    {inv.reorder.slice(0, stockWide ? 6 : 4).map((r) => (
                      <Link key={r.itemId} href={`/inventory/stock/${r.itemId}`} className="block">
                        <div className="flex items-baseline justify-between gap-2 text-xs">
                          <span className="min-w-0 truncate text-foreground hover:text-primary">{r.name}</span>
                          <span className="shrink-0 tabular-nums text-muted-foreground">
                            {r.onHand.toLocaleString('en-IN')} / {r.reorderLevel.toLocaleString('en-IN')} {r.uom}
                          </span>
                        </div>
                        <div className="mt-1 h-1.5 rounded-full bg-secondary">
                          <div
                            className="h-1.5 rounded-full"
                            style={{ width: `${Math.max(2, Math.min(100, r.cover))}%`, background: r.cover < 25 ? TONE.rose : r.cover < 75 ? TONE.amber : TONE.emerald }}
                          />
                        </div>
                      </Link>
                    ))}
                    {inv.toReorder > (stockWide ? 6 : 4) && (
                      <Link href="/inventory/stock?low=true" className="block pt-1 text-xs font-medium text-primary hover:underline">
                        All {inv.toReorder} items to reorder
                      </Link>
                    )}
                  </div>
                )}
                </div>
              </DashCard>
            )}
          </div>
        )}

        {/* ── The rhythm of the place ── */}
        <div className="grid gap-5 xl:grid-cols-3">
          <DashCard className="xl:col-span-2" icon={CalendarDays} title="Mill activity" hint="Every entry across the system, a square a day, over the last twelve weeks — point at a day for its detail">
            <ActivityHeatmap data={data.activity.heat} />
          </DashCard>
          <DashCard icon={RadarIcon} title="Where the work happens" hint={`Entries made in each module over ${periodWords}`}>
            <ModuleRadar data={data.activity.modules} />
            {data.activity.modules.length > 0 && (
              <div className="mt-2 divide-y divide-border/60">
                {data.activity.modules.map((mod) => (
                  <div key={mod.module} className="flex items-center gap-2 py-1.5 text-[11px]">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: moduleOf(mod.module).colour }} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-foreground">{moduleOf(mod.module).label}</span>
                      <span className="block truncate text-muted-foreground">
                        {mod.created} added · {mod.changed} changed
                        {mod.approved ? ` · ${mod.approved} signed off` : ''}
                        {mod.removed ? ` · ${mod.removed} removed` : ''}
                      </span>
                    </span>
                    <span className="text-sm font-semibold tabular-nums text-foreground">{mod.total}</span>
                  </div>
                ))}
              </div>
            )}
          </DashCard>
        </div>
      </div>
    </div>
  )
}

function ErrorBox({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3">
      <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
      <p className="text-sm text-red-400">{text}</p>
    </div>
  )
}
