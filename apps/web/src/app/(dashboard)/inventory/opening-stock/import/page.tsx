'use client'

import { Suspense, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  AlertCircle,
  Asterisk,
  CalendarDays,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Info,
  Layers,
  ListChecks,
  Loader2,
  PackagePlus,
  PenLine,
  Printer,
  Rows3,
  ShieldCheck,
  Upload,
} from 'lucide-react'
import { api, ApiError, can, tokens } from '@/lib/api'
import { cn, newRequestId } from '@/lib/utils'
import { KINDS, money, num, todayInIndia, type Kind } from '@/components/inventory/opening/kinds'
import { Banner, ChoiceCard, DoneCard, PageHead, Panel, StatTile, Stats } from '@/components/inventory/opening/Frame'
import { StickersReady } from '@/components/packages/StickersReady'
import { PackagingDialog, packInputOf, packValueOf, type PackInputBody } from '@/components/packages/PackagingEditor'
import { useQtyRules } from '@/lib/qtyRules'

/*
 * Inventory → Opening Stock → Import from Excel, step by step: what the sheet
 * holds (each kind has its own template; the mill's 19-column sheet holds all
 * three), then the template and the upload, then every row checked against
 * the masters — those to correct shown with what is wrong and an error report
 * to fix and upload again — and nothing brought in until every row is right.
 */

type Choice = Kind | 'ALL'
interface RowPlan {
  row: number
  skipped: boolean
  problems: string[]
  stage: string | null
  process: string
  location: string
  newFloor: boolean
  item: { code: string; name: string } | null
  /** Not in Items & Products yet: made on import, with its own code. */
  newItem?: { key: string; name: string; category: string; unit: string; type: string; tax: string; approved: boolean; copiedFrom: string | null } | null
  /** Named an item not in Items & Products, and matched to this one instead. */
  matched?: { key: string; name: string } | null
  /** No rate: in at nought, its value to be set later. */
  valuationPending?: boolean
  size: string | null
  order: string | null
  lot: string | null
  bundle: string | null
  qty: number | null
  unit: string | null
  rate: number | null
  value: number | null
  status: string
  /** Raw materials labelled by package: what its stickers will be. */
  packing?: string | null
  stickers?: number
  /** The same, to start a change from. */
  pack?: { type: string; qtys: number[]; later: boolean; count: number | null; barcode: string | null } | null
}
interface Summary {
  rows: number
  lines: number
  skipped: number
  problems: number
  value: number
  floorsToMake: string[]
  /** Items not in Items & Products yet, made on import. */
  itemsToMake?: Array<{ name: string; category: string; unit: string }>
  /** Each item the sheet names that is not in Items & Products: to make, or matched to one already there. */
  decisions?: Decision[]
  /** New items still to approve or match. */
  undecided?: number
  /** Lines coming in without a rate. */
  valuationPending?: number
  byGroup: Array<{ group: string; label: string; lines: number; value: number }>
  /** Stickers to print; packages keeping their own barcode; rows whose packaging is pending. */
  stickers?: number
  kept?: number
  waiting?: number
}
interface Decision {
  key: string
  name: string
  category: string
  unit: string
  tax: string
  similar: Array<{ id: string; code: string; name: string }>
  decision: 'PENDING' | 'NEW' | 'MATCHED'
  matched: { code: string; name: string } | null
}
interface Done {
  id: string
  number: string
  lines: number
  stickers: number
  /** Packages keeping a lot's own barcode: nothing to print for them. */
  kept?: number
  floorsMade: string[]
  /** Items made on import, with the codes the ERP gave them. */
  itemsMade?: Array<{ code: string; name: string }>
  again?: boolean
}

const STEPS = ['Upload Excel', 'Validate data', 'Resolve new items', 'Review stock & packaging', 'Confirm import', 'Import completed']
const ALL = { key: 'ALL' as const, label: 'All in one sheet', short: '19 columns', text: "Your standard 19-column opening stock sheet, Opening Date to Remarks: finished goods, semi-finished goods and raw materials together.", icon: Rows3 }

