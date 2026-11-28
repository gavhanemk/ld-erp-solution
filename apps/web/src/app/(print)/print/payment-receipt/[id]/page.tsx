'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { modeLabel } from '@/components/sales/status'
import {
  StoreSheet,
  Dash,
  Note,
  PartyLine,
  TotalsBox,
  WordsAndTotals,
  money,
  longDate,
  shortDate,
  INK,
  MUTED,
  type SheetColumn,
  type TotalLine,
} from '@/components/print/StoreSheet'

interface Payload {
  company: Record<string, string | null>
  template: { title: string; footerNote: string | null; declaration: string | null }
  amountInWords: string
  receipt: {
    receiptNumber: string
    receiptDate: string
    amount: string
    tdsAmount: string
    onAccount: string
    mode: string
    referenceNo: string | null
    chequeNo: string | null
    chequeDate: string | null
    isChequeCleared: boolean
    status: string
    reversedAt: string | null
    reversalReason: string | null
    notes: string | null
    customer: {
      name: string
      gstin: string | null
      phone: string | null
      billingAddress: string | null
      billingCity: string | null
      billingState: string | null
      billingPincode: string | null
    }
    bankAccount: { accountName: string; bankName: string } | null
    allocations: Array<{
      id: string
      amount: string
      tdsAmount: string
      invoice: { invoiceNumber: string; invoiceDate: string; totalAmount: string }
    }>
    createdBy: { name: string } | null
    reversedBy: { name: string } | null
  }
}

/**
 * The receipt handed to the customer for money received: who paid, how, the
 * amount in figures and words, and the invoices it settles. A post-dated or
 * ordinary cheque says it is subject to realisation; a reversed receipt
 * prints with a band across it.
 */
export default function PrintPaymentReceipt() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<{ data: Payload }>(`/sales/receipts/${id}/print`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not open that receipt.'))
  }, [id])

  if (error) return <p style={{ padding: 48, color: INK }}>{error}</p>
  if (!data) return <p style={{ padding: 48, color: MUTED }}>Opening the receipt…</p>

  const { company, template, receipt: r } = data
  const c = r.customer
  const address = [c.billingAddress, c.billingCity, c.billingState, c.billingPincode].filter(Boolean).join(', ')
  const isCheque = r.mode === 'CHEQUE' || r.mode === 'PDC'

  const columns: SheetColumn[] = [
    { key: 'sn', head: 'S.N', width: '6%', align: 'center' },
    { key: 'invoice', head: 'Against invoice', width: '30%' },
    { key: 'date', head: 'Invoice date', width: '18%' },
    { key: 'total', head: 'Invoice total', width: '16%', align: 'right' },
    { key: 'received', head: 'Received (₹)', width: '16%', align: 'right' },
    { key: 'tds', head: 'TDS (₹)', width: '14%', align: 'right' },
  ]
  const rows = r.allocations.length
    ? r.allocations.map((a, i) => ({
        key: a.id,
        cells: {
          sn: i + 1,
          invoice: <strong>{a.invoice.invoiceNumber}</strong>,
          date: shortDate(a.invoice.invoiceDate),
          total: money(a.invoice.totalAmount),
          received: money(a.amount),
          tds: Number(a.tdsAmount) > 0 ? money(a.tdsAmount) : '—',
        },
      }))
    : // Nothing settled yet: say so in the table rather than leave it empty.
      [
        {
          key: 'advance',
          cells: {
            sn: '—',
            invoice: 'Received in advance, held on account against future invoices.',
            date: <Dash />,
            total: <Dash />,
            received: <Dash />,
            tds: <Dash />,
          },
        },
      ]

  const banner =
    r.status === 'REVERSED'
      ? `REVERSED on ${longDate(r.reversedAt)}${r.reversedBy ? ` by ${r.reversedBy.name}` : ''}${r.reversalReason ? ` — ${r.reversalReason}` : ''}. This receipt settles nothing.`
      : null

  const settled = r.allocations.reduce((s, a) => s + Number(a.amount), 0)
  const totals: TotalLine[] = [
    ...(r.allocations.length ? [{ label: 'Against invoices', value: money(settled) }] : []),
    ...(Number(r.onAccount) > 0 && r.status !== 'REVERSED' ? [{ label: 'On account', value: money(r.onAccount) }] : []),
    ...(Number(r.tdsAmount) > 0 ? [{ label: 'TDS deducted (not in the amount)', value: money(r.tdsAmount) }] : []),
  ]

  // Laid out like the purchase order (27 Nov 2026): who paid in the
  // "Received from" block with the receipt's facts and how it was paid beside it.
  return (
    <StoreSheet
      company={company}
      title={template.title}
      number={r.receiptNumber}
      dateLabel="Receipt date"
      date={longDate(r.receiptDate) ?? ''}
      backHref="/sales/payments?tab=receipts"
      backLabel="Payments received"
      banner={banner}
      party={{
        heading: 'Received from,',
        name: c.name,
        lines: (
          <>
            <PartyLine label="Address-" value={address || null} />
            <PartyLine label="GST No" value={c.gstin ?? 'Unregistered'} mono={Boolean(c.gstin)} />
            <PartyLine label="Contact No" value={c.phone} mono />
          </>
        ),
        meta: [
          ['Receipt No', r.receiptNumber, true],
          ['Receipt Date', shortDate(r.receiptDate), true],
          ['Mode', modeLabel(r.mode)],
          isCheque && !!r.chequeNo && ['Cheque', `${r.chequeNo}${r.chequeDate ? `, ${shortDate(r.chequeDate)}` : ''}`, true],
          !!r.referenceNo && [isCheque ? 'Drawn on' : 'Reference', r.referenceNo, !isCheque],
          ['Into', r.bankAccount ? r.bankAccount.accountName : r.mode === 'CASH' ? 'Cash' : null],
        ],
      }}
      columns={columns}
      rows={rows}
      after={
        <WordsAndTotals
          words={data.amountInWords}
          left={
            <>
              {isCheque && (
                <Note title="Cheque">{r.isChequeCleared ? 'The cheque has been credited.' : 'Subject to realisation of the cheque.'}</Note>
              )}
              <Note title="Special notes">{r.notes || <Dash />}</Note>
            </>
          }
          totals={<TotalsBox rows={totals} totalLabel="Amount received" total={`₹ ${money(r.amount)}`} />}
        />
      }
      signatures={[{ role: `For ${company.name} — Authorised signatory`, who: r.createdBy?.name }]}
      footerNote={template.footerNote ?? 'Thank you for your payment.'}
    />
  )
}
