'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { Box, DocTable, SubLine } from '@/components/print/doc'
import {
  StoreSheet,
  Eyebrow,
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
} from '@/components/print/StoreSheet'

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
 *
 * Laid out like the purchase order (27 Nov 2026): the party in the "To,"
 * block with the period beside it, the entries with their running balance,
 * then the closing balance in words beside the opening, debits and credits.
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
  // Sized so a balance like "1,25,00,000.00 Dr" stays on one line.
  const columns: SheetColumn[] = [
    { key: 'date', head: 'Date', width: '10%' },
    { key: 'particulars', head: 'Particulars', width: '37%' },
    { key: 'voucher', head: 'Voucher', width: '14%' },
    { key: 'debit', head: 'Debit (₹)', width: '12.5%', align: 'right' },
    { key: 'credit', head: 'Credit (₹)', width: '12.5%', align: 'right' },
    { key: 'balance', head: 'Balance (₹)', width: '14%', align: 'right' },
  ]
  const rows = [
    {
      key: 'opening',
      cells: { date: shortDate(st.period.from), particulars: 'Opening balance', voucher: '', debit: '', credit: '', balance: side(st.opening) },
      muted: true,
    },
    ...st.rows.map((r) => ({
      key: r.lineId,
      cells: {
        date: shortDate(r.date),
        particulars: (
          <>
            <div style={{ fontWeight: 600 }}>{r.particulars}</div>
            {(r.narration || r.chequeNo) && <SubLine>{[r.narration, r.chequeNo ? `Chq ${r.chequeNo}` : null].filter(Boolean).join(' · ')}</SubLine>}
          </>
        ),
        voucher: (
          <>
            {r.voucherNo}
            <SubLine>{r.kindLabel}</SubLine>
          </>
        ),
        debit: r.debit ? money(r.debit) : '',
        credit: r.credit ? money(r.credit) : '',
        balance: side(r.balance),
      },
    })),
  ]
  // Which way the balance runs, as a party would say it.
  const owes = st.closing > 0 ? `due from you to ${company.name}` : st.closing < 0 ? `due to you from ${company.name}` : 'nil'
  const period = `${shortDate(st.period.from)} – ${shortDate(st.period.to)}`

  return (
    <StoreSheet
      company={company}
      title={confirm ? 'CONFIRMATION OF ACCOUNTS' : data.template.title}
      number={party.code ?? party.name}
      dateLabel="Period"
      date={`${longDate(st.period.from)} to ${longDate(st.period.to)}`}
      backHref={`/accounts/ledger?id=${id}&from=${st.period.from}&to=${st.period.to}`}
      backLabel="Ledger"
      party={{
        name: party.name,
        code: party.code,
        lines: (
          <>
            <PartyLine label="Address-" value={party.address || null} />
            <PartyLine label="GST No" value={party.gstin} mono />
            <PartyLine label="PAN No" value={party.pan} mono />
            <PartyLine label="Contact No" value={party.phone} mono />
            {party.email && <PartyLine label="Email" value={party.email} />}
          </>
        ),
        meta: [
          ['Statement', confirm ? 'Confirmation of accounts' : 'Statement of account'],
          ['As on', shortDate(st.period.to), true],
          ['Period', period, true],
          ['Opening', side(st.opening), true],
          ['Closing', side(st.closing), true],
        ],
      }}
      columns={columns}
      rows={rows}
      after={
        <>
          <WordsAndTotals
            words={data.closingInWords}
            left={
              <Note title={`Balance on ${longDate(st.period.to)}`}>
                ₹{money(Math.abs(st.closing))} — {owes}.
              </Note>
            }
            totals={
              <TotalsBox
                rows={[
                  { label: 'Opening balance', value: side(st.opening) },
                  { label: 'Debits', value: money(st.totals.dr) },
                  { label: 'Credits', value: money(st.totals.cr) },
                ]}
                totalLabel="Closing balance"
                total={`₹ ${side(st.closing)}`}
              />
            }
          />
          {data.openBills.length > 0 && (
            <div style={{ marginTop: '9px' }}>
              <Eyebrow style={{ breakAfter: 'avoid' }}>Bills open on {longDate(st.period.to)}</Eyebrow>
              <DocTable
                style={{ marginTop: '3px' }}
                columns={[
                  { key: 'bill', head: 'Bill', width: '34%' },
                  { key: 'date', head: 'Bill date', width: '14%' },
                  { key: 'due', head: 'Due on', width: '14%' },
                  { key: 'late', head: 'Overdue by', width: '18%' },
                  { key: 'amount', head: 'Amount (₹)', width: '20%', align: 'right' },
                ]}
                rows={data.openBills.map((b, i) => ({
                  key: `${b.billNo}-${i}`,
                  cells: {
                    bill: b.kind === 'unsplit' ? 'Opening balance, not split into bills' : b.billNo,
                    date: b.kind === 'unsplit' ? '' : shortDate(b.billDate),
                    due: b.dueDate ? shortDate(b.dueDate) : '',
                    late: b.kind === 'bill' && b.days > 0 ? `${b.days} days` : '',
                    amount: `${money(Math.abs(b.amount))}${b.amount < 0 ? ' advance' : ''}`,
                  },
                }))}
              />
            </div>
          )}
          {confirm && (
            <Box title="Please confirm" style={{ marginTop: '9px' }}>
              <div style={{ fontSize: '10px', lineHeight: 1.6 }}>
                In our books your account stands at <strong>₹{money(Math.abs(st.closing))}</strong> ({data.closingInWords}) {owes}, as on {longDate(st.period.to)}.
                Please check it against your own books and sign and return a copy of this statement as your confirmation. If your books show a different
                balance, tell us the difference and the entries behind it within 15 days; if we hear nothing, we will take the balance as agreed.
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '24px', marginTop: '28px' }}>
                <div style={{ flex: 1, borderTop: '1pt solid #000', paddingTop: '3px', fontSize: '9.5px', fontWeight: 700 }}>
                  Confirmed for {party.name} — signature, stamp and date
                </div>
                <div style={{ flex: 1, borderTop: '1pt solid #000', paddingTop: '3px', fontSize: '9.5px', fontWeight: 700 }}>Balance as per your books, if different</div>
              </div>
            </Box>
          )}
        </>
      }
      signatures={[{ role: `For ${company.name} — Accounts`, who: null }]}
      footerNote={data.template.footerNote ?? 'Errors and omissions excepted.'}
    />
  )
}
