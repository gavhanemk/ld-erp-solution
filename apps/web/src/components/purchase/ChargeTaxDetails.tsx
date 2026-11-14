'use client'

import { useEffect, useState } from 'react'
import { can, masterResource } from '@/lib/api'
import type { ChargeTaxSnapshot, PricedCharge } from '@ld-erp/shared'
import type { HsnOption } from './TaxBreakdown'

export function taxOverridePayload(c?: ChargeTaxSnapshot) {
  if (!c) return undefined
  return {
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

/** Routine entry is amount-only. Changing tax requires an explicit, explained override. */
export function ChargeTaxDetails({
  config,
  priced,
  hsnOptions = [],
  onOverride,
}: {
  config: ChargeTaxSnapshot
  priced?: Pick<PricedCharge, 'amount' | 'tax' | 'payable' | 'gstRate' | 'parts'>
  hsnOptions?: HsnOption[]
  onOverride?: (value: ChargeTaxSnapshot) => void
}) {
  const [draft, setDraft] = useState<ChargeTaxSnapshot | null>(null)
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
    <div className="text-muted-foreground mt-1 space-y-1 text-[11px]">
      <div className="flex flex-wrap justify-between gap-x-3 tabular-nums">
        <span>Before GST ₹{money(priced?.amount ?? 0)}</span>
        <span>
          GST {priced?.parts.map((p) => `${p.gstRate}%`).join(' / ') || '0%'} · ₹
          {money(priced?.tax ?? 0)}
        </span>
        <span className="text-foreground">Total ₹{money(priced?.payable ?? 0)}</span>
      </div>
      <details>
        <summary className="cursor-pointer">
          Tax breakdown · {config.treatment === 'INCLUSIVE' ? 'GST-inclusive' : 'GST-exclusive'}
        </summary>
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
      </details>
      {can('masters', 'edit') && onOverride && (
        <details
          onToggle={(e) => {
            if (e.currentTarget.open && !draft) setDraft({ ...config, overrideReason: '' })
          }}
        >
          <summary className="cursor-pointer">Advanced Tax Settings</summary>
          {draft && (
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
                      taxCategory: e.target.value === 'NONE' ? 'UNSPECIFIED' : draft.taxCategory,
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
              {!draft.followsGoodsRate && !draft.hsnCodeId && draft.treatment !== 'NON_TAXABLE' && (
                <label>
                  GST %
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step="0.01"
                    className="form-input h-8"
                    value={draft.ownRate}
                    onChange={(e) => setDraft({ ...draft, ownRate: Number(e.target.value) })}
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
                      setDraft({ ...draft, treatment: e.target.value as 'INCLUSIVE' | 'EXCLUSIVE' })
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
              <button
                type="button"
                className="btn-secondary"
                disabled={
                  (draft.overrideReason?.trim().length ?? 0) < 5 ||
                  draft.taxCategory === 'UNSPECIFIED'
                }
                onClick={() => onOverride(draft)}
              >
                Apply tax override
              </button>
            </div>
          )}
        </details>
      )}
    </div>
  )
}
