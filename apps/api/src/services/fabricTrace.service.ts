import type { Prisma } from '@prisma/client'
import { prisma } from '@ld-erp/database'

/**
 * Fabric traceability for a job-work order's garments, read from where each
 * fact is recorded — never typed at dispatch (the user's dispatch redesign of
 * 28 Nov 2026):
 *
 *   the customer's rolls, roll by roll, on their receipt (CustomerGRNRoll:
 *   barcode, metres, design, lot, the receipt and their challan number)
 *     → each roll's sticker (StockPackage, the same barcode)
 *     → issued to the floor on the requisitions of the order's MOs
 *     → cut on those MOs (CuttingOrder: lot, fabric given, used, wasted, pieces).
 *
 * A roll is put against a garment when one line of its MO was cut from that
 * fabric; when several were, the roll is listed with the MO and the gap says
 * so. Cutting does not record how many pieces came from each roll, so no
 * pieces are given per roll: the pieces are the cutting's. Nothing is
 * allocated that was not recorded.
 */

export interface TracedRoll {
  barcode: string
  designNo: string | null
  lotNo: string | null
  /** Metres on the customer's receipt. */
  received: number
  /** Metres issued from it to this garment's production, returns taken off. */
  issued: number
  grnId: string | null
  grnNumber: string | null
  receiptDate: Date | null
  partyChallan: string | null
  mrNumbers: string[]
}

export interface TracedCut {
  cutOrderNumber: string
  lotNo: string | null
  cutterName: string | null
  fabricGiven: number
  fabricUsed: number
  wastage: number
  pieces: number
}

export interface LineTrace {
  mos: Array<{ id: string; moNumber: string }>
  rolls: TracedRoll[]
  cuts: TracedCut[]
  /** What is not recorded, in plain words, each with the production order to put it right on. */
  gaps: Array<{ text: string; moId: string | null; moNumber: string | null }>
}

const r3 = (n: number) => Math.round(n * 1000) / 1000

type Db = Prisma.TransactionClient | typeof prisma

