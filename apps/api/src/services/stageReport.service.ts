import type { Prisma, PrismaClient } from '@prisma/client'

type Db = PrismaClient | Prisma.TransactionClient

/*
 * A stage's report: everything that happened at one process — cutting,
 * stitching, a check — across every job card, entry by entry: what came in and
 * from where, what was done, what was sent on and to where, what was damaged
 * or failed and why, with the date, the time and who. Undone entries, and the
 * entries that undid them, are left out: together they changed nothing.
 *
 * A size change at stitching (pieces of a bundle made as another size, moved
 * into a new bundle) is shown as its own entry with each bundle's move, but
 * counts as nothing received, done or sent: the pieces stay where they were.
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

  // Each size change's moves, bundle by bundle: "20 pcs M → L (B003 → B061)".
  const changeIds = [...new Set(entries.filter((e) => e.event.type === 'SIZE_CHANGE').map((e) => e.event.id))]
  const changes = changeIds.length
    ? await db.sizeChange.findMany({
        where: { eventId: { in: changeIds } },
        orderBy: { fromBundle: { bundleNo: 'asc' } },
        select: { eventId: true, qty: true, fromBundle: { select: { bundleNo: true } }, toBundle: { select: { bundleNo: true } }, fromSize: { select: { code: true } }, toSize: { select: { code: true } } },
      })
    : []
  const bNo = (n: number) => `B${String(n).padStart(3, '0')}`
  const movesOf = new Map<string, Array<{ from: string; fromSize: string; to: string; toSize: string; qty: number }>>()
  for (const c of changes) {
    // Since 12 Nov 2026 the pieces stay in their own bundle: from and to are the same bundle.
    movesOf.set(c.eventId, [...(movesOf.get(c.eventId) ?? []), { from: bNo(c.fromBundle.bundleNo), fromSize: c.fromSize.code, to: bNo((c.toBundle ?? c.fromBundle).bundleNo), toSize: c.toSize.code, qty: c.qty }])
  }

  const byEvent = new Map<string, typeof entries>()
  for (const e of entries) byEvent.set(e.event.id, [...(byEvent.get(e.event.id) ?? []), e])

  const rows = [...byEvent.values()].map((list) => {
    const ev = list[0].event
    const t = ev.transfer
    // A size change only hands pieces to a new bundle where they lie: nothing came in or went anywhere.
    const sizeChange = ev.type === 'SIZE_CHANGE' ? (movesOf.get(ev.id) ?? []) : null
    const into = (bucket: string) => (sizeChange ? 0 : sumIf(list, (e) => e.qty > 0 && e.bucket === bucket))
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
      /** A size change's moves, bundle by bundle; null for every other entry. */
      sizeChange,
    }
    return row
  })
  // An entry that moved nothing worth showing here — a split's book-keeping — is left out. A size
  // change is shown, with its moves, though it counts in none of the figures.
  const shown = rows.filter(
    (r) => r.sizeChange?.length || r.received || r.cut || r.done || r.sentOn || r.packed || r.onTheWay || r.damaged || r.failed || r.rework || r.bGrade || r.scrapped || r.short,
  )
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
