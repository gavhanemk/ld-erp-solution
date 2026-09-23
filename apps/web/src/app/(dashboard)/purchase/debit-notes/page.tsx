'use client'

import { PurchaseNotesScreen } from '@/components/purchase/PurchaseNotesScreen'

/**
 * What the mill claims back from its suppliers.
 *
 * The screen itself is shared with the credit notes page: the two documents
 * adjust the same bills against the same remaining balance and differ in who
 * signed the paper, which is one field rather than a second implementation.
 */
export default function DebitNotesPage() {
  return <PurchaseNotesScreen moduleType="DEBIT" />
}
