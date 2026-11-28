'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { modeLabel } from '@/components/sales/status'
import { SubLine } from '@/components/print/doc'
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
} from '@/components/print/StoreSheet'

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
      /** isMoney: a cash or bank ledger; billWise: a party kept bill by bill. */
      ledger: { name: string; group: string; isMoney?: boolean; billWise?: boolean }
      bills: Array<{ kind: string; billNo: string; billDate: string; amount: number }>
    }>
  }
}

type VoucherLine = Payload['voucher']['lines'][number]

const BILL: Record<string, string> = { NEW_REF: 'New bill', AGAINST_REF: 'Against bill', ADVANCE: 'Advance', ON_ACCOUNT: 'On account' }

/**
 * Whom the voucher is about, for the "To," block: the party paid on a
 * payment, the party that paid on a receipt, and otherwise the party ledger
 * kept bill by bill (the customer on a sale, the supplier on a purchase), or
 * the first ledger that is not cash or bank.
 */
function partyOf(kind: string, lines: VoucherLine[]): VoucherLine | undefined {
  const notMoney = (l: VoucherLine) => !l.ledger.isMoney
  if (kind === 'PAYMENT') return lines.find((l) => l.debit > 0 && notMoney(l)) ?? lines.find((l) => l.debit > 0)
  if (kind === 'RECEIPT') return lines.find((l) => l.credit > 0 && notMoney(l)) ?? lines.find((l) => l.credit > 0)
  if (kind === 'CONTRA') return lines.find((l) => l.debit > 0)
  return lines.find((l) => l.ledger.billWise) ?? lines.find(notMoney) ?? lines[0]
}

/**
 * A voucher as the accountant files it: the type and number, the date, every
 * ledger debited and credited, the bills each settles, the amount in words,
 * the narration, and room to sign — prepared, checked, authorised, and for a
 * payment, the person who took the money. A cancelled voucher prints with a
 * band across it.
 *
 * Laid out like the purchase order (27 Nov 2026): the party in the "To," block
 * with the voucher's facts beside it, the ledgers, then the amount in words
 * beside the debit and credit totals.
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
    { key: 'sn', head: 'S.N', width: '5%', align: 'center' },
    { key: 'ledger', head: 'Particulars', width: '51%' },
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
          <div>
            <strong>{l.debit > 0 ? 'Dr ' : 'Cr '}</strong>
            <span style={{ fontWeight: 600 }}>{l.ledger.name}</span>
          </div>
          <SubLine>{l.ledger.group}</SubLine>
          {l.bills.map((b, j) => (
            <SubLine key={j}>
              {BILL[b.kind] ?? b.kind} {b.billNo}
              {b.kind === 'AGAINST_REF' ? ` of ${shortDate(b.billDate)}` : ''} — ₹{money(b.amount)}
            </SubLine>
          ))}
        </>
      ),
      brand: l.costCentre?.name ?? '',
      debit: l.debit > 0 ? money(l.debit) : '',
      credit: l.credit > 0 ? money(l.credit) : '',
    },
  }))

  const banner = v.status === 'CANCELLED' ? `CANCELLED on ${longDate(v.cancelledAt)}${v.cancelledBy ? ` by ${v.cancelledBy.name}` : ''}${v.cancelReason ? ` — ${v.cancelReason}` : ''}. This voucher counts for nothing.` : null
  const signatures = [
    { role: 'Prepared by', who: v.createdBy?.name ?? null },
    { role: 'Checked by', who: null },
    { role: `For ${company.name} — Authorised signatory`, who: null },
    ...(v.kind === 'PAYMENT' ? [{ role: "Receiver's signature", who: null }] : []),
  ]

  // The party, and on a payment or receipt the cash or bank it went through.
  const party = partyOf(v.kind, v.lines)
  const heading = v.kind === 'PAYMENT' ? 'Paid to,' : v.kind === 'RECEIPT' ? 'Received from,' : 'Account,'
  const moneySide = (side: 'debit' | 'credit') =>
    v.lines
      .filter((l) => l.ledger.isMoney && l[side] > 0)
      .map((l) => l.ledger.name)
      .join(', ') || null
  const mode = v.mode ? modeLabel(v.mode) : v.kind === 'JOURNAL' ? 'Journal entry' : null

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
      party={{
        heading,
        name: party?.ledger.name ?? <Dash />,
        lines: (
          <>
            <PartyLine label="Ledger group" value={party?.ledger.group ?? null} />
            {v.kind === 'PAYMENT' && <PartyLine label="Paid from" value={moneySide('credit')} />}
            {v.kind === 'RECEIPT' && <PartyLine label="Received in" value={moneySide('debit')} />}
            {party?.costCentre && <PartyLine label="Brand" value={party.costCentre.name} />}
          </>
        ),
        meta: [
          ['Voucher No', v.voucherNo, true],
          ['Date', shortDate(v.date), true],
          ['Type', `${v.kindLabel} voucher`],
          !!mode && ['Mode', mode],
          isCheque && !!v.chequeNo && ['Cheque', `${v.chequeNo}${v.chequeDate ? `, ${shortDate(v.chequeDate)}` : ''}`, true],
          !!v.referenceNo && [isCheque ? 'Drawn on' : 'Reference', v.referenceNo, true],
          ['Entered by', v.createdBy?.name ?? (v.sourceType ? 'From its document' : null)],
          ['Entered on', shortDate(v.createdAt), true],
          !!v.sourceType && ['From', `Document ${v.voucherNo}`, true],
        ],
      }}
      columns={columns}
      rows={rows}
      after={
        <WordsAndTotals
          words={data.amountInWords}
          left={<Note title="Narration">{v.narration || <Dash />}</Note>}
          totals={
            <TotalsBox
              rows={[
                { label: 'Total debit', value: money(v.amount) },
                { label: 'Total credit', value: money(v.amount) },
              ]}
              totalLabel="Voucher amount"
              total={`₹ ${money(v.amount)}`}
            />
          }
        />
      }
      signatures={signatures}
      footerNote={data.template.footerNote ?? 'A computer-generated voucher.'}
    />
  )
}
