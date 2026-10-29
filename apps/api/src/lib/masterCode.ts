import { prisma } from '@ld-erp/database'

/**
 * Makes up the short code a master record is known by.
 *
 * A code is a handle, not information. Nobody at a cutting table decides that
 * a customer should be CUS-017 rather than CUS-018 — it just has to be short,
 * unique, and the same every time it is quoted. Asking a person to invent one
 * on a form is asking them to do the computer's job, and it is how a register
 * ends up with CUST-1, Cust001 and C-1 all meaning different firms.
 *
 * So the forms no longer ask. This fills it in.
 *
 * The exception is a size, whose code IS the information ("40"): that is
 * still typed. A style's code says which brand, garment and season it belongs
 * to, so it is made from those (see nextStyleCode) rather than numbered.
 */

/** Which prefix each register uses. Matches what is already in the data. */
const PREFIX: Record<string, string> = {
  customer: 'CUS',
  supplier: 'SUP',
  broker: 'BRK',
  warehouse: 'WH',
  workstation: 'WS',
  item: 'ITM',
  contractor: 'CON',
}

/**
 * How many attempts before giving up.
 *
 * Two people saving at the same instant can both read the same highest number.
 * The database's unique constraint catches the second one, and it simply tries
 * again with the next number — which is why the caller has to be able to retry.
 * Five is far more than a mill will ever need; it is a guard against a loop,
 * not a serious expectation of contention.
 */
export const CODE_ATTEMPTS = 5

/**
 * Items keep the prefix their category already uses.
 *
 * A store keeper searching for "FAB" expects fabric, and the existing register
 * is full of FAB-, THR-, BTN-. Generating ITM-041 for a cotton poplin would be
 * unique and correct and would still make the list harder to read, so the
 * category's own name decides the prefix.
 */
export async function itemPrefix(categoryId: unknown): Promise<string> {
  if (typeof categoryId !== 'string' || !categoryId) return PREFIX.item

  const category = await prisma.itemCategory.findUnique({
    where: { id: categoryId },
    select: { name: true },
  })
  if (!category) return PREFIX.item

  // "Buttons & Fasteners" → BUT, "Packing Material" → PAC, "Fabric" → FAB.
  const letters = category.name.replace(/[^A-Za-z]/g, '').toUpperCase()
  return letters.length >= 3 ? letters.slice(0, 3) : PREFIX.item
}

/**
 * The next free code for a register, as prefix + a three-digit number.
 *
 * The number is one past the highest already in use with that prefix, read
 * from the codes themselves rather than from a counter. A counter would be
 * faster and would also drift the first time somebody imports a spreadsheet or
 * deletes a row, and then two records would fight over one code.
 *
 * `attempt` walks past a number that has just been taken by somebody else.
 */
/**
 * A department's code is short and says which department: CUT, STI, PKG,
 * CUTQC. That is what the mill's own list already looks like, so a new one is
 * made the same way from its name: the first three letters of the first word,
 * then any short word after it whole ("QC") and the first letter of any long
 * one. "Printing QC" → PRIQC. If that is taken, a number goes on the end.
 */
async function nextDepartmentCode(name: unknown, attempt: number): Promise<string> {
  const words = String(name ?? '')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
  const base =
    (words[0]?.slice(0, 3) ?? '') + words.slice(1).map((w) => (w.length <= 3 ? w : w[0])).join('')
  const stem = (base || 'DEP').slice(0, 10)

  const taken = new Set(
    (
      await prisma.department.findMany({
        where: { code: { startsWith: stem } },
        select: { code: true },
      })
    ).map((d) => d.code),
  )
  let n = 1 + attempt
  let code = n === 1 ? stem : `${stem}${n}`
  while (taken.has(code)) {
    n += 1
    code = `${stem}${n}`
  }
  return code
}

/** The brand part of a style code by kind, for a style with no brand picked: LD-, VH-. */
const STYLE_BRAND: Record<string, string> = { LD_COTTON_MILLS: 'LD', VHAGAR: 'VH', CUSTOM: 'CU' }

/**
 * The brand part of a style code, from the brand's own name, so the codes
 * the mill already has keep reading the same: "LD Cotton Mills" → LD (a short
 * first word is kept whole), "VHAGAR" → VH, "DCot" → DC (otherwise the first
 * two letters).
 */
export function brandCode(name: unknown, type?: unknown): string {
  const words = String(name ?? '')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
  if (!words.length) return STYLE_BRAND[String(type)] ?? 'LD'
  if (words.length > 1 && words[0].length <= 3) return words[0]
  return words[0].slice(0, 2)
}

/**
 * The garment part: SH for a shirt, TR for a trouser, as in LD-SH-2604 and
 * LD-TR-2602. The garment type is typed freely, so "Shirts", "shirt" and
 * "SHIRT" all read the same; a type not listed takes its first letter and
 * the next consonant (Kurta → KR), and no type at all is GN.
 */
