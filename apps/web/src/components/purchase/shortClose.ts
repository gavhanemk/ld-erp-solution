/**
 * "Closed short" and "cancelled" are one action on the server — a boolean, a
 * free-text reason, `receivedQty` left exactly as it was — because both say
 * the same thing about what happens next: the pending quantity stops
 * counting as due. But they are not the same fact about what happened.
 *
 * A line closed after some of it arrived is a genuine shortfall — the
 * supplier came up short. A line closed with nothing ever received was
 * never delivered at all, and calling that "closed short" reads as though
 * part of the order turned up when none of it did. The word is derived from
 * `receivedQty` rather than carried as a second field, because the fact it
 * describes already lives there.
 */
export const wasNeverReceived = (receivedQty: number | string | undefined | null) =>
  Number(receivedQty ?? 0) <= 0

export const shortCloseNoun = (receivedQty: number | string | undefined | null) =>
  wasNeverReceived(receivedQty) ? 'Cancelled' : 'Closed short'

export const shortCloseVerb = (receivedQty: number | string | undefined | null) =>
  wasNeverReceived(receivedQty) ? 'Cancel' : 'Close short'
