import { prisma } from '@ld-erp/database'
import { ZodError } from 'zod'
import {
  ITEM_GROUP_LABEL,
  ITEM_GROUP_TABS,
  ITEM_GROUP_TYPES,
  typeFitsGroup,
  type ItemGroup,
} from '@ld-erp/shared'

/*
 * Items & Products in three tabs. A main category says which tab it is under,
 * its sub-categories carry the same, and an item's type has to fit the tab of
 * the category it is filed under.
 */

const TYPE_LABEL: Record<string, string> = {
  RAW_MATERIAL: 'raw material',
  SEMI_FINISHED: 'semi-finished',
  FINISHED_GOOD: 'finished good',
  CONSUMABLE: 'consumable',
  PACKING_MATERIAL: 'packing material',
  TRIM: 'trim',
}

/**
 * The main categories: one per tab. Everything else is a sub-category under
 * one of them. The expense heads keep a main category of their own, made by the
 * Expense Heads screen.
 */
export const MAIN_CATEGORIES = ['Raw Materials', 'Semi-Finished Goods', 'Finished Goods']

/** Whether a main category of this name may be made: one of the three, or the expense heads'. */
export function mainNameAllowed(name: string) {
  const n = name.trim().toLowerCase()
  return /expense/.test(n) || MAIN_CATEGORIES.some((m) => m.toLowerCase() === n)
}

/** A new main category's tab when none is picked: by its name, else Raw Materials. */
export function defaultGroupForName(name: string): ItemGroup {
  if (/expense/i.test(name)) return 'EXPENSES'
  if (/^\s*semi/i.test(name)) return 'SEMI_FINISHED'
  if (/^\s*finished/i.test(name)) return 'FINISHED_GOODS'
  return 'RAW_MATERIALS'
}

/** The tab a category is under: its own when main, its main category's when not. */
export async function groupOfCategory(categoryId: string) {
  const c = await prisma.itemCategory.findUnique({
    where: { id: categoryId },
    select: { name: true, itemGroup: true, parent: { select: { itemGroup: true } } },
  })
  if (!c) return null
  return { name: c.name, group: (c.parent?.itemGroup ?? c.itemGroup) as ItemGroup }
}

/** "a finished good cannot be filed under Cotton, which is under Raw Materials …" */
export function typeMismatchMessage(type: string, categoryName: string, group: ItemGroup) {
  const takes = (ITEM_GROUP_TYPES[group] ?? []).map((t) => TYPE_LABEL[t] ?? t)
  const list = takes.length > 1 ? `${takes.slice(0, -1).join(', ')} or ${takes[takes.length - 1]}` : takes[0]
  return `${categoryName} is under ${ITEM_GROUP_LABEL[group]}, which takes ${list} items — not a ${
    TYPE_LABEL[type] ?? type
  }. Change the type or file it under another category.`
}

/**
 * Refuses an item whose type does not fit its category's tab. Checked only when
 * the type or the category changes, so an older item filed oddly can still have
 * its rate edited; it shows in the list for someone to put right.
 */
export async function assertItemFitsCategory(data: Record<string, unknown>, before?: Record<string, unknown>) {
  const type = String(data.type ?? before?.type ?? '')
  const categoryId = String(data.categoryId ?? before?.categoryId ?? '')
  if (!type || !categoryId) return
  if (before && type === before.type && categoryId === before.categoryId) return

  // Filed somewhere new: it has to be a category in use, under one of the three.
  // A switched-off sub-category (Cotton, folded into Fabric) takes no items.
  if (!before || categoryId !== before.categoryId) {
    const c = await prisma.itemCategory.findUnique({
      where: { id: categoryId },
      select: { name: true, isActive: true, parent: { select: { name: true, parentId: true } } },
    })
    if (c && (!c.isActive || c.parent?.parentId)) {
      throw new ZodError([
        {
          code: 'custom',
          path: ['categoryId'],
          message: c.parent?.parentId
            ? `${c.name} was folded into ${c.parent.name}. File the item under ${c.parent.name}.`
            : `${c.name} is switched off. Pick a subcategory in use, or switch ${c.name} on again first.`,
        },
      ])
    }
  }

  const found = await groupOfCategory(categoryId)
  if (!found || typeFitsGroup(type, found.group)) return
  throw new ZodError([
    { code: 'custom', path: ['type'], message: typeMismatchMessage(type, found.name, found.group) },
  ])
}

/**
 * A category's tab on save. A sub-category takes its main category's, whatever
 * was sent. A main category takes what was picked, or one from its name. When a
 * main category's tab changes, or a sub-category moves under another main, every
 * item under it has to fit the new tab; its sub-categories follow it.
 */
