'use client'

import { useState } from 'react'
import { AlertCircle, CheckCircle2, Download, FileSpreadsheet, Loader2, Upload } from 'lucide-react'
import { api, apiErrorMessage, tokens } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'

interface RowPlan {
  row: number
  name: string
  item: 'new' | 'existing' | 'none'
  code: string | null
  stock: { store: string; qty: number; rate: number } | null
  skipped: boolean
  problems: string[]
}

interface Summary {
  rows: number
  newItems: number
  existingItems: number
  skipped: number
  stockLines: number
  problems: number
}

const n = (v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 3 })

/** The template, fetched with the sign-in token and handed to the browser as a file. */
async function downloadTemplate(withItems: boolean) {
  const base = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:5000/api'
  const res = await fetch(`${base}/masters/items/import-template?withItems=${withItems}`, {
    headers: { Authorization: `Bearer ${tokens.access() ?? ''}` },
  })
  if (!res.ok) throw new Error(`The template could not be made (${res.status}).`)
  const name =
    /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'items-import.xlsx'
  const url = URL.createObjectURL(await res.blob())
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** A file as base64, without the data-URL prefix. */
const asBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:.*?;base64,/, ''))
    reader.onerror = () => reject(new Error('The file could not be read.'))
    reader.readAsDataURL(file)
  })

/**
 * Items, and the stock of them, from a spreadsheet.
 *
 * Three steps on one page: get the template (blank, or listing every item
 * already in the system so only the stock has to be typed), upload it filled,
 * and see what each row will do before anything is written. Import stays off
 * while any row has a problem: the sheet goes in whole or not at all, so it is
 * fixed and uploaded again rather than half imported.
 */
