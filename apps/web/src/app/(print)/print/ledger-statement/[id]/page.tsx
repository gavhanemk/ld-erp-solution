'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { StoreSheet, Fact, Eyebrow, money, longDate, GREY, INK, MUTED, NAVY, NUM, RULE, type SheetColumn } from '@/components/print/StoreSheet'

interface Payload {
  company: Record<string, string | null>
  template: { title: string; footerNote: string | null }
  party: { name: string; code: string | null; gstin: string | null; pan: string | null; phone: string | null; email: string | null; address: string | null }
  statement: {
    period: { from: string; to: string }
    opening: number
    totals: { dr: number; cr: number }
    closing: number
    rows: Array<{ lineId: string; date: string; kindLabel: string; voucherNo: string; particulars: string; narration: string | null; chequeNo: string | null; debit: number; credit: number; balance: number }>
  }
  openBills: Array<{ billNo: string; billDate: string; dueDate: string | null; days: number; amount: number; kind: string }>
  closingInWords: string
}

/** A balance as the party reads it: "1,25,000.00 Dr". */
const side = (n: number) => (Math.round(n * 100) === 0 ? '0.00' : `${money(Math.abs(n))} ${n > 0 ? 'Dr' : 'Cr'}`)

/**
 * A party's account as it is sent to them: who they are, the balance the
 * period opened with, every entry with the balance after it, where it
 * closed, and the bills still open that day.
 *
 * With ?confirm=1 it is a confirmation of accounts: the same statement with a
 * request to sign and send back the balance as they see it — what auditors
 * ask for at the year end.
 */
