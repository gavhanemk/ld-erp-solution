import { redirect } from 'next/navigation'

/** Reservations live in a tab of Material Requisitions; the old address goes there. */
export default function ReservationsPage() {
  redirect('/inventory/requisitions?view=reservations')
}
