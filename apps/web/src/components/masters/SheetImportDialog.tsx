'use client'

import { useState, type ReactNode } from 'react'
import { AlertCircle, CheckCircle2, Download, FileSpreadsheet, Loader2, Upload, type LucideIcon } from 'lucide-react'
import { api, apiErrorMessage, tokens } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'

/** What every import says about a row, whatever else it says. */
export interface SheetRowPlan {
  row: number
  skipped: boolean
  problems: string[]
}

export interface SheetSummary {
  problems: number
  skipped: number
}

export interface SheetImportConfig<R extends SheetRowPlan, S extends SheetSummary> {
  icon?: LucideIcon
  title: string
  subtitle: string
  /** The API path the sheet is posted to, checked and then confirmed. */
  importPath: string
  /** The API path of the template; `current` asks for the one listing what is there. */
  templatePath: (current: boolean) => string
  templates: { blank: { title: string; text: string }; current: { title: string; text: string } }
  /** The preview's columns after Row, before Problem. */
  columns: Array<{ head: string; width?: number; cell: (r: R) => ReactNode }>
  /** The summary badges over the preview. */
  chips: (s: S) => ReactNode
  /** What the import will do, as parts of the button: "12 new items", "3 stock lines". None: nothing to do. */
  toDo: (s: S) => string[]
  /** What was made, from the confirmed import's data, for the done view. */
  created: (data: unknown) => Array<{ code?: string; name: string }>
}

/** A template, fetched with the sign-in token and handed to the browser as a file. */
async function downloadTemplate(path: string) {
  const base = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:5000/api'
  const res = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${tokens.access() ?? ''}` },
  })
  if (!res.ok) throw new Error(`The template could not be made (${res.status}).`)
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'import.xlsx'
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
 * A master from a spreadsheet.
 *
 * Three steps on one page: get the template (blank, or listing what is
 * already in the system), upload it filled, and see what each row will do
 * before anything is written. Import stays off while any row has a problem:
 * the sheet goes in whole or not at all, so it is fixed and uploaded again
 * rather than half imported.
 */
export function SheetImportDialog<R extends SheetRowPlan, S extends SheetSummary>({
  config,
  onClose,
  onImported,
}: {
  config: SheetImportConfig<R, S>
  onClose: () => void
  onImported: () => void
}) {
  const [file, setFile] = useState<{ name: string; data: string } | null>(null)
  const [checking, setChecking] = useState(false)
  const [importing, setImporting] = useState(false)
  const [downloading, setDownloading] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<S | null>(null)
  const [rows, setRows] = useState<R[]>([])
  const [onlyProblems, setOnlyProblems] = useState(false)
  const [done, setDone] = useState<{ message: string; created: Array<{ code?: string; name: string }> } | null>(
    null,
  )

  const busy = checking || importing

  const template = async (current: boolean) => {
    setDownloading(current)
    setError(null)
    try {
      await downloadTemplate(config.templatePath(current))
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
      const res = await api.post<{ data: { summary: S; rows: R[] } }>(config.importPath, {
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
      const res = await api.post<{ message: string; data: unknown }>(config.importPath, {
        fileName: file.name,
        file: file.data,
        confirm: true,
      })
      setDone({ message: res.message, created: config.created(res.data) })
      onImported()
    } catch (err) {
      setError(apiErrorMessage(err, 'The import did not go through. Nothing was saved.'))
    } finally {
      setImporting(false)
    }
  }

  const toDo = summary ? config.toDo(summary) : []
  const ready = Boolean(summary && summary.problems === 0 && toDo.length > 0 && !done)
  const shown = rows.filter((r) => !r.skipped && (!onlyProblems || r.problems.length > 0))
  const Icon = config.icon ?? FileSpreadsheet

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
        : summary && toDo.length > 0
          ? `Import ${toDo.join(' and ')}`
          : summary
            ? 'Nothing new to import'
            : 'Import'}
    </button>
  )

  const templateCard = (current: boolean) => {
    const t = current ? config.templates.current : config.templates.blank
    return (
      <button
        type="button"
        className="border-border hover:border-primary/50 hover:bg-primary/5 rounded-lg border p-3 text-left transition-colors"
        onClick={() => void template(current)}
        disabled={downloading !== null}
      >
        <div className="text-foreground flex items-center gap-2 text-sm font-semibold">
          {downloading === current ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
          {t.title}
        </div>
        <p className="text-muted-foreground mt-1 text-xs">{t.text}</p>
      </button>
    )
  }

  return (
    <FormFrame
      icon={Icon}
      title={config.title}
      subtitle={config.subtitle}
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
                <div key={c.code ?? c.name} className="flex min-w-0 gap-2">
                  {c.code && <span className="shrink-0 font-mono text-xs text-teal-500">{c.code}</span>}
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
              {templateCard(false)}
              {templateCard(true)}
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
                {checking ? (
                  'Checking every row…'
                ) : file ? (
                  <>
                    {file.name} <span className="text-muted-foreground">· choose another to check again</span>
                  </>
                ) : (
                  'Choose the .xlsx (or .csv) file'
                )}
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
                {config.chips(summary)}
                {summary.skipped > 0 && (
                  <span className="badge-neutral">
                    {summary.skipped} {summary.skipped === 1 ? 'row' : 'rows'} with nothing to do, skipped
                  </span>
                )}
                {summary.problems > 0 && <span className="badge-danger">{summary.problems} with problems</span>}
              </div>

              <div className="max-h-[45vh] overflow-auto">
                <table className="line-table w-full min-w-[720px] text-sm">
                  <thead>
                    <tr>
                      <th style={{ width: 56 }}>Row</th>
                      {config.columns.map((c) => (
                        <th key={c.head} style={c.width ? { width: c.width } : undefined}>
                          {c.head}
                        </th>
                      ))}
                      <th>Problem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((r) => (
                      <tr key={r.row} className={r.problems.length ? 'bg-red-500/5' : ''}>
                        <td className="text-muted-foreground px-3 py-2 text-xs">{r.row}</td>
                        {config.columns.map((c) => (
                          <td key={c.head} className="px-3 py-2">
                            {c.cell(r)}
                          </td>
                        ))}
                        <td className="px-3 py-2 text-xs text-red-500">{r.problems.join(' ')}</td>
                      </tr>
                    ))}
                    {shown.length === 0 && (
                      <tr>
                        <td colSpan={config.columns.length + 2} className="text-muted-foreground px-3 py-6 text-center text-sm">
                          {rows.length > 0 ? 'Every row is already in the system. Nothing to import.' : 'No rows to show.'}
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
