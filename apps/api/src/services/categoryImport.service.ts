import ExcelJS from 'exceljs'
import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'
import { addDropdowns, addHowToSheet, addTemplateSheet, readSheetRows, type SheetColumn } from '../lib/sheet'

/**
 * Item categories from a spreadsheet.
 *
 * A row names a main category, and optionally a sub-category under it and the
 * department that uses what is filed there. Each row can make a main category,
 * a sub-category (and its main category, if that is new too), or set a
 * category's department. Nothing else: it never touches an item. An item keeps
 * the department it has even when its category's department changes, because
 * that is the item's own record; the category's is only where a new item
 * starts.
 *
 * As with items: checked first and shown row by row, then all or nothing.
 */

export const MAX_ROWS = 1000

type Key = 'category' | 'subCategory' | 'department'
type Raw = Partial<Record<Key, string>>

const COLUMNS: SheetColumn<Key>[] = [
  { key: 'category', head: 'Category *', width: 26, list: 'categories', note: 'A main category: an existing one from the list, or a new name.' },
  { key: 'subCategory', head: 'Sub Category', width: 26, note: 'Leave empty to add (or set the department of) the main category itself.' },
  { key: 'department', head: 'Department', width: 22, list: 'departments', note: 'Who normally uses what is filed here. A new item in the category starts with it.' },
]

const low = (s?: string | null) => (s ?? '').trim().toLowerCase()

async function loadMasters() {
  const [categories, departments] = await Promise.all([
    prisma.itemCategory.findMany({
      select: { id: true, name: true, parentId: true, isActive: true, departmentId: true },
    }),
    prisma.department.findMany({ where: { isActive: true }, select: { id: true, name: true, code: true } }),
  ])
  return { categories, departments }
}

/** The template, optionally listing every active category with its department. */
export async function buildTemplate(withCurrent: boolean): Promise<Buffer> {
  const m = await loadMasters()
  const wb = new ExcelJS.Workbook()
  wb.creator = 'LD ERP'
  const sheet = addTemplateSheet(wb, 'Categories', COLUMNS)
  const deptName = new Map(m.departments.map((d) => [d.id, d.name]))
  const active = m.categories.filter((c) => c.isActive)
  const mains = active.filter((c) => !c.parentId).sort((a, b) => a.name.localeCompare(b.name))

  if (withCurrent) {
    for (const main of mains) {
      sheet.addRow({ category: main.name, subCategory: '', department: deptName.get(main.departmentId ?? '') ?? '' })
      for (const sub of active.filter((c) => c.parentId === main.id).sort((a, b) => a.name.localeCompare(b.name))) {
        sheet.addRow({ category: main.name, subCategory: sub.name, department: deptName.get(sub.departmentId ?? '') ?? '' })
      }
    }
  }

  addDropdowns(
    wb,
    sheet,
    COLUMNS,
    {
      categories: mains.map((c) => c.name),
      departments: m.departments.map((d) => d.name).sort(),
    },
    MAX_ROWS,
  )
  addHowToSheet(wb, [
    'One row per category. Category is the main category; Sub Category, if given, goes under it.',
    'A new main category: its name in Category, Sub Category empty. A new sub-category: its main category in Category, its name in Sub Category. A new main category named on a sub-category row is made too.',
    'Department is optional. It is who normally uses what is filed there; a new item in the category starts with it.',
    'A category already in the system is not renamed or moved. If the row gives it a different department, the department is changed.',
    'Items are never touched. An item keeps its own department even if its category’s changes.',
    'Names are unique across all categories, ignoring capitals: the same name cannot be a sub-category in two places.',
    'Nothing is saved until you have seen what each row will do and pressed Import. If any row has a problem, nothing is imported.',
  ])
  return Buffer.from(await wb.xlsx.writeBuffer())
}

