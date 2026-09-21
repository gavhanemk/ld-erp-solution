'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Paperclip, Loader2, AlertCircle } from 'lucide-react'
import { api, ApiError } from '@/lib/api'

interface Attachment {
  id: string
  fileName: string
  sizeBytes: number
  uploadedBy?: { id: string; name: string } | null
  createdAt: string
}

/**
 * What is attached to an order, for the orders that cannot be opened at all.
 *
 * A sent order has no edit screen — the mill's own rule is that a supplier
 * already holding the paper is not to have it change under them — so the
 * form that uploads and lists these files was never reachable once an order
 * left draft. The paperclip count on the row said a file existed and gave no
 * way to see what it was. This opens read-only, off that same count.
 */
export function OrderAttachmentsDialog({
  docId,
  docNumber,
  kind = 'order',
  onClose,
}: {
  docId: string
  docNumber: string
  /**
   * Which document's files these are.
   *
   * Orders and receipts keep their attachments in separate tables behind
   * separate routes, and both have the same problem this dialog was written
   * for: a paperclip on the row saying a file exists, with no way to see it.
   * One dialog, two callers, rather than the same component twice.
   */
  kind?: 'order' | 'receipt'
  onClose: () => void
}) {
  const listPath =
    kind === 'order'
      ? `/purchase/orders/${docId}/attachments`
      : `/purchase/grn/${docId}/attachments`
  const linkBase = kind === 'order' ? '/purchase/attachments' : '/purchase/grn-attachments'

  const [files, setFiles] = useState<Attachment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await api.get<{ success: boolean; data: Attachment[] }>(
          listPath
        )
        if (!cancelled) setFiles(res.data)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : 'Could not load the files.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [listPath])

  const open = async (file: Attachment) => {
    setOpening(file.id)
    try {
      const res = await api.get<{ success: boolean; data: { url: string } }>(
        `${linkBase}/${file.id}/link`
      )
      window.open(res.data.url, '_blank', 'noopener')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open that file.')
    } finally {
      setOpening(null)
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="glass-card w-full max-w-md p-5"
        role="dialog"
        aria-modal="true"
        aria-labelledby="order-files-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="order-files-title" className="text-foreground text-base font-semibold">
              Files on {docNumber}
            </h2>
            <p className="text-muted-foreground mt-0.5 text-sm">
              What was scanned or attached against this order.
            </p>
          </div>
          <button
            type="button"
            className="btn-ghost p-1"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="mt-4">
          {loading ? (
            <p className="text-muted-foreground flex items-center gap-2 text-sm">
              <Loader2 size={14} className="animate-spin" /> Loading...
            </p>
          ) : error ? (
            <p className="flex items-center gap-2 text-sm text-red-400">
              <AlertCircle size={14} /> {error}
            </p>
          ) : files.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing is attached.</p>
          ) : (
            <ul className="space-y-1.5">
              {files.map((f) => (
                <li
                  key={f.id}
                  className="border-border bg-secondary flex items-center gap-2 rounded-lg border px-3 py-2"
                >
                  <Paperclip size={13} className="text-muted-foreground shrink-0" />
                  <button
                    type="button"
                    className="text-primary min-w-0 flex-1 truncate text-left text-sm underline disabled:opacity-50"
                    onClick={() => void open(f)}
                    disabled={opening === f.id}
                    title={`Open ${f.fileName}`}
                  >
                    {f.fileName}
                  </button>
                  <span className="text-muted-foreground whitespace-nowrap text-[10px]">
                    {(f.sizeBytes / 1024).toFixed(0)} KB
                    {f.uploadedBy?.name ? ` · ${f.uploadedBy.name}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
