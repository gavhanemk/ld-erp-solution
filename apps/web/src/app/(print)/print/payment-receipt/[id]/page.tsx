'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { modeLabel } from '@/components/sales/status'
import { StoreSheet, Fact, Eyebrow, money, longDate, GREY, INK, MUTED, NAVY, NUM, RULE, type SheetColumn } from '@/components/print/StoreSheet'

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
  const rows = r.allocations.map((a, i) => ({
    key: a.id,
    cells: {
      sn: i + 1,
      invoice: <strong>{a.invoice.invoiceNumber}</strong>,
      date: longDate(a.invoice.invoiceDate),
      total: money(a.invoice.totalAmount),
      received: money(a.amount),
      tds: Number(a.tdsAmount) > 0 ? money(a.tdsAmount) : '—',
    },
  }))

  const banner =
    r.status === 'REVERSED'
      ? `REVERSED on ${longDate(r.reversedAt)}${r.reversedBy ? ` by ${r.reversedBy.name}` : ''}${r.reversalReason ? ` — ${r.reversalReason}` : ''}. This receipt settles nothing.`
      : null

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
      panels={[
        {
          title: 'Received from',
          body: (
            <>
              <div style={{ fontSize: '12px', fontWeight: 700, color: NAVY, lineHeight: 1.3 }}>{c.name}</div>
              {address && <div style={{ fontSize: '10px', color: GREY, lineHeight: 1.55, marginTop: '3px' }}>{address}</div>}
              <div style={{ marginTop: '4px' }}>
                <Fact label="GSTIN" value={c.gstin ?? 'Unregistered'} mono />
                <Fact label="Phone" value={c.phone} />
              </div>
            </>
          ),
        },
        {
          title: 'Paid by',
          body: (
            <>
              <Fact label="Mode" value={modeLabel(r.mode)} />
              <Fact label="Cheque" value={isCheque && r.chequeNo ? `${r.chequeNo}${r.chequeDate ? `, ${longDate(r.chequeDate)}` : ''}` : null} mono />
              <Fact label={isCheque ? 'Drawn on' : 'Reference'} value={r.referenceNo} mono={!isCheque} />
              <Fact label="Into" value={r.bankAccount ? `${r.bankAccount.accountName}` : r.mode === 'CASH' ? 'Cash' : null} />
            </>
          ),
        },
        {
          title: 'Amount',
          body: (
            <>
              <div style={{ fontSize: '16px', fontWeight: 700, color: NAVY, ...NUM }}>₹{money(r.amount)}</div>
              <div style={{ fontSize: '9.5px', color: GREY, marginTop: '3px', lineHeight: 1.5 }}>{data.amountInWords}</div>
              {Number(r.tdsAmount) > 0 && <Fact label="TDS deducted" value={`₹${money(r.tdsAmount)}`} />}
              {Number(r.onAccount) > 0 && r.status !== 'REVERSED' && <Fact label="On account" value={`₹${money(r.onAccount)}`} />}
            </>
          ),
        },
      ]}
      columns={columns}
      rows={rows}
      minRows={3}
      after={
        <>
          {r.allocations.length === 0 && (
            <div style={{ fontSize: '10px', color: GREY, marginTop: '6px' }}>Received in advance, held on account against future invoices.</div>
          )}
          {isCheque && (
            <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px', marginTop: '8px' }}>
              <div style={{ fontSize: '10px', color: INK }}>
                {r.isChequeCleared ? 'The cheque has been credited.' : 'Subject to realisation of the cheque.'}
              </div>
            </div>
          )}
          {r.notes && (
            <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px', marginTop: '8px' }}>
              <Eyebrow style={{ color: GREY }}>Note</Eyebrow>
              <div style={{ fontSize: '10px', color: GREY, marginTop: '3px', lineHeight: 1.55 }}>{r.notes}</div>
            </div>
          )}
        </>
      }
      signatures={[{ role: `For ${company.name} — Authorised signatory`, who: r.createdBy?.name }]}
      footerNote={template.footerNote ?? 'Thank you for your payment.'}
    />
  )
}
