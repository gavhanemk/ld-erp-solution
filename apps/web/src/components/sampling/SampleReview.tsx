'use client'
import { useState } from 'react'
import { ClipboardCheck, Printer, Send, ThumbsUp } from 'lucide-react'
import {
  cellKey,
  colourKey,
  normaliseQc,
  pointsFor,
  requestColours,
  SAMPLE_COLOUR_STATUS_LABEL,
  SAMPLE_CHANGES_MIN,
  SAMPLE_COLOUR_RESULT_LABEL,
  SAMPLE_DECISION_RESULTS,
  SAMPLE_DISPATCH_MODES,
  SAMPLE_DISPATCH_MODE_LABEL,
  SAMPLE_REASON_MIN,
  withinTolerance,
  type MakingCellKey,
  type SampleColourOutcome,
  type SampleColourStatus,
  type SampleDecisionResult,
  type SampleDispatchMode,
} from '@ld-erp/shared'
import { formatDate, formatRupees } from '@/lib/utils'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { Field } from './SampleSpecEditor'
import { CellInputs, DateField, MakingWindow, num, today, useGrid, useSave, whole } from './SampleMaking'
import { makingOf } from './samplingFlow'
import { limitDecimals, plural } from './specRules'
import type { SampleDispatch, SampleRequest, SampleRound } from './types'

/*
 * QC, the buyer's samples and the buyer's word, colour by colour (phase 6):
 * what each colour's inspection found, the Sample Delivery Challans the
 * samples went on, and where every colour of the request stands. The figures
 * come from the shared colourOutcomes, which the server checks against.
 */

const pieces = (n: number) => plural(n, 'piece')
const sum = (cells: Array<{ qty: number }>) => cells.reduce((t, c) => t + c.qty, 0)
const STATUS_BADGE: Record<SampleColourStatus, string> = {
  DRAFT: 'badge-neutral',
  MAKING: 'badge-neutral',
  QC_FAILED: 'badge-danger',
  TO_SEND: 'badge-info',
  SENT: 'badge-warning',
  APPROVED: 'badge-success',
  CHANGES_REQUIRED: 'badge-warning',
  REJECTED: 'badge-danger',
  DROPPED: 'badge-neutral',
  NOT_FINISHED: 'badge-danger',
}
export function ColourBadge({ status }: { status: SampleColourStatus }) {
  return <span className={STATUS_BADGE[status]}>{SAMPLE_COLOUR_STATUS_LABEL[status]}</span>
}