export function readSheet(file: Buffer, fileName: string) {
  return readSheetRows(file, fileName, {
    columns: COLUMNS,
    sheetName: 'Categories',
    mustHave: 'category',
    mustHaveLabel: 'Category',
    maxRows: MAX_ROWS,
  })
}

export interface CategoryRowPlan {
  row: number
  category: string
  subCategory: string | null
  department: string | null
  /** What the row does: a new main, a new sub-category, a department set, or nothing. */
  action: 'new-main' | 'new-sub' | 'set-department' | 'none'
  /** Also makes its main category, named here for the first time. */
  alsoMain: boolean
  skipped: boolean
  problems: string[]
}

interface Resolved {
  plan: CategoryRowPlan
  /** Keys: `id:<existing>` or `new:<lower name>`. */
  mainKey?: string
  targetKey?: string
  newMain?: { name: string; departmentId: string | null }
  newSub?: { name: string; departmentId: string | null }
  setDepartment?: { id: string; departmentId: string }
}

/** Checks every row against the categories and against each other. Writes nothing. */
export async function planImport(rows: Array<{ row: number; raw: Raw }>): Promise<Resolved[]> {
  const m = await loadMasters()
  const byName = new Map(m.categories.map((c) => [low(c.name), c]))
  const byId = new Map(m.categories.map((c) => [c.id, c]))
  const dept = new Map(m.departments.flatMap((d) => [[low(d.name), d], [low(d.code), d]] as const))

  // Names this sheet makes, with where they go and what will be created for
  // them, and the department each row gives each category, so two rows
  // cannot disagree.
  const newNames = new Map<string, { parent: string | null; row: number; made: { departmentId: string | null } }>()
  const deptGiven = new Map<string, { id: string; row: number }>()
  const out: Resolved[] = []

  for (const { row, raw } of rows) {
    const problems: string[] = []
    const mainName = (raw.category ?? '').trim()
    const subName = (raw.subCategory ?? '').trim() || null
    const plan: CategoryRowPlan = {
      row,
      category: mainName,
      subCategory: subName,
      department: raw.department?.trim() || null,
      action: 'none',
      alsoMain: false,
      skipped: false,
      problems,
    }
    const res: Resolved = { plan }
    out.push(res)

    if (!mainName) {
      problems.push('Category is empty.')
      continue
    }

    const d = raw.department ? dept.get(low(raw.department)) : undefined
    if (raw.department && !d) problems.push(`No department "${raw.department}".`)

    // The main category: one already there, or one this sheet makes.
    const main = byName.get(low(mainName))
    if (main?.parentId) {
      problems.push(`${main.name} is a sub-category of ${byId.get(main.parentId)?.name ?? 'another category'}, so it cannot be a main category. Put ${byId.get(main.parentId)?.name ?? 'its main category'} in Category.`)
      continue
    }
    if (main && !main.isActive) {
      problems.push(`${main.name} is deactivated. Reactivate it on the Item Categories screen first.`)
      continue
    }
    const sheetMain = newNames.get(low(mainName))
    if (!main && sheetMain && sheetMain.parent !== null) {
      problems.push(`Row ${sheetMain.row} makes ${mainName} a sub-category, so it cannot also be a main category.`)
      continue
    }
    res.mainKey = main ? `id:${main.id}` : `new:${low(mainName)}`
    const mainIsNew = !main && !sheetMain

    if (!subName) {
      // The row is about the main category itself.
      res.targetKey = res.mainKey
      if (mainIsNew) {
        res.newMain = { name: mainName, departmentId: null }
        newNames.set(low(mainName), { parent: null, row, made: res.newMain })
        plan.action = 'new-main'
      }
    } else {
      const sub = byName.get(low(subName))
      const sheetSub = newNames.get(low(subName))
      if (sub) {
        if (!sub.parentId) {
          problems.push(`${sub.name} is a main category, so it cannot go under ${mainName}.`)
          continue
        }
        if (!main || sub.parentId !== main.id) {
          problems.push(`${sub.name} already exists under ${byId.get(sub.parentId)?.name}. Names are unique across all categories.`)
          continue
        }
        if (!sub.isActive) {
          problems.push(`${sub.name} is deactivated. Reactivate it on the Item Categories screen first.`)
          continue
        }
        res.targetKey = `id:${sub.id}`
      } else if (sheetSub) {
        if (sheetSub.parent !== low(mainName)) {
          problems.push(`Row ${sheetSub.row} already puts ${subName} under another category.`)
          continue
        }
        res.targetKey = `new:${low(subName)}`
      } else {
        if (low(subName) === low(mainName)) {
          problems.push('A sub-category cannot have the same name as its main category.')
          continue
        }
        res.targetKey = `new:${low(subName)}`
        res.newSub = { name: subName, departmentId: null }
        newNames.set(low(subName), { parent: low(mainName), row, made: res.newSub })
        plan.action = 'new-sub'
        if (mainIsNew) {
          res.newMain = { name: mainName, departmentId: null }
          newNames.set(low(mainName), { parent: null, row, made: res.newMain })
          plan.alsoMain = true
        }
      }
    }

    // The department, on the category the row is about.
    if (d && res.targetKey) {
      const earlier = deptGiven.get(res.targetKey)
      if (earlier && earlier.id !== d.id) {
        // Two rows giving one category different departments: neither wins.
        problems.push(`Row ${earlier.row} gives ${subName ?? mainName} a different department.`)
      } else if (!earlier) {
        deptGiven.set(res.targetKey, { id: d.id, row })
        const made = newNames.get(low(subName ?? mainName))?.made
        if (res.targetKey.startsWith('new:') && made) {
          // Made by this sheet, on this row or an earlier one.
          made.departmentId = d.id
          if (plan.action === 'none') plan.action = 'set-department'
        } else {
          const existing = byId.get(res.targetKey.slice(3))
          if (existing && existing.departmentId !== d.id) {
            res.setDepartment = { id: existing.id, departmentId: d.id }
            plan.action = 'set-department'
          }
        }
      }
    }

    if (plan.action === 'none' && problems.length === 0) plan.skipped = true
  }
  return out
}