/** Each template's columns as the sheet has them, those that must be filled marked. */
const COLUMNS: Record<Choice, Array<[string, boolean]>> = {
  ALL: [
    ['Opening Date', true], ['Process', false], ['Department / Location', false], ['Order No.', false], ['Style / Article No.', false], ['Item Code', false],
    ['Item Description', true], ['Item Category', false], ['Fabric / Material', false], ['Colour', false], ['Size', false], ['Lot / Batch / Roll No.', false],
    ['Bundle / Barcode No.', false], ['UOM', false], ['Opening Qty', true], ['Unit Rate', false], ['Opening Value', false], ['Stock Status', false], ['Remarks', false],
    ['HSN Code', false], ['GST %', false],
  ],
  FG: [['Style / Article No.', true], ['Item Code', false], ['Colour', true], ['Size', true], ['Opening Quantity', true], ['Rate Per Piece', false], ['Location', false], ['Stock Status', false], ['Remarks', false]],
  SFG: [
    ['Style / Article No.', true], ['Process', true], ['Colour', true], ['Size', true], ['Opening Quantity', true], ['Rate / Valuation', false], ['Department', false],
    ['Location', false], ['Order Reference', false], ['Batch / Bundle Reference', false], ['Stock Status', false], ['Remarks', false],
  ],
  RM: [
    ['Material Category', false], ['Item Code', false], ['Item Name', true], ['Lot / Batch / Roll Number', false], ['Bundle / Barcode Number', false], ['UOM', false],
    ['Opening Quantity', true], ['Unit Rate', false], ['Location', false], ['Package Type', false], ['Package Count', false], ['Qty per Package', false],
    ['Package Quantities', false], ['Package References', false], ['Stock Status', false], ['Remarks', false], ['HSN Code', false], ['GST %', false],
  ],
  FA: [
    ['Asset Category', false], ['Item Code', false], ['Item Name', true], ['Serial Numbers', false], ['Quantity', true], ['Cost Each', false], ['Location', false],
    ['Stock Status', false], ['Remarks', false], ['HSN Code', false], ['GST %', false],
  ],
}
/** What each template is for, in a line. */
const ABOUT: Record<Choice, string> = {
  ALL: 'Finished goods, semi-finished goods and raw materials together, as your own sheet holds them.',
  FG: 'One row per style, colour and size, in a finished goods store.',
  SFG: "One row per style, process, colour and size. The process must be on the style's route.",
  RM: 'One row per item and lot or roll, in its own unit. How it is packed is optional.',
  FA: 'One row per item and place — a store, or the department it is installed at. Each one gets its own asset tag.',
}

const asBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:.*?;base64,/, ''))
    reader.onerror = () => reject(new Error('The file could not be read.'))
    reader.readAsDataURL(file)
  })

