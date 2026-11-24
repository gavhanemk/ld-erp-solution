'use client'

import { Suspense, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { AlertCircle, ArrowLeft, CheckCircle2, Download, FileSpreadsheet, Loader2, Printer, Rows3, Upload } from 'lucide-react'
import { api, ApiError, can, tokens } from '@/lib/api'
import { cn, newRequestId } from '@/lib/utils'
import { KINDS, money, num, todayInIndia, type Kind } from '@/components/inventory/opening/kinds'
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
  byGroup: Array<{ group: string; label: string; lines: number; value: number }>
  /** Stickers to print; packages keeping their own barcode; rows whose packaging is pending. */
  stickers?: number
  kept?: number
  waiting?: number
}
interface Done {
  id: string
  number: string
  lines: number
  stickers: number
  /** Packages keeping a lot's own barcode: nothing to print for them. */
  kept?: number
  floorsMade: string[]
  again?: boolean
}

const STEPS = ['What the sheet holds', 'Template and upload', 'Check the rows', 'Imported']
const ALL = { key: 'ALL' as const, label: 'All in one sheet', short: '19 columns', text: "Your standard 19-column opening stock sheet, Opening Date to Remarks: finished goods, semi-finished goods and raw materials together.", icon: Rows3 }

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
  // Packing changed on the review, by sheet row: sent with the check and the import.
  const [packs, setPacks] = useState<Record<string, PackInputBody>>({})
  const [packing, setPacking] = useState<RowPlan | null>(null)
  const qtyRules = useQtyRules()
  const input = useRef<HTMLInputElement>(null)
  const mayImport = can('inventory', 'create')

  const body = (extra: Record<string, unknown> = {}) => ({
    fileName: file?.name,
    file: file?.data,
    ...(choice && choice !== 'ALL' ? { kind: choice, openingDate: date } : {}),
    ...(Object.keys(packs).length ? { packs } : {}),
    ...extra,
  })

  const check = async (f: { name: string; data: string }, onDate = date, withPacks = packs) => {
    setBusy('check')
    setError(null)
    setSummary(null)
    setRows([])
    try {
      const res = await api.post<{ data: { summary: Summary; rows: RowPlan[] } }>('/inventory/opening-stock/import', {
        fileName: f.name,
        file: f.data,
        ...(choice && choice !== 'ALL' ? { kind: choice, openingDate: onDate } : {}),
        ...(Object.keys(withPacks).length ? { packs: withPacks } : {}),
      })
      setSummary(res.data.summary)
      setRows(res.data.rows)
      setOnly(res.data.summary.problems ? 'bad' : 'all')
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
      // A new sheet: changes made on the last one's rows do not carry over.
      setPacks({})
      await check(f, date, {})
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

  const stepIndex = !choice ? 0 : done ? 3 : summary ? 2 : 1
  const listed = rows.filter((r) => !r.skipped && (only === 'all' || (only === 'bad' ? r.problems.length > 0 : r.problems.length === 0)))
  const ready = summary ? summary.lines : 0

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <Link href="/inventory/opening-stock" className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs">
            <ArrowLeft size={12} /> Opening Stock
          </Link>
          <h1 className="page-title">Import Opening Stock{shown ? ` — ${shown.label}` : ''}</h1>
        </div>
        <ol className="flex flex-wrap items-center gap-1 text-xs" aria-label="Steps">
          {STEPS.map((label, i) => (
            <li key={label} className="flex items-center gap-1">
              <span
                className={cn(
                  'flex items-center gap-1.5 rounded-full border px-2.5 py-1',
                  i === stepIndex ? 'border-primary bg-primary/10 text-primary font-semibold' : i < stepIndex ? 'border-border text-foreground' : 'border-border text-muted-foreground',
                )}
                aria-current={i === stepIndex ? 'step' : undefined}
              >
                <span className="tabular-nums">{i + 1}</span> {label}
              </span>
              {i < STEPS.length - 1 && <span className="text-muted-foreground">›</span>}
            </li>
          ))}
        </ol>
      </div>

      {!mayImport && <Note tone="warn">Importing opening stock needs Inventory → create. Ask an administrator for it.</Note>}
      {error && <Note tone="bad">{error}</Note>}

      {/* 1. What the sheet holds. */}
      {!choice && (
        <div className="space-y-3">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {[...KINDS, ALL].map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => router.push(`/inventory/opening-stock/import?type=${t.key}`)}
                className="glass-card hover:border-primary group flex flex-col gap-3 border p-5 text-left transition-colors"
                aria-label={`Import ${t.label}`}
              >
                <div className="flex items-center gap-3">
                  <span className="bg-primary/10 text-primary rounded-xl p-3">
                    <t.icon size={22} />
                  </span>
                  <div>
                    <div className="text-foreground font-semibold">{t.label}</div>
                    <div className="text-muted-foreground text-xs font-semibold">{t.short}</div>
                  </div>
                </div>
                <p className="text-muted-foreground flex-1 text-sm">{t.text}</p>
                <span className="text-primary text-sm font-semibold group-hover:underline">Use this template →</span>
              </button>
            ))}
          </div>
          <p className="text-muted-foreground text-sm">
            Only a few lines?{' '}
            <Link href="/inventory/opening-stock/new" className="text-primary font-medium hover:underline">
              Add them by hand instead
            </Link>
          </p>
        </div>
      )}

      {/* 2. Template, date and upload; then 3. the rows. */}
      {choice && !done && (
        <>
          <section className="glass-card grid gap-4 p-4 lg:grid-cols-3" aria-label="Template and upload">
            <div className="space-y-2">
              <h2 className="text-foreground text-sm font-semibold">1. The template</h2>
              <p className="text-muted-foreground text-xs">
                {choice === 'ALL'
                  ? 'Your 19 columns, Opening Date to Remarks, with dropdowns for process, location, unit and status.'
                  : choice === 'FG'
                    ? 'Style / Article No., Item Code, Colour, Size, Opening Quantity, Rate Per Piece, Location — with Stock Status and Remarks at the end.'
                    : choice === 'SFG'
                      ? "Style / Article No., Process, Colour, Size, Opening Quantity, Rate / Valuation, Department, Location, Order Reference, Batch / Bundle Reference — the process must be on the style's route."
                      : 'Material Category, Item Code, Item Name, Lot / Batch / Roll Number, Bundle / Barcode Number, UOM, Opening Quantity, Unit Rate, Location.'}
              </p>
              <button
                type="button"
                className="btn-secondary h-9 text-sm"
                disabled={busy !== null}
                onClick={async () => {
                  setBusy('template')
                  setError(null)
                  try {
                    await download(`/inventory/opening-stock/import-template${choice === 'ALL' ? '' : `?type=${choice}`}`)
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'The template could not be made.')
                  } finally {
                    setBusy(null)
                  }
                }}
              >
                {busy === 'template' ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />} Download the {shown?.label} template
              </button>
            </div>
            {choice !== 'ALL' && (
              <label className="space-y-2 text-sm">
                <span className="text-foreground block font-semibold">2. Opening date, for the whole sheet</span>
                <input
                  type="date"
                  className="form-input w-48"
                  value={date}
                  max={todayInIndia()}
                  onChange={(e) => {
                    setDate(e.target.value)
                    if (file) void check(file, e.target.value)
                  }}
                  aria-label="Opening date"
                />
              </label>
            )}
            <div className="space-y-2">
              <h2 className="text-foreground text-sm font-semibold">{choice === 'ALL' ? '2.' : '3.'} Upload the filled sheet</h2>
              <input ref={input} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => void choose(e.target.files?.[0])} aria-label="Choose the sheet" />
              <button type="button" className="btn-primary h-9 text-sm" disabled={busy !== null || !mayImport} onClick={() => input.current?.click()}>
                {busy === 'check' ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />} {file ? 'Upload a corrected sheet' : 'Choose the sheet'}
              </button>
              {file && (
                <p className="text-muted-foreground flex items-center gap-1 text-xs">
                  <FileSpreadsheet size={13} /> {file.name}
                </p>
              )}
            </div>
          </section>

          {summary && (
            <section className="glass-card space-y-3 p-4" aria-label="Check">
              <div className="flex flex-wrap items-center gap-2">
                {summary.problems ? (
                  <span className="flex items-center gap-1.5 text-sm font-semibold text-red-400">
                    <AlertCircle size={16} /> {summary.problems} {summary.problems === 1 ? 'row' : 'rows'} of {summary.rows - summary.skipped} {summary.problems === 1 ? 'needs' : 'need'} correcting · {ready} ready
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 text-sm font-semibold text-emerald-500">
                    <CheckCircle2 size={16} /> All {ready} {ready === 1 ? 'row is' : 'rows are'} right
                  </span>
                )}
                <span className="badge-info">{money(summary.value)}</span>
                {summary.byGroup.map((g) => (
                  <span key={g.group} className="badge-neutral">
                    {g.label}: {g.lines}
                  </span>
                ))}
                {summary.floorsToMake.length > 0 && <span className="badge-warning">Made on import: {summary.floorsToMake.join(', ')}</span>}
                {(summary.stickers ?? 0) > 0 && <span className="badge-neutral">{summary.stickers} stickers to print</span>}
                {(summary.kept ?? 0) > 0 && (
                  <span className="badge-neutral" title="A lot's own barcode stays its package's identity: nothing to print for it">
                    {summary.kept} keep their own barcode
                  </span>
                )}
                {(summary.waiting ?? 0) > 0 && (
                  <span className="badge-warning" title="In stock with packaging pending: configure the packages later from Stickers or the opening stock list">
                    {summary.waiting} {summary.waiting === 1 ? 'row' : 'rows'}: packaging pending
                  </span>
                )}
                <div className="border-border bg-secondary ml-auto flex rounded-lg border p-0.5 text-xs" role="tablist" aria-label="Rows">
                  {(
                    [
                      { key: 'all', label: `All (${summary.rows - summary.skipped})` },
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
              </div>
              {summary.problems > 0 && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm">
                  <span className="text-red-400">Nothing is imported until every row is right. Correct the sheet and upload it again — or download the error report, fix the shaded rows there and upload that.</span>
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
                </div>
              )}
              <div className="max-h-[28rem] overflow-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-muted-foreground text-left text-[10px] font-semibold uppercase tracking-wide">
                      <th className="px-2 py-1.5">Row</th>
                      <th className="px-2 py-1.5">Where</th>
                      <th className="px-2 py-1.5">Item</th>
                      <th className="px-2 py-1.5">Size</th>
                      <th className="px-2 py-1.5 text-right">Qty</th>
                      <th className="px-2 py-1.5 text-right">Rate</th>
                      <th className="px-2 py-1.5 text-right">Value</th>
                      <th className="px-2 py-1.5">Status</th>
                      <th className="px-2 py-1.5">Stickers</th>
                      <th className="px-2 py-1.5">Problems</th>
                    </tr>
                  </thead>
                  <tbody>
                    {listed.map((r) => (
                      <tr key={r.row} className={cn('border-border border-t align-top', r.problems.length && 'bg-red-500/5')} data-row={r.row}>
                        <td className="text-muted-foreground px-2 py-1.5 tabular-nums">{r.row}</td>
                        <td className="px-2 py-1.5">
                          <div className="text-foreground">{r.process}</div>
                          <div className="text-muted-foreground">
                            {r.location || '—'}
                            {r.newFloor && !r.problems.length && <span className="text-primary"> · made on import</span>}
                          </div>
                        </td>
                        <td className="px-2 py-1.5">
                          <div className="text-foreground">{r.item?.name ?? '—'}</div>
                          <div className="text-muted-foreground">{[r.item?.code, r.order && `Order ${r.order}`, r.lot && `Lot ${r.lot}`, r.bundle && `Bundle ${r.bundle}`].filter(Boolean).join(' · ')}</div>
                        </td>
                        <td className="px-2 py-1.5 font-semibold">{r.size ?? ''}</td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">
                          {r.qty !== null ? `${num(r.qty)} ${r.unit ?? ''}` : '—'}
                        </td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{r.rate !== null ? money(r.rate) : '—'}</td>
                        <td className="text-foreground whitespace-nowrap px-2 py-1.5 text-right font-semibold tabular-nums">{r.value !== null ? money(r.value) : '—'}</td>
                        <td className="px-2 py-1.5">{r.status}</td>
                        <td className="text-muted-foreground px-2 py-1.5">
                          {r.packing ?? '—'}
                          {r.pack && r.qty ? (
                            <button type="button" className="text-primary ml-1.5 text-[11px] font-medium hover:underline" onClick={() => setPacking(r)} aria-label={`Change the packing of row ${r.row}`}>
                              {packs[String(r.row)] ? 'Changed · change' : 'Change'}
                            </button>
                          ) : null}
                        </td>
                        <td className="px-2 py-1.5 text-red-400">{r.problems.join(' · ')}</td>
                      </tr>
                    ))}
                    {listed.length === 0 && (
                      <tr>
                        <td colSpan={10} className="text-muted-foreground px-2 py-6 text-center">
                          No rows here.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
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
              <button type="button" className="btn-primary h-9" disabled={busy !== null || summary.problems > 0 || ready === 0 || !mayImport} onClick={() => void bringIn()}>
                {busy === 'import' ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />}{' '}
                {summary.problems ? 'Correct every row to import' : `Confirm and import ${ready} ${ready === 1 ? 'line' : 'lines'}`}
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
          places={qtyRules.places({ uom: { symbol: packing.unit ?? '' } })}
          noteLabel="Roll no. / reference (optional)"
          countForLater
          laterText="Saved as stock with packaging pending. Configure the packages later — from Stickers → Packaging pending, or the line in Opening Stock."
          saveLabel={() => 'Use this'}
          onSave={(_, v) => {
            const next = { ...packs, [String(packing.row)]: packInputOf(v, packing.qty!, packing.unit ?? '', qtyRules.places({ uom: { symbol: packing.unit ?? '' } })) }
            setPacks(next)
            setPacking(null)
            void check(file, date, next)
          }}
          onClose={() => setPacking(null)}
        />
      )}

      {/* 4. Imported. */}
      {done && (
        <div className="glass-card space-y-4 p-6">
          <div className="flex items-start gap-3">
            <CheckCircle2 size={28} className="shrink-0 text-emerald-500" />
            <div>
              <h2 className="text-foreground text-lg font-semibold">
                {done.again ? 'Already imported' : 'Imported'} as <span className="font-mono text-teal-400">{done.number}</span>
              </h2>
              <p className="text-foreground text-sm" role="status">
                {done.lines} {done.lines === 1 ? 'line' : 'lines'} of opening stock{summary ? ` · ${money(summary.value)}` : ''} — in stock now, by item, size and place.
                {done.floorsMade.length > 0 && ` Made ${done.floorsMade.join(', ')}.`}
                {(done.kept ?? 0) > 0 && ` ${done.kept} ${done.kept === 1 ? 'package keeps its' : 'packages keep their'} own barcode: nothing to print for ${done.kept === 1 ? 'it' : 'them'}.`}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
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
          </div>
          {printing && <StickersReady source={{ type: 'OPENING', id: done.id }} onClose={() => setPrinting(false)} />}
        </div>
      )}
    </div>
  )
}

function Note({ tone, children }: { tone: 'bad' | 'warn'; children: ReactNode }) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm',
        tone === 'bad' ? 'border-red-500/30 bg-red-500/10 text-red-400' : 'border-amber-500/30 bg-amber-500/10 text-amber-600',
      )}
      role={tone === 'bad' ? 'alert' : 'status'}
    >
      <AlertCircle size={15} className="shrink-0" /> <span>{children}</span>
    </div>
  )
}
