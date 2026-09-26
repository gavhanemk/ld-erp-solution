'use client'

import { PurchaseNotesScreen } from '@/components/purchase/PurchaseNotesScreen'

/**
 * Reductions the mill's suppliers have granted it.
 *
 * Their document, not ours: they reduced their own invoice and sent the note,
 * and this screen records it under our reference so it can be found when the
 * department matches their document against ours.
 */
export default function CreditNotesPage() {
  return <PurchaseNotesScreen moduleType="CREDIT" />
}
