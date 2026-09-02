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
 * The exceptions are the masters where the code IS the information: a size's
 * code is "40", and a style's code says which brand, garment and season it
 * belongs to. Those are still typed, and this is never called for them.
 */

/** Which prefix each register uses. Matches what is already in the data. */
const PREFIX: Record<string, string> = {
  customer: 'CUS',
  supplier: 'SUP',
  broker: 'BRK',
  warehouse: 'WH',
  workstation: 'WS',
  item: 'ITM',
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
async function itemPrefix(categoryId: unknown): Promise<string> {
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
export async function nextMasterCode(
  model: string,
  data: Record<string, unknown> = {},
  attempt = 0,
): Promise<string> {
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
export const isGeneratedCode = (model: string): boolean => model in PREFIX

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
