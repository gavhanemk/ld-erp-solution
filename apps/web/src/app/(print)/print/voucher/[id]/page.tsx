'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { modeLabel } from '@/components/sales/status'
import { StoreSheet, Fact, Eyebrow, money, longDate, GREY, INK, MUTED, NAVY, NUM, RULE, type SheetColumn } from '@/components/print/StoreSheet'

interface Payload {
  company: Record<string, string | null>
  template: { title: string; footerNote: string | null }
  amountInWords: string
  voucher: {
    kind: string
    kindLabel: string
    voucherNo: string
    date: string
    narration: string | null
    amount: number
    mode: string | null
    referenceNo: string | null
    chequeNo: string | null
    chequeDate: string | null
    sourceType: string | null
    status: 'POSTED' | 'CANCELLED'
    cancelledAt: string | null
    cancelReason: string | null
    cancelledBy: { name: string } | null
    createdAt: string
    createdBy: { name: string } | null
    lines: Array<{
      id: string
      debit: number
      credit: number
      costCentre: { name: string } | null
      ledger: { name: string; group: string }
      bills: Array<{ kind: string; billNo: string; billDate: string; amount: number }>
    }>
  }
}

const BILL: Record<string, string> = { NEW_REF: 'New bill', AGAINST_REF: 'Against bill', ADVANCE: 'Advance', ON_ACCOUNT: 'On account' }

/**
 * A voucher as the accountant files it: the type and number, the date, every
 * ledger debited and credited, the bills each settles, the amount in words,
 * the narration, and room to sign — prepared, checked, authorised, and for a
 * payment, the person who took the money. A cancelled voucher prints with a
 * band across it.
 */
export default function PrintVoucher() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<{ data: Payload }>(`/accounts/vouchers/${id}/print`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not open that voucher.'))
  }, [id])

  if (error) return <p style={{ padding: 48, color: INK }}>{error}</p>
  if (!data) return <p style={{ padding: 48, color: MUTED }}>Opening the voucher…</p>

  const { company, voucher: v } = data
  const isCheque = v.mode === 'CHEQUE' || v.mode === 'PDC'
  const columns: SheetColumn[] = [
    { key: 'sn', head: 'S.N', width: '6%', align: 'center' },
    { key: 'ledger', head: 'Particulars', width: '50%' },
    { key: 'brand', head: 'Brand', width: '14%' },
    { key: 'debit', head: 'Debit (₹)', width: '15%', align: 'right' },
    { key: 'credit', head: 'Credit (₹)', width: '15%', align: 'right' },
  ]
  const rows: Array<{ key: string; cells: Record<string, React.ReactNode> }> = v.lines.map((l, i) => ({
    key: l.id,
    cells: {
      sn: i + 1,
      ledger: (
        <>
          <strong>{l.debit > 0 ? 'Dr ' : 'Cr '}</strong>
          {l.ledger.name}
          <div style={{ fontSize: '9px', color: GREY }}>{l.ledger.group}</div>
          {l.bills.map((b, j) => (
            <div key={j} style={{ fontSize: '9px', color: GREY }}>
              {BILL[b.kind] ?? b.kind} {b.billNo}
              {b.kind === 'AGAINST_REF' ? ` of ${longDate(b.billDate)}` : ''} — ₹{money(b.amount)}
            </div>
          ))}
        </>
      ),
      brand: l.costCentre?.name ?? '',
      debit: l.debit > 0 ? money(l.debit) : '',
      credit: l.credit > 0 ? money(l.credit) : '',
    },
  }))
  rows.push({
    key: 'total',
    cells: { sn: '', ledger: <strong>Total</strong>, brand: '', debit: <strong>{money(v.amount)}</strong>, credit: <strong>{money(v.amount)}</strong> },
  })

  const banner = v.status === 'CANCELLED' ? `CANCELLED on ${longDate(v.cancelledAt)}${v.cancelledBy ? ` by ${v.cancelledBy.name}` : ''}${v.cancelReason ? ` — ${v.cancelReason}` : ''}. This voucher counts for nothing.` : null
  const signatures = [
    { role: 'Prepared by', who: v.createdBy?.name ?? null },
    { role: 'Checked by', who: null },
    { role: `For ${company.name} — Authorised signatory`, who: null },
    ...(v.kind === 'PAYMENT' ? [{ role: "Receiver's signature", who: null }] : []),
  ]

  return (
    <StoreSheet
      company={company}
      title={`${v.kindLabel.toUpperCase()} VOUCHER`}
      number={v.voucherNo}
      dateLabel="Date"
      date={longDate(v.date) ?? ''}
      backHref={`/accounts/vouchers?open=${id}`}
      backLabel="Day Book"
      banner={banner}
      panels={[
        {
          title: 'Amount',
          body: (
            <>
              <div style={{ fontSize: '16px', fontWeight: 700, color: NAVY, ...NUM }}>₹{money(v.amount)}</div>
              <div style={{ fontSize: '9.5px', color: GREY, marginTop: '3px', lineHeight: 1.5 }}>{data.amountInWords}</div>
            </>
          ),
        },
        {
          title: 'How it was paid',
          body: (
            <>
              <Fact label="Mode" value={v.mode ? modeLabel(v.mode) : v.kind === 'JOURNAL' ? 'Journal entry' : null} />
              <Fact label="Cheque" value={isCheque && v.chequeNo ? `${v.chequeNo}${v.chequeDate ? `, ${longDate(v.chequeDate)}` : ''}` : null} mono />
              <Fact label={isCheque ? 'Drawn on' : 'Reference'} value={v.referenceNo} mono />
            </>
          ),
        },
        {
          title: 'Entered',
          body: (
            <>
              <Fact label="By" value={v.createdBy?.name ?? (v.sourceType ? 'From its document' : null)} />
              <Fact label="On" value={longDate(v.createdAt)} />
              {v.sourceType && <Fact label="From" value={`Document ${v.voucherNo}`} mono />}
            </>
          ),
        },
      ]}
      columns={columns}
      rows={rows}
      minRows={2}
      after={
        v.narration ? (
          <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px', marginTop: '8px' }}>
            <Eyebrow style={{ color: GREY }}>Narration</Eyebrow>
            <div style={{ fontSize: '10.5px', color: INK, marginTop: '3px', lineHeight: 1.55 }}>{v.narration}</div>
          </div>
        ) : null
      }
      signatures={signatures}
      footerNote={data.template.footerNote ?? 'A computer-generated voucher.'}
    />
  )
}
