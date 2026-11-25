'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Upload, Trash2, FileText, Stamp, CheckCircle2, Image as ImageIcon } from 'lucide-react'
import { ApiError } from '@/lib/api'
import { loadAppSettings } from '@/lib/appSettings'
import {
  settingsApi,
  type DocumentBranding,
  type DocumentTemplate,
} from '@/lib/settingsApi'
import { Field, FieldGrid, FieldGroup, LoadingRow, Notice, SaveButton, SettingsCard, ToggleRow } from '@/components/settings/ui'

/**
 * What appears on your printed papers.
 *
 * This replaces Absolute's Templates gallery. There is no layout editor,
 * because the arrangement of an Indian tax invoice is fixed by what has to be
 * on it — there is nothing useful to drag around. What genuinely differs
 * between businesses is the wording and which blocks are shown, and that is
 * what this sets.
 */
export default function DocumentSettingsPage() {
  const [branding, setBranding] = useState<DocumentBranding | null>(null)
  const [documents, setDocuments] = useState<DocumentTemplate[]>([])
  const [selected, setSelected] = useState('INV')
  const [loading, setLoading] = useState(true)
  const [savingBranding, setSavingBranding] = useState(false)
  const [savingDoc, setSavingDoc] = useState(false)
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await settingsApi.documents.get()
      setBranding(res.data.branding)
      setDocuments(res.data.documents)
    } catch (err) {
      setMessage({
        kind: 'error',
        text:
          err instanceof ApiError
            ? err.status === 403
              ? 'Your role does not allow changing documents. Ask an administrator.'
              : err.message
            : 'Could not load the document settings.',
      })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const setBrand = (key: keyof DocumentBranding, value: string | null) => {
    setBranding((b) => (b ? { ...b, [key]: value } : b))
    setErrors((e) => (e[key] ? { ...e, [key]: '' } : e))
  }

  const saveBranding = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!branding) return
    setSavingBranding(true)
    setErrors({})
    setMessage(null)
    try {
      await settingsApi.documents.saveBranding({
        logoUrl: branding.logoUrl ?? '',
        signatureUrl: branding.signatureUrl ?? '',
        bankName: branding.bankName ?? '',
        bankBranch: branding.bankBranch ?? '',
        bankAccount: branding.bankAccount ?? '',
        bankIFSC: branding.bankIFSC ?? '',
        upiId: branding.upiId ?? '',
      })
      // The menu shows the logo, so it is told straight away rather than at the next reload.
      await loadAppSettings(true)
      setMessage({ kind: 'success', text: 'Letterhead and bank details saved.' })
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.fieldErrors) setErrors(err.fieldErrors)
        setMessage({
          kind: 'error',
          text: err.fieldErrors ? 'Please correct the highlighted fields.' : err.message,
        })
      } else {
        setMessage({ kind: 'error', text: 'Could not save.' })
      }
    } finally {
      setSavingBranding(false)
    }
  }

  const current = documents.find((d) => d.docType === selected)

  const setDoc = (patch: Partial<DocumentTemplate>) =>
    setDocuments((ds) => ds.map((d) => (d.docType === selected ? { ...d, ...patch } : d)))

  const saveDoc = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!current) return
    setSavingDoc(true)
    setMessage(null)
    try {
      await settingsApi.documents.saveTemplate(current.docType, {
        title: current.title,
        termsText: current.termsText ?? '',
        declaration: current.declaration ?? '',
        footerNote: current.footerNote ?? '',
        showHsn: current.showHsn,
        showAmountInWords: current.showAmountInWords,
        showBankDetails: current.showBankDetails,
        showSignature: current.showSignature,
        copies: current.copies,
      })
      setDoc({ configured: true })
      setMessage({ kind: 'success', text: `${current.label} saved.` })
    } catch (err) {
      setMessage({
        kind: 'error',
        text: err instanceof ApiError ? err.message : 'Could not save.',
      })
    } finally {
      setSavingDoc(false)
    }
  }

  if (loading) {
    return (
      <SettingsCard title="Printed documents" icon={FileText}>
        <LoadingRow />
      </SettingsCard>
    )
  }

  return (
    <div className="space-y-5">
      {message && <Notice kind={message.kind}>{message.text}</Notice>}

      <form onSubmit={saveBranding}>
        <SettingsCard
          icon={Stamp}
          title="Letterhead and bank details"
          description="The same on every paper you print. The logo also shows at the top of the menu."
          footer={<SaveButton saving={savingBranding}>Save letterhead</SaveButton>}
        >
          <div className="space-y-5">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <ImagePicker
                label="Company logo"
                help="Printed at the top of every document. PNG or JPG, under 400 KB."
                value={branding?.logoUrl ?? null}
                error={errors.logoUrl}
                onChange={(v) => setBrand('logoUrl', v)}
              />
              <ImagePicker
                label="Signature"
                help="Printed above the signature line. A scan of a signature on white."
                value={branding?.signatureUrl ?? null}
                error={errors.signatureUrl}
                onChange={(v) => setBrand('signatureUrl', v)}
              />
            </div>

            <FieldGroup title="Bank details" description="Printed on the invoice so a customer knows where to pay.">
              <FieldGrid>
                <Field label="Bank name" htmlFor="bankName" error={errors.bankName}>
                  <input
                    id="bankName"
                    className="form-input"
                    placeholder="HDFC Bank"
                    value={branding?.bankName ?? ''}
                    onChange={(e) => setBrand('bankName', e.target.value)}
                  />
                </Field>
                <Field label="Branch" htmlFor="bankBranch" error={errors.bankBranch}>
                  <input
                    id="bankBranch"
                    className="form-input"
                    placeholder="Bhiwandi"
                    value={branding?.bankBranch ?? ''}
                    onChange={(e) => setBrand('bankBranch', e.target.value)}
                  />
                </Field>
                <Field label="Account number" htmlFor="bankAccount" error={errors.bankAccount}>
                  <input
                    id="bankAccount"
                    className="form-input font-mono"
                    value={branding?.bankAccount ?? ''}
                    onChange={(e) => setBrand('bankAccount', e.target.value)}
                  />
                </Field>
                <Field label="IFSC code" htmlFor="bankIFSC" error={errors.bankIFSC}>
                  <input
                    id="bankIFSC"
                    className="form-input font-mono"
                    placeholder="HDFC0001234"
                    maxLength={11}
                    value={branding?.bankIFSC ?? ''}
                    onChange={(e) => setBrand('bankIFSC', e.target.value.toUpperCase())}
                  />
                </Field>
                <Field label="UPI ID" htmlFor="upiId" error={errors.upiId} help="Optional. For smaller customers who pay by phone.">
                  <input
                    id="upiId"
                    className="form-input font-mono"
                    placeholder="ldcotton@hdfcbank"
                    value={branding?.upiId ?? ''}
                    onChange={(e) => setBrand('upiId', e.target.value)}
                  />
                </Field>
              </FieldGrid>
            </FieldGroup>
          </div>
        </SettingsCard>
      </form>

      <form onSubmit={saveDoc}>
        <SettingsCard
          icon={FileText}
          title="Each document"
          description="Pick a document on the left to set its heading, its terms and which blocks are printed."
          footer={current && <SaveButton saving={savingDoc}>Save {current.label}</SaveButton>}
        >
          <div className="grid gap-5 lg:grid-cols-[13.5rem_minmax(0,1fr)]">
            {/* The documents, down the side: eight of them would not fit in a row. */}
            <div
              role="tablist"
              aria-label="Documents"
              className="no-scrollbar flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible lg:border-r lg:border-border/70 lg:pr-4"
            >
              {documents.map((d) => {
                const on = selected === d.docType
                return (
                  <button
                    key={d.docType}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    onClick={() => setSelected(d.docType)}
                    className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                      on ? 'bg-primary/10 text-primary font-medium' : 'text-foreground hover:bg-secondary'
                    }`}
                  >
                    <FileText size={14} className={`shrink-0 ${on ? 'text-primary' : 'text-muted-foreground'}`} />
                    <span className="flex-1 whitespace-nowrap">{d.label}</span>
                    {d.configured ? (
                      <CheckCircle2 size={13} className="text-emerald-500" aria-label="Set up" />
                    ) : (
                      <span className="text-muted-foreground text-[10px]">default</span>
                    )}
                  </button>
                )
              })}
            </div>

            {current && (
              <div className="min-w-0 space-y-5">
                <FieldGrid cols={2}>
                  <Field label="Heading" htmlFor="doc-title" required help="Printed in large type at the top">
                    <input
                      id="doc-title"
                      className="form-input"
                      value={current.title}
                      onChange={(e) => setDoc({ title: e.target.value })}
                    />
                  </Field>
                  <Field label="Footer line" htmlFor="doc-footer" help="A short line right at the bottom">
                    <input
                      id="doc-footer"
                      className="form-input"
                      placeholder="Subject to Thane jurisdiction"
                      value={current.footerNote ?? ''}
                      onChange={(e) => setDoc({ footerNote: e.target.value })}
                    />
                  </Field>
                  <Field label="Terms and conditions" htmlFor="doc-terms" help="Printed at the foot. One point per line.">
                    <textarea
                      id="doc-terms"
                      rows={4}
                      className="form-input"
                      placeholder={
                        current.docType === 'PO'
                          ? 'Goods must match the approved sample.\nDelivery within the agreed date.\nPayment 30 days from bill date.'
                          : 'Interest at 18% per annum on overdue amounts.\nGoods once sold will not be taken back.'
                      }
                      value={current.termsText ?? ''}
                      onChange={(e) => setDoc({ termsText: e.target.value })}
                    />
                  </Field>
                  <Field
                    label="Declaration"
                    htmlFor="doc-declaration"
                    help="The line certifying the particulars are true. Your accountant will give you the exact wording."
                  >
                    <textarea
                      id="doc-declaration"
                      rows={4}
                      className="form-input"
                      placeholder="We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct."
                      value={current.declaration ?? ''}
                      onChange={(e) => setDoc({ declaration: e.target.value })}
                    />
                  </Field>
                </FieldGrid>

                <FieldGroup title="What to print">
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <ToggleRow
                      label="HSN code column"
                      description="Required on a tax invoice. Check the digits with your accountant."
                      checked={current.showHsn}
                      onChange={(v) => setDoc({ showHsn: v })}
                    />
                    <ToggleRow
                      label="Total in words"
                      description="Rupees Forty-Seven Thousand Two Hundred Fifty Only"
                      checked={current.showAmountInWords}
                      onChange={(v) => setDoc({ showAmountInWords: v })}
                    />
                    <ToggleRow
                      label="Bank details"
                      description="Where the customer should pay. Set them above."
                      checked={current.showBankDetails}
                      onChange={(v) => setDoc({ showBankDetails: v })}
                    />
                    <ToggleRow
                      label="Signature block"
                      description="For and on behalf of, with your signature image"
                      checked={current.showSignature}
                      onChange={(v) => setDoc({ showSignature: v })}
                    />
                  </div>
                </FieldGroup>

                <FieldGroup
                  title="Copies to print"
                  description="One line per copy. Each is printed on its own page with that label. Leave blank for a single copy."
                >
                  <textarea
                    id="doc-copies"
                    aria-label="Copies to print"
                    rows={3}
                    className="form-input font-mono text-xs md:max-w-xl"
                    placeholder={'Original for Recipient\nDuplicate for Transporter\nTriplicate for Supplier'}
                    value={current.copies.join('\n')}
                    onChange={(e) =>
                      setDoc({
                        copies: e.target.value
                          .split('\n')
                          .map((s) => s.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </FieldGroup>
              </div>
            )}
          </div>
        </SettingsCard>
      </form>

      <p className="text-muted-foreground max-w-2xl text-xs">
        There is no layout designer here on purpose. What has to appear on a tax invoice is fixed by
        law, so the arrangement is not yours to choose — only the wording and which blocks are shown.
      </p>
    </div>
  )
}

/** Reads a picture straight into the form as a data URL — no upload server needed. */
function ImagePicker({
  label,
  help,
  value,
  error,
  onChange,
}: {
  label: string
  help: string
  value: string | null
  error?: string
  onChange: (v: string | null) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [localError, setLocalError] = useState<string | null>(null)

  const pick = (file: File) => {
    setLocalError(null)
    if (file.size > 400 * 1024) {
      setLocalError('That image is too large. Keep it under 400 KB.')
      return
    }
    const reader = new FileReader()
    reader.onload = () => onChange(String(reader.result))
    reader.onerror = () => setLocalError('Could not read that file.')
    reader.readAsDataURL(file)
  }

  return (
    <div className="border-border/70 flex flex-col gap-4 rounded-lg border p-4 sm:flex-row sm:items-center">
      {/* White behind it, as it will be on the paper. */}
      <div className="border-border flex h-24 w-full shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-white p-2 sm:w-40">
        {value ? (
          // A data URL, so next/image would gain nothing and needs configuring.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={value} alt={label} className="max-h-full max-w-full object-contain" />
        ) : (
          <span className="flex flex-col items-center gap-1 text-[11px] text-slate-400">
            <ImageIcon size={20} />
            No picture yet
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p className="text-foreground text-sm font-medium">{label}</p>
        {error || localError ? (
          <p className="mt-0.5 text-xs text-red-500">{error || localError}</p>
        ) : (
          <p className="text-muted-foreground mt-0.5 text-xs leading-snug">{help}</p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/svg+xml,image/webp"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) pick(file)
              e.target.value = ''
            }}
          />
          <button type="button" className="btn-secondary h-8 text-xs" onClick={() => input.current?.click()}>
            <Upload size={13} /> {value ? 'Change picture' : 'Choose picture'}
          </button>
          {value && (
            <button
              type="button"
              className="btn-ghost h-8 text-xs text-muted-foreground hover:text-red-500"
              onClick={() => onChange(null)}
            >
              <Trash2 size={13} /> Remove
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
