'use client'

import { useState } from 'react'
import Link from 'next/link'
import { LockKeyhole, PackageCheck } from 'lucide-react'
import { approvedFrom, colourKey, handoverBomLines, handoverReady } from '@ld-erp/shared'
import { formatDate, formatRupees } from '@/lib/utils'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { Field } from './SampleSpecEditor'
import { MakingWindow, useSave } from './SampleMaking'
import { plural } from './specRules'
import { handoverWaiting, materialHeld, waitingName } from './samplingFlow'
import type { Lookups, SampleRequest, SampleRound } from './types'

/**
 * Handover to bulk (phase 8). Once every colour has ended and the costs are
 * final, the approver says which BOM each approved colour goes to production
 * with — a draft made from the round it was approved in, or one Masters has
 * already approved — and which routing. A style sampling made becomes a
 * production style. Production accepts once Masters has approved the BOMs.
 * What the server would refuse (HANDOVER) is said here first, not offered.
 */
const joinAnd = (list: string[]) =>
  list.length < 2 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`

type Plan = Array<{ colour: string; revision: number; lines: number }>

export function SampleHandoverSection({
  request,
  round,
  lookups,
  latest,
  canPrepare,
  canAccept,
  seesCosts,
  record,
  say,
}: {
  request: SampleRequest
  round: SampleRound
  lookups: Lookups
  latest: boolean
  /** Sampling approval on an open request. */
  canPrepare: boolean
  /** Sampling edit and production approval. */
  canAccept: boolean
  seesCosts: boolean
  record: (action: string, data: unknown) => Promise<SampleRequest>
  say: (message: string) => void
}) {
  const [preparing, setPreparing] = useState(false)
  const ready = handoverReady(request.rounds)
  const open = ready.ready && ['APPROVED', 'REJECTED'].includes(round.state) && latest
  const handedOn = request.rounds.find((r) => r.handover)
  const holding = request.rounds.some((r) => r.materials.some((m) => materialHeld(m) > 0))
  const costFinal = !!request.costFinalisedAt
  const from = approvedFrom(request.rounds)
  // The style the round was made in, as the server reads it; the request names it since phase 1.
  const styleId = round.specification.styleId || request.style?.id || ''
  const style = request.style?.id === styleId ? request.style : null
  const sheet = request.costSheet ?? null
  const plan: Plan = from.map((f) => ({
    colour: f.colour,
    revision: f.round.revision,
    lines: handoverBomLines(f.round, f.colour, sheet?.rounds.find((r) => r.roundId === f.round.id) ?? null).lines
      .length,
  }))
  // What the server would refuse before anything is chosen.
  const offStyle = style ? from.filter((f) => !style.colors.some((c) => colourKey(c) === colourKey(f.colour))) : []
  const blocker = !style
    ? ''
    : !style.isActive
      ? `${style.code} is deactivated. Reactivate it in Masters before handing the sample over.`
      : offStyle.length
        ? `${joinAnd(offStyle.map((f) => f.colour))} ${offStyle.length === 1 ? 'is' : 'are'} no longer one of ${style.code}’s colours. Add ${offStyle.length === 1 ? 'it' : 'them'} back on the style first.`
        : ''
  const h = round.handover

  if (request.cancelledAt && !h) return null
  return (
    <div className="space-y-4">
      {!h && handedOn && (
        <div className="glass-card p-5 text-sm">The handover is recorded on round {handedOn.revision}.</div>
      )}
      {!h && !handedOn && !latest && (
        <div className="glass-card p-5 text-sm">
          The handover is prepared on the latest round, round {request.rounds[0].revision}.
        </div>
      )}
      {!open && !h && !handedOn && latest && (
        <div className="glass-card flex gap-3 p-5 text-sm">
          <LockKeyhole size={18} className="shrink-0" /> Every colour has to end approved, rejected or dropped,
          with at least one approved, before preparing the production package.
        </div>
      )}
      {open && !handedOn && !costFinal && (
        <div className="glass-card flex gap-3 p-5 text-sm">
          <LockKeyhole size={18} className="shrink-0" /> Finalise what the sample cost first, in Costing: the
          BOMs are priced from it, and after handover it cannot change.
        </div>
      )}
      {open && !handedOn && holding && (
        <div className="glass-card p-5 text-sm">
          Material remains held on a sampling round. Record its use, waste or return in Material preparation to
          unlock handover.
        </div>
      )}
      {open && !handedOn && costFinal && !holding && blocker && (
        <div className="glass-card flex gap-3 p-5 text-sm">
          <LockKeyhole size={18} className="shrink-0" /> {blocker}
        </div>
      )}
      {open && !handedOn && costFinal && !holding && !blocker && (
        <div className="glass-card space-y-3 p-4">
          <h2 className="font-semibold">Prepare the production package</h2>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {style?.stage === 'DEVELOPMENT' && (
              <li>{style.code} becomes a production style: from then on it can be ordered, costed and made.</li>
            )}
            {plan.map((p) => (
              <li key={p.colour}>
                {p.colour}:{' '}
                {p.lines
                  ? `a draft BOM from round ${p.revision} (${plural(p.lines, 'line')}), priced at what the sample paid, or a BOM Masters has approved.`
                  : `round ${p.revision} has no material for it, so it needs a BOM Masters has approved.`}
              </li>
            ))}
            <li>The style’s routing: one it has, or one made from the sample’s route.</li>
            <li>Masters approves each draft BOM as usual; production accepts once they are approved.</li>
          </ul>
          {canPrepare ? (
            <button type="button" className="btn-primary" onClick={() => setPreparing(true)}>
              <PackageCheck size={16} /> Prepare handover
            </button>
          ) : (
            <p className="text-muted-foreground text-sm">Preparing the handover needs sampling approval.</p>
          )}
        </div>
      )}
      {preparing && (
        <HandoverWindow
          request={request}
          lookups={lookups}
          plan={plan}
          styleId={styleId}
          styleCategory={style?.category ?? null}
          // The route the approved colours were last made on, which a routing is made from.
          routeOk={(() => {
            const made = from.reduce<(typeof from)[number]['round'] | null>(
              (a, f) => (!a || f.round.revision > a.revision ? f.round : a),
              null
            )
            return !!made && made.stages.length > 0 && made.stages.every((s) => s.operationId && s.departmentId)
          })()}
          onClose={() => setPreparing(false)}
          save={async (d) => {
            await record('HANDOVER', d)
            setPreparing(false)
            say(
              'Handover prepared. Masters approves the draft BOMs in Masters → BOMs; production accepts the handover after that.'
            )
          }}
        />
      )}
      {h && (
        <HandoverRecord
          request={request}
          round={round}
          canAccept={canAccept && latest}
          seesCosts={seesCosts}
          record={record}
          say={say}
        />
      )}
    </div>
  )
}

function HandoverWindow({
  request,
  lookups,
  plan,
  styleId,
  styleCategory,
  routeOk,
  onClose,
  save,
}: {
  request: SampleRequest
  lookups: Lookups
  plan: Plan
  styleId: string
  styleCategory: string | null
  /** Every step of the sample's route was picked from the routing masters. */
  routeOk: boolean
  onClose: () => void
  save: (d: { boms: Array<{ colour: string; bomId: string | null }>; routingId: string | null; notes: string }) => Promise<void>
}) {
  // Approved BOMs of the style for a colour, or for every colour.
  const bomsFor = (colour: string) =>
    lookups.boms.filter((b) => b.styleId === styleId && (!b.color || colourKey(b.color) === colourKey(colour)))
  // Routings that fit the style, as the server judges them (routingProblem).
  const category = (styleCategory ?? '').trim().toLowerCase()
  const routings = lookups.routings.filter((r) =>
    r.styleId ? r.styleId === styleId : !r.category?.trim() || r.category.trim().toLowerCase() === category
  )
  const own = routings.filter((r) => r.styleId === styleId).sort((a, b) => b.version - a.version)[0]
  const [boms, setBoms] = useState<Record<string, string>>({})
  // The style's own routing when it has one; otherwise one made from the sample, if its route allows.
  const [routingId, setRouting] = useState(own?.id ?? (routeOk ? '' : (routings[0]?.id ?? '')))
  const [notes, setNotes] = useState('')
  const { busy, error, run } = useSave()
  const latestMade = plan.reduce((a, p) => Math.max(a, p.revision), 0)
  const empty = plan.filter((p) => !boms[p.colour] && p.lines === 0)
  const noRoute = !routingId && !routeOk
  return (
    <MakingWindow
      id="sample-handover-form"
      title="Prepare handover"
      subtitle={`${request.number} · ${request.style?.code ?? 'Style'} · ${joinAnd(plan.map((p) => p.colour))}`}
      submit="Prepare handover"
      icon={PackageCheck}
      note="A draft BOM is priced at what the sample paid, with the sample's labour and charges a piece; Masters checks and approves it. Nothing here makes a production order."
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void run(
          empty.length
            ? empty
                .map((p) =>
                  bomsFor(p.colour).length
                    ? `Round ${p.revision} has no material for ${p.colour}: pick an approved BOM for it.`
                    : `Round ${p.revision} has no material for ${p.colour}, and no BOM of the style is approved for it. Approve one in Masters → BOMs first.`
                )
                .join(' ')
            : noRoute
              ? 'Pick one of the style’s routings: the sample’s route has steps that were not picked from the routing masters.'
              : !notes.trim()
                ? 'Write the technical acceptance and handover notes.'
                : '',
          () =>
            save({
              boms: plan.map((p) => ({ colour: p.colour, bomId: boms[p.colour] || null })),
              routingId: routingId || null,
              notes: notes.trim(),
            })
        )
      }
    >
      <div className="space-y-4">
        {plan.map((p, i) => {
          const choices = bomsFor(p.colour)
          return (
            <Field key={p.colour} label={`BOM for ${p.colour}`} required>
              {choices.length ? (
                <SmartSelect
                  className="form-input"
                  value={boms[p.colour] ?? ''}
                  autoFocus={i === 0}
                  onChange={(e) => setBoms({ ...boms, [p.colour]: e.target.value })}
                >
                  <option value="" disabled={!p.lines}>
                    {p.lines
                      ? `Make a draft from round ${p.revision} (${plural(p.lines, 'line')})`
                      : `Round ${p.revision} has no material for it: pick an approved BOM`}
                  </option>
                  {choices.map((b) => (
                    <option key={b.id} value={b.id}>
                      Approved BOM v{b.version} · {b.color || 'All colours'}
                    </option>
                  ))}
                </SmartSelect>
              ) : (
                <p className="form-input bg-transparent text-sm">
                  {p.lines
                    ? `A draft made from round ${p.revision} (${plural(p.lines, 'line')})`
                    : `Round ${p.revision} has no material for ${p.colour}, and no BOM of the style is approved for it.`}
                </p>
              )}
            </Field>
          )
        })}
        <Field
          label="Production routing"
          required
          hint={routeOk ? undefined : 'The sample’s route has steps typed in by name, so a routing cannot be made from it.'}
        >
          <SmartSelect className="form-input" value={routingId} onChange={(e) => setRouting(e.target.value)}>
            <option value="" disabled={!routeOk}>
              Make the style’s routing from round {latestMade}’s route
            </option>
            {routings.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} · v{r.version}
              </option>
            ))}
          </SmartSelect>
        </Field>
        <Field label="Technical acceptance and handover notes" required>
          <textarea className="form-input" value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </MakingWindow>
  )
}

function HandoverRecord({
  request,
  round,
  canAccept,
  seesCosts,
  record,
  say,
}: {
  request: SampleRequest
  round: SampleRound
  canAccept: boolean
  seesCosts: boolean
  record: (action: string, data: unknown) => Promise<SampleRequest>
  say: (message: string) => void
}) {
  const h = round.handover!
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const status = request.handoverBoms ?? []
  const waiting = handoverWaiting(request, round)
  const accept = async () => {
    setBusy(true)
    setError('')
    try {
      await record('ACCEPT_HANDOVER', {})
      say('Handover accepted into production planning.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not accept the handover.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="glass-card space-y-3 p-4">
      <h2 className="font-semibold">Bulk handover</h2>
      {h.style && (
        <p className="text-sm">
          {h.style.code} · {h.style.name}
          {h.style.promoted && <span className="text-muted-foreground"> · made a production style at handover</span>}
        </p>
      )}
      {h.boms ? (
        <div className="overflow-x-auto">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th>Colour</th>
                <th>BOM</th>
                <th>{h.acceptedAt ? 'Production took' : 'In Masters now'}</th>
                {seesCosts && <th className="text-right">Cost a piece</th>}
              </tr>
            </thead>
            <tbody>
              {h.boms.map((b) => {
                const now = status.find((s) => colourKey(s.colour) === colourKey(b.colour))
                const took = h.accepted?.find((a) => colourKey(a.colour) === colourKey(b.colour))
                return (
                  <tr key={b.colour}>
                    <td>{b.colour}</td>
                    <td>
                      v{b.version}{' '}
                      <span className="text-muted-foreground text-xs">
                        {b.made
                          ? `draft made from round ${b.revision}, ${plural(b.lines.length, 'line')}`
                          : 'approved before handover'}
                      </span>
                    </td>
                    <td>
                      {h.acceptedAt
                        ? took
                          ? `BOM v${took.version}`
                          : `BOM v${b.version}`
                        : now?.approved
                          ? `Approved v${now.approved.version}${now.approved.color ? '' : ' (all colours)'}`
                          : now?.status === 'DELETED' || now?.status === 'OBSOLETE'
                            ? 'Retired or removed in Masters: approve another BOM for this colour'
                            : 'Waiting for approval in Masters'}
                    </td>
                    {seesCosts && (
                      <td className="text-right tabular-nums">
                        {b.costPerPiece == null ? '—' : formatRupees(b.costPerPiece)}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p>
          BOM {h.bomVersion} · Routing version {h.routingVersion}
        </p>
      )}
      {h.routing && (
        <p className="text-sm">
          Routing {h.routing.code} v{h.routing.version}
          {h.routing.made && <span className="text-muted-foreground"> · made from round {h.routing.revision}’s route</span>}
        </p>
      )}
      <p>{h.notes}</p>
      <p className="text-muted-foreground text-sm">
        Prepared by {h.preparedBy}
        {h.preparedAt ? ` · ${formatDate(h.preparedAt)}` : ''}
      </p>
      {h.acceptedAt ? (
        <p>
          Accepted by {h.acceptedBy} · {formatDate(h.acceptedAt)}
        </p>
      ) : waiting.length ? (
        <p className="text-sm">
          <LockKeyhole size={14} className="mr-1 inline" />
          Production accepts once Masters has approved a BOM for {joinAnd(waiting.map(waitingName))} in{' '}
          <Link href="/masters/bom" className="underline">
            Masters → BOMs
          </Link>
          .
        </p>
      ) : (
        canAccept && (
          <button type="button" className="btn-primary" disabled={busy} onClick={() => void accept()}>
            {busy ? 'Saving…' : 'Accept into production planning'}
          </button>
        )
      )}
      {error && <p className="text-destructive text-sm">{error}</p>}
    </div>
  )
}
