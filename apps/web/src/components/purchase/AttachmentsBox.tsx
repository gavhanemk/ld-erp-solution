'use client'

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Loader2, LockKeyhole, Paperclip, Trash2, UploadCloud } from 'lucide-react'
import { api, ApiError, apiErrorMessage } from '@/lib/api'

/**
 * Files kept against a document — a purchase order or a goods receipt.
 *
 * Shared rather than written twice. Both forms want the same thing: a drop
 * zone, a list of what is attached, a delete button, and — for a document
 * that does not exist yet — files held in the browser until saving gives them
 * something to belong to. Two copies of that would drift the first time one
 * of them was fixed and the other was not.
 *
 * The bytes never pass through our server. Three steps per file: ask the API
 * for a one-use link, send the file straight to storage on that link, then
 * tell the API it landed so a row can be written. One file at a time, so a
 * mill connection that drops halfway costs one file and the message names it.
 */

export interface Attachment {
  id: string
  fileName: string
  sizeBytes: number
  mimeType: string | null
  uploadedBy?: { id: string; name: string } | null
  createdAt: string
  /** False once the file is kept as part of the record; absent means it can go. */
  removable?: boolean
  /** Why it is kept, in words, shown in place of the remove button. */
  lockedReason?: string | null
}

export interface AttachmentsBoxHandle {
  /** How many files are attached or waiting to be sent. */
  fileCount: number
  /**
   * Sends every file chosen before the document existed.
   *
   * Called once, right after the parent's own save succeeds and the new
   * record has an id. A file that fails to send does not fail the save that
   * is already done — its name comes back so the caller can say which one
   * did not make it, and it can be added again by reopening the document.
   */
  uploadPending: (recordId: string) => Promise<{ failed: string[] }>
}

const MAX_FILE_MB = 50
const MAX_FILES = 5

export const AttachmentsBox = forwardRef<
  AttachmentsBoxHandle,
  {
    /** '/purchase/orders' or '/purchase/grn' — where a record's own files live. */
    basePath: string
    /** '/purchase/attachments' or '/purchase/grn-attachments' — link and delete. */
    linkBasePath: string
    /** Unset until the document has been saved once. */
    recordId?: string
    onError: (message: string) => void
    /** Fires whenever the attached-or-pending count changes, for a caller that
        wants to show it somewhere the ref itself cannot reach — a folded
        section's own summary line, say, which has to re-render to update. */
    onCountChange?: (count: number) => void
    /**
     * Extra fields sent with each attach, for a document that files its files
     * under something narrower than itself.
     *
     * A purchase enquiry is the one that needs it: a drawing belongs to the
     * enquiry and every supplier gets the same one, but a scanned proforma
     * invoice belongs to the supplier who sent it, and three unlabelled PDFs in
     * one list is not a filing system. The box does not know or care what the
     * fields mean — it passes them through.
     */
    extraBody?: Record<string, unknown>
    /**
     * Which of the document's files this box is showing.
     *
     * Applied to what the server returns, so a box scoped to one supplier does
     * not list another's paperwork. Absent shows everything, which is what every
     * caller but the enquiry wants.
     */
    filter?: (file: Attachment) => boolean
    /**
     * Which of the files shown count against the five, when not all of them
     * do: a sample request lists every photo but allows five per round.
     * Absent counts every file shown.
     */
    limitFilter?: (file: Attachment) => boolean
    /*
     * The props below are for a record whose files are changes to the record
     * itself — a sample request, where filing or removing a file takes the
     * request's version and leaves a line in its history. Every one of them is
     * optional, and a caller that sets none gets the box exactly as before.
     */
    /** Extra fields for the one-use link request: what the file is, so a full kind is refused before it is sent. */
    uploadBody?: Record<string, unknown>
    /**
     * The record's files, when the caller already holds them and keeps them
     * current from its own saves. The box then shows these (through `filter`)
     * and neither fetches nor keeps a list of its own.
     */
    files?: Attachment[]
    /** Files a file that has reached storage, in place of the box's own POST. */
    register?: (
      recordId: string,
      file: { fileName: string; storagePath: string }
    ) => Promise<Attachment | void>
    /** Removes a file in place of the box's own DELETE; the caller asks anything it must first. */
    remove?: (file: Attachment) => void | Promise<void>
    /** The files and nothing to change them with: no drop zone, no remove buttons. */
    readOnly?: boolean
    /** A second line under a file: what it is filed against, who sent it, when. */
    describe?: (file: Attachment) => React.ReactNode
    /** True while files are being sent, so the caller can hold its other actions. */
    onBusyChange?: (busy: boolean) => void
    /** What the list says when there is nothing in it. */
    emptyText?: string
  }