export default function PrintLedgerStatement() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)

  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    setConfirm(p.get('confirm') === '1')
    const qs = new URLSearchParams()
    if (p.get('from')) qs.set('from', p.get('from')!)
    if (p.get('to')) qs.set('to', p.get('to')!)
    api
      .get<{ data: Payload }>(`/accounts/ledgers/${id}/print-statement?${qs}`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not open that statement.'))
  }, [id])

  if (error) return <p style={{ padding: 48, color: INK }}>{error}</p>
  if (!data) return <p style={{ padding: 48, color: MUTED }}>Opening the statement…</p>

  const { company, party, statement: st } = data
  const columns: SheetColumn[] = [
    { key: 'date', head: 'Date', width: '12%' },
    { key: 'particulars', head: 'Particulars', width: '38%' },
    { key: 'voucher', head: 'Voucher', width: '14%' },
    { key: 'debit', head: 'Debit (₹)', width: '12%', align: 'right' },
    { key: 'credit', head: 'Credit (₹)', width: '12%', align: 'right' },
    { key: 'balance', head: 'Balance', width: '12%', align: 'right' },
  ]
  const rows = [
    {
      key: 'opening',
      cells: { date: longDate(st.period.from), particulars: <em>Opening balance</em>, voucher: '', debit: '', credit: '', balance: side(st.opening) },
      muted: true,
    },
    ...st.rows.map((r) => ({
      key: r.lineId,
      cells: {
        date: longDate(r.date),
        particulars: (
          <>
            {r.particulars}
            {(r.narration || r.chequeNo) && <div style={{ fontSize: '9px', color: GREY }}>{[r.narration, r.chequeNo ? `Chq ${r.chequeNo}` : null].filter(Boolean).join(' · ')}</div>}
          </>
        ),
        voucher: (
          <>
            {r.voucherNo}
            <div style={{ fontSize: '9px', color: GREY }}>{r.kindLabel}</div>
          </>
        ),
        debit: r.debit ? money(r.debit) : '',
        credit: r.credit ? money(r.credit) : '',
        balance: side(r.balance),
      },
    })),
    {
      key: 'total',
      cells: { date: '', particulars: <strong>Total, and closing balance</strong>, voucher: '', debit: <strong>{money(st.totals.dr)}</strong>, credit: <strong>{money(st.totals.cr)}</strong>, balance: <strong>{side(st.closing)}</strong> },
    },
  ]
  // Which way the balance runs, as a party would say it.
  const owes = st.closing > 0 ? `due from you to ${company.name}` : st.closing < 0 ? `due to you from ${company.name}` : 'nil'

  return (
    <StoreSheet
      company={company}
      title={confirm ? 'CONFIRMATION OF ACCOUNTS' : data.template.title}
      number={party.code ?? party.name}
      dateLabel="Period"
      date={`${longDate(st.period.from)} to ${longDate(st.period.to)}`}
      backHref={`/accounts/ledger?id=${id}&from=${st.period.from}&to=${st.period.to}`}
      backLabel="Ledger"
      panels={[
        {
          title: 'Account of',
          body: (
            <>
              <div style={{ fontSize: '12px', fontWeight: 700, color: NAVY, lineHeight: 1.3 }}>{party.name}</div>
              {party.address && <div style={{ fontSize: '10px', color: GREY, lineHeight: 1.55, marginTop: '3px' }}>{party.address}</div>}
              <div style={{ marginTop: '4px' }}>
                <Fact label="GSTIN" value={party.gstin} mono />
                <Fact label="PAN" value={party.pan} mono />
              </div>
            </>
          ),
        },
        {
          title: 'Summary',
          body: (
            <>
              <Fact label="Opening" value={side(st.opening)} />
              <Fact label="Debits" value={money(st.totals.dr)} />
              <Fact label="Credits" value={money(st.totals.cr)} />
              <Fact label="Closing" value={side(st.closing)} />
            </>
          ),
        },
        {
          title: `Balance on ${longDate(st.period.to)}`,
          body: (
            <>
              <div style={{ fontSize: '16px', fontWeight: 700, color: NAVY, ...NUM }}>₹{money(Math.abs(st.closing))}</div>
              <div style={{ fontSize: '9.5px', color: GREY, marginTop: '3px', lineHeight: 1.5 }}>
                {data.closingInWords}, {owes}.
              </div>
            </>
          ),
        },
      ]}
      columns={columns}
      rows={rows}
      minRows={4}
      after={
        <>
          {data.openBills.length > 0 && (
            <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px', marginTop: '8px' }}>
              <Eyebrow style={{ color: GREY }}>Bills open on {longDate(st.period.to)}</Eyebrow>
              <table style={{ width: '100%', fontSize: '10px', color: INK, marginTop: '4px', borderCollapse: 'collapse' }}>
                <tbody>
                  {data.openBills.map((b) => (
                    <tr key={b.billNo}>
                      <td style={{ padding: '2px 0' }}>{b.kind === 'unsplit' ? 'Opening balance, not split into bills' : b.billNo}</td>
                      <td style={{ padding: '2px 0', color: GREY }}>{b.kind === 'unsplit' ? '' : longDate(b.billDate)}</td>
                      <td style={{ padding: '2px 0', color: GREY }}>{b.dueDate ? `due ${longDate(b.dueDate)}` : ''}</td>
                      <td style={{ padding: '2px 0', color: GREY }}>{b.kind === 'bill' && b.days > 0 ? `${b.days} days past due` : ''}</td>
                      <td style={{ padding: '2px 0', textAlign: 'right', ...NUM }}>
                        {money(Math.abs(b.amount))}
                        {b.amount < 0 ? ' advance' : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {confirm && (
            <div style={{ border: `1px solid ${RULE}`, padding: '9px 12px', marginTop: '8px', fontSize: '10.5px', color: INK, lineHeight: 1.6 }}>
              <Eyebrow>Please confirm</Eyebrow>
              <div style={{ marginTop: '4px' }}>
                In our books your account stands at <strong>₹{money(Math.abs(st.closing))}</strong> ({data.closingInWords}) {owes}, as on {longDate(st.period.to)}.
                Please check it against your own books and sign and return a copy of this statement as your confirmation. If your books show a different
                balance, tell us the difference and the entries behind it within 15 days; if we hear nothing, we will take the balance as agreed.
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '24px', marginTop: '28px' }}>
                <div style={{ flex: 1, borderTop: `1px solid ${RULE}`, paddingTop: '4px', fontSize: '9.5px', color: GREY }}>
                  Confirmed for {party.name} — signature, stamp and date
                </div>
                <div style={{ flex: 1, borderTop: `1px solid ${RULE}`, paddingTop: '4px', fontSize: '9.5px', color: GREY }}>Balance as per your books, if different</div>
              </div>
            </div>
          )}
        </>
      }
      signatures={[{ role: `For ${company.name} — Accounts`, who: null }]}
      footerNote={data.template.footerNote ?? 'Errors and omissions excepted.'}
    />
  )
}
