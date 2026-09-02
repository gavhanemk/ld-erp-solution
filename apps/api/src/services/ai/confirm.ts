import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Nothing the assistant writes happens on the first ask.
 *
 * A person saying "add a supplier, Nova Trims, Surat, 30 days" is not being
 * precise, and a model turning that into a record has to fill in several blanks.
 * Usually it fills them in correctly. The one time it hears 1180 instead of 118
 * on a rate, that mistake becomes a saved record with a document behind it, and
 * nobody finds out until a bill does not reconcile.
 *
 * So a write is two steps. The first call validates everything, saves nothing,
 * and hands back exactly what *would* be saved plus a ticket. The person reads
 * it and says yes. The second call presents the ticket and the write happens.
 *
 * The ticket is what makes this real rather than a polite convention:
 *
 *   · it is signed, so the model cannot invent one
 *   · it is bound to the exact values proposed, so nothing can be changed
 *     between the preview somebody read and the record that gets written
 *   · it is bound to the person, so it cannot be carried to another account
 *   · it is bound to the turn it was issued on, so it can only be redeemed on a
 *     later message — which means a real human "yes" sits in between, not two
 *     tool calls in the same breath
 *   · it expires, so an abandoned conversation cannot be finished off tomorrow
 *
 * None of it is stored. A ticket is self-describing and verifiable on its own,
 * so an interrupted conversation leaves nothing behind to clean up.
 */

const TICKET_TTL_MS = 15 * 60 * 1000

interface TicketBody {
  /** Which write was proposed. */
  t: string
  /** A fingerprint of the exact values, so they cannot be edited afterwards. */
  h: string
  /** Whose conversation it was. */
  u: string
  /** How many things the person had said when it was proposed. */
  n: number
  /** Milliseconds since the epoch when it stops being valid. */
  x: number
}

function secret(): string {
  const value = process.env.JWT_SECRET
  if (!value) {
    // Signing with a fallback would make every ticket forgeable by anyone who
    // read this file, which is worse than the assistant not being able to write.
    throw new Error('JWT_SECRET is not set, so the assistant cannot write safely')
  }
  return value
}

const b64 = (s: string) => Buffer.from(s).toString('base64url')

function sign(body: string): string {
  return createHmac('sha256', secret()).update(body).digest('base64url')
}

/**
 * A fingerprint of the values being written.
 *
 * Keys are sorted so that the same values in a different order produce the same
 * fingerprint — a model rewriting its own arguments between the preview and the
 * confirmation is normal, and should not be treated as tampering.
 */
function fingerprint(args: Record<string, unknown>): string {
  const stable = JSON.stringify(args, Object.keys(args).sort())
  return createHmac('sha256', secret()).update(stable).digest('base64url').slice(0, 32)
}

export function mintTicket(
  tool: string,
  args: Record<string, unknown>,
  userId: string,
  turnCount: number,
): string {
  const body: TicketBody = {
    t: tool,
    h: fingerprint(args),
    u: userId,
    n: turnCount,
    x: Date.now() + TICKET_TTL_MS,
  }
  const encoded = b64(JSON.stringify(body))
  return `${encoded}.${sign(encoded)}`
}

export type TicketCheck =
  | { ok: true }
  | { ok: false; reason: string }

export function checkTicket(
  ticket: unknown,
  tool: string,
  args: Record<string, unknown>,
  userId: string,
  turnCount: number,
): TicketCheck {
  if (typeof ticket !== 'string' || !ticket.includes('.')) {
    return { ok: false, reason: 'That confirmation code is not one I issued.' }
  }

  const [encoded, signature] = ticket.split('.', 2)

  const expected = Buffer.from(sign(encoded))
  const given = Buffer.from(signature)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'That confirmation code is not one I issued.' }
  }

  let body: TicketBody
  try {
    body = JSON.parse(Buffer.from(encoded, 'base64url').toString())
  } catch {
    return { ok: false, reason: 'That confirmation code could not be read.' }
  }

  if (body.x < Date.now()) {
    return { ok: false, reason: 'That confirmation has expired. Ask again and I will re-check it.' }
  }
  if (body.u !== userId) {
    return { ok: false, reason: 'That confirmation belongs to somebody else.' }
  }
  if (body.t !== tool) {
    return { ok: false, reason: 'That confirmation was for a different change.' }
  }
  if (body.h !== fingerprint(args)) {
    return {
      ok: false,
      reason: 'The details have changed since I showed them. Let me show you the new ones first.',
    }
  }
  // The whole point: a ticket issued while answering message 3 can only be spent
  // on message 4 or later. Within one answer the model cannot propose and
  // confirm in the same breath, because the person has not spoken yet.
  if (turnCount <= body.n) {
    return {
      ok: false,
      reason: 'I have not asked you yet. Let me show you what would change first.',
    }
  }

  return { ok: true }
}
