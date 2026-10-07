import ExcelJS from 'exceljs'
import { z } from 'zod'
import { prisma } from '@ld-erp/database'
import { addDropdowns, addHowToSheet, addTemplateSheet, readSheetRows, type SheetColumn } from '../lib/sheet'
import { createCustomerGrnSchema } from '../schemas/inventory.schemas'

/**
 * Customer receipts from a spreadsheet.
 *
 * One row per item. Rows for the same customer, store, day and challan number
 * are one receipt, as they would be one lorry. Everything is checked and shown
 * row by row first; then either every receipt is booked or none is.
 *
 * A challan already booked for that customer (the same number, not cancelled)
 * is skipped rather than booked twice: importing the same sheet again, or the
 * "with your receipts" sheet with new rows added, is safe.
 */

export const MAX_ROWS = 2000

export const importBody = z.object({
  fileName: z.string().min(1).max(200),
  file: z.string().min(1, 'Choose a file'),
  confirm: z.boolean().optional(),
})

export type CmKey =
  | 'customer'
  | 'store'
  | 'receivedOn'
  | 'challanNo'
  | 'challanDate'
  | 'gateEntry'
  | 'gateEntryDate'
  | 'billNo'
  | 'billDate'
  | 'vehicleNo'
  | 'transport'
  | 'note'
  | 'itemCode'
  | 'itemName'
  | 'challanQty'
  | 'arrivedQty'
  | 'rejectedQty'
  | 'markings'
type Raw = Partial<Record<CmKey, string>>

export const CM_COLUMNS: SheetColumn<CmKey>[] = [
  { key: 'customer', head: 'Customer *', width: 28, list: 'customers' },
  { key: 'store', head: 'Store *', width: 22, list: 'stores', note: 'Which of our stores it went into.' },
  { key: 'receivedOn', head: 'Received On', width: 13, note: 'The day it arrived, as 2026-09-29 or 29-09-2026. Empty means today.' },
  { key: 'challanNo', head: 'Their Challan No', width: 16, note: 'Rows with the same customer, store, day and challan are one receipt.' },
  { key: 'challanDate', head: 'Their Challan Date', width: 14 },
  { key: 'gateEntry', head: 'Gate Entry No', width: 14 },
  { key: 'gateEntryDate', head: 'Gate Entry Date', width: 14 },
  { key: 'billNo', head: 'Their Bill No', width: 14 },
  { key: 'billDate', head: 'Their Bill Date', width: 14 },
  { key: 'vehicleNo', head: 'Vehicle No', width: 14 },
  { key: 'transport', head: 'Transport', width: 18 },
  { key: 'note', head: 'Note', width: 26 },
  { key: 'itemCode', head: 'Item Code *', width: 16, list: 'items', note: 'The item code. The name beside it is only for reading.' },
  { key: 'itemName', head: 'Item Name', width: 30 },
  { key: 'challanQty', head: 'Their Challan Qty', width: 12, note: 'What their challan says. Empty means the same as arrived.' },
  { key: 'arrivedQty', head: 'Arrived Qty *', width: 12, note: 'What actually came off the lorry. This is what goes into stock.' },
  { key: 'rejectedQty', head: 'Rejected Qty', width: 12, note: 'Of what arrived, how much failed the check. It stays in their stock, flagged to go back. Empty means none.' },
  { key: 'markings', head: 'Their Markings', width: 20 },
]

const low = (s?: string | null) => (s ?? '').trim().toLowerCase()
const key = (s?: string | null) => low(s).replace(/\s+/g, '')
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : '')

/** 2026-09-29, 29-09-2026 or 29/09/2026 — a day, or null when it is none of those. */
function parseDay(v?: string): Date | null | 'bad' {
  const t = (v ?? '').trim()
  if (!t) return null
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t)
  let y: number, mo: number, d: number
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  else if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(t))) [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])]
  else return 'bad'
  const out = new Date(Date.UTC(y, mo - 1, d, 6, 30))
  return out.getUTCMonth() === mo - 1 && out.getUTCDate() === d ? out : 'bad'
}