/** The fabric trail of each of these order lines, keyed by order line. */
export async function fabricTrace(db: Db, soLineIds: string[]): Promise<Map<string, LineTrace>> {
  const out = new Map<string, LineTrace>(soLineIds.map((id) => [id, { mos: [], rolls: [], cuts: [], gaps: [] }]))
  if (!soLineIds.length) return out

  const moLines = await db.mOLine.findMany({
    where: { soLineId: { in: soLineIds } },
    select: { id: true, soLineId: true, moId: true, mo: { select: { id: true, moNumber: true } } },
  })
  const moIds = [...new Set(moLines.map((m) => m.moId))]
  const [cuts, siblings, mrs] = await Promise.all([
    db.cuttingOrder.findMany({
      where: { moLineId: { in: moLines.map((m) => m.id) }, status: { not: 'CANCELLED' } },
      select: { moLineId: true, cutOrderNumber: true, lotNo: true, cutterName: true, fabricItemId: true, fabricIssued: true, fabricUsed: true, wastage: true, actualPieces: true },
      orderBy: { cutDate: 'asc' },
    }),
    // Every line of those MOs, to know when an MO makes more than one garment.
    db.mOLine.findMany({ where: { moId: { in: moIds } }, select: { id: true, moId: true } }),
    db.materialRequisition.findMany({ where: { moId: { in: moIds } }, select: { id: true, mrNumber: true, moId: true } }),
  ])
  const moOfMr = new Map(mrs.map((m) => [m.id, m]))

  // Roll stickers issued (and returned) on those requisitions, net, by sticker.
  const moves = mrs.length
    ? await db.stockPackageMove.findMany({
        where: { referenceType: 'MATERIAL_REQUISITION', referenceId: { in: mrs.map((m) => m.id) } },
        select: {
          qty: true,
          referenceId: true,
          package: {
            select: {
              id: true,
              itemId: true,
              barcode: true,
              ownership: true,
              sourceType: true,
              sourceId: true,
              parent: { select: { barcode: true, sourceId: true, parent: { select: { barcode: true, sourceId: true } } } },
            },
          },
        },
      })
    : []
  // A sticker split off a roll carries no barcode of its own: the roll's is its parent's.
  const rollCode = (p: (typeof moves)[number]['package']) => p.barcode ?? p.parent?.barcode ?? p.parent?.parent?.barcode ?? null
  const byRoll = new Map<string, { moId: string; itemId: string; issued: number; mrNumbers: Set<string> }>()
  for (const m of moves) {
    if (m.package.ownership !== 'CUSTOMER_OWNED') continue
    const code = rollCode(m.package)
    const mr = m.referenceId ? moOfMr.get(m.referenceId) : undefined
    if (!code || !mr?.moId) continue
    const key = `${mr.moId}|${code}`
    const hit = byRoll.get(key) ?? { moId: mr.moId, itemId: m.package.itemId, issued: 0, mrNumbers: new Set<string>() }
    hit.issued += -Number(m.qty)
    hit.mrNumbers.add(mr.mrNumber)
    byRoll.set(key, hit)
  }
  const codes = [...new Set([...byRoll.keys()].map((k) => k.split('|')[1]))]
  const receiptRolls = codes.length
    ? await db.customerGRNRoll.findMany({
        where: { barcode: { in: codes } },
        select: { barcode: true, meters: true, designNo: true, lotNo: true, line: { select: { grn: { select: { id: true, grnNumber: true, receiptDate: true, challanNumber: true } } } } },
      })
    : []
  const rollOf = new Map(receiptRolls.map((r) => [r.barcode, r]))

  // Customer fabric issued on each MO, all of it, to see what went without a roll sticker.
  const mrLines = mrs.length
    ? await db.materialRequisitionLine.findMany({
        where: { mrId: { in: mrs.map((m) => m.id) }, ownership: 'CUSTOMER_OWNED' },
        select: { mrId: true, issuedQty: true, returnedQty: true },
      })
    : []

  for (const soLineId of soLineIds) {
    const t = out.get(soLineId)!
    const mine = moLines.filter((m) => m.soLineId === soLineId)
    if (!mine.length) {
      t.gaps.push({ text: 'No production order is raised for this garment yet.', moId: null, moNumber: null })
      continue
    }
    for (const ml of mine) {
      if (!t.mos.some((m) => m.id === ml.mo.id)) t.mos.push(ml.mo)
      const myCuts = cuts.filter((c) => c.moLineId === ml.id)
      for (const c of myCuts) {
        t.cuts.push({
          cutOrderNumber: c.cutOrderNumber,
          lotNo: c.lotNo,
          cutterName: c.cutterName,
          fabricGiven: Number(c.fabricIssued ?? 0),
          fabricUsed: Number(c.fabricUsed ?? 0),
          wastage: Number(c.wastage ?? 0),
          pieces: Number(c.actualPieces ?? 0),
        })
      }
      const shared = siblings.filter((s) => s.moId === ml.moId).length > 1
      const fabricsCut = new Set(myCuts.map((c) => c.fabricItemId).filter(Boolean))
      const issuedOnMo = r3(mrLines.filter((l) => moOfMr.get(l.mrId)?.moId === ml.moId).reduce((s, l) => s + Number(l.issuedQty) - Number(l.returnedQty ?? 0), 0))
      let traced = 0
      for (const [key, v] of byRoll) {
        if (v.moId !== ml.moId) continue
        // With one garment on the MO every roll is its; with several, only a fabric this line was cut from.
        if (shared && !fabricsCut.has(v.itemId)) continue
        const code = key.split('|')[1]
        const rec = rollOf.get(code)
        traced += v.issued
        if (r3(v.issued) <= 0) continue
        t.rolls.push({
          barcode: code,
          designNo: rec?.designNo ?? null,
          lotNo: rec?.lotNo ?? null,
          received: rec ? Number(rec.meters) : 0,
          issued: r3(v.issued),
          grnId: rec?.line.grn.id ?? null,
          grnNumber: rec?.line.grn.grnNumber ?? null,
          receiptDate: rec?.line.grn.receiptDate ?? null,
          partyChallan: rec?.line.grn.challanNumber ?? null,
          mrNumbers: [...v.mrNumbers],
        })
      }
      const mo = ml.mo
      if (issuedOnMo <= 0) t.gaps.push({ text: `None of the customer's fabric has been issued to ${mo.moNumber} yet.`, moId: mo.id, moNumber: mo.moNumber })
      else if (!shared && r3(issuedOnMo - traced) > 0.001) {
        t.gaps.push({
          text: `${r3(issuedOnMo - traced)} m of the customer's fabric went to ${mo.moNumber} without roll barcodes, so those rolls are not known. Record the rolls on the customer's receipt.`,
          moId: mo.id,
          moNumber: mo.moNumber,
        })
      }
      if (shared && !fabricsCut.size && issuedOnMo > 0) {
        t.gaps.push({ text: `${mo.moNumber} makes more than one garment and this one is not cut yet, so its rolls are not known.`, moId: mo.id, moNumber: mo.moNumber })
      }
      if (!myCuts.length) t.gaps.push({ text: `This garment is not cut yet on ${mo.moNumber}.`, moId: mo.id, moNumber: mo.moNumber })
    }
    t.rolls.sort((a, b) => (a.receiptDate?.getTime() ?? 0) - (b.receiptDate?.getTime() ?? 0) || a.barcode.localeCompare(b.barcode))
  }
  return out
}