export async function categoryGroupOnSave(data: Record<string, unknown>, before?: Record<string, unknown>) {
  const parentId = (data.parentId !== undefined ? data.parentId : before?.parentId) as string | null | undefined
  // A new main category, or a sub-category made into one, has to be one of the three.
  const becomingMain = !parentId && (!before || before.parentId)
  const name = String(data.name ?? before?.name ?? '')
  if (becomingMain && !mainNameAllowed(name)) {
    throw new ZodError([
      {
        code: 'custom',
        path: ['parentId'],
        message: `Items & Products has three categories: ${MAIN_CATEGORIES.join(', ')}. Pick the one ${name || 'this'} goes under.`,
      },
    ])
  }
  let group: ItemGroup
  if (parentId) {
    const parent = await prisma.itemCategory.findUnique({ where: { id: parentId }, select: { itemGroup: true } })
    group = (parent?.itemGroup ?? 'RAW_MATERIALS') as ItemGroup
  } else if (data.itemGroup) {
    group = data.itemGroup as ItemGroup
  } else if (before?.itemGroup) {
    group = before.itemGroup as ItemGroup
  } else {
    group = defaultGroupForName(String(data.name ?? before?.name ?? ''))
  }

  if (before?.id && group !== before.itemGroup) {
    const id = String(before.id)
    const items = await prisma.item.groupBy({
      by: ['type'],
      where: { OR: [{ categoryId: id }, { category: { parentId: id } }] },
      _count: { _all: true },
    })
    const misfits = items.filter((r) => !typeFitsGroup(r.type, group))
    if (misfits.length) {
      const n = misfits.reduce((s, r) => s + r._count._all, 0)
      const what = misfits.map((r) => TYPE_LABEL[r.type] ?? r.type).join(' and ')
      throw new ZodError([
        {
          code: 'custom',
          path: [parentId ? 'parentId' : 'itemGroup'],
          message: `${n} ${what} ${n === 1 ? 'item is' : 'items are'} filed here, and ${
            ITEM_GROUP_LABEL[group]
          } cannot take ${n === 1 ? 'it' : 'them'}. Move ${n === 1 ? 'it' : 'them'} first.`,
        },
      ])
    }
    if (!parentId) {
      await prisma.itemCategory.updateMany({ where: { parentId: id }, data: { itemGroup: group } })
    }
  }
  return { ...data, itemGroup: group }
}

/**
 * Where each department falls on the floor, worked out from the routings: its
 * average place along the routes it is on, 0 at the start and 1 at the end. A
 * department on no routing comes after the rest. Kept from the data rather than
 * a fixed list, so a new process finds its own place.
 */
export async function processRanks() {
  const steps = await prisma.routingStep.findMany({
    where: { routing: { isActive: true } },
    select: { routingId: true, sequence: true, departmentId: true },
    orderBy: [{ routingId: 'asc' }, { sequence: 'asc' }],
  })
  const byRouting = new Map<string, string[]>()
  for (const s of steps) {
    const list = byRouting.get(s.routingId) ?? []
    list.push(s.departmentId)
    byRouting.set(s.routingId, list)
  }
  const sum = new Map<string, { total: number; n: number }>()
  for (const depts of byRouting.values()) {
    depts.forEach((d, i) => {
      const at = depts.length > 1 ? i / (depts.length - 1) : 0
      const s = sum.get(d) ?? { total: 0, n: 0 }
      s.total += at
      s.n += 1
      sum.set(d, s)
    })
  }
  return new Map([...sum].map(([d, s]) => [d, s.total / s.n]))
}

interface Process {
  id: string
  name: string
}

/**
 * Everything the tabs need, in one read: how many items each tab holds, and
 * each tab's categories in the order the floor uses them, with the process
 * each is for and the sub-categories under it, counted.
 */
export async function itemGroupTree(opts: { activeOnly: boolean }) {
  const [categories, counts, ranks] = await Promise.all([
    prisma.itemCategory.findMany({
      select: {
        id: true,
        name: true,
        parentId: true,
        itemGroup: true,
        isActive: true,
        department: { select: { id: true, name: true } },
      },
    }),
    prisma.item.groupBy({
      by: ['categoryId'],
      where: opts.activeOnly ? { isActive: true } : {},
      _count: { _all: true },
    }),
    processRanks(),
  ])
  const countOf = new Map(counts.map((c) => [c.categoryId, c._count._all]))
  const rankOf = (p: Process | null) => (p ? (ranks.get(p.id) ?? 2) : 3)
  const byRank = <T extends { rank: number; name: string }>(a: T, b: T) => a.rank - b.rank || a.name.localeCompare(b.name)

  const mains = categories
    .filter((c) => !c.parentId)
    .map((m) => {
      const subs = categories
        .filter((s) => s.parentId === m.id)
        .map((s) => ({
          id: s.id,
          name: s.name,
          isActive: s.isActive,
          process: s.department ?? m.department ?? null,
          count: countOf.get(s.id) ?? 0,
        }))
        .filter((s) => s.isActive || s.count > 0)
        .map((s) => ({ ...s, rank: rankOf(s.process) }))
        .sort(byRank)
      const direct = countOf.get(m.id) ?? 0
      const total = direct + subs.reduce((n, s) => n + s.count, 0)

      // The category's process: the one most of its items are for, else most
      // of its sub-categories, else its own.
      const weight = new Map<string, { p: Process; items: number; subs: number }>()
      for (const s of subs) {
        if (!s.process) continue
        const w = weight.get(s.process.id) ?? { p: s.process, items: 0, subs: 0 }
        w.items += s.count
        w.subs += 1
        weight.set(s.process.id, w)
      }
      const lead = [...weight.values()].sort((a, b) => b.items - a.items || b.subs - a.subs)[0]
      const process = lead?.p ?? m.department ?? null
      const processes = [...weight.values()]
        .map((w) => ({ ...w.p, rank: rankOf(w.p) }))
        .sort(byRank)
        .map(({ id, name }) => ({ id, name }))

      return {
        id: m.id,
        name: m.name,
        itemGroup: m.itemGroup as ItemGroup,
        isActive: m.isActive,
        process,
        processes: processes.length ? processes : process ? [process] : [],
        rank: rankOf(process),
        direct,
        total,
        subs: subs.map(({ rank: _rank, ...s }) => s),
      }
    })
    .filter((m) => m.isActive || m.total > 0)
    .sort(byRank)

  const groups = ITEM_GROUP_TABS.map((group) => {
    const list = mains.filter((m) => m.itemGroup === group)
    return {
      group,
      label: ITEM_GROUP_LABEL[group],
      count: list.reduce((n, m) => n + m.total, 0),
      categories: list.map(({ rank: _rank, ...m }) => m),
    }
  })
  return { groups }
}
