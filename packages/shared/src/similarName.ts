/**
 * Whether two names most likely name the same thing, typed twice — "Lio
 * Linene" and "lio linen" rather than "Cotton Poplin 40s" and "Cotton Poplin
 * 60s", which differ on purpose. Used to warn before a master record (an
 * item, say) is saved as a near-duplicate of one that already exists.
 *
 * The two names are split into words. If they split into a different number
 * of words, or more than one word differs between them, they are taken for
 * different things on purpose (a colour, a sleeve length, an extra word) —
 * not compared further. With exactly one differing word, that word is
 * compared on its own: if either side of it carries a digit — a count, a
 * size, a GSM — the two are taken as different specifications, however close
 * the spelling, because a number in a name is almost always chosen on
 * purpose. Otherwise the two words are compared by edit distance relative to
 * their own length, so a short word only tolerates a letter or two before it
 * reads as a different word rather than a typo of this one.
 */

const words = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

/** Edit distance between two short strings — insertions, deletions, substitutions, each counting one. */
function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]
      prev[j] = a[i - 1] === b[j - 1] ? diag : 1 + Math.min(diag, up, prev[j - 1])
      diag = up
    }
  }
  return prev[b.length]
}

export function looksLikeSameName(a: string, b: string): boolean {
  const wa = words(a)
  const wb = words(b)
  if (!wa.length || !wb.length || wa.length !== wb.length) return false

  let at = -1
  let differing = 0
  for (let i = 0; i < wa.length; i++) {
    if (wa[i] !== wb[i]) {
      differing++
      at = i
    }
  }
  if (differing === 0) return true // the same name, once case and spacing are set aside
  if (differing > 1) return false // more than one word apart: a different name, not a typo of this one

  const one = wa[at]
  const two = wb[at]
  if (/\d/.test(one) || /\d/.test(two)) return false // a count, a size, a GSM — chosen on purpose
  if (one.length < 3 || two.length < 3) return false // too short a word to judge safely

  const dist = editDistance(one, two)
  return dist <= 2 && dist / Math.max(one.length, two.length) <= 0.34
}
