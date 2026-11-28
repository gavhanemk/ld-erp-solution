'use client'

import { ChevronDown } from 'lucide-react'
import { useEffect, useState } from 'react'
import { can, masterResource } from '@/lib/api'
import { StepInput } from '@/components/ui/StepInput'
import type { ChargeTaxSnapshot, PricedCharge } from '@ld-erp/shared'
import type { HsnOption } from './TaxBreakdown'

export function taxOverridePayload(c?: ChargeTaxSnapshot) {
  if (!c) return undefined
  return {
    gstApplicable: c.gstApplicable,
    applicabilityOnly: c.applicabilityOverride,
    mode: c.followsGoodsRate
      ? 'INHERIT'
      : c.treatment === 'NON_TAXABLE'
        ? 'NONE'
        : c.hsnCodeId
          ? 'HSN'
          : 'MANUAL',
    treatment: c.treatment,
    hsnCodeId: c.hsnCodeId,
    gstRate: c.ownRate,
    taxCategory: c.taxCategory,
    reason: c.overrideReason ?? '',
  }
}

/**
 * Routine entry is amount-only. Changing tax requires an explicit, explained override.
 *
 * `mayOverride`: who may change it here — on a sales document the dedicated
 * "Override Sales Charge GST" right, on a purchase document Masters edit (the
 * default). `requireReason`: switching GST on or off asks for a reason too,
 * before it takes effect (sales documents); otherwise it applies at once with
 * a standard note.
 */
