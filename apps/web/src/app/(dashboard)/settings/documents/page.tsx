'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Upload, Trash2, FileText } from 'lucide-react'
import { ApiError } from '@/lib/api'
import {
  settingsApi,
  type DocumentBranding,
  type DocumentTemplate,
} from '@/lib/settingsApi'
import { Field, LoadingRow, Notice, SaveButton, SettingsCard, Toggle } from '@/components/settings/ui'

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
      <SettingsCard title="Printed documents">
        <LoadingRow />
      </SettingsCard>
    )
  }

  return (
    <div className="space-y-6">
      {message && <Notice kind={message.kind}>{message.text}</Notice>}

      <form onSubmit={saveBranding}>
        <SettingsCard
          title="Letterhead and bank details"
          description="The same on every paper you print."
        >
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
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

            <div className="pt-5 border-t border-border">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                Bank details
              </h3>
              <p className="text-xs text-muted-foreground mb-4">
                Printed on the invoice so a customer knows where to pay.
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
                    value={branding?.bankIFSC ?? ''}
                    onChange={(e) => setBrand('bankIFSC', e.target.value.toUpperCase())}
                  />
                </Field>
                <Field
                  label="UPI ID"
                  htmlFor="upiId"
                  error={errors.upiId}
                  help="Optional. For smaller customers who pay by phone."
                  span={2}
                >
                  <input
                    id="upiId"
                    className="form-input font-mono"
                    placeholder="ldcotton@hdfcbank"
                    value={branding?.upiId ?? ''}
                    onChange={(e) => setBrand('upiId', e.target.value)}
                  />
                </Field>
              </div>
            </div>

            <div className="flex justify-end pt-3 border-t border-border">
              <SaveButton saving={savingBranding} />
            </div>
          </div>
        </SettingsCard>
      </form>

      <form onSubmit={saveDoc}>
        <SettingsCard
          title="Each document"
          description="The heading, the terms and which blocks are printed."
        >
          <div className="flex flex-wrap gap-1 p-1 mb-5 rounded-lg border border-border bg-secondary/40 w-fit">
            {documents.map((d) => (
              <button
                key={d.docType}
                type="button"
                onClick={() => setSelected(d.docType)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                  selected === d.docType
                    ? 'bg-teal-500/15 text-teal-400 border border-teal-500/25'
                    : 'text-muted-foreground hover:text-foreground border border-transparent'
                }`}
              >
                <FileText size={13} />
                {d.label}
                {!d.configured && <span className="text-[9px] opacity-60">not set</span>}
              </button>
            ))}
          </div>

          {current && (
            <div className="space-y-5">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field
                  label="Heading"
                  htmlFor="doc-title"
                  required
                  help="Printed in large type at the top"
                  span={2}
                >
                  <input
                    id="doc-title"
                    className="form-input"
                    value={current.title}
                    onChange={(e) => setDoc({ title: e.target.value })}
                  />
                </Field>

                <Field
                  label="Terms and conditions"
                  htmlFor="doc-terms"
                  help="Printed at the foot. One point per line."
                  span={2}
                >
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
                  span={2}
                >
                  <textarea
                    id="doc-declaration"
                    rows={2}
                    className="form-input"
                    placeholder="We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct."
                    value={current.declaration ?? ''}
                    onChange={(e) => setDoc({ declaration: e.target.value })}
                  />
                </Field>

                <Field
                  label="Footer line"
                  htmlFor="doc-footer"
                  help="A short line right at the bottom"
                  span={2}
                >
                  <input
                    id="doc-footer"
                    className="form-input"
                    placeholder="Subject to Thane jurisdiction"
                    value={current.footerNote ?? ''}
                    onChange={(e) => setDoc({ footerNote: e.target.value })}
                  />
                </Field>
              </div>

              <div className="pt-4 border-t border-border">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
                  What to print
                </h3>
                <div className="divide-y divide-border/60">
                  <ToggleRow
                    label="HSN code column"
                    help="Required on a tax invoice. Check the digits with your accountant."
                    checked={current.showHsn}
                    onChange={(v) => setDoc({ showHsn: v })}
                  />
                  <ToggleRow
                    label="Total in words"
                    help="Rupees Forty-Seven Thousand Two Hundred Fifty Only"
                    checked={current.showAmountInWords}
                    onChange={(v) => setDoc({ showAmountInWords: v })}
                  />
                  <ToggleRow
                    label="Bank details"
                    help="Where the customer should pay. Set them above."
                    checked={current.showBankDetails}
                    onChange={(v) => setDoc({ showBankDetails: v })}
                  />
                  <ToggleRow
                    label="Signature block"
                    help="For and on behalf of, with your signature image"
                    checked={current.showSignature}
                    onChange={(v) => setDoc({ showSignature: v })}
                  />
                </div>
              </div>

              <Field
                label="Copies to print"
                htmlFor="doc-copies"
                help="One line per copy. Each is printed on its own page with that label. Leave blank for a single copy."
              >
                <textarea
                  id="doc-copies"
                  rows={3}
                  className="form-input font-mono text-xs"
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
              </Field>

              <div className="flex justify-end pt-3 border-t border-border">
                <SaveButton saving={savingDoc}>Save {current.label}</SaveButton>
              </div>
            </div>
          )}
        </SettingsCard>
      </form>

      <p className="text-xs text-muted-foreground max-w-2xl">
        There is no layout designer here on purpose. What has to appear on a tax invoice is fixed by
        law, so the arrangement is not yours to choose — only the wording and which blocks are shown.
      </p>
    </div>
  )
}

function ToggleRow({
  label,
  help,
  checked,
  onChange,
}: {
  label: string
  help: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-6 py-3 first:pt-0">
      <div>
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{help}</p>
      </div>
      <Toggle checked={checked} onChange={onChange} label={label} />
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
    <div>
      <label className="form-label">{label}</label>

      <div className="flex items-start gap-4">
        <div className="w-32 h-20 rounded-lg border border-border bg-secondary/40 flex items-center justify-center overflow-hidden shrink-0">
          {value ? (
            // A data URL, so next/image would gain nothing and needs configuring.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={value} alt={label} className="max-w-full max-h-full object-contain" />
          ) : (
            <span className="text-[10px] text-muted-foreground">Nothing yet</span>
          )}
        </div>

        <div className="flex flex-col gap-2">
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
          <button type="button" className="btn-secondary text-xs" onClick={() => input.current?.click()}>
            <Upload size={13} /> Choose picture
          </button>
          {value && (
            <button
              type="button"
              className="btn-ghost text-xs text-muted-foreground hover:text-red-400"
              onClick={() => onChange(null)}
            >
              <Trash2 size={13} /> Remove
            </button>
          )}
        </div>
      </div>

      {error || localError ? (
        <p className="text-xs text-red-400 mt-2">{error || localError}</p>
      ) : (
        <p className="text-xs text-muted-foreground mt-2">{help}</p>
      )}
    </div>
  )
}
