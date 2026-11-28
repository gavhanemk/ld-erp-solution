'use client'
import { useEffect, useState } from 'react'
import { Calculator, Lock, Printer, Receipt } from 'lucide-react'
import {
  SAMPLE_CHARGE_KINDS,
  SAMPLE_CHARGE_LABEL,
  SAMPLE_RATE_BASIS_LABEL,
  SAMPLE_REASON_MIN,
  type SampleChargeKind,
  type SampleCostSheet,
} from '@ld-erp/shared'
import { api, apiErrorMessage } from '@/lib/api'
import { itemShade } from '@/lib/items'
import { formatDate, formatRupees } from '@/lib/utils'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { Field } from './SampleSpecEditor'
import { DateField, MakingWindow, today, useSave } from './SampleMaking'
import { finaliseBlocker } from './samplingFlow'
import { rateFigure } from './specRules'
import type { SampleCharge, SampleDispatch, SampleRequest } from './types'

/*
 * The Costing section: the sample's other charges (testing, pattern, setups,
 * couriers), the cost sheet as the records stand or as finalised, and
 * finalising it. Figures come from the server's sheet (the shared
 * sampleCostSheet), which the prints use too.
 */

type Open =
  | { kind: 'ADD' }
  | { kind: 'REMOVE'; charge: SampleCharge }
  | { kind: 'COURIER'; dispatch: SampleDispatch }
  | { kind: 'FINALISE' }
  | { kind: 'REOPEN' }

interface CostData {
  live: SampleCostSheet
  finalised: { sheet: SampleCostSheet & { notes?: string }; at: string; by: string } | null
}
const rupees = (v: number | string | undefined | null) => formatRupees(Number(v ?? 0))

