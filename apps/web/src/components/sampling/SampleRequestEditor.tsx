'use client'
import { useState } from 'react'
import { Pencil } from 'lucide-react'
import { FormFrame } from '@/components/ui/FormFrame'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { SuggestInput } from '@/components/ui/SuggestInput'
import { Field } from './SampleSpecEditor'
import { distinctValues } from './samplingFlow'
import type { Lookups, SampleRequest } from './types'

export interface RequestEdits {
  title: string
  customerId: string | null
  brandId: string
  buyerRef: string
  owner: string
  brief: string
  requiredAt: string | null
  // An emptied box is saved as nothing.
  buyerStyleRef: string
  season: string
  garmentCategory: string
  reason: string
}

/**
 * The tech-pack details asked for when a request is made and when it is
 * edited: the buyer's own style number, the season and the garment. Season
 * and garment suggest what the Styles master already uses, so the same
 * season is not typed three ways.
 */
export function TechPackFields({
  lookups,
  value,
  onChange,
}: {
  lookups: Lookups
  value: { buyerStyleRef: string; season: string; garmentCategory: string }
  onChange: (key: 'buyerStyleRef' | 'season' | 'garmentCategory', text: string) => void
}) {
  return (
    <>
      <Field
        label="Buyer style reference (optional)"
        hint="The buyer’s own style name or number, as on their tech pack."
      >
        <input
          className="form-input"
          maxLength={100}
          placeholder="e.g. BY-SS27-014"
          value={value.buyerStyleRef}
          onChange={(e) => onChange('buyerStyleRef', e.target.value)}
        />
      </Field>
      <Field label="Season (optional)">
        <SuggestInput
          className="form-input"
          maxLength={50}
          placeholder="e.g. SS-27"
          value={value.season}
          onValueChange={(text) => onChange('season', text)}
          suggestions={distinctValues(lookups.styles.map((s) => s.season)).map((v) => ({
            value: v,
          }))}
        />
      </Field>
      <Field label="Garment category (optional)" hint="Shirt, trouser, kurta…">
        <SuggestInput
          className="form-input"
          maxLength={100}
          placeholder="e.g. Shirt"
          value={value.garmentCategory}
          onValueChange={(text) => onChange('garmentCategory', text)}
          suggestions={distinctValues(lookups.styles.map((s) => s.category)).map((v) => ({
            value: v,
          }))}
        />
      </Field>
    </>
  )
}
export function SampleRequestEditor({
  request,
  lookups,
  busy,
  error,
  close,
  save,
}: {
  request: SampleRequest
  lookups: Lookups
  busy: boolean
  error: string
  close: () => void
  save: (data: RequestEdits) => Promise<SampleRequest | null>
}) {
  const [draft, setDraft] = useState<RequestEdits>({
    title: request.title,
    customerId: request.customerId,
    brandId: request.brandId,
    buyerRef: request.buyerRef ?? '',
    owner: request.owner,
    brief: request.brief,
    requiredAt: request.requiredAt?.slice(0, 10) ?? null,
    buyerStyleRef: request.buyerStyleRef ?? '',
    season: request.season ?? '',
    garmentCategory: request.garmentCategory ?? '',
    reason: '',
  })
  const set = <K extends keyof RequestEdits>(key: K, value: RequestEdits[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))
  const identityLocked = request.rounds.some((r) => r.state !== 'DRAFT')
  // A style belongs to one brand, so the brand waits until the style is off.
  const styleSelected = !!request.styleId || request.rounds.some((r) => !!r.specification.styleId)
  const brands = lookups.brands.some((b) => b.id === request.brandId)
    ? lookups.brands
    : [...lookups.brands, { id: request.brandId, name: request.brand.name }]
  const buyers =
    !request.customerId || lookups.customers.some((c) => c.id === request.customerId)
      ? lookups.customers
      : [
          ...lookups.customers,
          { id: request.customerId, name: request.customer?.name ?? 'Current buyer' },
        ]
  return (
    <FormFrame
      icon={Pencil}
      title="Edit request details"
      subtitle={request.number}
      width="max-w-3xl"
      primaryInHeader={false}
      busy={busy}
      error={error}
      onClose={close}
      primary={
        <button type="submit" form="edit-sample-request" className="btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save request details'}
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={close} disabled={busy}>
          Cancel
        </button>
      }
      footerNote="The changes and your reason will be retained in the activity history."
    >
      <form
        id="edit-sample-request"
        onSubmit={async (e) => {
          e.preventDefault()
          const saved = await save(draft)
          if (saved) close()
        }}
      >
        <fieldset disabled={busy} className="grid gap-5 p-2 md:grid-cols-2">
          <div className="bg-muted/40 text-muted-foreground rounded-lg p-3 text-sm md:col-span-2">
            {identityLocked
              ? 'Buyer and brand are locked because sampling has been released. Other request details can be updated until handover; released technical specifications stay frozen.'
              : styleSelected
                ? 'Buyer and brand may be corrected before the first release. The brand stays while the request has a style: take the style off in Style for this sample first.'
                : 'Buyer and brand may be corrected before the first release.'}
          </div>
          <Field label="Request title" required>
            <input
              className="form-input"
              required
              maxLength={150}
              value={draft.title}
              onChange={(e) => set('title', e.target.value)}
            />
          </Field>
          <Field label="Brand" required>
            <SmartSelect
              className="form-input"
              disabled={identityLocked || styleSelected}
              value={draft.brandId}
              onChange={(e) => set('brandId', e.target.value)}
            >
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </SmartSelect>
          </Field>
          <Field label="Buyer">
            <SmartSelect
              className="form-input"
              disabled={identityLocked}
              value={draft.customerId ?? ''}
              onChange={(e) => set('customerId', e.target.value || null)}
            >
              <option value="">Internal development</option>
              {buyers.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </SmartSelect>
          </Field>
          <Field label="Buyer reference (optional)">
            <input
              className="form-input"
              maxLength={150}
              value={draft.buyerRef}
              onChange={(e) => set('buyerRef', e.target.value)}
            />
          </Field>
          <TechPackFields
            lookups={lookups}
            value={draft}
            onChange={(key, text) => set(key, text)}
          />
          <Field label="Sampling owner" required>
            <input
              className="form-input"
              required
              maxLength={100}
              value={draft.owner}
              onChange={(e) => set('owner', e.target.value)}
            />
          </Field>
          <Field label="Required by (optional)">
            <input
              className="form-input"
              type="date"
              value={draft.requiredAt ?? ''}
              onChange={(e) => set('requiredAt', e.target.value || null)}
            />
          </Field>
          <div className="md:col-span-2">
            <Field label="Buyer brief & design references" required>
              <textarea
                className="form-input"
                required
                maxLength={4000}
                rows={4}
                value={draft.brief}
                onChange={(e) => set('brief', e.target.value)}
              />
            </Field>
          </div>
          <div className="md:col-span-2">
            <Field label="Reason for this change" required>
              <textarea
                className="form-input"
                required
                maxLength={500}
                rows={2}
                placeholder="Explain the correction or updated instruction."
                value={draft.reason}
                onChange={(e) => set('reason', e.target.value)}
              />
            </Field>
          </div>
        </fieldset>
      </form>
    </FormFrame>
  )
}
