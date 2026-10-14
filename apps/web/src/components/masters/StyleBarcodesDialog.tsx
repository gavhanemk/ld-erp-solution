'use client'

import { useCallback, useEffect, useState } from 'react'
import { Barcode, Loader2, Save } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { StepInput } from '@/components/ui/StepInput'

interface Row {
  itemId: string
  itemCode: string
  color: string
  sizeId: string | null
  size: string
  ean: string | null
  mrp: number | null
}

interface Data {
  style: { code: string; name: string; mrp: number | null }
  prefix: string | null
  rows: Row[]
}

const key = (r: Row) => `${r.itemId}|${r.sizeId ?? ''}`

/**
 * A style's retail barcodes: every colour and size, its EAN-13 and its MRP.
 * Numbers are given from the GS1 prefix in one press; one already issued on
 * the GS1 portal can be typed in instead. A size whose MRP differs from the
 * style's — 2XL dearer, say — carries its own.
 */
export function StyleBarcodesDialog({ styleId, onClose }: { styleId: string; onClose: () => void }) {
  const [data, setData] = useState<Data | null>(null)
  const [edits, setEdits] = useState<Record<string, { ean?: string; mrp?: string }>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ data: Data }>(`/retail/styles/${styleId}/barcodes`)
      setData(res.data)
      setEdits({})
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the barcodes.')
    }
  }, [styleId])

  useEffect(() => {
    void load()
  }, [load])

  const missing = data?.rows.filter((r) => !r.ean).length ?? 0
  const changed = Object.keys(edits).length

  const assign = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<{ message: string }>(`/retail/styles/${styleId}/barcodes/assign`, {})
      setMessage(res.message)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not give the barcodes.')
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    if (!data) return
    setBusy(true)
    setError(null)
    try {
      for (const r of data.rows) {
        const e = edits[key(r)]
        if (!e) continue
        await api.patch('/retail/barcodes', {
          itemId: r.itemId,
          sizeId: r.sizeId,
          ...(e.ean !== undefined && e.ean.trim() && e.ean.trim() !== r.ean ? { ean: e.ean.trim() } : {}),
          ...(e.mrp !== undefined ? { mrp: e.mrp.trim() === '' ? null : Number(e.mrp) } : {}),
        })
      }
      setMessage('Saved.')
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <FormFrame
      icon={Barcode}
      title={data ? `Barcodes · ${data.style.code}` : 'Barcodes'}
      subtitle={data ? `${data.style.name} — one EAN-13 for every colour and size, printed on its retail tag` : undefined}
      onClose={onClose}
      busy={busy}
      error={error}
      width="max-w-3xl"
      primary={
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={busy || !changed}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Save
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
          Close
        </button>
      }
      footerNote={message}
    >
      {!data ? (
        <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
          <Loader2 size={16} className="animate-spin" /> Loading…
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="text-muted-foreground">
              {data.prefix ? (
                <>
                  GS1 prefix <span className="text-foreground font-mono">{data.prefix}</span> · style MRP{' '}
                  <span className="text-foreground">{data.style.mrp != null ? `₹${data.style.mrp.toLocaleString('en-IN')}` : 'not set'}</span>
                </>
              ) : (
                'No GS1 prefix yet: enter it in Settings → Company, or type each barcode in.'
              )}
            </span>
            {missing > 0 && data.prefix && (
              <button type="button" className="btn-primary h-9" onClick={() => void assign()} disabled={busy}>
                <Barcode size={15} /> Give barcodes to {missing} {missing === 1 ? 'size' : 'sizes'}
              </button>
            )}
          </div>
          {!data.rows.length ? (
            <p className="text-muted-foreground py-4 text-center text-sm">No finished items for this style yet. They are made from its colours.</p>
          ) : (
            <div className="border-border overflow-x-auto rounded-lg border">
              <table className="data-table table-compact min-w-full">
                <thead>
                  <tr className="bg-secondary">
                    <th>Colour</th>
                    <th>Size</th>
                    <th>EAN-13</th>
                    <th style={{ textAlign: 'right' }}>MRP for this size (₹)</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => {
                    const e = edits[key(r)] ?? {}
                    return (
                      <tr key={key(r)}>
                        <td className="whitespace-nowrap text-sm">
                          {r.color || '—'} <span className="text-muted-foreground font-mono text-xs">{r.itemCode}</span>
                        </td>
                        <td className="whitespace-nowrap text-sm font-semibold">{r.size || '—'}</td>
                        <td>
                          <input
                            className="form-input h-8 w-40 font-mono text-xs"
                            value={e.ean ?? r.ean ?? ''}
                            placeholder={data.prefix ? 'Given on save' : '13 digits'}
                            maxLength={13}
                            inputMode="numeric"
                            onChange={(ev) => setEdits((p) => ({ ...p, [key(r)]: { ...p[key(r)], ean: ev.target.value.replace(/\D/g, '') } }))}
                            aria-label={`Barcode for ${r.color} ${r.size}`}
                          />
                        </td>
                        <td className="text-right">
                          <StepInput
                            className="form-input h-8 w-28 text-right"
                            value={e.mrp ?? (r.mrp != null ? String(r.mrp) : '')}
                            onValueChange={(v) => setEdits((p) => ({ ...p, [key(r)]: { ...p[key(r)], mrp: v } }))}
                            decimals
                            placeholder={data.style.mrp != null ? String(data.style.mrp) : ''}
                            aria-label={`MRP for ${r.color} ${r.size}`}
                          />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-muted-foreground text-xs">An empty MRP uses the style&apos;s. A barcode, once given, stays with its size for good.</p>
        </div>
      )}
    </FormFrame>
  )
}