/** "1,250.5" as 1250.5; null when empty, NaN when not a number. */
function parseQty(v?: string): number | null {
  const t = (v ?? '').replace(/,/g, '').trim()
  if (!t) return null
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : NaN
}

/** One receipt line as a sheet row, the columns the import reads. */
export function cmRow(r: Record<string, unknown>, l: Record<string, unknown>): Record<CmKey, string | number> {
  const text = (v: unknown) => (v === null || v === undefined ? '' : String(v))
  const nameOf = (v: unknown) => text((v as { name?: string } | null)?.name)
  const item = l.item as { code: string; name: string }
  return {
    customer: nameOf(r.customer),
    store: nameOf(r.warehouse),
    receivedOn: day(r.receiptDate as Date),
    challanNo: text(r.challanNumber),
    challanDate: day(r.challanDate as Date | null),
    gateEntry: text(r.gateEntryNumber),
    gateEntryDate: day(r.gateEntryDate as Date | null),
    billNo: text(r.billNumber),
    billDate: day(r.billDate as Date | null),
    vehicleNo: text(r.vehicleNo),
    transport: text(r.transporter),
    note: text(r.notes),
    itemCode: item.code,
    itemName: item.name,
    challanQty: Number(l.challanQty),
    arrivedQty: Number(l.receivedQty),
    rejectedQty: Number(l.rejectedQty ?? 0),
    markings: text(l.markings),
  }
}

export async function buildTemplate(withCurrent: boolean): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'LD ERP'
  const sheet = addTemplateSheet(wb, 'Customer Material', CM_COLUMNS)
  if (withCurrent) {
    const receipts = await prisma.customerGRN.findMany({
      where: { cancelledAt: null },
      orderBy: [{ receiptDate: 'asc' }, { grnNumber: 'asc' }],
      include: {
        customer: { select: { name: true } },
        warehouse: { select: { name: true } },
        lines: { include: { item: { select: { code: true, name: true } } } },
      },
    })
    for (const r of receipts) for (const l of r.lines) sheet.addRow(cmRow(r as never, l as never))
  }
  const [customers, stores, items] = await Promise.all([
    prisma.customer.findMany({ where: { isActive: true }, select: { name: true }, orderBy: { name: 'asc' } }),
    prisma.warehouse.findMany({ where: { isActive: true }, select: { name: true }, orderBy: { name: 'asc' } }),
    prisma.item.findMany({ where: { isActive: true }, select: { code: true }, orderBy: { code: 'asc' } }),
  ])
  addDropdowns(
    wb,
    sheet,
    CM_COLUMNS,
    { customers: customers.map((c) => c.name), stores: stores.map((s) => s.name), items: items.map((i) => i.code) },
    MAX_ROWS,
  )
  addHowToSheet(wb, [
    'One row per item that arrived. Several rows for the same customer, store, day and challan number make one receipt.',
    'Required: Customer, Store, Item Code and Arrived Qty. Pick Customer, Store and Item Code from the dropdowns.',
    'Arrived Qty is what goes into stock, under the customer\'s name and with no value to us. Their Challan Qty is what their paperwork says; the difference shows as short or excess.',
    'A challan already booked for that customer is skipped, not booked twice.',
    'Nothing is saved until you have seen what each row will do and pressed Import. If any row has a problem, nothing is imported.',
  ])
  return Buffer.from(await wb.xlsx.writeBuffer())
}

export function readSheet(file: Buffer, fileName: string) {
  return readSheetRows(file, fileName, {
    columns: CM_COLUMNS,
    sheetName: 'Customer Material',
    mustHave: 'itemCode',
    mustHaveLabel: 'Item Code',
    maxRows: MAX_ROWS,
  })
}

export interface CmRowPlan {
  row: number
  /** Which receipt of the sheet this row is part of: "Receipt 1", "Receipt 2"… */
  receipt: string | null
  customer: string
  store: string
  challanNo: string | null
  item: string
  itemCode: string
  challanQty: number | null
  arrivedQty: number | null
  uom: string
  /** The receipt this challan was already booked as, when it was. */
  already: string | null
  skipped: boolean
  problems: string[]
}

