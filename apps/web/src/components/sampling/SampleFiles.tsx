'use client'
import { useEffect, useState } from 'react'
import { Paperclip } from 'lucide-react'
import {
  SAMPLE_ATTACHMENT_KINDS,
  SAMPLE_ATTACHMENT_KIND_LABEL,
  SAMPLE_STATE_LABEL,
  type SampleAttachment,
  type SampleAttachmentKind,
} from '@ld-erp/shared'
import { formatDate } from '@/lib/utils'
import { AttachmentsBox, type Attachment } from '@/components/purchase/AttachmentsBox'
import { ReasonDialog } from '@/components/ui/ReasonDialog'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { Field } from './SampleSpecEditor'
import { fileCounts, fileScope, filedHere, filesFullText } from './samplingFlow'
import type { SampleRequest } from './types'

/*
 * Kinds that usually show one round — the sample made in it, the buyer's word
 * on it, the courier slip it went with — so a new one of these is offered for
 * the latest round first. The tech pack and anything else are the request's.
 */
const ROUND_KINDS: SampleAttachmentKind[] = ['PATTERN', 'PHOTO', 'APPROVAL', 'DISPATCH']

/**
 * The buyer's tech pack and the other files of a sample request, a kind at a
 * time.
 *
 * Filing a file and removing one are changes to the request itself (they take
 * its version and leave a line in its activity), so the shared file box is
 * given the request's own actions in place of its plain POST and DELETE, and
 * the request's file list in place of fetching its own. It lists every file
 * of the kind chosen, but the five-file limit is per kind and per place filed
 * (the whole request, or one round), which is what it is told to count.
 */
export function SampleFiles({
  request,
  canEdit,
  closedReason,
  post,
  onBusyChange,
}: {
  request: SampleRequest
  /** Sampling edit permission on an open request. */
  canEdit: boolean
  /** Why files can no longer be added or removed, when they cannot. */
  closedReason: string
  post: (action: string, data: unknown) => Promise<SampleRequest>
  onBusyChange: (busy: boolean) => void
}) {
  const [kind, setKind] = useState<SampleAttachmentKind>('TECH_PACK')
  // '' files it against the whole request; otherwise one round's id.
  const [scope, setScope] = useState('')
  const [error, setError] = useState('')
  const [removing, setRemoving] = useState<SampleAttachment | null>(null)
  const [busy, setBusy] = useState(false)
  const files = request.attachments ?? []
  const counts = fileCounts(files)
  const label = SAMPLE_ATTACHMENT_KIND_LABEL[kind]
  const open = canEdit && !closedReason
  const latestId = request.rounds[0].id
  const pick = (next: SampleAttachmentKind) => {
    setKind(next)
    setScope(ROUND_KINDS.includes(next) ? latestId : '')
    setError('')
  }
  // A new round is where the next photo or approval belongs, not the round
  // that was latest when this panel opened.
  useEffect(() => {
    if (ROUND_KINDS.includes(kind)) setScope(latestId)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when a round is added
  }, [latestId])
  const full = filesFullText(files, kind, scope, request.rounds)
  const detach = async (reason: string) => {
    if (!removing) return
    setBusy(true)
    setError('')
    try {
      await post('DETACH', { attachmentId: removing.id, reason })
      setRemoving(null)
    } catch (e) {
      // Shown in the panel, where the file is, rather than behind the question.
      setRemoving(null)
      setError(e instanceof Error ? e.message : 'Could not remove that file.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="glass-card space-y-4 p-5" aria-labelledby="sample-files-title">
      <div>
        <h3 id="sample-files-title" className="flex items-center gap-2 font-semibold">
          <Paperclip size={16} /> Tech pack & files
        </h3>
        <p className="text-muted-foreground mt-1 text-sm">
          The buyer’s tech pack, patterns, photos and approvals, kept with this request. 50MB a
          file. Click a file name to open it.
        </p>
      </div>
      <div role="group" aria-label="Kind of file" className="flex flex-wrap gap-2">
        {SAMPLE_ATTACHMENT_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={kind === k}
            onClick={() => pick(k)}
            className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors ${kind === k ? 'border-primary/50 bg-primary/10 text-foreground font-medium' : 'border-border text-muted-foreground hover:bg-muted/40'}`}
          >
            {SAMPLE_ATTACHMENT_KIND_LABEL[k]}
            <span className={counts[k] ? 'badge-info' : 'badge-neutral'}>{counts[k]}</span>
          </button>
        ))}
      </div>
      {open && (
        <div className="grid gap-3 md:grid-cols-2">
          <Field
            label="File against"
            hint="A tech pack belongs to the whole request. Photos, approvals and dispatch slips usually belong to the round they show."
          >
            <SmartSelect
              className="form-input"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            >
              <option value="">Whole request</option>
              {request.rounds.map((r) => (
                <option key={r.id} value={r.id}>
                  Round {r.revision} · {r.specification.milestone || 'Milestone not named'} ·{' '}
                  {SAMPLE_STATE_LABEL[r.state]}
                </option>
              ))}
            </SmartSelect>
          </Field>
        </div>
      )}
      {error && (
        <p role="alert" className="warn-text text-sm">
          {error}
        </p>
      )}
      {open && full && <p className="text-muted-foreground text-xs">{full}</p>}
      <div>
        <p className="form-label">{label} files</p>
        <AttachmentsBox
          basePath="/sampling"
          linkBasePath="/sampling/attachments"
          recordId={request.id}
          files={files}
          filter={(a) => (a as SampleAttachment).kind === kind}
          limitFilter={(a) => filedHere(kind, scope)(a as SampleAttachment)}
          uploadBody={{ kind, roundId: scope || null }}
          register={async (_, file) => {
            setError('')
            const updated = await post('ATTACH', { ...file, kind, roundId: scope || null })
            return updated.attachments?.find((a) => a.storagePath === file.storagePath)
          }}
          remove={(file: Attachment) => {
            setError('')
            setRemoving(file as SampleAttachment)
          }}
          readOnly={!open}
          describe={(f) => {
            const a = f as SampleAttachment
            return `${fileScope(a, request.rounds)} · ${formatDate(a.createdAt)}${a.uploadedBy ? ` · ${a.uploadedBy.name}` : ''}`
          }}
          onBusyChange={onBusyChange}
          onError={setError}
          emptyText={
            open
              ? kind === 'TECH_PACK'
                ? 'No tech pack yet. Choose the buyer’s tech pack file, or drag it here.'
                : `No ${label.toLowerCase()} files yet.`
              : `No ${label.toLowerCase()} files on this request.`
          }
        />
      </div>
      {!open && (
        <p className="text-muted-foreground text-xs">
          {closedReason ||
            'You can open these files. Adding or removing them needs sampling edit permission.'}
        </p>
      )}
      {open && (
        <p className="text-muted-foreground text-xs">
          Once a round is released, the files it was released with and the tech pack it followed
          are kept as the record of what was made; add a newer version beside them instead. A file
          added after the release can still be removed. Up to 5 of a kind for the whole request,
          and 5 for each round.
        </p>
      )}
      {removing && (
        <ReasonDialog
          title={`Remove ${removing.fileName}?`}
          description="The file is taken off this request and deleted from storage. The removal and your reason stay in the request’s activity."
          confirmLabel="Remove file"
          danger
          busy={busy}
          placeholder="e.g. Wrong file, buyer sent a newer version"
          onCancel={() => setRemoving(null)}
          onConfirm={(reason) => void detach(reason)}
        />
      )}
    </section>
  )
}