const GARMENT: Record<string, string> = {
  shirt: 'SH',
  trouser: 'TR',
  pant: 'TR',
  chino: 'TR',
  tshirt: 'TS',
  tee: 'TS',
  polo: 'PL',
  jean: 'JN',
  denim: 'JN',
  short: 'SO',
  kurta: 'KR',
  jacket: 'JK',
  blazer: 'BZ',
  waistcoat: 'WC',
  trackpant: 'TP',
  jogger: 'JG',
  pyjama: 'PJ',
  pajama: 'PJ',
  boxer: 'BX',
  vest: 'VS',
}
export function garmentCode(type: unknown): string {
  let word = String(type ?? '').toLowerCase().replace(/[^a-z]/g, '')
  if (!word) return 'GN'
  if (word.endsWith('s') && word.length > 3) word = word.slice(0, -1)
  if (GARMENT[word]) return GARMENT[word]
  const first = word[0].toUpperCase()
  const next = word.slice(1).match(/[bcdfghjklmnpqrstvwxyz]/)?.[0] ?? word[1] ?? 'X'
  return first + next.toUpperCase()
}

/**
 * The year part: the season's year — SS-26 and AW-26 are 26 — or, with no
 * season typed, this year (in India).
 */
export function seasonYear(season: unknown, now = new Date()): string {
  const digits = String(season ?? '').match(/(\d{4}|\d{2})(?!.*\d)/)?.[1]
  if (digits) return digits.slice(-2)
  return new Date(now.getTime() + 5.5 * 3600 * 1000).getUTCFullYear().toString().slice(-2)
}

/**
 * A style's code: brand, garment, year, then the next number for those three
 * — LD-SH-2601 to LD-SH-2605 are taken, so the next LD Cotton Mills shirt for
 * a 26 season is LD-SH-2606. Read from the codes already there, like every
 * other code here, so an imported style counts too. The database keeps codes
 * unique; `attempt` steps past one somebody else has just taken.
 */
export async function nextStyleCode(data: Record<string, unknown>, attempt = 0): Promise<string> {
  const brand =
    typeof data.brandId === 'string' && data.brandId
      ? await prisma.brand.findUnique({ where: { id: data.brandId }, select: { name: true, type: true } })
      : null
  const prefix = brand ? brandCode(brand.name, brand.type) : (STYLE_BRAND[String(data.brandType)] ?? 'LD')
  const stem = `${prefix}-${garmentCode(data.category)}-${seasonYear(data.season)}`
  const rows = await prisma.style.findMany({ where: { code: { startsWith: stem } }, select: { code: true } })
  const highest = rows.reduce((max, r) => {
    const tail = r.code.slice(stem.length)
    if (!/^\d+$/.test(tail)) return max
    const n = Number.parseInt(tail, 10)
    return n > max ? n : max
  }, 0)
  // A retry reads the codes again, so the one just taken is already counted:
  // no number is skipped. Only a third try steps further, in case the other
  // save is not yet visible.
  return `${stem}${String(highest + 1 + Math.max(0, attempt - 1)).padStart(2, '0')}`
}

export async function nextMasterCode(
  model: string,
  data: Record<string, unknown> = {},
  attempt = 0,
): Promise<string> {
  if (model === 'department') return nextDepartmentCode(data.name, attempt)
  if (model === 'style') return nextStyleCode(data, attempt)

  const prefix = model === 'item' ? await itemPrefix(data.categoryId) : PREFIX[model]
  if (!prefix) {
    throw new Error(`No code prefix is set up for ${model}`)
  }

  const delegate = prisma[model as 'customer'] as unknown as {
    findMany: (args: unknown) => Promise<Array<{ code: string }>>
  }

  const rows = await delegate.findMany({
    where: { code: { startsWith: `${prefix}-` } },
    select: { code: true },
  })

  const highest = rows.reduce((max, row) => {
    // Only the tail after the last dash counts, so an imported FAB-COT-001
    // still reads as 1 rather than as nothing.
    const tail = row.code.slice(row.code.lastIndexOf('-') + 1)
    const n = Number.parseInt(tail, 10)
    return Number.isFinite(n) && n > max ? n : max
  }, 0)

  return `${prefix}-${String(highest + 1 + attempt).padStart(3, '0')}`
}

/** Whether this register has its codes made up for it. */
export const isGeneratedCode = (model: string): boolean =>
  model in PREFIX || model === 'department' || model === 'style'

/**
 * Saves a record with a generated code, stepping past a number somebody else
 * took first.
 *
 * Only a clash on the code is worth retrying. Any other failure — a bad
 * foreign key, a duplicate GSTIN — is a real problem the person has to see,
 * and quietly retrying it five times would only delay the message.
 */
export async function withGeneratedCode<T>(
  model: string,
  data: Record<string, unknown>,
  save: (data: Record<string, unknown>) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
    const code = await nextMasterCode(model, data, attempt)
    try {
      return await save({ ...data, code })
    } catch (err) {
      if (!isDuplicateCode(err)) throw err
    }
  }

  throw new Error(
    `Could not find a free code for ${model} after ${CODE_ATTEMPTS} tries. Try saving again.`,
  )
}

/** Prisma's unique-constraint error, but only when it is the code that clashed. */
function isDuplicateCode(err: unknown): boolean {
  const e = err as { code?: string; meta?: { target?: unknown } }
  if (e?.code !== 'P2002') return false
  const target = e.meta?.target
  const fields = Array.isArray(target) ? target : typeof target === 'string' ? [target] : []
  return fields.some((f) => String(f).toLowerCase().includes('code'))
}
