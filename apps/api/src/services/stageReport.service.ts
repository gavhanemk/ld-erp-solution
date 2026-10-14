import type { Prisma, PrismaClient } from '@prisma/client'

type Db = PrismaClient | Prisma.TransactionClient

/*
 * A stage's report: everything that happened at one process — cutting,
 * stitching, a check — across every job card, entry by entry: what came in and
 * from where, what was done, what was sent on and to where, what was damaged
 * or failed and why, with the date, the time and who. Undone entries, and the
 * entries that undid them, are left out: together they changed nothing.
 */

export interface StageReportQuery {
  operationId: string
  from?: Date
  to?: Date
  moId?: string
}

type Entry = { qty: number; bucket: string; vendorId: string | null }
const sumIf = (list: Entry[], test: (e: Entry) => boolean) =>
  list.filter(test).reduce((s, e) => s + Math.abs(e.qty), 0)

export async function stageReport(db: Db, q: StageReportQuery) {
  const entries = await db.wipEntry.findMany({
    where: {
      step: { operationId: q.operationId },
      ...(q.moId ? { moId: q.moId } : {}),
      event: {
        reversedAt: null,
        type: { not: 'REVERSAL' },
        ...(q.from || q.to ? { eventDate: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
      },
    },
    select: {
      qty: true,
      bucket: true,
      vendorId: true,
      moLineId: true,
      bundle: { select: { code: true, size: { select: { code: true, sequence: true } } } },
      event: {
        select: {
          id: true,
          type: true,
          eventDate: true,
          reason: true,
          notes: true,
          personName: true,
          theirChallanNo: true,
          createdBy: { select: { name: true } },
          vendor: { select: { name: true } },
          mo: { select: { moNumber: true } },
          transfer: { select: { transferNumber: true, isRework: true, fromStep: { select: { name: true } }, toStep: { select: { name: true } }, vendor: { select: { name: true } } } },
          fgReceipt: { select: { fgrNumber: true } },
          cuttingOrder: { select: { cutOrderNumber: true } },
        },
      },
    },
    orderBy: [{ event: { eventDate: 'asc' } }, { createdAt: 'asc' }],
    take: 20000,
  })

  const cards = await db.jobCard.findMany({
    where: { moLineId: { in: [...new Set(entries.map((e) => e.moLineId))] } },
    select: { moLineId: true, jobCardNumber: true },
  })
  const cardOf = new Map(cards.map((c) => [c.moLineId, c.jobCardNumber]))

  const byEvent = new Map<string, typeof entries>()
  for (const e of entries) byEvent.set(e.event.id, [...(byEvent.get(e.event.id) ?? []), e])

  const rows = [...byEvent.values()].map((list) => {
    const ev = list[0].event
    const t = ev.transfer
    const into = (bucket: string) => sumIf(list, (e) => e.qty > 0 && e.bucket === bucket)
    const counted = ['RECEIVE', 'EXCESS', 'SETTLE'].includes(ev.type) ? into('WIP') : 0
    // Given to an outside unit for this stage: the pieces go straight into its hands.
    const toUnit = ev.type === 'DISPATCH' ? sumIf(list, (e) => e.qty > 0 && e.bucket === 'WIP' && !!e.vendorId) : 0
    const onTheWay = ev.type === 'DISPATCH' ? into('TRANSIT') : 0
    const sentOn = ['DISPATCH', 'EXCESS'].includes(ev.type) ? sumIf(list, (e) => e.qty < 0 && (e.bucket === 'DONE' || e.bucket === 'WIP') && !e.vendorId) : 0
    const packed = ev.type === 'PACK' ? sumIf(list, (e) => e.qty < 0 && (e.bucket === 'DONE' || e.bucket === 'WIP')) : 0
    const row = {
      id: ev.id,
      at: ev.eventDate,
      type: ev.type,
      mo: ev.mo.moNumber,
      jobCard: cardOf.get(list[0].moLineId) ?? null,
      bundles: [...new Set(list.map((e) => e.bundle.code))],
      sizes: [...new Map(list.map((e) => [e.bundle.size?.code ?? '', e.bundle.size?.sequence ?? 0])).entries()].sort((a, b) => a[1] - b[1]).map(([c]) => c).filter(Boolean),
      received: counted + toUnit,
      cut: ev.type === 'CUT' ? into('DONE') : 0,
      done: ['PROCESS', 'REWORK_DONE', 'VENDOR_RETURN', 'DECIDE'].includes(ev.type) ? into('DONE') : 0,
      sentOn,
      packed,
      onTheWay,
      damaged: into('DAMAGED'),
      failed: into('REJECTED'),
      rework: into('REWORK'),
      bGrade: into('B_GRADE'),
      scrapped: into('SCRAPPED'),
      short: into('SHORT'),
      from: t && (counted || toUnit || onTheWay) ? t.fromStep.name : null,
      to: t && sentOn ? (t.vendor ? `${t.toStep.name} at ${t.vendor.name}` : t.toStep.name) : null,
      unit: ev.vendor?.name ?? t?.vendor?.name ?? null,
      isRework: Boolean(t?.isRework),
      reason: ev.reason,
      notes: ev.notes,
      by: ev.personName ?? ev.createdBy?.name ?? null,
      document: t?.transferNumber ?? ev.fgReceipt?.fgrNumber ?? ev.cuttingOrder?.cutOrderNumber ?? ev.theirChallanNo ?? null,
    }
    return row
  })
  // An entry that moved nothing worth showing here — a split's book-keeping — is left out.
  const shown = rows.filter((r) => r.received || r.cut || r.done || r.sentOn || r.packed || r.onTheWay || r.damaged || r.failed || r.rework || r.bGrade || r.scrapped || r.short)
  const total = (k: 'received' | 'cut' | 'done' | 'sentOn' | 'packed' | 'damaged' | 'failed' | 'rework' | 'bGrade' | 'scrapped' | 'short') => shown.reduce((s, r) => s + r[k], 0)
  return {
    rows: shown,
    totals: {
      received: total('received'),
      cut: total('cut'),
      done: total('done'),
      sentOn: total('sentOn'),
      packed: total('packed'),
      damaged: total('damaged'),
      failed: total('failed'),
      rework: total('rework'),
      bGrade: total('bGrade'),
      scrapped: total('scrapped'),
      short: total('short'),
    },
    mos: [...new Set(shown.map((r) => r.mo))],
  }
}