>(function AttachmentsBox(
  {
    basePath,
    linkBasePath,
    recordId,
    onError,
    onCountChange,
    extraBody,
    filter,
    limitFilter,
    uploadBody,
    files,
    register,
    remove,
    readOnly = false,
    describe,
    onBusyChange,
    emptyText = 'Nothing attached yet.',
  },
  ref
) {
  const [fetched, setAttachments] = useState<Attachment[]>([])
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  // The caller's list when it holds one; the box's own otherwise.
  const controlled = files !== undefined
  const attachments = files !== undefined ? (filter ? files.filter(filter) : files) : fetched
  // What counts against the five: every file shown, unless the caller says fewer do.
  const counted = limitFilter ? attachments.filter(limitFilter) : attachments

  // Read inside the imperative handle without making it a dependency of a
  // effect — the handle is stable, the files inside it are not.
  const pendingRef = useRef<File[]>([])
  pendingRef.current = pendingFiles

  useEffect(() => {
    onBusyChange?.(uploading)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- an inline callback on the caller
  }, [uploading])

  useEffect(() => {
    if (!recordId) {
      setAttachments([])
      return
    }
    if (controlled) return
    let cancelled = false
    void (async () => {
      try {
        const res = await api.get<{ data: Attachment[] }>(`${basePath}/${recordId}/attachments`)
        if (!cancelled) setAttachments(filter ? res.data.filter(filter) : res.data)
      } catch {
        // Silent. The document itself has already loaded; a failed file list
        // is not worth a banner over, and the box below simply reads empty.
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `filter` is an
    // inline closure on most callers and would refetch on every render.
  }, [basePath, recordId])

  const uploadOne = async (file: File, id: string): Promise<Attachment | void> => {
    const signed = await api.post<{ data: { uploadUrl: string; storagePath: string } }>(
      `${basePath}/${id}/attachments/upload-url`,
      { fileName: file.name, sizeBytes: file.size, ...uploadBody }
    )

    // The token is in the URL's query string, which is the whole
    // authorisation. No header, and deliberately not our own API token.
    const put = await fetch(signed.data.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    })
    if (!put.ok) {
      throw new Error(`${file.name} could not be sent. Check your connection and try again.`)
    }

    if (register) return register(id, { fileName: file.name, storagePath: signed.data.storagePath })
    const saved = await api.post<{ data: Attachment }>(`${basePath}/${id}/attachments`, {
      fileName: file.name,
      storagePath: signed.data.storagePath,
      ...extraBody,
    })
    return saved.data
  }

  const chooseFiles = (fileList: FileList | null) => {
    if (!fileList?.length) return
    const chosen = Array.from(fileList)

    const room = MAX_FILES - counted.length - pendingFiles.length
    if (chosen.length > room) {
      onError(
        room === 0
          ? `This already has ${MAX_FILES} files. Remove one before adding another.`
          : `Only ${room} more file${room === 1 ? '' : 's'} can be attached.`
      )
      return
    }

    const tooBig = chosen.find((f) => f.size > MAX_FILE_MB * 1024 * 1024)
    if (tooBig) {
      onError(
        `${tooBig.name} is ${(tooBig.size / 1024 / 1024).toFixed(1)}MB. The limit is ${MAX_FILE_MB}MB.`
      )
      return
    }
    // Usually a download that failed: the server would refuse it anyway.
    const empty = chosen.find((f) => f.size === 0)
    if (empty) {
      onError(`${empty.name} is empty. Choose the file again.`)
      return
    }

    // Sent straight away once the document has an id; held until then
    // otherwise, since a file needs something to belong to.
    if (recordId) void uploadNow(chosen, recordId)
    else setPendingFiles((prev) => [...prev, ...chosen])
  }

  const uploadNow = async (chosen: File[], id: string) => {
    setUploading(true)
    try {
      for (const file of chosen) {
        const saved = await uploadOne(file, id)
        if (saved && !controlled) setAttachments((prev) => [...prev, saved])
      }
    } catch (err) {
      // apiErrorMessage: a refused link's real reason ("That file is empty")
      // travels in its field errors, under a flat "Validation error".
      onError(
        err instanceof ApiError
          ? apiErrorMessage(err, 'Could not attach that file.')
          : err instanceof Error
            ? err.message
            : 'Could not attach that file.'
      )
    } finally {
      setUploading(false)
    }
  }

  useImperativeHandle(ref, () => ({
    fileCount: attachments.length + pendingFiles.length,
    uploadPending: async (recordId: string) => {
      const waiting = pendingRef.current
      if (!waiting.length) return { failed: [] }
      const failed: string[] = []
      for (const file of waiting) {
        try {
          const saved = await uploadOne(file, recordId)
          if (saved && !controlled) setAttachments((prev) => [...prev, saved])
        } catch {
          failed.push(file.name)
        }
      }
      setPendingFiles([])
      return { failed }
    },
  }))

  const openFile = async (id: string) => {
    try {
      const res = await api.get<{ data: { url: string } }>(`${linkBasePath}/${id}/link`)
      window.open(res.data.url, '_blank', 'noopener')
    } catch (err) {
      onError(apiErrorMessage(err, 'Could not open that file.'))
    }
  }

  const removeFile = async (file: Attachment) => {
    if (remove) {
      // The caller asks its own question (a reason, say) and refreshes its list.
      try {
        await remove(file)
      } catch (err) {
        onError(apiErrorMessage(err, 'Could not remove that file.'))
      }
      return
    }
    if (!confirm(`Remove ${file.fileName}?`)) return
    try {
      await api.delete(`${linkBasePath}/${file.id}`)
      setAttachments((prev) => prev.filter((f) => f.id !== file.id))
    } catch (err) {
      onError(apiErrorMessage(err, 'Could not remove that file.'))
    }
  }

  const fileCount = attachments.length + pendingFiles.length
  // Against the limit: what the drop zone counts and stops at.
  const used = counted.length + pendingFiles.length

  useEffect(() => {
    onCountChange?.(fileCount)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileCount])

  return (
    <div className="space-y-2">
      {!readOnly && (
        <label
          onDragOver={(e) => {
            e.preventDefault()
            if (!uploading && used < MAX_FILES) setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            if (!uploading && used < MAX_FILES) chooseFiles(e.dataTransfer.files)
          }}
          // The file box inside is focusable (sr-only, not hidden), so Tab
          // stops here and Space or Enter opens the chooser; this shows where.
          className={`focus-within:ring-primary/40 relative flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-dashed px-3 py-3 focus-within:ring-2 ${
            uploading || used >= MAX_FILES
              ? 'border-border bg-secondary cursor-not-allowed opacity-70'
              : dragOver
                ? 'border-primary bg-primary/10 cursor-pointer'
                : 'border-border bg-secondary cursor-pointer hover:border-teal-500/40'
          }`}
        >
          <span className="flex min-w-0 items-center gap-2.5">
            {uploading ? (
              <Loader2 size={18} className="text-muted-foreground shrink-0 animate-spin" />
            ) : (
              <UploadCloud size={18} className="text-muted-foreground shrink-0" />
            )}
            <span className="min-w-0">
              <span className="text-foreground block truncate text-sm">
                {uploading ? 'Sending...' : 'Choose files'}
              </span>
              <span className="text-muted-foreground block whitespace-nowrap text-xs">
                or drag and drop
              </span>
            </span>
          </span>
          <span className="text-muted-foreground ml-auto shrink-0 whitespace-nowrap text-xs">
            {used}/{MAX_FILES} · {MAX_FILE_MB}MB each
          </span>
          <input
            type="file"
            multiple
            className="sr-only"
            disabled={uploading || used >= MAX_FILES}
            onChange={(e) => {
              chooseFiles(e.target.files)
              e.target.value = ''
            }}
          />
        </label>
      )}

      {fileCount === 0 ? (
        <p className="text-muted-foreground text-xs">{emptyText}</p>
      ) : (
        <ul className="space-y-1">
          {attachments.map((f) => {
            const note = describe?.(f)
            // Kept with the record: shown with its reason, never offered for removal.
            const kept = f.removable === false
            return (
              <li
                key={f.id}
                className={`border-border bg-secondary flex items-center gap-2 rounded-lg border px-3 py-1.5 ${note || kept ? 'flex-wrap' : ''}`}
              >
                <Paperclip size={13} className="text-muted-foreground shrink-0" />
                <button
                  type="button"
                  className="text-primary min-w-0 flex-1 truncate text-left text-sm underline"
                  onClick={() => void openFile(f.id)}
                  title={`Open ${f.fileName}`}
                >
                  {f.fileName}
                </button>
                <span className="text-muted-foreground whitespace-nowrap text-[10px]">
                  {(f.sizeBytes / 1024).toFixed(0)} KB
                </span>
                {kept ? (
                  <span className="text-muted-foreground p-1" title={f.lockedReason ?? undefined}>
                    <LockKeyhole size={13} aria-label="Kept with the record" />
                  </span>
                ) : (
                  !readOnly && (
                    <button
                      type="button"
                      className="btn-ghost text-muted-foreground p-1 hover:text-red-400"
                      onClick={() => void removeFile(f)}
                      aria-label={`Remove ${f.fileName}`}
                    >
                      <Trash2 size={13} />
                    </button>
                  )
                )}
                {(note || kept) && (
                  <span className="text-muted-foreground basis-full pl-5 text-xs">
                    {note}
                    {kept && f.lockedReason && (
                      <span className="block">Kept: {f.lockedReason}</span>
                    )}
                  </span>
                )}
              </li>
            )
          })}

          {/* Chosen but not yet sent. Marked so nobody believes a file is
            safely filed before the document is saved. */}
          {pendingFiles.map((f, i) => (
            <li
              key={`pending-${f.name}-${i}`}
              className="border-border bg-secondary flex items-center gap-2 rounded-lg border border-dashed px-3 py-1.5"
            >
              <Paperclip size={13} className="text-muted-foreground shrink-0" />
              <span className="text-foreground min-w-0 flex-1 truncate text-sm">{f.name}</span>
              <span className="text-muted-foreground whitespace-nowrap text-[10px]">
                {(f.size / 1024).toFixed(0)} KB · on save
              </span>
              <button
                type="button"
                className="btn-ghost text-muted-foreground p-1 hover:text-red-400"
                onClick={() => setPendingFiles((prev) => prev.filter((_, x) => x !== i))}
                aria-label={`Remove ${f.name}`}
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
})
