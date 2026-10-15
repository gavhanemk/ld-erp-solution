// A size run and its sizes saved in one go, against the running API.
//
// Makes a throwaway run, renames, swaps, adds, reorders and removes its sizes,
// checks what the server refuses (a name or code twice, a size from another
// run, a size a document uses), and deletes the throwaway run at the end. The
// refusal on a size in use is tried on a real run, but it is refused before
// anything is written, and the run is checked to be unchanged afterwards.
//
//   cd apps/api
//   npx tsx ../../tools/check-size-runs.ts            (API on :5400)
//   API=http://localhost:5000/api npx tsx ../../tools/check-size-runs.ts
import { prisma } from '../packages/database/src/index'

const BASE = process.env.API ?? 'http://localhost:5400/api'
let token = ''
let pass = 0
let fail = 0
const check = (label: string, ok: boolean, extra?: unknown) => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`)
}
async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, json: (await res.json().catch(() => null)) as any }
}

type Size = { id: string; code: string; label: string; sequence: number }

async function main() {
  const login = await call('POST', '/auth/login', { email: 'admin@ldcottonmills.com', password: 'Admin@123' })
  token = login.json?.data?.accessToken ?? login.json?.accessToken ?? login.json?.data?.token
  check('sign in', !!token, login.json)
  if (!token) return

  const name = `ZZ size-run check ${Date.now().toString(36)}`
  let runId: string | null = null
  try {
    // A new run with its sizes, positions from the rows, "shown as" from the code.
    const made = await call('POST', '/masters/size-groups/with-sizes', {
      name,
      gender: 'MALE',
      sizes: [{ code: 'S' }, { code: 'M', label: 'Medium' }, { code: 'L' }, { code: '3XL' }],
    })
    runId = made.json?.data?.id ?? null
    const s0: Size[] = made.json?.data?.sizes ?? []
    check('new run saved with its sizes', made.status === 201 && s0.length === 4, made.json)
    check('positions follow the rows', s0.map((s) => `${s.code}${s.sequence}`).join(' ') === 'S1 M2 L3 3XL4', s0)
    check('"shown as" is the code unless typed', s0.map((s) => s.label).join(' ') === 'S Medium L 3XL', s0)
    if (!runId) return
    const id = (c: string) => s0.find((s) => s.code === c)!.id

    // Same name in other letters, a code twice, a size from no run of this one.
    const again = await call('POST', '/masters/size-groups/with-sizes', { name: name.toUpperCase(), sizes: [{ code: 'S' }] })
    check('a second run of the same name is refused', again.status === 409 && again.json?.code === 'DUPLICATE_ENTRY', again.json)
    const twice = await call('PATCH', `/masters/size-groups/${runId}/with-sizes`, { name, sizes: [{ code: 'xl' }, { code: 'XL' }] })
    check('a code twice is refused (any case)', twice.status === 400 && twice.json?.code === 'DUPLICATE_SIZE', twice.json)
    const other = await prisma.size.findFirst({ where: { NOT: { sizeGroupId: runId } }, select: { id: true } })
    if (other) {
      const stray = await call('PATCH', `/masters/size-groups/${runId}/with-sizes`, { name, sizes: [{ id: other.id, code: 'S' }] })
      check("another run's size is refused", stray.status === 409 && stray.json?.code === 'STALE', stray.json)
    }
    const empty = await call('PATCH', `/masters/size-groups/${runId}/with-sizes`, { name, sizes: [] })
    check('a run with no sizes is refused', empty.status === 400, empty.json)

    // Swap S and M (as if typed the wrong way round), add XS and 4XL, drop L,
    // and move 3XL: all in one save, the sizes kept keeping their ids.
    const edit = await call('PATCH', `/masters/size-groups/${runId}/with-sizes`, {
      name,
      gender: 'UNISEX',
      isActive: true,
      sizes: [
        { code: 'XS' },
        { id: id('M'), code: 'S', label: 'S' },
        { id: id('S'), code: 'M', label: 'M' },
        { id: id('3XL'), code: '3XL' },
        { code: '4XL' },
      ],
    })
    const s1: Size[] = edit.json?.data?.sizes ?? []
    check('edited in one save', edit.status === 200, edit.json)
    check('order and codes as the rows', s1.map((s) => `${s.code}${s.sequence}`).join(' ') === 'XS1 S2 M3 3XL4 4XL5', s1)
    check('a swapped size keeps its id', s1.find((s) => s.code === 'S')?.id === id('M') && s1.find((s) => s.code === 'M')?.id === id('S'), s1)
    check('the row taken out is gone', !s1.some((s) => s.id === id('L')), s1)
    check('who it is for saved', edit.json?.data?.gender === 'UNISEX', edit.json?.data)

    const usage = await call('GET', `/masters/size-groups/${runId}/sizes`)
    check('sizes listed with what uses them', usage.status === 200 && usage.json?.data?.length === 5 && usage.json.data.every((s: { uses: number }) => s.uses === 0), usage.json)
  } finally {
    if (runId) await prisma.sizeGroup.delete({ where: { id: runId } })
  }

  // A size an order uses cannot leave its run; nothing in the run changes.
  const used = await prisma.size.findFirst({
    where: { soLineSizes: { some: {} } },
    select: { id: true, code: true, sizeGroupId: true },
  })
  if (used) {
    const run = await prisma.sizeGroup.findUniqueOrThrow({ where: { id: used.sizeGroupId }, include: { sizes: { orderBy: { sequence: 'asc' } } } })
    const res = await call('PATCH', `/masters/size-groups/${run.id}/with-sizes`, {
      name: run.name,
      gender: run.gender,
      isActive: run.isActive,
      sizes: run.sizes.filter((s) => s.id !== used.id).map((s) => ({ id: s.id, code: s.code, label: s.label })),
    })
    check(`${used.code} in ${run.name} is refused: it is on an order`, res.status === 409 && res.json?.code === 'SIZE_IN_USE', res.json)
    console.log(`     ${res.json?.message}`)
    const still = await prisma.size.findMany({ where: { sizeGroupId: run.id }, orderBy: { sequence: 'asc' } })
    check(`${run.name} unchanged`, JSON.stringify(still) === JSON.stringify(run.sizes))
    const u = await call('GET', `/masters/size-groups/${run.id}/sizes`)
    const row = (u.json?.data ?? []).find((s: { id: string }) => s.id === used.id)
    check('the form is told what uses it', row?.uses > 0 && /sales order line/.test(row?.usedOn ?? ''), row)
  } else console.log('SKIP no size is on an order yet')

  const gone = await prisma.sizeGroup.count({ where: { name } })
  check('the throwaway run is deleted', gone === 0)
  console.log(`\n${pass} passed, ${fail} failed`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