/** Checks every row and puts them into receipts. Writes nothing. */
export async function planImport(rows: Array<{ row: number; raw: Raw }>) {
  const [customers, stores, items, booked] = await Promise.all([
    prisma.customer.findMany({ select: { id: true, name: true, code: true } }),
    prisma.warehouse.findMany({ select: { id: true, name: true, code: true, isActive: true } }),
    prisma.item.findMany({ select: { id: true, code: true, name: true, isActive: true, uom: { select: { symbol: true } } } }),
    prisma.customerGRN.findMany({
      where: { cancelledAt: null, challanNumber: { not: null } },
      select: { grnNumber: true, customerId: true, challanNumber: true },
    }),
  ])
  const customerBy = new Map<string, (typeof customers)[number]>()
  for (const c of customers) {
    customerBy.set(key(c.name), c)
    if (c.code) customerBy.set(key(c.code), c)
  }
  const storeBy = new Map<string, (typeof stores)[number]>()
  for (const w of stores) {
    storeBy.set(key(w.name), w)
    if (w.code) storeBy.set(key(w.code), w)
  }
  const itemByCode = new Map(items.map((i) => [key(i.code), i]))
  const itemByName = new Map(items.map((i) => [key(i.name), i]))
  const bookedAs = new Map(booked.map((b) => [`${b.customerId}|${key(b.challanNumber)}`, b.grnNumber]))

  type Group = {
    label: string
    plans: CmRowPlan[]
    body: Record<string, unknown>
    lines: Array<Record<string, unknown>>
    itemIds: Set<string>
  }
  const groups = new Map<string, Group>()
  const plans: CmRowPlan[] = []

  for (const { row, raw } of rows) {
    const problems: string[] = []
    const customer = customerBy.get(key(raw.customer))
    const store = storeBy.get(key(raw.store))
    const item = raw.itemCode ? itemByCode.get(key(raw.itemCode)) : raw.itemName ? itemByName.get(key(raw.itemName)) : undefined
    const receivedOn = parseDay(raw.receivedOn)
    const challanDate = parseDay(raw.challanDate)
    const gateEntryDate = parseDay(raw.gateEntryDate)
    const billDate = parseDay(raw.billDate)
    const rejected = parseQty(raw.rejectedQty)
    const arrived = parseQty(raw.arrivedQty)
    const onChallan = parseQty(raw.challanQty)

    if (!raw.customer) problems.push('Customer is empty.')
    else if (!customer) problems.push(`No customer called "${raw.customer}".`)
    if (!raw.store) problems.push('Store is empty.')
    else if (!store) problems.push(`No store called "${raw.store}".`)
    else if (!store.isActive) problems.push(`${store.name} is no longer in use.`)
    if (!raw.itemCode && !raw.itemName) problems.push('Item Code is empty.')
    else if (!item) problems.push(`No item with code "${raw.itemCode ?? raw.itemName}".`)
    if (receivedOn === 'bad') problems.push(`Received On "${raw.receivedOn}" is not a date. Write it as 2026-09-29.`)
    if (challanDate === 'bad') problems.push(`Their Challan Date "${raw.challanDate}" is not a date.`)
    if (gateEntryDate === 'bad') problems.push(`Gate Entry Date "${raw.gateEntryDate}" is not a date.`)
    if (billDate === 'bad') problems.push(`Their Bill Date "${raw.billDate}" is not a date.`)
    if (rejected !== null && (Number.isNaN(rejected) || rejected < 0)) problems.push(`Rejected Qty "${raw.rejectedQty}" is not a number.`)
    else if (rejected !== null && arrived !== null && !Number.isNaN(arrived) && rejected > arrived)
      problems.push(`Rejected Qty ${rejected} is more than arrived. Rejected is part of what arrived.`)
    if (arrived === null) problems.push('Arrived Qty is empty.')
    else if (Number.isNaN(arrived) || arrived <= 0) problems.push(`Arrived Qty "${raw.arrivedQty}" has to be a number above 0.`)
    if (onChallan !== null && (Number.isNaN(onChallan) || onChallan < 0)) problems.push(`Their Challan Qty "${raw.challanQty}" is not a number.`)

    const plan: CmRowPlan = {
      row,
      receipt: null,
      customer: customer?.name ?? raw.customer ?? '',
      store: store?.name ?? raw.store ?? '',
      challanNo: raw.challanNo || null,
      item: item?.name ?? raw.itemName ?? '',
      itemCode: item?.code ?? raw.itemCode ?? '',
      challanQty: onChallan !== null && !Number.isNaN(onChallan) ? onChallan : arrived !== null && !Number.isNaN(arrived) ? arrived : null,
      arrivedQty: arrived !== null && !Number.isNaN(arrived) ? arrived : null,
      uom: item?.uom?.symbol ?? '',
      already: null,
      skipped: false,
      problems,
    }
    plans.push(plan)
    if (!customer || !store) continue

    const when = receivedOn instanceof Date ? receivedOn : null
    const gk = [customer.id, store.id, day(when), key(raw.challanNo)].join('|')
    let g = groups.get(gk)
    if (!g) {
      g = {
        label: `Receipt ${groups.size + 1}`,
        plans: [],
        body: {
          customerId: customer.id,
          warehouseId: store.id,
          ...(when ? { receiptDate: when } : {}),
          challanNumber: raw.challanNo || null,
          challanDate: challanDate instanceof Date ? challanDate : null,
          gateEntryNumber: raw.gateEntry || null,
          gateEntryDate: gateEntryDate instanceof Date ? gateEntryDate : null,
          billNumber: raw.billNo || null,
          billDate: billDate instanceof Date ? billDate : null,
          vehicleNo: raw.vehicleNo || null,
          transporter: raw.transport || null,
          notes: raw.note || null,
        },
        lines: [],
        itemIds: new Set(),
      }
      groups.set(gk, g)
    } else {
      // The receipt's details come from its first row that has each one.
      const b = g.body
      b.challanDate ??= challanDate instanceof Date ? challanDate : null
      b.gateEntryNumber ??= raw.gateEntry || null
      b.gateEntryDate ??= gateEntryDate instanceof Date ? gateEntryDate : null
      b.billNumber ??= raw.billNo || null
      b.billDate ??= billDate instanceof Date ? billDate : null
      b.vehicleNo ??= raw.vehicleNo || null
      b.transporter ??= raw.transport || null
      b.notes ??= raw.note || null
    }
    plan.receipt = g.label
    g.plans.push(plan)

    if (item) {
      if (g.itemIds.has(item.id)) problems.push(`${item.code} is already on an earlier row of this receipt. Put it on one row.`)
      g.itemIds.add(item.id)
    }
    if (!problems.length && item && plan.arrivedQty !== null) {
      g.lines.push({
        itemId: item.id,
        challanQty: plan.challanQty ?? plan.arrivedQty,
        receivedQty: plan.arrivedQty,
        rejectedQty: rejected !== null && !Number.isNaN(rejected) ? rejected : 0,
        markings: raw.markings || null,
      })
    }
  }

  const receipts: Array<Record<string, unknown>> = []
  for (const g of groups.values()) {
    const challan = g.body.challanNumber as string | null
    const already = challan ? bookedAs.get(`${g.body.customerId}|${key(challan)}`) : undefined
    if (already) {
      for (const p of g.plans) {
        p.already = already
        p.skipped = true
        p.problems = []
      }
      continue
    }
    if (g.plans.some((p) => p.problems.length)) continue
    const check = createCustomerGrnSchema.safeParse({ ...g.body, lines: g.lines })
    if (!check.success) {
      g.plans[0].problems.push(...check.error.issues.map((i) => i.message))
      continue
    }
    receipts.push({ ...g.body, lines: g.lines })
  }

  return { plans, receipts }
}