export function ImportItemsDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [file, setFile] = useState<{ name: string; data: string } | null>(null)
  const [checking, setChecking] = useState(false)
  const [importing, setImporting] = useState(false)
  const [downloading, setDownloading] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [rows, setRows] = useState<RowPlan[]>([])
  const [onlyProblems, setOnlyProblems] = useState(false)
  const [done, setDone] = useState<{ message: string; created: Array<{ code: string; name: string }> } | null>(null)

  const busy = checking || importing

  const template = async (withItems: boolean) => {
    setDownloading(withItems)
    setError(null)
    try {
      await downloadTemplate(withItems)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The template could not be made.')
    } finally {
      setDownloading(null)
    }
  }

  const check = async (picked: File) => {
    setChecking(true)
    setError(null)
    setSummary(null)
    setRows([])
    setDone(null)
    try {
      const data = await asBase64(picked)
      setFile({ name: picked.name, data })
      const res = await api.post<{ data: { summary: Summary; rows: RowPlan[] } }>('/masters/items/import', {
        fileName: picked.name,
        file: data,
      })
      setSummary(res.data.summary)
      setRows(res.data.rows)
      setOnlyProblems(res.data.summary.problems > 0)
    } catch (err) {
      setError(apiErrorMessage(err, 'That sheet could not be checked.'))
    } finally {
      setChecking(false)
    }
  }

  const run = async () => {
    if (!file) return
    setImporting(true)
    setError(null)
    try {
      const res = await api.post<{ message: string; data: { created: Array<{ code: string; name: string }> } }>(
        '/masters/items/import',
        { fileName: file.name, file: file.data, confirm: true },
      )
      setDone({ message: res.message, created: res.data.created })
      onImported()
    } catch (err) {
      setError(apiErrorMessage(err, 'The import did not go through. Nothing was saved.'))
    } finally {
      setImporting(false)
    }
  }

  const toDo = summary ? summary.newItems + summary.stockLines : 0
  const ready = Boolean(summary && summary.problems === 0 && toDo > 0 && !done)
  const shown = rows.filter((r) => !r.skipped && (!onlyProblems || r.problems.length > 0))

  const primary = done ? (
    <button type="button" className="btn-primary" onClick={onClose}>
      <CheckCircle2 size={15} /> Done
    </button>
  ) : (
    <button
      type="button"
      className="btn-primary disabled:cursor-not-allowed disabled:opacity-50"
      onClick={() => void run()}
      disabled={!ready || busy}
    >
      {importing ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
      {summary && summary.problems > 0
        ? 'Fix the problems to import'
        : summary && toDo > 0
        ? `Import ${[
            summary.newItems ? `${summary.newItems} new ${summary.newItems === 1 ? 'item' : 'items'}` : '',
            summary.stockLines ? `${summary.stockLines} stock ${summary.stockLines === 1 ? 'line' : 'lines'}` : '',
          ]
            .filter(Boolean)
            .join(' and ')}`
        : 'Import'}
    </button>
  )

  return (
    <FormFrame
      icon={FileSpreadsheet}
      title="Import items and stock"
      subtitle="From a spreadsheet: new items, and the stock of any item on hand today."
      primary={primary}
      footer={
        !done && (
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        )
      }
      footerNote={
        done
          ? undefined
          : summary && summary.problems > 0
            ? `${summary.problems} ${summary.problems === 1 ? 'row has a problem' : 'rows have problems'}. Fix the sheet and upload it again; nothing is imported until every row is right.`
            : 'Nothing is saved until you press Import.'
      }
      error={error}
      onClose={onClose}
      busy={busy}
      width="max-w-6xl"
    >
      {done ? (
        <Section icon={CheckCircle2} title="Imported">
          <p className="text-foreground text-sm">{done.message}</p>
          {done.created.length > 0 && (
            <div className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
              {done.created.map((c) => (
                <div key={c.code} className="flex min-w-0 gap-2">
                  <span className="shrink-0 font-mono text-xs text-teal-500">{c.code}</span>
                  <span className="text-foreground truncate">{c.name}</span>
                </div>
              ))}
            </div>
          )}
        </Section>
      ) : (
        <>
          <Section icon={Download} title="1. Get the sheet">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <button
                type="button"
                className="border-border hover:border-primary/50 hover:bg-primary/5 rounded-lg border p-3 text-left transition-colors"
                onClick={() => void template(false)}
                disabled={downloading !== null}
              >
                <div className="text-foreground flex items-center gap-2 text-sm font-semibold">
                  {downloading === false ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
                  Blank template
                </div>
                <p className="text-muted-foreground mt-1 text-xs">
                  For new items. Dropdowns for type, category, sub-category, department, unit and store.
                </p>
              </button>
              <button
                type="button"
                className="border-border hover:border-primary/50 hover:bg-primary/5 rounded-lg border p-3 text-left transition-colors"
                onClick={() => void template(true)}
                disabled={downloading !== null}
              >
                <div className="text-foreground flex items-center gap-2 text-sm font-semibold">
                  {downloading === true ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
                  With your current items
                </div>
                <p className="text-muted-foreground mt-1 text-xs">
                  Every item already listed. Type the store, quantity and rate against the ones you have in
                  stock; rows left empty are skipped. New items can be added at the bottom.
                </p>
              </button>
            </div>
          </Section>

          <Section icon={Upload} title="2. Upload the filled sheet">
            <label className="border-border hover:border-primary/50 flex cursor-pointer items-center gap-3 rounded-lg border border-dashed p-4">
              {checking ? (
                <Loader2 size={18} className="text-primary animate-spin" />
              ) : (
                <FileSpreadsheet size={18} className="text-primary" />
              )}
              <span className="text-sm">
                {checking
                  ? 'Checking every row…'
                  : file
                    ? <>{file.name} <span className="text-muted-foreground">· choose another to check again</span></>
                    : 'Choose the .xlsx (or .csv) file'}
              </span>
              <input
                type="file"
                accept=".xlsx,.csv"
                className="hidden"
                disabled={busy}
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ''
                  if (f) void check(f)
                }}
              />
            </label>
          </Section>

          {summary && (
            <Section
              icon={summary.problems > 0 ? AlertCircle : CheckCircle2}
              title="3. What each row will do"
              actions={
                summary.problems > 0 && (
                  <label className="text-muted-foreground flex cursor-pointer items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      className="accent-teal-500"
                      checked={onlyProblems}
                      onChange={(e) => setOnlyProblems(e.target.checked)}
                    />
                    Only rows with problems
                  </label>
                )
              }
            >
              <div className="mb-3 flex flex-wrap gap-2 text-xs">
                <span className="badge-success">
                  {summary.newItems} new {summary.newItems === 1 ? 'item' : 'items'}
                </span>
                <span className="badge-info">
                  {summary.stockLines} stock {summary.stockLines === 1 ? 'line' : 'lines'}
                </span>
                {summary.existingItems > 0 && (
                  <span className="badge-neutral">{summary.existingItems} items already there, stock only</span>
                )}
                {summary.skipped > 0 && (
                  <span className="badge-neutral">{summary.skipped} rows with nothing to do, skipped</span>
                )}
                {summary.problems > 0 && <span className="badge-danger">{summary.problems} with problems</span>}
              </div>

              <div className="max-h-[45vh] overflow-auto">
                <table className="line-table w-full min-w-[720px] text-sm">
                  <thead>
                    <tr>
                      <th style={{ width: 56 }}>Row</th>
                      <th>Item</th>
                      <th style={{ width: 150 }}>What happens</th>
                      <th>Stock</th>
                      <th>Problem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((r) => (
                      <tr key={r.row} className={r.problems.length ? 'bg-red-500/5' : ''}>
                        <td className="text-muted-foreground px-3 py-2 text-xs">{r.row}</td>
                        <td className="px-3 py-2">
                          <div className="text-foreground font-medium">{r.name || '—'}</div>
                          {r.code && <div className="font-mono text-[11px] text-teal-500">{r.code}</div>}
                        </td>
                        <td className="px-3 py-2 text-xs">
                          {r.item === 'new' ? 'New item' : r.item === 'existing' ? 'Already there' : '—'}
                        </td>
                        <td className="px-3 py-2 text-xs tabular-nums">
                          {r.stock ? `${n(r.stock.qty)} @ ₹${n(r.stock.rate)} in ${r.stock.store}` : '—'}
                        </td>
                        <td className="px-3 py-2 text-xs text-red-500">{r.problems.join(' ')}</td>
                      </tr>
                    ))}
                    {shown.length === 0 && (
                      <tr>
                        <td colSpan={5} className="text-muted-foreground px-3 py-6 text-center text-sm">
                          No rows to show.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Section>
          )}
        </>
      )}
    </FormFrame>
  )
}