export function SampleCosting({
  request,
  canEdit,
  canApprove,
  seesCosts,
  record,
  say,
}: {
  request: SampleRequest
  /** Sampling edit permission on the request (charges are entered by those who record sampling). */
  canEdit: boolean
  /** Sampling approve: finalises and reopens the costs. */
  canApprove: boolean
  /** Sees the cost sheet: approvers and accounts. */
  seesCosts: boolean
  record: (action: string, data: unknown) => Promise<SampleRequest>
  say: (message: string) => void
}) {
  const [open, setOpen] = useState<Open | null>(null)
  const [data, setData] = useState<CostData | null>(null)
  const [loadError, setLoadError] = useState('')
  const final = !!request.costFinalisedAt
  const handedOver = request.rounds.some((r) => r.handover)
  const costOpen = !final && !handedOver
  const charges = request.charges ?? []
  const challans = request.rounds
    .flatMap((r) => r.dispatches.map((d) => ({ d, revision: r.revision })))
    .filter(({ d }) => !d.cancelledAt)
  // Amounts as the server sends them: to those who record charges, and to accounts.
  const showAmounts =
    charges.some((c) => c.amount !== undefined) ||
    challans.some(({ d }) => d.courierCharge !== undefined) ||
    canEdit
  const blocker = finaliseBlocker(request)
  const roundName = (id: string | null) =>
    id ? `Round ${request.rounds.find((r) => r.id === id)?.revision ?? '?'}` : 'Whole request'

  // The sheet as the server has it, again whenever the request moves on.
  useEffect(() => {
    if (!seesCosts) return
    let live = true
    api
      .get<{ data: CostData }>(`/sampling/${request.id}/cost`)
      .then((res) => live && (setData(res.data), setLoadError('')))
      .catch((e) => live && setLoadError(apiErrorMessage(e)))
    return () => {
      live = false
    }
  }, [request.id, request.version, seesCosts])

  const saved = async (action: string, body: unknown, message: string) => {
    await record(action, body)
    setOpen(null)
    say(message)
  }
  const sheet = data?.finalised?.sheet ?? data?.live ?? null

  const openWindow = (() => {
    if (!open) return null
    const close = () => setOpen(null)
    switch (open.kind) {
      case 'ADD':
        return (
          <ChargeWindow
            request={request}
            onClose={close}
            save={(d) => saved('ADD_CHARGE', d, seesCosts ? 'Charge added. It is in the cost sheet below.' : 'Charge added.')}
          />
        )
      case 'REMOVE':
        return (
          <ReasonWindow
            id="sample-charge-remove-form"
            title="Remove a charge"
            subtitle={`${SAMPLE_CHARGE_LABEL[open.charge.kind]} · ${open.charge.description}`}
            submit="Remove charge"
            note="The charge stays on record, marked removed, and counts for nothing."
            onClose={close}
            save={(reason) =>
              saved('REMOVE_CHARGE', { chargeId: open.charge.id, reason }, 'Charge removed.')
            }
          />
        )
      case 'COURIER':
        return (
          <CourierWindow
            dispatch={open.dispatch}
            onClose={close}
            save={(d) =>
              saved('DISPATCH_CHARGE', { ...d, dispatchId: open.dispatch.id }, `Courier charge on ${open.dispatch.number} corrected.`)
            }
          />
        )
      case 'FINALISE':
        return (
          <FinaliseWindow
            sheet={data?.live ?? null}
            onClose={close}
            save={(notes) =>
              saved('FINALISE_COST', { notes }, 'Costs finalised. The cost sheet and the Sample charges statement print from it.')
            }
          />
        )
      case 'REOPEN':
        return (
          <ReasonWindow
            id="sample-cost-reopen-form"
            title="Reopen the costs"
            subtitle="The finalised sheet is set aside; costs can change again."
            submit="Reopen costs"
            note="Finalise again once the change is in. The history keeps both."
            onClose={close}
            save={(reason) => saved('REOPEN_COST', { reason }, 'Costs reopened.')}
          />
        )
    }
  })()

  return (
    <div className="space-y-4">
      <div className="glass-card flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="flex items-start gap-3">
          {final ? <Lock size={18} className="mt-0.5 shrink-0" /> : <Calculator size={18} className="mt-0.5 shrink-0" />}
          <p className="text-sm">
            {final
              ? `Costs finalised by ${request.costFinalisedBy ?? 'someone'} on ${formatDate(request.costFinalisedAt!)}. Nothing that costs can change until they are reopened.`
              : handedOver
                ? 'Handed over before the costs were finalised: the sheet stays as the records stand.'
                : `Provisional: the cost sheet changes as material, labour and charges are recorded. ${blocker || 'Ready to finalise; finalising needs sampling approval.'}`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {seesCosts && (
            <>
              <a className="btn-secondary" href={`/print/sample-cost/${request.id}`} target="_blank" rel="noopener noreferrer">
                <Printer size={15} /> Cost sheet
              </a>
              <a className="btn-secondary" href={`/print/sample-charges/${request.id}`} target="_blank" rel="noopener noreferrer">
                <Printer size={15} /> Sample charges
              </a>
            </>
          )}
          {canApprove && costOpen && seesCosts && !blocker && (
            <button type="button" className="btn-primary" onClick={() => setOpen({ kind: 'FINALISE' })}>
              Finalise costs
            </button>
          )}
          {canApprove && final && !handedOver && (
            <button type="button" className="btn-ghost" onClick={() => setOpen({ kind: 'REOPEN' })}>
              Reopen costs
            </button>
          )}
        </div>
      </div>

      <div className="glass-card space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">Other charges</h2>
          {canEdit && costOpen && (
            <button type="button" className="btn-secondary" onClick={() => setOpen({ kind: 'ADD' })}>
              <Receipt size={15} /> Add a charge
            </button>
          )}
        </div>
        {!charges.length && !challans.length ? (
          <p className="text-muted-foreground text-sm">
            None yet. Testing, a pattern or CAD, an embroidery or print setup, a courier not on a challan.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>For</th>
                  <th>Charge</th>
                  <th>Bill</th>
                  {showAmounts && <th className="text-right">Amount</th>}
                  <th />
                </tr>
              </thead>
              <tbody>
                {charges.map((c) => (
                  <tr key={c.id} className={c.removedAt ? 'text-muted-foreground line-through' : ''}>
                    <td>{formatDate(c.chargedOn)}</td>
                    <td>{roundName(c.roundId)}</td>
                    <td>
                      {SAMPLE_CHARGE_LABEL[c.kind]} · {c.description}
                      {c.removedAt && (
                        <span className="block text-xs no-underline">removed: {c.removeReason}</span>
                      )}
                    </td>
                    <td>{c.billRef ?? '—'}</td>
                    {showAmounts && <td className="text-right tabular-nums">{c.amount !== undefined ? rupees(c.amount) : '—'}</td>}
                    <td className="text-right">
                      {canEdit && costOpen && !c.removedAt && (
                        <button
                          type="button"
                          className="btn-ghost text-xs"
                          aria-label={`Remove ${c.description}`}
                          onClick={() => setOpen({ kind: 'REMOVE', charge: c })}
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {challans
                  .filter(({ d }) => d.courierCharge !== undefined)
                  .map(({ d, revision }) => (
                    <tr key={d.id}>
                      <td>{formatDate(d.sentOn)}</td>
                      <td>Round {revision}</td>
                      <td>
                        Courier on {d.number}
                        {d.courier ? ` (${d.courier})` : ''}
                      </td>
                      <td>{d.number}</td>
                      {showAmounts && <td className="text-right tabular-nums">{rupees(d.courierCharge)}</td>}
                      <td className="text-right">
                        {canEdit && costOpen && (
                          <button
                            type="button"
                            className="btn-ghost text-xs"
                            aria-label={`Change the courier charge on ${d.number}`}
                            onClick={() => setOpen({ kind: 'COURIER', dispatch: d })}
                          >
                            Change
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {seesCosts ? (
        loadError ? (
          <p className="text-sm text-red-500">{loadError}</p>
        ) : !sheet ? (
          <p className="text-muted-foreground text-sm">Working out the cost sheet…</p>
        ) : (
          <CostSheetView sheet={sheet} />
        )
      ) : (
        <p className="text-muted-foreground text-sm">
          The cost sheet is for those who approve sampling, and for accounts.
        </p>
      )}
      {openWindow}
    </div>
  )
}

/** The sheet, round by round, then the request's own charges and its totals. */
export function CostSheetView({ sheet }: { sheet: SampleCostSheet }) {
  return (
    <div className="space-y-4">
      {sheet.rounds.map((r) => (
        <div key={r.roundId} className="glass-card space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">
              Round {r.revision} · {r.milestone || 'Sample'}
            </h2>
            <span className="text-muted-foreground text-xs">
              {r.colours.map((c) => `${c.colour} ${c.pieces}`).join(' · ') || 'Nothing finished'} ·{' '}
              {r.pieces} {r.pieces === 1 ? 'piece' : 'pieces'} made
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th>Material</th>
                  <th className="text-right">Used and wasted</th>
                  <th className="text-right">Rate</th>
                  <th className="text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {r.materials.map((m, i) => (
                  <tr key={`${m.materialId ?? 'left'}-${i}`}>
                    <td>
                      <span className="font-medium">{m.item.name}</span>
                      {/* The material's own design and colour (a sheet finalised before 27 Nov 2026 has none). */}
                      {itemShade(m.item) && <span className="text-muted-foreground block text-xs">{itemShade(m.item)}</span>}
                      <span className="text-muted-foreground block text-xs">
                        {[m.component, m.colour, SAMPLE_RATE_BASIS_LABEL[m.basis]].filter(Boolean).join(' · ')}
                      </span>
                    </td>
                    <td className="text-right tabular-nums">
                      {m.consumed} {m.item.unit}
                    </td>
                    <td className="text-right tabular-nums">{m.basis === 'BUYER' ? '—' : `₹${rateFigure(m.rate)}`}</td>
                    <td className="text-right tabular-nums">{rupees(m.amount)}</td>
                  </tr>
                ))}
                {r.labourLines.map((l, i) => (
                  <tr key={`${l.stageId}-${l.kind}-${i}`}>
                    <td>
                      {l.sequence}. {l.name}
                      <span className="text-muted-foreground block text-xs">
                        {l.kind === 'OUTSIDE' ? `Outside unit${l.who ? `: ${l.who}` : ''}` : 'Labour'}
                      </span>
                    </td>
                    <td />
                    <td />
                    <td className="text-right tabular-nums">{rupees(l.amount)}</td>
                  </tr>
                ))}
                {r.miscLines.map((c) => (
                  <tr key={c.id}>
                    <td>
                      {SAMPLE_CHARGE_LABEL[c.kind]} · {c.description}
                      {c.billRef && <span className="text-muted-foreground block text-xs">{c.billRef}</span>}
                    </td>
                    <td />
                    <td />
                    <td className="text-right tabular-nums">{rupees(c.amount)}</td>
                  </tr>
                ))}
                <Totals totals={r} />
              </tbody>
            </table>
          </div>
        </div>
      ))}
      <div className="glass-card space-y-3 p-4">
        <h2 className="font-semibold">The request</h2>
        <div className="overflow-x-auto">
          <table className="data-table w-full">
            <tbody>
              {sheet.requestCharges.map((c) => (
                <tr key={c.id}>
                  <td>
                    {SAMPLE_CHARGE_LABEL[c.kind]} · {c.description}
                    {c.billRef && <span className="text-muted-foreground block text-xs">{c.billRef}</span>}
                  </td>
                  <td className="text-right tabular-nums">{rupees(c.amount)}</td>
                </tr>
              ))}
              <tr>
                <td>Material</td>
                <td className="text-right tabular-nums">{rupees(sheet.material)}</td>
              </tr>
              <tr>
                <td>Labour and outside units</td>
                <td className="text-right tabular-nums">{rupees(sheet.labour)}</td>
              </tr>
              <tr>
                <td>Other charges</td>
                <td className="text-right tabular-nums">{rupees(sheet.misc)}</td>
              </tr>
              <tr className="font-semibold">
                <td>Total · {sheet.pieces} {sheet.pieces === 1 ? 'piece' : 'pieces'} made</td>
                <td className="text-right tabular-nums">{rupees(sheet.total)}</td>
              </tr>
              <tr className="font-semibold">
                <td>A piece</td>
                <td className="text-right tabular-nums">{sheet.perPiece === null ? '—' : rupees(sheet.perPiece)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {sheet.notCosted.length > 0 && (
          <p className="text-muted-foreground text-xs">
            Still in the sample store, not costed until closed out as used:{' '}
            {sheet.notCosted.map((n) => `${n.qty} ${n.unit} of ${n.item}${itemShade(n) ? ` (${itemShade(n)})` : ''}`).join(', ')}.
          </p>
        )}
      </div>
    </div>
  )
}
function Totals({ totals }: { totals: { material: number; labour: number; misc: number; total: number; perPiece: number | null } }) {
  return (
    <tr className="font-semibold">
      <td>
        Material {rupees(totals.material)} · labour {rupees(totals.labour)} · other {rupees(totals.misc)}
      </td>
      <td />
      <td className="text-right">{totals.perPiece === null ? '' : `${rupees(totals.perPiece)} a piece`}</td>
      <td className="text-right tabular-nums">{rupees(totals.total)}</td>
    </tr>
  )
}

function ChargeWindow({
  request,
  onClose,
  save,
}: {
  request: SampleRequest
  onClose: () => void
  save: (d: unknown) => Promise<void>
}) {
  const rounds = request.rounds.filter((r) => r.state !== 'DRAFT')
  const [roundId, setRoundId] = useState(rounds[0]?.id ?? '')
  const [kind, setKind] = useState<SampleChargeKind>('TESTING')
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [bill, setBill] = useState('')
  const [on, setOn] = useState(today())
  const s = useSave()
  return (
    <MakingWindow
      id="sample-charge-form"
      icon={Receipt}
      title="Add a charge"
      subtitle={`${request.number} · ${request.title}`}
      submit="Add charge"
      note="It goes into the cost sheet and the Sample charges statement."
      busy={s.busy}
      error={s.error}
      onClose={onClose}
      onSubmit={() =>
        void s.run(
          !description.trim()
            ? 'Say what the charge is.'
            : !(Number(amount) > 0)
              ? 'Give the amount in rupees.'
              : '',
          () =>
            save({
              roundId: roundId || null,
              kind,
              description: description.trim(),
              amount: Math.round(Number(amount) * 100) / 100,
              billRef: bill.trim(),
              chargedOn: on || undefined,
            })
        )
      }
      width="max-w-2xl"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="What it is" required>
          <SmartSelect className="form-input" value={kind} autoFocus onChange={(e) => setKind(e.target.value as SampleChargeKind)}>
            {SAMPLE_CHARGE_KINDS.map((k) => (
              <option key={k} value={k}>
                {SAMPLE_CHARGE_LABEL[k]}
              </option>
            ))}
          </SmartSelect>
        </Field>
        <Field label="For" required>
          <SmartSelect className="form-input" value={roundId} onChange={(e) => setRoundId(e.target.value)}>
            {rounds.map((r) => (
              <option key={r.id} value={r.id}>
                Round {r.revision} · {r.specification.milestone}
              </option>
            ))}
            <option value="">The whole request</option>
          </SmartSelect>
        </Field>
        <div className="sm:col-span-2">
          <Field label="Description" required>
            <input className="form-input" maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </div>
        <Field label="Amount, ₹" required>
          <StepInput className="form-input" decimals value={amount} onValueChange={setAmount} />
        </Field>
        <Field label="Bill or receipt (optional)">
          <input className="form-input" maxLength={100} value={bill} onChange={(e) => setBill(e.target.value)} />
        </Field>
        <DateField label="Date" value={on} onChange={setOn} />
      </div>
    </MakingWindow>
  )
}

function CourierWindow({
  dispatch,
  onClose,
  save,
}: {
  dispatch: SampleDispatch
  onClose: () => void
  save: (d: { courierCharge: number; reason: string }) => Promise<void>
}) {
  const [amount, setAmount] = useState(Number(dispatch.courierCharge) > 0 ? String(Number(dispatch.courierCharge)) : '')
  const [reason, setReason] = useState('')
  const s = useSave()
  return (
    <MakingWindow
      id="sample-courier-form"
      icon={Receipt}
      title={`Courier charge · ${dispatch.number}`}
      subtitle={`${dispatch.recipient} · ${formatDate(dispatch.sentOn)}`}
      submit="Save charge"
      note="Only the charge changes; the challan stays as it went."
      busy={s.busy}
      error={s.error}
      onClose={onClose}
      onSubmit={() =>
        void s.run(amount !== '' && !(Number(amount) >= 0) ? 'The charge is a sum in rupees.' : '', () =>
          save({ courierCharge: amount === '' ? 0 : Math.round(Number(amount) * 100) / 100, reason: reason.trim() })
        )
      }
      width="max-w-xl"
    >
      <Field label="Courier charge, ₹" required>
        <StepInput className="form-input" decimals autoFocus value={amount} onValueChange={setAmount} />
      </Field>
      <Field label="Why it changed (optional)" hint="The courier’s bill came…">
        <input className="form-input" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </MakingWindow>
  )
}

function FinaliseWindow({
  sheet,
  onClose,
  save,
}: {
  sheet: SampleCostSheet | null
  onClose: () => void
  save: (notes: string) => Promise<void>
}) {
  const [notes, setNotes] = useState('')
  const s = useSave()
  return (
    <MakingWindow
      id="sample-finalise-form"
      icon={Lock}
      title="Finalise the costs"
      subtitle={sheet ? `Total ${rupees(sheet.total)}${sheet.perPiece === null ? '' : ` · ${rupees(sheet.perPiece)} a piece`}` : 'The sheet as it stands'}
      submit="Finalise"
      note="The sheet is kept as it stands now. Nothing that costs can change until the costs are reopened."
      busy={s.busy}
      error={s.error}
      onClose={onClose}
      onSubmit={() => void s.run('', () => save(notes.trim()))}
      width="max-w-xl"
    >
      <Field label="Note (optional)" hint="Sent with the samples, agreed with the buyer…">
        <textarea className="form-input" maxLength={1000} autoFocus value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
    </MakingWindow>
  )
}

function ReasonWindow({
  id,
  title,
  subtitle,
  submit,
  note,
  onClose,
  save,
}: {
  id: string
  title: string
  subtitle: string
  submit: string
  note: string
  onClose: () => void
  save: (reason: string) => Promise<void>
}) {
  const [reason, setReason] = useState('')
  const s = useSave()
  return (
    <MakingWindow
      id={id}
      icon={Receipt}
      title={title}
      subtitle={subtitle}
      submit={submit}
      closeLabel="Keep it"
      note={note}
      busy={s.busy}
      error={s.error}
      onClose={onClose}
      onSubmit={() =>
        void s.run(reason.trim().length < SAMPLE_REASON_MIN ? 'Say why, in a few words.' : '', () => save(reason.trim()))
      }
      width="max-w-xl"
    >
      <Field label="Why" required>
        <textarea className="form-input" maxLength={500} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </MakingWindow>
  )
}