/** A file from the API, fetched with the sign-in token and handed to the browser. */
async function download(path: string, init?: { body: unknown }) {
  const base = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:5000/api'
  const res = await fetch(`${base}${path}`, {
    method: init ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${tokens.access() ?? ''}`, ...(init ? { 'Content-Type': 'application/json' } : {}) },
    body: init ? JSON.stringify(init.body) : undefined,
  })
  if (!res.ok) {
    let message = `The file could not be made (${res.status}).`
    try {
      message = ((await res.json()) as { message?: string }).message ?? message
    } catch {
      // Not JSON: the status says it.
    }
    throw new Error(message)
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'opening-stock.xlsx'
  const url = URL.createObjectURL(await res.blob())
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function ImportOpeningStockPage() {
  return (
    <Suspense fallback={null}>
      <ImportOpeningStock />
    </Suspense>
  )
}

function ImportOpeningStock() {
  const params = useSearchParams()
  const router = useRouter()
  const choice = ((['FG', 'SFG', 'RM', 'ALL'] as const).find((c) => c === params.get('type')) ?? null) as Choice | null
  const kind = choice && choice !== 'ALL' ? KINDS.find((k) => k.key === choice)! : null
  const shown = choice === 'ALL' ? ALL : kind
  const [date, setDate] = useState(todayInIndia)
  const [file, setFile] = useState<{ name: string; data: string } | null>(null)
  const [requestKey, setRequestKey] = useState(newRequestId)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [rows, setRows] = useState<RowPlan[]>([])
  const [only, setOnly] = useState<'all' | 'bad' | 'good'>('all')
  const [busy, setBusy] = useState<null | 'template' | 'check' | 'report' | 'import'>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<Done | null>(null)
  const [printing, setPrinting] = useState(false)
  // A sheet being dragged over the drop box.
  const [over, setOver] = useState(false)
  // Packing changed on the review, by sheet row: sent with the check and the import.
  const [packs, setPacks] = useState<Record<string, PackInputBody>>({})
  // Each new item: 'NEW' to make it, or the id of an item already there to use instead.
  const [resolve, setResolve] = useState<Record<string, string>>({})
  const [packing, setPacking] = useState<RowPlan | null>(null)
  const qtyRules = useQtyRules()
  const input = useRef<HTMLInputElement>(null)
  const results = useRef<HTMLDivElement>(null)
  const mayImport = can('inventory', 'create')

  const body = (extra: Record<string, unknown> = {}) => ({
    fileName: file?.name,
    file: file?.data,
    ...(choice && choice !== 'ALL' ? { kind: choice, openingDate: date } : {}),
    ...(Object.keys(packs).length ? { packs } : {}),
    ...(Object.keys(resolve).length ? { resolve } : {}),
    ...extra,
  })

  const check = async (f: { name: string; data: string }, onDate = date, withPacks = packs, withResolve = resolve, scroll = true) => {
    setBusy('check')
    setError(null)
    try {
      const res = await api.post<{ data: { summary: Summary; rows: RowPlan[] } }>('/inventory/opening-stock/import', {
        fileName: f.name,
        file: f.data,
        ...(choice && choice !== 'ALL' ? { kind: choice, openingDate: onDate } : {}),
        ...(Object.keys(withPacks).length ? { packs: withPacks } : {}),
        ...(Object.keys(withResolve).length ? { resolve: withResolve } : {}),
      })
      setSummary(res.data.summary)
      setRows(res.data.rows)
      if (scroll) setOnly(res.data.summary.problems ? 'bad' : 'all')
      // The answer, brought into view under the upload.
      if (scroll) setTimeout(() => results.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not check the sheet.')
    } finally {
      setBusy(null)
    }
  }

  const choose = async (picked: File | undefined) => {
    if (!picked) return
    try {
      const f = { name: picked.name, data: await asBase64(picked) }
      setFile(f)
      setRequestKey(newRequestId())
      // A new sheet: changes made on the last one's rows, and decisions on its items, do not carry over.
      setPacks({})
      setResolve({})
      setSummary(null)
      setRows([])
      await check(f, date, {}, {})
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The file could not be read.')
    } finally {
      if (input.current) input.current.value = ''
    }
  }

  const bringIn = async () => {
    if (!file || !summary || summary.problems) return
    setBusy('import')
    setError(null)
    try {
      const res = await api.post<{ data: Done }>('/inventory/opening-stock/import', body({ confirm: true, requestKey }))
      setDone(res.data)
      // Stickers made as it came in: here they are to print.
      if (res.data.stickers > 0) setPrinting(true)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not import the sheet.')
    } finally {
      setBusy(null)
    }
  }

  const getTemplate = async () => {
    if (!choice) return
    setBusy('template')
    setError(null)
    try {
      await download(`/inventory/opening-stock/import-template${choice === 'ALL' ? '' : `?type=${choice}`}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The template could not be made.')
    } finally {
      setBusy(null)
    }
  }

  const undecided = summary?.undecided ?? 0
  const decide = (next: Record<string, string>) => {
    setResolve(next)
    if (file) void check(file, date, packs, next, false)
  }
  // Upload, validate, resolve new items, review, confirm, done — as far as this sheet has got.
  const stepIndex = done ? 5 : busy === 'import' ? 4 : !summary ? 0 : summary.problems ? 1 : undecided ? 2 : 3
  const listed = rows.filter((r) => !r.skipped && (only === 'all' || (only === 'bad' ? r.problems.length > 0 : r.problems.length === 0)))
  const ready = summary ? summary.lines : 0
  const checkedRows = summary ? summary.rows - summary.skipped : 0

  return (
    <div className="space-y-5" style={{ ['--field' as string]: 'var(--card)' }}>
      <PageHead
        title={`Import Opening Stock${shown ? ` — ${shown.label}` : ''}`}
        subtitle={!choice ? 'Bring in the stock you had on the day from an Excel sheet. Pick what the sheet holds.' : ABOUT[choice]}
        steps={STEPS}
        current={stepIndex}
      />

      {!mayImport && <Banner tone="warn">Importing opening stock needs Inventory → create. Ask an administrator for it.</Banner>}
      {error && <Banner tone="bad">{error}</Banner>}

      {/* 1. What the sheet holds. */}
      {!choice && (
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
            {[...KINDS, ALL].map((t) => (
              <ChoiceCard
                key={t.key}
                icon={t.icon}
                label={t.label}
                short={t.short}
                text={t.text}
                cta="Use this template"
                ariaLabel={`Import ${t.label}`}
                onClick={() => router.push(`/inventory/opening-stock/import?type=${t.key}`)}
              >
                <p className="text-muted-foreground text-xs">
                  {COLUMNS[t.key].length} columns · {COLUMNS[t.key].filter(([, must]) => must).length} must be filled
                </p>
              </ChoiceCard>
            ))}
          </div>
          <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
            <PenLine size={14} /> Only a few lines?{' '}
            <Link href="/inventory/opening-stock/new" className="text-primary font-medium hover:underline">
              Add them by hand instead
            </Link>
          </p>
        </div>
      )}

      {/* 2. Template, date and upload; then 3. the rows. */}
      {choice && !done && (
        <>
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_19rem]">
            <Panel icon={FileSpreadsheet} title="Prepare and upload the sheet" description="Three steps: the template, then the date, then the filled sheet." label="Template and upload">
              <div className="divide-border divide-y">
                <StepRow
                  n={1}
                  title="Download the template"
                  text={`${COLUMNS[choice].length} columns, with dropdowns from your masters, an example on row 2 and a "How to fill" sheet.`}
                  action={
                    <button type="button" className="btn-secondary h-9 text-sm" disabled={busy !== null} onClick={() => void getTemplate()}>
                      {busy === 'template' ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />} Download the {shown?.label} template
                    </button>
                  }
                >
                  <ul className="flex flex-wrap gap-1.5" aria-label="Columns in the template">
                    {COLUMNS[choice].map(([name, must]) => (
                      <li
                        key={name}
                        className={cn(
                          'rounded-md border px-2 py-0.5 text-[11px]',
                          must ? 'border-primary/40 bg-primary/10 text-primary font-semibold' : 'border-border text-muted-foreground',
                        )}
                      >
                        {name}
                        {must && ' *'}
                      </li>
                    ))}
                  </ul>
                  <p className="text-muted-foreground text-[11px]">
                    <span className="text-primary font-semibold">*</span> must be filled · every other column is optional
                  </p>
                </StepRow>

                {choice !== 'ALL' && (
                  <StepRow n={2} title="Opening date" text="One date for every row of this sheet: the day the stock was counted.">
                    <div className="relative w-56">
                      <CalendarDays size={15} className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 -translate-y-1/2" />
                      <input
                        type="date"
                        className="form-input h-10 pl-9"
                        value={date}
                        max={todayInIndia()}
                        onChange={(e) => {
                          setDate(e.target.value)
                          if (file) void check(file, e.target.value)
                        }}
                        aria-label="Opening date"
                      />
                    </div>
                  </StepRow>
                )}

                <StepRow n={choice === 'ALL' ? 2 : 3} title="Upload the filled sheet" text="Every row is checked against your masters before anything is brought in.">
                  <input ref={input} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => void choose(e.target.files?.[0])} aria-label="Choose the sheet" />
                  <div
                    onDragOver={(e) => {
                      e.preventDefault()
                      if (!over) setOver(true)
                    }}
                    onDragLeave={() => setOver(false)}
                    onDrop={(e) => {
                      e.preventDefault()
                      setOver(false)
                      if (mayImport && busy === null) void choose(e.dataTransfer.files?.[0])
                    }}
                    className={cn(
                      'flex flex-wrap items-center gap-4 rounded-xl border-2 border-dashed px-5 py-5 transition-colors',
                      over ? 'border-primary bg-primary/5' : file ? 'border-primary/30 bg-primary/[0.03]' : 'border-border',
                    )}
                  >
                    <span className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-full', file ? 'bg-emerald-500/15 text-emerald-500' : 'bg-primary/10 text-primary')}>
                      {busy === 'check' ? <Loader2 size={20} className="animate-spin" /> : file ? <FileSpreadsheet size={20} /> : <Upload size={20} />}
                    </span>
                    <div className="min-w-0 flex-1">
                      {file ? (
                        <>
                          <p className="text-foreground truncate text-sm font-semibold">{file.name}</p>
                          <p className="text-muted-foreground text-xs">
                            {busy === 'check'
                              ? 'Checking every row…'
                              : summary
                                ? `Checked: ${checkedRows} ${checkedRows === 1 ? 'row' : 'rows'}. Corrected it? Upload it again.`
                                : 'Not checked yet.'}
                          </p>
                        </>
                      ) : (
                        <>
                          <p className="text-foreground text-sm font-semibold">Drop the filled sheet here</p>
                          <p className="text-muted-foreground text-xs">.xlsx or .csv · up to 3,000 rows</p>
                        </>
                      )}
                    </div>
                    <button type="button" className="btn-primary h-9 text-sm" disabled={busy !== null || !mayImport} onClick={() => input.current?.click()}>
                      <Upload size={15} /> {file ? 'Upload a corrected sheet' : 'Choose the sheet'}
                    </button>
                  </div>
                </StepRow>
              </div>
            </Panel>

            <Panel icon={Info} title="Good to know" label="Good to know">
              <ul className="space-y-3.5 text-xs">
                <Tip icon={Asterisk}>Columns marked * must be filled. Every other column is optional.</Tip>
                <Tip icon={ListChecks}>Row 2 is a grey example and is never brought in. Add your stock from row 3, or delete row 2 first.</Tip>
                <Tip icon={PackagePlus}>Item Code can stay empty. An item not in Items &amp; Products yet is made on import, with its own code — the check lists it first.</Tip>
                <Tip icon={ShieldCheck}>Nothing is brought in until every row is right. Rows to correct are shown with what is wrong.</Tip>
                <Tip icon={Layers}>Up to 3,000 rows per upload. A bigger stock goes in several uploads.</Tip>
              </ul>
              <Link href="/inventory/opening-stock/new" className="text-primary border-border mt-5 flex items-center gap-1.5 border-t pt-4 text-xs font-semibold hover:underline">
                <PenLine size={13} /> Only a few lines? Add them by hand
              </Link>
            </Panel>
          </div>

          <div ref={results} className="scroll-mt-4" />
          {summary && (summary.decisions?.length ?? 0) > 0 && (
            <ResolvePanel
              decisions={summary.decisions!}
              resolve={resolve}
              undecided={undecided}
              busy={busy !== null}
              onDecide={(key, value) => decide({ ...resolve, [key]: value })}
              onApproveAll={() => decide({ ...resolve, ...Object.fromEntries(summary.decisions!.filter((d) => !resolve[d.key]).map((d) => [d.key, 'NEW'])) })}
            />
          )}
          {summary && (
            <Panel
              icon={summary.problems ? AlertCircle : CheckCircle2}
              title={
                summary.problems ? (
                  <span className="text-red-400">
                    {summary.problems} {summary.problems === 1 ? 'row' : 'rows'} of {checkedRows} {summary.problems === 1 ? 'needs' : 'need'} correcting · {ready} ready
                  </span>
                ) : (
                  <span className="text-emerald-500">
                    All {ready} {ready === 1 ? 'row is' : 'rows are'} right
                  </span>
                )
              }
              description={summary.problems ? 'Nothing is imported until every row is right.' : 'Look them over, then confirm the import at the bottom.'}
              label="Check"
              actions={
                <div className="border-border bg-secondary flex rounded-lg border p-0.5 text-xs" role="tablist" aria-label="Rows">
                  {(
                    [
                      { key: 'all', label: `All (${checkedRows})` },
                      { key: 'bad', label: `To correct (${summary.problems})` },
                      { key: 'good', label: `Ready (${ready})` },
                    ] as const
                  ).map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      role="tab"
                      aria-selected={only === t.key}
                      onClick={() => setOnly(t.key)}
                      className={cn('rounded-md px-2.5 py-1', only === t.key ? 'bg-card text-foreground font-medium shadow-sm' : 'text-muted-foreground')}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              }
              bodyClassName="space-y-4"
            >
              <Stats label="Sheet figures">
                <StatTile label="Rows checked" value={num(checkedRows)} hint={summary.skipped ? `${summary.skipped} empty left out` : undefined} />
                <StatTile label="Ready" value={num(ready)} tone={ready ? 'good' : undefined} />
                <StatTile label="To correct" value={num(summary.problems)} tone={summary.problems ? 'bad' : undefined} />
                <StatTile label="Stock value" value={money(summary.value)} />
              </Stats>

              <div className="flex flex-wrap items-center gap-2">
                {summary.byGroup.map((g) => (
                  <span key={g.group} className="badge-neutral">
                    {g.label}: {g.lines}
                  </span>
                ))}
                {summary.floorsToMake.length > 0 && <span className="badge-warning">Made on import: {summary.floorsToMake.join(', ')}</span>}
                {(summary.itemsToMake?.length ?? 0) > 0 && (
                  <span className="badge-warning" title={summary.itemsToMake!.map((i) => `${i.name} — ${i.category}, ${i.unit}`).join('\n')}>
                    {summary.itemsToMake!.length === 1 ? '1 new item made on import, with its own code' : `${summary.itemsToMake!.length} new items made on import, with their own codes`}
                  </span>
                )}
                {(summary.stickers ?? 0) > 0 && <span className="badge-neutral">{summary.stickers} stickers to print</span>}
                {(summary.kept ?? 0) > 0 && (
                  <span className="badge-neutral" title="A lot's own barcode stays its package's identity: nothing to print for it">
                    {summary.kept} keep their own barcode
                  </span>
                )}
                {(summary.valuationPending ?? 0) > 0 && (
                  <span className="badge-warning" title="No rate given: in at ₹0, its value to be set later (Opening Stock → Set rate)">
                    {summary.valuationPending} {summary.valuationPending === 1 ? 'row' : 'rows'}: valuation pending
                  </span>
                )}
                {(summary.waiting ?? 0) > 0 && (
                  <span className="badge-warning" title="In stock with packaging pending: configure the packages later from Stickers or the opening stock list">
                    {summary.waiting} {summary.waiting === 1 ? 'row' : 'rows'}: packaging pending
                  </span>
                )}
              </div>

              {summary.problems > 0 && (
                <Banner
                  tone="bad"
                  action={
                    <button
                      type="button"
                      className="btn-secondary h-8 text-xs"
                      disabled={busy !== null}
                      onClick={async () => {
                        setBusy('report')
                        try {
                          await download('/inventory/opening-stock/import/report', { body: body() })
                        } catch (err) {
                          setError(err instanceof Error ? err.message : 'The error report could not be made.')
                        } finally {
                          setBusy(null)
                        }
                      }}
                    >
                      {busy === 'report' ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} Download the error report
                    </button>
                  }
                >
                  Correct the sheet and upload it again — or download the error report, fix the shaded rows there and upload that.
                </Banner>
              )}

              <div className="border-border max-h-[32rem] overflow-auto rounded-lg border">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-muted-foreground text-left text-[10px] font-semibold uppercase tracking-wide">
                      <th className="w-12 px-3 py-2">Row</th>
                      <th className="px-3 py-2">Item</th>
                      <th className="px-3 py-2">Where</th>
                      <th className="px-3 py-2">Size</th>
                      <th className="px-3 py-2 text-right">Qty</th>
                      <th className="px-3 py-2 text-right">Rate</th>
                      <th className="px-3 py-2 text-right">Value</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2">Stickers</th>
                    </tr>
                  </thead>
                  <tbody>
                    {listed.map((r) => (
                      <CheckRow key={r.row} r={r} changed={Boolean(packs[String(r.row)])} onPacking={() => setPacking(r)} />
                    ))}
                    {listed.length === 0 && (
                      <tr>
                        <td colSpan={9} className="text-muted-foreground px-3 py-8 text-center">
                          No rows here.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}

          {summary && (
            <div className="border-border bg-card/95 sticky bottom-0 z-30 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 backdrop-blur">
              <p className="text-muted-foreground text-sm">
                {summary.problems ? (
                  <>
                    <span className="font-semibold text-red-400">{summary.problems}</span> to correct · <span className="text-foreground font-semibold">{ready}</span> ready
                  </>
                ) : (
                  <>
                    <span className="text-foreground font-semibold">{ready}</span> {ready === 1 ? 'line' : 'lines'} will be posted · <span className="text-foreground font-semibold">{money(summary.value)}</span>
                  </>
                )}
              </p>
              <button type="button" className="btn-primary h-9" disabled={busy !== null || summary.problems > 0 || undecided > 0 || ready === 0 || !mayImport} onClick={() => void bringIn()}>
                {busy === 'import' ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />}{' '}
                {summary.problems
                  ? 'Correct every row to import'
                  : undecided
                    ? `Decide the ${undecided} new ${undecided === 1 ? 'item' : 'items'} first`
                    : `Confirm and import ${ready} ${ready === 1 ? 'line' : 'lines'}`}
              </button>
            </div>
          )}
        </>
      )}

      {/* A row's packing changed before the import: checked again with the change. */}
      {packing?.pack && packing.qty && file && (
        <PackagingDialog
          title="How is it packed?"
          subtitle={`Row ${packing.row} · ${packing.item?.code ?? ''} ${packing.item?.name ?? ''}${packing.lot ? ` · lot ${packing.lot}` : ''} · ${num(packing.qty)} ${packing.unit ?? ''}${packing.pack.barcode ? ` · its own barcode ${packing.pack.barcode} stays as one package's identity` : ''}`}
          initial={packValueOf(packing.pack)}
          total={packing.qty}
          unit={packing.unit ?? ''}
          part={false}
          places={qtyRules.places({ uom: { symbol: packing.unit ?? '' } })}
          noteLabel="Roll no. / reference (optional)"
          countForLater
          laterText="Saved as stock with packaging pending. Configure the packages later — from Stickers → Packaging pending, or the line in Opening Stock."
          saveLabel={() => 'Use this'}
          onSave={(_, v) => {
            const next = { ...packs, [String(packing.row)]: packInputOf(v, packing.qty!, packing.unit ?? '', qtyRules.places({ uom: { symbol: packing.unit ?? '' } })) }
            setPacks(next)
            setPacking(null)
            void check(file, date, next, resolve, false)
          }}
          onClose={() => setPacking(null)}
        />
      )}

      {/* 4. Imported. */}
      {done && (
        <DoneCard
          title={
            <>
              {done.again ? 'Already imported' : 'Imported'} as <span className="font-mono text-teal-400">{done.number}</span>
            </>
          }
          message={
            <>
              {done.lines} {done.lines === 1 ? 'line' : 'lines'} of opening stock{summary ? ` · ${money(summary.value)}` : ''} — in stock now, by item, size and place.
              {done.floorsMade.length > 0 && ` Made ${done.floorsMade.join(', ')}.`}
              {(done.kept ?? 0) > 0 && ` ${done.kept} ${done.kept === 1 ? 'package keeps its' : 'packages keep their'} own barcode: nothing to print for ${done.kept === 1 ? 'it' : 'them'}.`}
            </>
          }
          stats={
            <Stats label="Imported">
              <StatTile label="Lines" value={num(done.lines)} />
              <StatTile label="Stock value" value={summary ? money(summary.value) : '—'} />
              <StatTile label="Stickers to print" value={num(done.stickers)} />
              <StatTile label="New items" value={num(done.itemsMade?.length ?? 0)} />
            </Stats>
          }
          actions={
            <>
              <Link href={`/inventory/opening-stock?entry=${done.id}`} className="btn-primary">
                See these lines
              </Link>
              {done.stickers > 0 && (
                <button type="button" className="btn-secondary" onClick={() => setPrinting(true)}>
                  <Printer size={15} /> Print {done.stickers} {done.stickers === 1 ? 'sticker' : 'stickers'}
                </button>
              )}
              <Link href="/inventory/opening-stock/import" className="btn-secondary">
                Import another sheet
              </Link>
            </>
          }
        >
          {(done.itemsMade?.length ?? 0) > 0 && (
            <div className="border-border rounded-lg border">
              <p className="text-muted-foreground border-border border-b px-4 py-2 text-[11px] font-semibold uppercase tracking-wide">New in Items &amp; Products</p>
              <ul className="divide-border divide-y text-sm">
                {done.itemsMade!.map((i) => (
                  <li key={i.code} className="flex items-center gap-3 px-4 py-2">
                    <span className="font-mono text-xs font-semibold text-teal-400">{i.code}</span>
                    <span className="text-foreground">{i.name}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {printing && <StickersReady source={{ type: 'OPENING', id: done.id }} onClose={() => setPrinting(false)} />}
        </DoneCard>
      )}
    </div>
  )
}

/** One step of preparing the sheet: its number, what to do, and the control for it. */
function StepRow({ n, title, text, action, children }: { n: number; title: string; text: string; action?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex gap-4 py-5 first:pt-0 last:pb-0">
      <span className="border-primary/40 bg-primary/10 text-primary flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums">{n}</span>
      <div className="min-w-0 flex-1 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-foreground text-sm font-semibold">{title}</h3>
            <p className="text-muted-foreground mt-0.5 text-xs">{text}</p>
          </div>
          {action}
        </div>
        {children}
      </div>
    </div>
  )
}

function Tip({ icon: Icon, children }: { icon: typeof Info; children: ReactNode }) {
  return (
    <li className="text-muted-foreground flex gap-2.5 leading-relaxed">
      <Icon size={14} className="text-primary mt-0.5 shrink-0" />
      <span>{children}</span>
    </li>
  )
}

/** A checked row: what it is, where it goes and its figures — and under it, what to correct. */
function CheckRow({ r, changed, onPacking }: { r: RowPlan; changed: boolean; onPacking: () => void }) {
  const bad = r.problems.length > 0
  return (
    <>
      <tr className={cn('border-border align-top', !bad && 'border-b', bad && 'bg-red-500/5')} data-row={r.row}>
        <td className="px-3 py-2">
          <span className={cn('inline-flex items-center gap-1 tabular-nums', bad ? 'text-red-400' : 'text-muted-foreground')}>
            {bad ? <AlertCircle size={12} /> : <CheckCircle2 size={12} className="text-emerald-500" />}
            {r.row}
          </span>
        </td>
        <td className="px-3 py-2">
          <div className="text-foreground font-medium">
            {r.item?.name ?? '—'}
            {r.newItem && <span className="badge-warning ml-1.5 align-middle text-[10px]">New item</span>}
            {r.matched && <span className="badge-info ml-1.5 align-middle text-[10px]">Matched</span>}
          </div>
          {r.newItem && (
            <div className="text-muted-foreground">
              Made on import: {r.newItem.category} · {r.newItem.unit} · {r.newItem.tax} · code given by the ERP
            </div>
          )}
          {r.matched && <div className="text-muted-foreground">The sheet says “{r.matched.name}”: brought in on this item instead.</div>}
          <div className="text-muted-foreground">
            {[r.item?.code && <span key="c" className="font-mono text-teal-400">{r.item.code}</span>, r.order && `Order ${r.order}`, r.lot && `Lot ${r.lot}`, r.bundle && `Bundle ${r.bundle}`]
              .filter(Boolean)
              .map((x, i) => (
                <span key={i}>
                  {i > 0 && ' · '}
                  {x}
                </span>
              ))}
          </div>
        </td>
        <td className="px-3 py-2">
          <div className="text-foreground">{r.process}</div>
          <div className="text-muted-foreground">
            {r.location || '—'}
            {r.newFloor && !bad && <span className="text-primary"> · made on import</span>}
          </div>
        </td>
        <td className="text-foreground px-3 py-2 font-semibold">{r.size ?? ''}</td>
        <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{r.qty !== null ? `${num(r.qty)} ${r.unit ?? ''}` : '—'}</td>
        <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
          {r.rate !== null ? money(r.rate) : '—'}
          {r.valuationPending && !bad && <div className="text-[10px] font-semibold text-amber-600">Valuation pending</div>}
        </td>
        <td className="text-foreground whitespace-nowrap px-3 py-2 text-right font-semibold tabular-nums">{r.value !== null ? money(r.value) : '—'}</td>
        <td className="px-3 py-2">{r.status}</td>
        <td className="text-muted-foreground px-3 py-2">
          {r.packing ?? '—'}
          {r.pack && r.qty ? (
            <button type="button" className="text-primary ml-1.5 text-[11px] font-medium hover:underline" onClick={onPacking} aria-label={`Change the packing of row ${r.row}`}>
              {changed ? 'Changed · change' : 'Change'}
            </button>
          ) : null}
        </td>
      </tr>
      {bad && (
        <tr className="border-border border-b bg-red-500/5">
          <td />
          <td colSpan={8} className="px-3 pb-2.5 pt-0">
            <ul className="space-y-0.5 border-l-2 border-red-500/60 pl-2.5 text-red-400">
              {r.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </td>
        </tr>
      )}
    </>
  )
}

/**
 * Each item the sheet names that is not in Items & Products: made with its
 * own code once approved, or matched to an item already there — a spelling
 * slip of one, say. Items of a similar name are offered first.
 */
function ResolvePanel({
  decisions,
  resolve,
  undecided,
  busy,
  onDecide,
  onApproveAll,
}: {
  decisions: Decision[]
  resolve: Record<string, string>
  undecided: number
  busy: boolean
  onDecide: (key: string, value: string) => void
  onApproveAll: () => void
}) {
  return (
    <Panel
      icon={PackagePlus}
      title={
        undecided ? (
          <span className="text-amber-600">
            {undecided} new {undecided === 1 ? 'item' : 'items'} to decide
          </span>
        ) : (
          <span className="text-emerald-500">Every new item decided</span>
        )
      }
      description="Not in Items & Products yet. Match each to an item already there (a spelling slip), or approve making it with its own code."
      label="Resolve new items"
      actions={
        undecided > 0 ? (
          <button type="button" className="btn-secondary h-8 text-xs" disabled={busy} onClick={onApproveAll}>
            Approve the rest as new
          </button>
        ) : undefined
      }
      bodyClassName="p-0"
    >
      <ul className="divide-border divide-y">
        {decisions.map((d) => {
          const chosen = resolve[d.key] ?? ''
          return (
            <li key={d.key} className="grid gap-3 px-5 py-3.5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
              <div className="min-w-0">
                <div className="text-foreground flex flex-wrap items-center gap-2 text-sm font-semibold">
                  {d.name}
                  {!chosen && <span className="badge-warning text-[10px]">To decide</span>}
                  {chosen === 'NEW' && <span className="badge-success text-[10px]">Made new</span>}
                  {chosen && chosen !== 'NEW' && <span className="badge-info text-[10px]">Matched</span>}
                </div>
                <div className="text-muted-foreground mt-0.5 text-xs">{[d.category, d.unit, d.tax].filter(Boolean).join(' · ')}</div>
                {d.similar.length > 0 && !chosen && (
                  <div className="mt-1 text-xs text-amber-600">
                    Looks like {d.similar.length === 1 ? 'an item' : `${d.similar.length} items`} already there — check it is not a spelling slip.
                  </div>
                )}
              </div>
              <div className="space-y-1.5" role="radiogroup" aria-label={`Decide ${d.name}`}>
                {d.similar.map((m) => (
                  <label key={m.id} className={cn('border-border flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm', chosen === m.id && 'border-primary bg-primary/5')}>
                    <input type="radio" name={`decide-${d.key}`} checked={chosen === m.id} disabled={busy} onChange={() => onDecide(d.key, m.id)} aria-label={`Use ${m.code} for ${d.name}`} />
                    <span className="min-w-0 flex-1 truncate">
                      Use <span className="font-mono text-xs font-semibold text-teal-400">{m.code}</span> {m.name}
                    </span>
                  </label>
                ))}
                <label className={cn('border-border flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm', chosen === 'NEW' && 'border-primary bg-primary/5')}>
                  <input type="radio" name={`decide-${d.key}`} checked={chosen === 'NEW'} disabled={busy} onChange={() => onDecide(d.key, 'NEW')} aria-label={`Make ${d.name} new`} />
                  <span>Make it new, with its own code</span>
                </label>
              </div>
            </li>
          )
        })}
      </ul>
    </Panel>
  )
}
