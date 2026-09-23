'use client'

import { PurchaseNotesScreen } from '@/components/purchase/PurchaseNotesScreen'

/**
 * The credit notes suppliers have sent us.
 *
 * Ours to record, not to raise — the document is theirs, so the form asks for
 * their number and their date and files it under a reference of our own.
 */
export default function SupplierCreditNotesPage() {
  return <PurchaseNotesScreen moduleType="CREDIT" />
}