/** Makes the new categories and sets departments, in one transaction. Items are not touched. */
export async function runImport(plans: Resolved[]) {
  if (plans.some((p) => p.plan.problems.length > 0)) {
    throw new AppError('Some rows have problems. Fix them and upload the sheet again.', 400, 'IMPORT_HAS_PROBLEMS')
  }
  return prisma.$transaction(
    async (tx) => {
      const idOf = new Map<string, string>()
      const made: string[] = []
      let mains = 0
      // Main categories first, so their sub-categories have somewhere to go.
      for (const p of plans) {
        if (!p.newMain || !p.mainKey || idOf.has(p.mainKey)) continue
        const c = await tx.itemCategory.create({
          data: { name: p.newMain.name, departmentId: p.newMain.departmentId },
          select: { id: true, name: true },
        })
        idOf.set(p.mainKey, c.id)
        made.push(c.name)
        mains += 1
      }
      for (const p of plans) {
        if (!p.newSub || !p.mainKey || !p.targetKey) continue
        const parentId = p.mainKey.startsWith('id:') ? p.mainKey.slice(3) : idOf.get(p.mainKey)!
        const c = await tx.itemCategory.create({
          data: { name: p.newSub.name, parentId, departmentId: p.newSub.departmentId },
          select: { id: true, name: true },
        })
        idOf.set(p.targetKey, c.id)
        made.push(c.name)
      }
      let departmentsSet = 0
      for (const p of plans) {
        if (!p.setDepartment) continue
        await tx.itemCategory.update({
          where: { id: p.setDepartment.id },
          data: { departmentId: p.setDepartment.departmentId },
        })
        departmentsSet += 1
      }
      return { made, mains, subs: made.length - mains, departmentsSet }
    },
    { timeout: 120_000, maxWait: 20_000 },
  )
}