export function ChargeTaxDetails({
  config,
  priced,
  hsnOptions = [],
  onOverride,
  mayOverride,
  requireReason = false,
}: {
  config: ChargeTaxSnapshot
  priced?: Pick<PricedCharge, 'amount' | 'tax' | 'payable' | 'gstRate' | 'parts'>
  hsnOptions?: HsnOption[]
  onOverride?: (value: ChargeTaxSnapshot) => void
  mayOverride?: boolean
  requireReason?: boolean
}) {
  const allowed = mayOverride ?? can('masters', 'edit')
  const [draft, setDraft] = useState<ChargeTaxSnapshot | null>(null)
  // A GST on/off switch waiting for its reason (requireReason), and what is missing from an override.
  const [switching, setSwitching] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [outerOpen, setOuterOpen] = useState(false)
  const [advOpen, setAdvOpen] = useState(false)
  const shown = switching && draft ? draft : config
  const [remoteHsn, setRemoteHsn] = useState<HsnOption[]>([])
  const options = hsnOptions.length ? hsnOptions : remoteHsn
  useEffect(() => {
    if (!draft || hsnOptions.length || remoteHsn.length) return
    let live = true
    void masterResource<HsnOption>('hsn-codes')
      .list({ active: true, limit: 200 })
      .then((r) => {
        if (live) setRemoteHsn(r.data)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [!!draft, hsnOptions.length, remoteHsn.length])
  const money = (n: number) =>
    n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return (
    <div className="text-muted-foreground mt-2 space-y-2 text-xs">
      <div className="flex items-center justify-between gap-3">
        <label className="min-w-0">
          <span className="sr-only">GST</span>
          <select
            aria-label={`${config.name} GST applicability`}
            className="form-input !bg-secondary/60 focus:!border-primary h-7 !w-auto max-w-full !rounded-md !border-transparent py-0 pl-2 pr-7 text-xs"
            value={
              shown.gstApplicable === false || shown.treatment === 'NON_TAXABLE'
                ? 'NONE'
                : 'APPLICABLE'
            }
            disabled={!allowed || !onOverride}
            onChange={(e) => {
              const switched = {
                ...config,
                gstApplicable: e.target.value === 'APPLICABLE',
                treatment:
                  e.target.value === 'APPLICABLE' && config.treatment === 'NON_TAXABLE'
                    ? ('EXCLUSIVE' as const)
                    : config.treatment,
                applicabilityOverride: config.applicabilityOverride === false ? false : true,
              }
              if (!requireReason) {
                onOverride?.({ ...switched, overrideReason: 'GST applicability changed for this transaction' })
                return
              }
              // Not yet: the reason first, in the panel below.
              setDraft({ ...switched, overrideReason: '' })
              setSwitching(true)
              setProblem(null)
              setOuterOpen(true)
              setAdvOpen(true)
            }}
          >
            <option value="APPLICABLE">GST Applicable</option>
            <option value="NONE">No GST</option>
          </select>
        </label>
        <span
          className="text-foreground whitespace-nowrap font-medium tabular-nums"
          aria-label="Charge total"
        >
          ₹{money(priced?.payable ?? 0)}
        </span>
      </div>
      <details className="group/charge-details" open={outerOpen} onToggle={(e) => setOuterOpen(e.currentTarget.open)}>
        <summary className="hover:text-foreground flex w-fit cursor-pointer list-none items-center gap-1 text-[11px] transition-colors [&::-webkit-details-marker]:hidden">
          <ChevronDown
            size={12}
            className="transition-transform group-open/charge-details:rotate-180"
          />
          {priced?.tax
            ? `GST ${priced.parts.map((p) => `${p.gstRate}%`).join(' / ')} · ₹${money(priced.tax)}`
            : 'Details'}
        </summary>
        <div className="border-border/60 mt-2 space-y-2 border-t pt-2 text-[11px]">
          <div className="flex justify-between gap-3">
            <span>Before GST</span>
            <span className="tabular-nums">₹{money(priced?.amount ?? 0)}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span>GST</span>
            <span className="tabular-nums">₹{money(priced?.tax ?? 0)}</span>
          </div>
          <p>{config.treatment === 'INCLUSIVE' ? 'GST-inclusive' : 'GST-exclusive'}</p>
          <p>
            {config.followsGoodsRate
              ? 'Allocated across goods after discounts'
              : config.hsnCode
                ? `HSN / SAC ${config.hsnCode}`
                : 'Configured charge rate'}{' '}
            · {config.taxCategory.replace('_', ' ')}
          </p>
          {config.amountMode === 'PERCENT' && (
            <p>{config.inputAmount}% of goods after discounts, before GST</p>
          )}
          {priced?.parts.map((p, i) => (
            <p key={i} className="tabular-nums">
              ₹{money(p.net)} @ {p.gstRate}%: CGST ₹{money(p.cgst)} + SGST ₹{money(p.sgst)} + IGST ₹
              {money(p.igst)}
            </p>
          ))}
          {allowed && onOverride && (
            <details
              open={advOpen}
              onToggle={(e) => {
                const open = e.currentTarget.open
                setAdvOpen(open)
                if (open && !draft) {
                  setDraft({ ...config, overrideReason: '' })
                  setSwitching(false)
                }
              }}
            >
              <summary className="hover:text-foreground cursor-pointer py-1 text-[11px]">
                Advanced Tax Settings
              </summary>
              {draft && switching && (
                <div className="mt-2 grid gap-2 rounded border p-2">
                  <p className="text-foreground">
                    GST {draft.gstApplicable === false ? 'switched off' : 'switched on'} for this document only. The charge’s master setting stays as it is.
                  </p>
                  <label>
                    Reason
                    <input
                      className="form-input h-8"
                      value={draft.overrideReason ?? ''}
                      placeholder="Why this document differs"
                      onChange={(e) => setDraft({ ...draft, overrideReason: e.target.value })}
                    />
                  </label>
                  {problem && <p className="warn-text">{problem}</p>}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => {
                        if ((draft.overrideReason?.trim().length ?? 0) < 5) return setProblem('Say why, in a few words (at least 5 letters).')
                        onOverride({ ...draft, applicabilityOverride: true })
                        setSwitching(false)
                        setDraft(null)
                        setProblem(null)
                        setAdvOpen(false)
                      }}
                    >
                      Apply
                    </button>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => {
                        setSwitching(false)
                        setDraft(null)
                        setProblem(null)
                        setAdvOpen(false)
                      }}
                    >
                      Keep as it was
                    </button>
                  </div>
                </div>
              )}
              {draft && !switching && (
                <div className="mt-2 grid gap-2 rounded border p-2">
                  <label>
                    GST treatment
                    <select
                      className="form-input h-8 text-xs"
                      value={
                        draft.followsGoodsRate
                          ? 'INHERIT'
                          : draft.treatment === 'NON_TAXABLE'
                            ? 'NONE'
                            : draft.hsnCodeId
                              ? 'HSN'
                              : 'MANUAL'
                      }
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          followsGoodsRate: e.target.value === 'INHERIT',
                          treatment: e.target.value === 'NONE' ? 'NON_TAXABLE' : 'EXCLUSIVE',
                          taxCategory:
                            e.target.value === 'NONE' ? 'UNSPECIFIED' : draft.taxCategory,
                          hsnCodeId: e.target.value === 'HSN' ? (options[0]?.id ?? null) : null,
                          hsnCode: e.target.value === 'HSN' ? (options[0]?.code ?? null) : null,
                          ownRate:
                            e.target.value === 'HSN'
                              ? Number(options[0]?.gstRate ?? 0)
                              : e.target.value === 'NONE'
                                ? 0
                                : draft.ownRate,
                        })
                      }
                    >
                      <option value="INHERIT">Inherit from goods</option>
                      <option value="HSN">Own HSN / SAC</option>
                      <option value="MANUAL">Manual rate</option>
                      <option value="NONE">No GST</option>
                    </select>
                  </label>
                  {draft.hsnCodeId && (
                    <label>
                      HSN / SAC
                      <select
                        className="form-input h-8 text-xs"
                        value={draft.hsnCodeId}
                        onChange={(e) => {
                          const h = options.find((h) => h.id === e.target.value)
                          setDraft({
                            ...draft,
                            hsnCodeId: h?.id ?? null,
                            hsnCode: h?.code ?? null,
                            ownRate: Number(h?.gstRate ?? 0),
                          })
                        }}
                      >
                        {options.map((h) => (
                          <option key={h.id} value={h.id}>
                            {h.code} · {h.gstRate}%
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {!draft.followsGoodsRate &&
                    !draft.hsnCodeId &&
                    draft.treatment !== 'NON_TAXABLE' && (
                      <label>
                        GST %
                        <StepInput
                          decimals
                          className="form-input h-8"
                          value={String(draft.ownRate)}
                          onValueChange={(v) => setDraft({ ...draft, ownRate: Math.min(100, Number(v) || 0) })}
                        />
                      </label>
                    )}
                  {draft.treatment !== 'NON_TAXABLE' && (
                    <label>
                      Amount type
                      <select
                        className="form-input h-8 text-xs"
                        value={draft.treatment}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            treatment: e.target.value as 'INCLUSIVE' | 'EXCLUSIVE',
                          })
                        }
                      >
                        <option value="EXCLUSIVE">GST-exclusive</option>
                        <option value="INCLUSIVE">GST-inclusive</option>
                      </select>
                    </label>
                  )}
                  <label>
                    Tax classification
                    <select
                      className="form-input h-8 text-xs"
                      value={draft.taxCategory}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          taxCategory: e.target.value as ChargeTaxSnapshot['taxCategory'],
                        })
                      }
                    >
                      {['UNSPECIFIED', 'TAXABLE', 'EXEMPT', 'NIL_RATED', 'NON_GST'].map((c) => (
                        <option key={c} value={c}>
                          {c.replace('_', ' ')}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Reason
                    <input
                      className="form-input h-8"
                      value={draft.overrideReason ?? ''}
                      onChange={(e) => setDraft({ ...draft, overrideReason: e.target.value })}
                    />
                  </label>
                  {problem && <p className="warn-text">{problem}</p>}
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => {
                      // Kept enabled: what is missing is said here, not hidden behind a faded button.
                      if (draft.taxCategory === 'UNSPECIFIED') return setProblem('Choose a tax classification.')
                      if ((draft.overrideReason?.trim().length ?? 0) < 5) return setProblem('Say why, in a few words (at least 5 letters).')
                      setProblem(null)
                      onOverride({ ...draft, applicabilityOverride: false })
                    }}
                  >
                    Apply tax override
                  </button>
                </div>
              )}
            </details>
          )}
        </div>
      </details>
    </div>
  )
}
