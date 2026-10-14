'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import { Ban, CalendarClock, ChevronDown, ChevronRight, Plus, X } from 'lucide-react'
import { ApiError } from '@/lib/api'
import { settingsApi, type TdsSection, type TdsSectionRate } from '@/lib/settingsApi'
import { Field, LoadingRow, Notice, SaveButton, SettingsCard } from '@/components/settings/ui'
import { StepInput } from '@/components/ui/StepInput'
import { formatDate } from '@/lib/utils'

/**
 * Settings → TDS sections.
 *
 * A section is its code and what it is for; its rate and limits are a history
 * by date, because the law changes them from a date and a bill has to be
 * worked out at what applied on its own day. A change is therefore entered as
 * "from this date", never typed over the old rate — the old one stays for the
 * bills booked before it.
 */

const today = () => {
  const d = new Date()
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

const inr = (v: number | null) =>
  v == null ? '—' : `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`

/** The row in force today: the latest one starting on or before it. */
const inForce = (rates: TdsSectionRate[]) => {
  const now = Date.now()
  const started = rates.filter((r) => new Date(r.effectiveFrom).getTime() <= now)
  return started[started.length - 1] ?? rates[0] ?? null
}

/** A change waiting to start, if one has been entered ahead of its date. */
const upcoming = (rates: TdsSectionRate[]) =>
  rates.find((r) => new Date(r.effectiveFrom).getTime() > Date.now()) ?? null

interface RateDraft {
  effectiveFrom: string
  rate: string
  noPanRate: string
  singleLimit: string
  yearlyLimit: string
}

const emptyRate = (): RateDraft => ({
  effectiveFrom: today(),
  rate: '',
  noPanRate: '',
  singleLimit: '',
  yearlyLimit: '',
})

const numOrNull = (v: string) => (v.trim() === '' ? null : Number(v))

/** The four figures a rate carries, shared by "add section" and "change from a date". */
function RateFields({
  draft,
  set,
  idPrefix,
}: {
  draft: RateDraft
  set: (patch: Partial<RateDraft>) => void
  idPrefix: string
}) {
  return (
    <>
      <Field label="Starts from" htmlFor={`${idPrefix}-from`} required>
        <input
          id={`${idPrefix}-from`}
          type="date"
          className="form-input"
          value={draft.effectiveFrom}
          onChange={(e) => set({ effectiveFrom: e.target.value })}
        />
      </Field>
      <Field label="Rate (%)" htmlFor={`${idPrefix}-rate`} required>
        <StepInput
          id={`${idPrefix}-rate`}
          className="form-input"
          decimals
          max={100}
          step={0.5}
          placeholder="1"
          value={draft.rate}
          onValueChange={(v) => set({ rate: v })}
        />
      </Field>
      <Field label="Rate with no PAN (%)" htmlFor={`${idPrefix}-nopan`} help="Leave empty if not set">
        <StepInput
          id={`${idPrefix}-nopan`}
          className="form-input"
          decimals
          max={100}
          step={0.5}
          placeholder="20"
          value={draft.noPanRate}
          onValueChange={(v) => set({ noPanRate: v })}
        />
      </Field>
      <Field label="Limit per bill (₹)" htmlFor={`${idPrefix}-single`} help="TDS above this one bill">
        <StepInput
          id={`${idPrefix}-single`}
          className="form-input"
          step={1000}
          placeholder="30000"
          value={draft.singleLimit}
          onValueChange={(v) => set({ singleLimit: v })}
        />
      </Field>
      <Field label="Limit per year (₹)" htmlFor={`${idPrefix}-yearly`} help="TDS once the year's total passes this">
        <StepInput
          id={`${idPrefix}-yearly`}
          className="form-input"
          step={1000}
          placeholder="100000"
          value={draft.yearlyLimit}
          onValueChange={(v) => set({ yearlyLimit: v })}
        />
      </Field>
    </>
  )
}

export function TdsSections() {
  const [sections, setSections] = useState<TdsSection[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState({ section: '', label: '' })
  const [firstRate, setFirstRate] = useState<RateDraft>(emptyRate())
  /** The section a new rate is being entered for. */
  const [changing, setChanging] = useState<string | null>(null)
  const [change, setChange] = useState<RateDraft>(emptyRate())
  /** The section whose history is open. */
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await settingsApi.tdsSections.list()
      setSections(res.data)
    } catch (err) {
      setMessage({
        kind: 'error',
        text: err instanceof ApiError ? err.message : 'Could not load TDS sections.',
      })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const fail = (err: unknown, fallback: string) =>
    setMessage({ kind: 'error', text: err instanceof ApiError ? err.message : fallback })

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setMessage(null)
    try {
      await settingsApi.tdsSections.create({
        section: draft.section.trim(),
        label: draft.label.trim(),
        rate: Number(firstRate.rate),
        effectiveFrom: firstRate.effectiveFrom,
        noPanRate: numOrNull(firstRate.noPanRate),
        singleLimit: numOrNull(firstRate.singleLimit),
        yearlyLimit: numOrNull(firstRate.yearlyLimit),
      })
      setDraft({ section: '', label: '' })
      setFirstRate(emptyRate())
      setAdding(false)
      await load()
      setMessage({ kind: 'success', text: 'Section added.' })
    } catch (err) {
      fail(err, 'Could not add the section.')
    } finally {
      setBusy(false)
    }
  }

  const startChange = (s: TdsSection) => {
    const now = inForce(s.rates)
    setChanging(s.id)
    // Starts from what applies today, so a change to one figure is one edit.
    setChange({
      effectiveFrom: today(),
      rate: now ? String(now.rate) : '',
      noPanRate: now?.noPanRate != null ? String(now.noPanRate) : '',
      singleLimit: now?.singleLimit != null ? String(now.singleLimit) : '',
      yearlyLimit: now?.yearlyLimit != null ? String(now.yearlyLimit) : '',
    })
    setMessage(null)
  }

  const saveChange = async (e: React.FormEvent, s: TdsSection) => {
    e.preventDefault()
    setBusy(true)
    setMessage(null)
    try {
      await settingsApi.tdsSections.addRate(s.id, {
        effectiveFrom: change.effectiveFrom,
        rate: Number(change.rate),
        noPanRate: numOrNull(change.noPanRate),
        singleLimit: numOrNull(change.singleLimit),
        yearlyLimit: numOrNull(change.yearlyLimit),
      })
      setChanging(null)
      setOpen(s.id)
      await load()
      setMessage({
        kind: 'success',
        text: `${s.section} — ${s.label}: new rate from ${formatDate(change.effectiveFrom)}. Bills dated before it keep the old one.`,
      })
    } catch (err) {
      fail(err, 'Could not save the new rate.')
    } finally {
      setBusy(false)
    }
  }

  const removeRate = async (s: TdsSection, r: TdsSectionRate) => {
    if (!confirm(`Remove the ${r.rate}% rate from ${formatDate(r.effectiveFrom)}? Bills already booked keep their figures.`)) return
    setBusy(true)
    setMessage(null)
    try {
      await settingsApi.tdsSections.removeRate(s.id, r.id)
      await load()
    } catch (err) {
      fail(err, 'Could not remove that rate.')
    } finally {
      setBusy(false)
    }
  }

  const retire = async (s: TdsSection) => {
    if (!confirm(`Stop offering ${s.section} — ${s.label} on new bills? Existing bills keep it.`)) return
    setBusy(true)
    try {
      const res = await settingsApi.tdsSections.remove(s.id)
      await load()
      setMessage({ kind: 'success', text: res.message })
    } catch (err) {
      fail(err, 'Could not save.')
    } finally {
      setBusy(false)
    }
  }

  const active = sections.filter((s) => s.isActive)
  const retired = sections.filter((s) => !s.isActive)
  const canAdd =
    draft.section.trim() && draft.label.trim() && firstRate.rate !== '' && firstRate.effectiveFrom

  return (
    <SettingsCard
      title="TDS sections"
      description="The tax deducted on service bills: each section's rate and limits, from the date they apply. Your accountant should confirm these against the current law."
      actions={
        !adding && (
          <button className="btn-secondary text-xs" onClick={() => setAdding(true)}>
            <Plus size={14} /> Add section
          </button>
        )
      }
    >
      {message && (
        <div className="mb-4">
          <Notice kind={message.kind}>{message.text}</Notice>
        </div>
      )}

      {adding && (
        <form onSubmit={add} className="border-border bg-secondary/40 mb-5 rounded-lg border p-4">
          <div className="grid grid-cols-1 items-end gap-3 md:grid-cols-3">
            <Field label="Section" htmlFor="tds-section" required>
              <input
                id="tds-section"
                className="form-input"
                placeholder="194C"
                value={draft.section}
                onChange={(e) => setDraft((d) => ({ ...d, section: e.target.value }))}
              />
            </Field>
            <Field label="What it is for" htmlFor="tds-label" required span={2}>
              <input
                id="tds-label"
                className="form-input"
                placeholder="Contractor — individual / HUF"
                value={draft.label}
                onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
              />
            </Field>
          </div>
          <div className="mt-3 grid grid-cols-1 items-end gap-3 md:grid-cols-5">
            <RateFields draft={firstRate} set={(p) => setFirstRate((d) => ({ ...d, ...p }))} idPrefix="tds-new" />
          </div>
          <div className="mt-3 flex gap-2">
            <SaveButton saving={busy} disabled={!canAdd}>
              Add section
            </SaveButton>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setAdding(false)
                setDraft({ section: '', label: '' })
                setFirstRate(emptyRate())
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <LoadingRow />
      ) : active.length === 0 ? (
        <p className="text-muted-foreground py-4 text-sm">No sections yet. Add the ones you deduct TDS under.</p>
      ) : (
        <div className="border-border overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-border bg-secondary/70 text-muted-foreground border-b text-left text-xs">
                <th className="w-8 px-2 py-2" />
                <th className="px-3 py-2 font-medium">Section</th>
                <th className="px-3 py-2 text-right font-medium">Rate today</th>
                <th className="px-3 py-2 text-right font-medium">No PAN</th>
                <th className="px-3 py-2 text-right font-medium">Per bill</th>
                <th className="px-3 py-2 text-right font-medium">Per year</th>
                <th className="px-3 py-2 font-medium">Since</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {active.map((s) => {
                const now = inForce(s.rates)
                const next = upcoming(s.rates)
                const isOpen = open === s.id
                return (
                  <Fragment key={s.id}>
                    <tr className="border-border border-b last:border-0">
                      <td className="px-2 py-2">
                        <button
                          type="button"
                          className="btn-ghost p-1"
                          onClick={() => setOpen(isOpen ? null : s.id)}
                          aria-expanded={isOpen}
                          aria-label={`${isOpen ? 'Hide' : 'Show'} the rate history of ${s.section}`}
                        >
                          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                      </td>
                      <td className="px-3 py-2">
                        <p className="text-foreground font-medium">
                          {s.section} <span className="text-muted-foreground font-normal">— {s.label}</span>
                        </p>
                        {next && (
                          <p className="text-[11px] text-teal-400">
                            {next.rate}% from {formatDate(next.effectiveFrom)}
                          </p>
                        )}
                      </td>
                      <td className="text-foreground px-3 py-2 text-right tabular-nums">{now ? `${now.rate}%` : '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {now?.noPanRate != null ? `${now.noPanRate}%` : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{inr(now?.singleLimit ?? null)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{inr(now?.yearlyLimit ?? null)}</td>
                      <td className="text-muted-foreground px-3 py-2 text-xs whitespace-nowrap">
                        {now ? formatDate(now.effectiveFrom) : '—'}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            className="btn-ghost px-2 py-1 text-xs"
                            onClick={() => startChange(s)}
                            disabled={busy}
                            title="The rate or limits change from a date"
                          >
                            <CalendarClock size={13} /> Change from a date
                          </button>
                          <button
                            className="btn-ghost text-muted-foreground p-1.5 hover:text-red-400"
                            onClick={() => void retire(s)}
                            disabled={busy}
                            title="Stop offering this section"
                            aria-label={`Stop offering ${s.section} — ${s.label}`}
                          >
                            <Ban size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>

                    {changing === s.id && (
                      <tr className="border-border border-b">
                        <td colSpan={8} className="bg-secondary/40 px-3 py-3">
                          <form onSubmit={(e) => void saveChange(e, s)}>
                            <p className="text-muted-foreground mb-2 text-xs">
                              New figures for {s.section} — {s.label}. Bills dated before the start date keep the old
                              ones.
                            </p>
                            <div className="grid grid-cols-1 items-end gap-3 md:grid-cols-5">
                              <RateFields draft={change} set={(p) => setChange((d) => ({ ...d, ...p }))} idPrefix={`tds-${s.id}`} />
                            </div>
                            <div className="mt-3 flex gap-2">
                              <SaveButton saving={busy} disabled={change.rate === '' || !change.effectiveFrom}>
                                Save new rate
                              </SaveButton>
                              <button type="button" className="btn-secondary" onClick={() => setChanging(null)}>
                                Cancel
                              </button>
                            </div>
                          </form>
                        </td>
                      </tr>
                    )}

                    {isOpen && (
                      <tr className="border-border border-b">
                        <td colSpan={8} className="bg-secondary/30 px-3 py-2">
                          <p className="text-muted-foreground mb-1.5 text-[11px] font-semibold uppercase tracking-wider">
                            Rate history
                          </p>
                          <ul className="space-y-1">
                            {[...s.rates].reverse().map((r) => (
                              <li key={r.id} className="flex items-center gap-3 text-xs">
                                <span className="text-muted-foreground w-24 shrink-0">
                                  from {formatDate(r.effectiveFrom)}
                                </span>
                                <span className="text-foreground tabular-nums">{r.rate}%</span>
                                <span className="text-muted-foreground">
                                  no PAN {r.noPanRate != null ? `${r.noPanRate}%` : '—'} · per bill {inr(r.singleLimit)} · per
                                  year {inr(r.yearlyLimit)}
                                </span>
                                {s.rates.length > 1 && (
                                  <button
                                    type="button"
                                    className="btn-ghost text-muted-foreground ml-auto p-1 hover:text-red-400"
                                    onClick={() => void removeRate(s, r)}
                                    disabled={busy}
                                    aria-label={`Remove the rate from ${formatDate(r.effectiveFrom)}`}
                                    title="Entered by mistake? Remove it"
                                  >
                                    <X size={12} />
                                  </button>
                                )}
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {retired.length > 0 && (
        <p className="text-muted-foreground mt-4 text-xs">
          No longer offered: {retired.map((s) => `${s.section} — ${s.label}`).join(', ')}
        </p>
      )}
    </SettingsCard>
  )
}
