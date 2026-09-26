import { tokens } from '@/lib/api'

/**
 * Fetches a report file and hands it to the browser.
 *
 * Not a plain link: the export route sits behind the same bearer token as
 * everything else, and a browser navigation carries no Authorization header.
 * So the file comes back as a blob and the anchor is made here.
 *
 * The file name is taken from the response rather than guessed — the server
 * is the only thing that knows whether it had to truncate, and the name is
 * where it says so.
 */
export async function downloadReport(
  reportId: string,
  format: 'xlsx' | 'csv',
  params: Record<string, string>
): Promise<{ fileName: string; bytes: number; charts: number | null; pivots: number | null }> {
  const base = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:5000/api'
  const qs = new URLSearchParams({ ...params, format })
  const res = await fetch(`${base}/reports/${reportId}/export?${qs}`, {
    headers: { Authorization: `Bearer ${tokens.access() ?? ''}` },
  })

  if (!res.ok) {
    let message = `The report could not be built (${res.status}).`
    try {
      const body = (await res.json()) as { message?: string }
      if (body.message) message = body.message
    } catch {
      // A non-JSON error body is not worth a second failure.
    }
    throw new Error(message)
  }

  const disposition = res.headers.get('Content-Disposition') ?? ''
  const fileName = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `${reportId}.${format}`

  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Freed on a delay: revoking in the same tick cancels the download in some
  // browsers before they have read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 1000)

  // Counted off the finished file by the server, not predicted here — the
  // whole point of saying "4 charts" is that something measured them.
  const charts = res.headers.get('X-Report-Charts')
  const pivots = res.headers.get('X-Report-Pivots')
  return {
    fileName,
    bytes: blob.size,
    charts: charts == null ? null : Number(charts),
    pivots: pivots == null ? null : Number(pivots),
  }
}

/**
 * What the file turned out to hold, as a sentence.
 *
 * Shared by the report screen and the four purchase lists so they describe
 * the same file the same way.
 */
export function describeReport(r: {
  fileName: string
  bytes: number
  charts: number | null
  pivots: number | null
}): string {
  const parts: string[] = []
  if (r.charts) parts.push(`${r.charts} ${r.charts === 1 ? 'chart' : 'charts'}`)
  if (r.pivots) parts.push(`${r.pivots === 1 ? 'a pivot table' : `${r.pivots} pivot tables`}`)
  const size = `${(r.bytes / 1024).toFixed(0)} KB`
  if (parts.length === 0) return `${r.fileName} — ${size}.`
  const list = parts.length === 1 ? parts[0] : `${parts[0]} and ${parts[1]}`
  return `${r.fileName} — ${size}, with ${list}.`
}
