'use client'

import { PurchaseNotesScreen } from '@/components/purchase/PurchaseNotesScreen'

/**
 * Every debit note against a supplier bill — ours and theirs.
 *
 * Both on one screen, because both are debit notes. Ours claims money back
 * and reduces the bill; theirs charges us more and increases it. Which is
 * which is a column and a badge on the row, not a separate menu entry —
 * splitting them asked a clerk to know whose paper a thing was before they
 * could find it, when finding it is how they discover whose it is.
 */
export default function DebitNotesPage() {
  return <PurchaseNotesScreen moduleType="DEBIT" />
}