/** What the round's inspection found, colour by colour. */
export function QcResults({ round, sizeName }: { round: SampleRound; sizeName: (id: string) => string }) {
  const qc = normaliseQc(round.qc, round.specification)
  if (!qc) return null
  // Inspected whole before colours were inspected one by one: one set of readings for all.
  const blocks = qc.whole
    ? [{ colour: 'The whole set', passed: qc.passed, results: qc.results, cells: [], notes: '' }]
    : qc.colours
  return (
    <div className="glass-card space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">QC</h2>
        <span className="text-muted-foreground text-xs">
          {[qc.by, qc.at ? formatDate(qc.at) : ''].filter(Boolean).join(' · ')}
        </span>
      </div>
      {!blocks.length && <p className="text-sm">Nothing finished, so nothing was inspected.</p>}
      {blocks.map((c) => (
        <div key={c.colour} className="border-border space-y-2 rounded-lg border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-medium">{c.colour}</h3>
            <span className={c.passed ? 'badge-success' : 'badge-danger'}>
              {c.passed ? 'Passed' : 'Failed'}
            </span>
          </div>
          {!qc.whole && (
            <p className="text-muted-foreground text-xs">
              {c.cells
                .map((z) => `${sizeName(z.sizeId)}: ${z.passed} of ${z.finished} passed workmanship`)
                .join(' · ') || 'No pieces finished.'}
            </p>
          )}
          {c.results.length > 0 && (
            <div className="overflow-x-auto">
              <table className="data-table w-full">
                <thead>
                  <tr>
                    <th>Size · point</th>
                    <th className="text-right">Actual</th>
                    <th className="text-right">Target</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {c.results.map((r, i) => (
                    <tr key={i}>
                      <td>
                        {sizeName(r.sizeId)} · {r.name}
                      </td>
                      <td className="text-right tabular-nums">
                        {r.actual} {r.unit}
                      </td>
                      <td className="text-right tabular-nums">
                        {r.target} ± {r.tolerance}
                      </td>
                      <td className={r.pass ? '' : 'text-red-500'}>
                        {r.pass ? 'Within tolerance' : 'Outside tolerance'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {c.notes && <p className="text-sm">{c.notes}</p>}
        </div>
      ))}
      {qc.notes && <p className="text-sm">{qc.notes}</p>}
    </div>
  )
}

/** Where each colour of the round stands: QC, what went to the buyer, the buyer's word. */
export function ColourTable({
  outcomes,
  sizeName,
}: {
  outcomes: SampleColourOutcome[]
  sizeName: (id: string) => string
}) {
  const cells = (list: Array<MakingCellKey & { qty: number }>) =>
    list.map((c) => `${sizeName(c.sizeId)} ${c.qty}`).join(', ') || '—'
  return (
    <div className="overflow-x-auto">
      <table className="data-table w-full">
        <thead>
          <tr>
            <th>Colour</th>
            <th>Where it stands</th>
            <th>Passed QC</th>
            <th>Sent</th>
            <th>The buyer’s word</th>
          </tr>
        </thead>
        <tbody>
          {outcomes.map((o) => (
            <tr key={o.key}>
              <td className="font-medium">{o.colour}</td>
              <td>
                <ColourBadge status={o.status} />
              </td>
              <td>
                {o.qc === 'PASSED'
                  ? cells(o.passed)
                  : o.status === 'NOT_FINISHED' || (o.decision && !o.passed.length && o.qc === 'FAILED')
                    ? o.status === 'NOT_FINISHED'
                      ? 'Nothing finished'
                      : 'Failed'
                    : o.qc === 'FAILED'
                      ? 'Failed'
                      : '—'}
              </td>
              <td>{cells(o.sent)}</td>
              <td>
                {o.decision
                  ? `${SAMPLE_COLOUR_RESULT_LABEL[o.decision.result]}${o.decision.conditions ? `: ${o.decision.conditions}` : ''}`
                  : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Every colour the request has sampled, where its latest round left it. */
export function RequestColours({ request }: { request: SampleRequest }) {
  const colours = requestColours(request.rounds)
  if (request.rounds.length < 2 || !colours.length) return null
  return (
    <div className="glass-card space-y-2 p-4">
      <h2 className="font-semibold">Colours of this request</h2>
      <p className="text-muted-foreground text-xs">
        Each colour as its latest round left it: a colour made again carries on in the next round.
      </p>
      <div className="overflow-x-auto">
        <table className="data-table w-full">
          <thead>
            <tr>
              <th>Colour</th>
              <th>Round</th>
              <th>Where it stands</th>
            </tr>
          </thead>
          <tbody>
            {colours.map((c) => (
              <tr key={c.key}>
                <td className="font-medium">{c.colour}</td>
                <td>{c.revision}</td>
                <td>
                  <ColourBadge status={c.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** The round's Sample Delivery Challans, newest last, each printable and, while undecided, cancellable. */
export function DispatchList({
  round,
  sizeName,
  outcomes,
  canCancel,
  onCancel,
}: {
  round: SampleRound
  sizeName: (id: string) => string
  outcomes: SampleColourOutcome[]
  canCancel: boolean
  onCancel: (d: SampleDispatch) => void
}) {
  if (!round.dispatches.length) return null
  const decided = (d: SampleDispatch) =>
    d.cells.some((c) => outcomes.find((o) => o.key === colourKey(c.colour))?.decision)
  return (
    <div className="glass-card space-y-2 p-4">
      <h2 className="font-semibold">Sent to the buyer</h2>
      <ul className="space-y-2 text-sm">
        {round.dispatches.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center justify-between gap-2">
            <span className={d.cancelledAt ? 'text-muted-foreground line-through' : ''}>
              <span className="font-medium">{d.number}</span> · {formatDate(d.sentOn)} ·{' '}
              {pieces(sum(d.cells))} to {d.recipient} ·{' '}
              {SAMPLE_DISPATCH_MODE_LABEL[d.mode]}
              {d.courier ? ` ${d.courier}` : ''}
              {d.awb ? ` ${d.awb}` : ''} ·{' '}
              {d.cells.map((c) => `${c.colour} ${sizeName(c.sizeId)} ${c.qty}`).join(', ')}
              {d.returnable ? ` · to come back${d.expectedBack ? ` by ${formatDate(d.expectedBack)}` : ''}` : ''}
              {d.courierCharge !== undefined && Number(d.courierCharge) > 0
                ? ` · ${formatRupees(+d.courierCharge)}`
                : ''}
            </span>
            <span className="flex items-center gap-1">
              {d.cancelledAt && (
                <span className="text-muted-foreground text-xs">cancelled: {d.cancelReason}</span>
              )}
              <a
                className="btn-ghost text-xs"
                href={`/print/sample-dispatch/${d.id}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Printer size={13} /> Challan
              </a>
              {canCancel && !d.cancelledAt && !decided(d) && (
                <button
                  type="button"
                  className="btn-ghost text-xs"
                  aria-label={`Cancel ${d.number}`}
                  onClick={() => onCancel(d)}
                >
                  Cancel
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * The inspection of the finished round: each colour read on the points of
 * the sizes it finished, its pieces passed size by size. A colour with every
 * reading within tolerance and a piece passed goes to the buyer.
 */
export function QcWindow({
  round,
  sizeName,
  onClose,
  save,
}: {
  round: SampleRound
  sizeName: (id: string) => string
  onClose: () => void
  save: (d: unknown) => Promise<void>
}) {
  const finished = makingOf(round).at(-1)?.cells.filter((c) => c.done > 0) ?? []
  const colours = [...new Map(finished.map((c) => [colourKey(c.colour), c.colour])).values()]
  const plan = colours.map((colour) => {
    const cells = finished.filter((c) => colourKey(c.colour) === colourKey(colour))
    return { colour, cells, points: pointsFor(round.specification, cells.map((c) => c.sizeId)) }
  })
  const [readings, setReadings] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(plan.map((p) => [p.colour, p.points.map(() => '')]))
  )
  const passGrid = useGrid(
    Object.fromEntries(plan.flatMap((p) => p.cells.map((c) => [cellKey(c), { passed: String(c.done) }])))
  )
  const [colourNotes, setColourNotes] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState('')
  const s = useSave()
  const read = (colour: string, i: number, v: string) =>
    setReadings((was) => ({ ...was, [colour]: was[colour].map((x, j) => (j === i ? limitDecimals(v, 2) : x)) }))
  /** The readings of the colour before, point for point where it has them. */
  const sameAs = (colour: string, from: string) => {
    const a = plan.find((p) => p.colour === from)!
    const b = plan.find((p) => p.colour === colour)!
    setReadings((was) => ({
      ...was,
      [colour]: b.points.map((m, i) => {
        const j = a.points.findIndex((x) => x.name === m.name && x.sizeId === m.sizeId)
        return j >= 0 && was[from][j] !== '' ? was[from][j] : was[colour][i]
      }),
    }))
  }
  const verdict = (p: (typeof plan)[number]) => {
    const r = readings[p.colour]
    if (r.some((x) => x === '' || !Number.isFinite(Number(x)))) return null
    const ok = p.points.every((m, i) => withinTolerance(m, Number(r[i])))
    const passedPieces = p.cells.reduce((t, c) => t + num(passGrid.values[cellKey(c)]?.passed), 0)
    return ok && passedPieces > 0
  }
  const submit = () =>
    s.run(
      plan.some((p) => readings[p.colour].some((x) => x === '' || !Number.isFinite(Number(x))))
        ? 'Type every reading, for every colour, as a number.'
        : plan.some((p) => p.cells.some((c) => !whole(num(passGrid.values[cellKey(c)]?.passed))))
          ? 'Pieces are whole numbers.'
          : plan.some((p) => p.cells.some((c) => num(passGrid.values[cellKey(c)]?.passed) > c.done))
            ? 'No more pieces pass than finished.'
            : !notes.trim()
              ? 'Say what the inspection found.'
              : '',
      () =>
        save({
          notes: notes.trim(),
          colours: plan.map((p) => ({
            colour: p.colour,
            actuals: readings[p.colour].map(Number),
            cells: p.cells.map((c) => ({ sizeId: c.sizeId, passed: num(passGrid.values[cellKey(c)]?.passed) })),
            notes: (colourNotes[p.colour] ?? '').trim(),
          })),
        })
    )
  return (
    <MakingWindow
      id="sample-qc-form"
      icon={ClipboardCheck}
      title="Record QC"
      subtitle={`${plural(colours.length, 'colour')} · ${pieces(finished.reduce((t, c) => t + c.done, 0))} finished`}
      submit="Save QC"
      note="A colour passes with every reading within tolerance and a piece passed; it goes to the buyer. A colour that fails is made again in the next round."
      busy={s.busy}
      error={s.error}
      onClose={onClose}
      onSubmit={() => void submit()}
      width="max-w-4xl"
    >
      {!plan.length && (
        <p className="bg-muted/40 rounded-lg p-3 text-sm">
          Every piece was rejected in making, so nothing finished to inspect. Saving records the
          inspection as failed; then start a new round to make it again, or cancel the request.
        </p>
      )}
      {plan.map((p, k) => {
        const v = verdict(p)
        return (
          <section key={p.colour} className="border-border space-y-3 rounded-lg border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold">{p.colour}</h3>
              <span className="flex items-center gap-2">
                {k > 0 && (
                  <button type="button" className="btn-ghost text-xs" onClick={() => sameAs(p.colour, plan[k - 1].colour)}>
                    Same readings as {plan[k - 1].colour}
                  </button>
                )}
                {v !== null && (
                  <span className={v ? 'badge-success' : 'badge-danger'}>{v ? 'Passes' : 'Fails'}</span>
                )}
              </span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {p.points.map((m, i) => {
                const typed = readings[p.colour][i]
                return (
                  <Field
                    key={`${m.sizeId}|${m.name}`}
                    label={`${sizeName(m.sizeId)} · ${m.name}`}
                    hint={`Target ${m.target} ± ${m.tolerance} ${m.unit}${
                      typed === '' ? '' : withinTolerance(m, Number(typed)) ? ' · within' : ' · outside'
                    }`}
                  >
                    <StepInput
                      className="form-input"
                      decimals
                      step={0.1}
                      max={10000}
                      autoFocus={k === 0 && i === 0}
                      value={typed}
                      onValueChange={(x) => read(p.colour, i, x)}
                    />
                  </Field>
                )
              })}
            </div>
            <CellInputs
              rows={p.cells.map((c) => ({
                key: cellKey(c),
                label: `${p.colour} · ${sizeName(c.sizeId)}`,
                hint: `${c.done} finished`,
                max: c.done,
              }))}
              columns={[{ key: 'passed', head: 'Passed workmanship' }]}
              values={passGrid.values}
              onChange={passGrid.set}
            />
            <Field label={`Findings on ${p.colour} (optional)`}>
              <input
                className="form-input"
                maxLength={1000}
                value={colourNotes[p.colour] ?? ''}
                onChange={(e) => setColourNotes((was) => ({ ...was, [p.colour]: e.target.value }))}
              />
            </Field>
          </section>
        )
      })}
      <Field label="What the inspection found" required hint="And what happens to pieces that did not pass.">
        <textarea className="form-input" maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
    </MakingWindow>
  )
}

/** The buyer's address as the challan's default: where samples are shipped, else billed. */
function buyerAddress(c: SampleRequest['customer']) {
  if (!c) return ''
  const ship = [c.shippingAddress, c.shippingCity, c.shippingState, c.shippingPincode].filter(Boolean)
  const bill = [c.billingAddress, c.billingCity, c.billingState, c.billingPincode].filter(Boolean)
  return (ship.length ? ship : bill).join(', ')
}

/** Samples that passed QC sent to the buyer on a Sample Delivery Challan. */
export function DispatchWindow({
  request,
  outcomes,
  sizeName,
  showCharge,
  onClose,
  save,
}: {
  request: SampleRequest
  outcomes: SampleColourOutcome[]
  sizeName: (id: string) => string
  /** What sending costs is entered by those who see it. */
  showCharge: boolean
  onClose: () => void
  save: (d: unknown) => Promise<void>
}) {
  const cells = outcomes.filter((o) => !o.decision).flatMap((o) => o.toSend)
  const grid = useGrid(Object.fromEntries(cells.map((c) => [cellKey(c), { qty: String(c.qty) }])))
  const [recipient, setRecipient] = useState(request.customer?.name ?? '')
  const [address, setAddress] = useState(buyerAddress(request.customer))
  const [mode, setMode] = useState<SampleDispatchMode>('COURIER')
  const [courier, setCourier] = useState('')
  const [awb, setAwb] = useState('')
  const [on, setOn] = useState(today())
  const [returnable, setReturnable] = useState(false)
  const [back, setBack] = useState('')
  const [value, setValue] = useState('')
  const [charge, setCharge] = useState('')
  const [notes, setNotes] = useState('')
  const s = useSave()
  const rows = cells.map((c) => ({ c, qty: num(grid.values[cellKey(c)]?.qty) }))
  const submit = () =>
    s.run(
      rows.some((r) => !whole(r.qty))
        ? 'Pieces are whole numbers.'
        : rows.find((r) => r.qty > r.c.qty)
          ? `Only ${rows.find((r) => r.qty > r.c.qty)!.c.qty} of ${rows.find((r) => r.qty > r.c.qty)!.c.colour} · ${sizeName(rows.find((r) => r.qty > r.c.qty)!.c.sizeId)} are left to send.`
          : !rows.some((r) => r.qty > 0)
            ? 'Say how many pieces go.'
            : !recipient.trim()
              ? 'Say who receives them.'
              : mode === 'COURIER' && !courier.trim()
                ? 'Name the courier.'
                : returnable && back && back < on
                  ? 'The day they are due back is before they go.'
                  : (value !== '' && !(Number(value) >= 0)) || (charge !== '' && !(Number(charge) >= 0))
                    ? 'Amounts are sums in rupees.'
                    : '',
      () =>
        save({
          cells: rows.filter((r) => r.qty > 0).map((r) => ({ colour: r.c.colour, sizeId: r.c.sizeId, qty: r.qty })),
          recipient: recipient.trim(),
          address: address.trim(),
          mode,
          courier: courier.trim(),
          awb: awb.trim(),
          sentOn: on || undefined,
          returnable,
          expectedBack: returnable && back ? back : null,
          declaredValue: value === '' ? null : Math.round(Number(value) * 100) / 100,
          courierCharge: charge === '' ? 0 : Math.round(Number(charge) * 100) / 100,
          notes: notes.trim(),
        })
    )
  return (
    <MakingWindow
      id="sample-dispatch-form"
      icon={Send}
      title="Send samples to the buyer"
      subtitle={`${pieces(sum(cells))} passed QC and not sent yet`}
      submit="Send on a challan"
      note="Numbered from the Sample Delivery Challan series. Print it to go with the samples; no stock moves and nothing is billed."
      busy={s.busy}
      error={s.error}
      onClose={onClose}
      onSubmit={() => void submit()}
      width="max-w-4xl"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Recipient" required>
          <input className="form-input" maxLength={150} autoFocus value={recipient} onChange={(e) => setRecipient(e.target.value)} />
        </Field>
        <DateField label="Date sent" value={on} onChange={setOn} />
        <div className="sm:col-span-2">
          <Field label="Address (optional)">
            <textarea className="form-input" rows={2} maxLength={500} value={address} onChange={(e) => setAddress(e.target.value)} />
          </Field>
        </div>
        <Field label="How it goes" required>
          <SmartSelect className="form-input" value={mode} onChange={(e) => setMode(e.target.value as SampleDispatchMode)}>
            {SAMPLE_DISPATCH_MODES.map((m) => (
              <option key={m} value={m}>
                {SAMPLE_DISPATCH_MODE_LABEL[m]}
              </option>
            ))}
          </SmartSelect>
        </Field>
        <Field label={mode === 'COURIER' ? 'Courier' : 'Carried by (optional)'} required={mode === 'COURIER'}>
          <input className="form-input" maxLength={100} value={courier} onChange={(e) => setCourier(e.target.value)} />
        </Field>
        <Field label={mode === 'COURIER' ? 'AWB / docket no. (optional)' : 'Reference (optional)'}>
          <input className="form-input" maxLength={60} value={awb} onChange={(e) => setAwb(e.target.value)} />
        </Field>
        <Field label="Declared value, ₹ (optional)" hint="Left empty, the challan says the samples have no commercial value.">
          <StepInput className="form-input" decimals value={value} onValueChange={setValue} />
        </Field>
        {showCharge && (
          <Field label="Courier charge, ₹ (optional)" hint="What sending them cost the sample.">
            <StepInput className="form-input" decimals value={charge} onValueChange={setCharge} />
          </Field>
        )}
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={returnable} onChange={(e) => setReturnable(e.target.checked)} />
          The buyer sends the samples back
        </label>
        {returnable && (
          <Field label="Due back (optional)">
            <input className="form-input" type="date" min={on} value={back} onChange={(e) => setBack(e.target.value)} />
          </Field>
        )}
      </div>
      <CellInputs
        rows={cells.map((c) => ({ key: cellKey(c), label: `${c.colour} · ${sizeName(c.sizeId)}`, hint: `${c.qty} to send`, max: c.qty }))}
        columns={[{ key: 'qty', head: 'Pieces' }]}
        values={grid.values}
        onChange={grid.set}
      />
      <Field label="Note (optional)" hint="Pieces kept back in the sample room, say so here.">
        <input className="form-input" maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
    </MakingWindow>
  )
}

/** The buyer's word, colour by colour, with who said it and where it is recorded. */
export function DecisionWindow({
  outcomes,
  onClose,
  save,
}: {
  outcomes: SampleColourOutcome[]
  onClose: () => void
  save: (d: unknown) => Promise<void>
}) {
  // What the buyer saw: colours sent, not dropped; one decided may be decided again until the round is.
  const open = outcomes.filter((o) => o.qc === 'PASSED' && o.sent.length > 0 && o.decision?.result !== 'DROPPED')
  const unsent = outcomes.filter((o) => o.qc === 'PASSED' && !o.sent.length && !o.decision)
  const [results, setResults] = useState<Record<string, SampleDecisionResult | ''>>(() =>
    Object.fromEntries(open.map((o) => [o.key, '']))
  )
  const [conditions, setConditions] = useState<Record<string, string>>({})
  const [buyer, setBuyer] = useState('')
  const [evidence, setEvidence] = useState('')
  const s = useSave()
  const chosen = open.filter((o) => results[o.key])
  const vague = chosen.find(
    (o) => results[o.key] === 'CHANGES_REQUIRED' && (conditions[o.key] ?? '').trim().length < SAMPLE_CHANGES_MIN
  )
  const submit = () =>
    s.run(
      !chosen.length
        ? 'Record the buyer’s word on at least one colour.'
        : vague
          ? `Say what the buyer wants changed on ${vague.colour}: the next round is made to it.`
          : !buyer.trim()
              ? 'Say who at the buyer decided.'
              : !evidence.trim()
                ? 'Say where it is recorded: the email, the comments sheet.'
                : '',
      () =>
        save({
          buyerName: buyer.trim(),
          evidence: evidence.trim(),
          colours: chosen.map((o) => ({
            colour: o.colour,
            result: results[o.key],
            // An approval carries no conditions.
            conditions: results[o.key] === 'APPROVED' ? '' : (conditions[o.key] ?? '').trim(),
          })),
        })
    )
  return (
    <MakingWindow
      id="sample-decision-form"
      icon={ThumbsUp}
      title="Record the buyer’s decision"
      subtitle="Colour by colour, as the buyer gives it"
      submit="Save decision"
      note="The round is decided once every colour that passed QC has a word. Colours to change, or that failed QC, are made again in the next round; a colour not sent is dropped instead."
      busy={s.busy}
      error={s.error}
      onClose={onClose}
      onSubmit={() => void submit()}
      width="max-w-4xl"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Who at the buyer decided" required>
          <input className="form-input" maxLength={150} autoFocus value={buyer} onChange={(e) => setBuyer(e.target.value)} />
        </Field>
        <Field label="Where it is recorded" required hint="Email, comments sheet, meeting note.">
          <input className="form-input" maxLength={2000} value={evidence} onChange={(e) => setEvidence(e.target.value)} />
        </Field>
      </div>
      <div className="overflow-x-auto">
        <table className="data-table w-full">
          <thead>
            <tr>
              <th>Colour</th>
              <th>Decision</th>
              <th>What to change, or what was said</th>
            </tr>
          </thead>
          <tbody>
            {open.map((o) => (
              <tr key={o.key}>
                <td>
                  <span className="font-medium">{o.colour}</span>
                  <span className="text-muted-foreground block text-xs">
                    {pieces(sum(o.sent))} sent
                    {o.decision ? ` · now ${SAMPLE_COLOUR_RESULT_LABEL[o.decision.result].toLowerCase()}` : ''}
                  </span>
                </td>
                <td className="w-48">
                  <SmartSelect
                    className="form-input h-9"
                    aria-label={`Decision on ${o.colour}`}
                    value={results[o.key]}
                    onChange={(e) => {
                      const next = e.target.value as SampleDecisionResult | ''
                      setResults((was) => ({ ...was, [o.key]: next }))
                      // An approval carries no conditions: what was typed goes with the choice.
                      if (next === 'APPROVED') setConditions((was) => ({ ...was, [o.key]: '' }))
                    }}
                  >
                    <option value="">Not now</option>
                    {SAMPLE_DECISION_RESULTS.map((r) => (
                      <option key={r} value={r}>
                        {SAMPLE_COLOUR_RESULT_LABEL[r]}
                      </option>
                    ))}
                  </SmartSelect>
                </td>
                <td>
                  <input
                    className="form-input h-9"
                    aria-label={`What to change on ${o.colour}`}
                    maxLength={2000}
                    placeholder={results[o.key] === 'CHANGES_REQUIRED' ? 'Required: what to change' : ''}
                    disabled={!results[o.key] || results[o.key] === 'APPROVED'}
                    value={conditions[o.key] ?? ''}
                    onChange={(e) => setConditions((was) => ({ ...was, [o.key]: e.target.value }))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {unsent.length > 0 && (
        <p className="text-muted-foreground text-xs">
          {unsent.map((o) => o.colour).join(', ')} passed QC but {unsent.length === 1 ? 'is' : 'are'} not sent:
          send {unsent.length === 1 ? 'it' : 'them'} first, or drop {unsent.length === 1 ? 'it' : 'them'} if the buyer does not want {unsent.length === 1 ? 'it' : 'them'}.
        </p>
      )}
    </MakingWindow>
  )
}

/**
 * A colour not to go on with: passed QC but not to be sent, or failed QC and
 * not to be made again. Our decision, not the buyer's.
 */
export function DropWindow({
  outcomes,
  onClose,
  save,
}: {
  outcomes: SampleColourOutcome[]
  onClose: () => void
  save: (d: { colour: string; reason: string }) => Promise<void>
}) {
  const open = outcomes.filter((o) => !o.decision && o.qc !== null)
  const [colour, setColour] = useState(open.length === 1 ? open[0].colour : '')
  const [reason, setReason] = useState('')
  const s = useSave()
  return (
    <MakingWindow
      id="sample-drop-form"
      icon={ThumbsUp}
      title="Drop a colour"
      subtitle="Not sent to the buyer, or not to be made again"
      submit="Drop colour"
      note="A dropped colour is not made again and is not part of the round’s verdict. It stays in the record with why."
      busy={s.busy}
      error={s.error}
      onClose={onClose}
      onSubmit={() =>
        void s.run(
          !colour
            ? 'Pick the colour.'
            : reason.trim().length < SAMPLE_REASON_MIN
              ? 'Say why, in a few words.'
              : '',
          () => save({ colour, reason: reason.trim() })
        )
      }
      width="max-w-xl"
    >
      <Field label="Colour" required>
        <SmartSelect className="form-input" value={colour} autoFocus onChange={(e) => setColour(e.target.value)}>
          <option value="">Pick the colour</option>
          {open.map((o) => (
            <option key={o.key} value={o.colour}>
              {o.colour} · {SAMPLE_COLOUR_STATUS_LABEL[o.status].toLowerCase()}
            </option>
          ))}
        </SmartSelect>
      </Field>
      <Field label="Why" required hint="The buyer dropped it, it is not worth making again…">
        <textarea className="form-input" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </MakingWindow>
  )
}

/** A challan sent by mistake, cancelled with why. */
export function CancelDispatchWindow({
  dispatch,
  onClose,
  save,
}: {
  dispatch: SampleDispatch
  onClose: () => void
  save: (reason: string) => Promise<void>
}) {
  const [reason, setReason] = useState('')
  const s = useSave()
  return (
    <MakingWindow
      id="sample-dispatch-cancel-form"
      icon={Send}
      title={`Cancel ${dispatch.number}`}
      subtitle={`${pieces(sum(dispatch.cells))} to ${dispatch.recipient} · ${formatDate(dispatch.sentOn)}`}
      submit="Cancel challan"
      closeLabel="Keep it"
      note="The challan stays on record, marked cancelled; its number is not used again. Its samples count as not sent."
      busy={s.busy}
      error={s.error}
      onClose={onClose}
      onSubmit={() =>
        void s.run(reason.trim().length < SAMPLE_REASON_MIN ? 'Say why, in a few words.' : '', () => save(reason.trim()))
      }
      width="max-w-xl"
    >
      <Field label="Why" required hint="Sent by mistake, courier not booked…">
        <textarea className="form-input" maxLength={500} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </MakingWindow>
  )
}

