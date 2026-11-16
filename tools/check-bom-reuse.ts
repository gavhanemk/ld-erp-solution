import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { prisma } from '../packages/database/src/index'
import { compareBomLines, type BomComparableLine } from '../packages/shared/src/index'
const requireApi = createRequire(new URL('../apps/api/package.json', import.meta.url))
const jwt = requireApi('jsonwebtoken')
let count = 0
const check = (name: string, fn: () => void) => {
  fn()
  count++
  console.log(`PASS ${name}`)
}
const row = (id: string, qty = 1): BomComparableLine => ({
  componentItemId: id,
  qtyPerUnit: qty,
  unitCost: 10,
  departmentId: 'cut',
})
async function main() {
  check('exact comparison ignores ordering and preserves repeated item counts', () => {
    assert.ok(compareBomLines([row('a'), row('a', 2)], [row('a', 2), row('a')]).exact)
    assert.ok(!compareBomLines([row('a'), row('a')], [row('a')]).exact)
  })
  check('shared buttons alone and radically different quantities do not trigger similarity', () => {
    assert.ok(
      !compareBomLines([row('button'), row('fabric')], [row('button'), row('other')]).similar
    )
    assert.ok(!compareBomLines([row('a'), row('b')], [row('a', 10), row('b', 10)]).similar)
  })
  check('partial matches retain added, removed, modified and unchanged details', () => {
    const c = compareBomLines(
      [row('a'), row('b'), row('c', 1.1), row('new')],
      [row('a'), row('b'), row('c'), row('old')]
    )
    assert.ok(c.similar)
    assert.deepEqual(
      new Set(c.rows.map((r) => r.kind)),
      new Set(['unchanged', 'modified', 'added', 'removed'])
    )
  })
  check('process, rate, wastage and size changes are never called exact', () => {
    const c = compareBomLines(
      [
        {
          ...row('a'),
          departmentId: 'sew',
          unitCost: 12,
          wastagePercent: 2,
          sizes: [{ sizeId: 'XL', qtyPerUnit: 2 }],
        },
      ],
      [row('a')]
    )
    assert.deepEqual(c.rows[0].changes, ['Process', 'Wastage', 'Rate', 'Size quantities'])
  })
  if (!process.env.BOM_TEST_DB) {
    console.log(`${count} checks passed`)
    return
  }
  const url = new URL(process.env.DATABASE_URL!)
  assert.equal(url.hostname, 'localhost')
  assert.equal(url.port, '5433')
  assert.equal(url.pathname, '/lderp_charge_test_20261114')
  const admin = await prisma.user.findFirstOrThrow({ where: { role: { name: 'Admin' } } })
  const token = jwt.sign(
    { id: admin.id, email: admin.email, name: admin.name, role: 'Admin', roleId: admin.roleId },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' }
  )
  type ResponseBom = {
    id: string
    status: string
    copiedFromId: string
    totalCost: string
    costPerPiece: string
    notes: string
    version: string
    lines: Array<{ id: string; componentItemId: string; qtyPerUnit: string; unitCost: string }>
  }
  async function api<T>(path: string, body?: unknown, method = 'POST', auth = token): Promise<T> {
    const r = await fetch(`http://localhost:5127/api/masters${path}`, {
      method,
      headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const j = (await r.json()) as { data: T; message?: string }
    if (!r.ok) throw new Error(`${r.status}: ${j.message}`)
    return j.data
  }
  const source = await prisma.bOM.findFirstOrThrow({
    // A colour is needed: a new version of a colourless BOM on a style with colours is refused.
    where: { status: 'APPROVED', lines: { some: {} }, color: { not: null } },
    include: { style: true, lines: { include: { sizes: true } }, costLines: true },
  })
  const sourceBefore = JSON.stringify(source)
  const stamp = Date.now()
  const target = await prisma.style.create({
    data: {
      code: `BOM-REUSE-${stamp}`,
      name: 'BOM reuse test',
      brandType: source.style.brandType,
      sizeGroupId: source.style.sizeGroupId,
      colors: ['Test colour'],
    },
  })
  const lines = source.lines.map((l) => ({
    componentItemId: l.componentItemId,
    component: l.component,
    departmentId: l.departmentId,
    qtyPerUnit: Number(l.qtyPerUnit),
    unitCost: l.unitCost == null ? undefined : Number(l.unitCost),
    wastagePercent: Number(l.wastagePercent),
    notes: l.notes,
    sizes: l.sizes.map((s) => ({ sizeId: s.sizeId, qtyPerUnit: Number(s.qtyPerUnit) })),
  }))
  const payload = {
    styleId: target.id,
    color: 'Test colour',
    copiedFromId: source.id,
    notes: source.notes,
    lines,
  }
  const created = await api<ResponseBom>('/bom', payload)
  check('cross-style copy creates an independent draft with source trace and saved costing', () => {
    assert.notEqual(created.id, source.id)
    assert.equal(created.status, 'DRAFT')
    assert.equal(created.copiedFromId, source.id)
    assert.equal(Number(created.totalCost), Number(source.totalCost))
    assert.equal(Number(created.costPerPiece), Number(source.costPerPiece))
    assert.ok(created.lines.every((l) => !source.lines.some((s) => s.id === l.id)))
  })
  const matches = await api<Array<{ bom: ResponseBom; kind: string }>>('/bom/similar', {
    styleId: target.id,
    color: 'Test colour',
    lines: lines.map((l) => ({ ...l, unitCost: l.unitCost ?? null })),
  })
  check('similarity endpoint finds exact target and identical components on another style', () => {
    assert.ok(matches.some((m) => m.bom.id === created.id && m.kind === 'EXACT'))
    assert.ok(matches.some((m) => m.bom.id === source.id && m.kind === 'IDENTICAL_COMPONENTS'))
  })
  const changed = await api<ResponseBom>(
    `/bom/${created.id}`,
    { lines: lines.map((l, i) => ({ ...l, qtyPerUnit: l.qtyPerUnit + (i === 0 ? 1 : 0) })) },
    'PATCH'
  )
  check('editing copy changes its own quantities', () =>
    assert.equal(Number(changed.lines[0].qtyPerUnit), lines[0].qtyPerUnit + 1)
  )
  const after = await prisma.bOM.findUniqueOrThrow({
    where: { id: source.id },
    include: { style: true, lines: { include: { sizes: true } }, costLines: true },
  })
  check('approved source remains unchanged and active', () =>
    assert.equal(JSON.stringify(after), sourceBefore)
  )
  const versions = await Promise.all([
    api<ResponseBom>('/bom', payload),
    api<ResponseBom>('/bom', payload),
  ])
  check('concurrent saves allocate distinct versions without overwriting', () =>
    assert.notEqual(versions[0].version, versions[1].version)
  )
  const references = await prisma.mOLine.findMany({
    select: { id: true, bomId: true },
    orderBy: { id: 'asc' },
  })
  const next = await api<ResponseBom>('/bom', {
    ...payload,
    styleId: source.styleId,
    color: source.color,
  })
  check('new version remains draft while previous approval remains active', () =>
    assert.equal(next.status, 'DRAFT')
  )
  assert.equal(
    (await prisma.bOM.findUniqueOrThrow({ where: { id: source.id } })).status,
    'APPROVED'
  )
  await api(`/bom/${next.id}/approve`, {}, 'PATCH')
  const referencesAfter = await prisma.mOLine.findMany({
    select: { id: true, bomId: true },
    orderBy: { id: 'asc' },
  })
  check('approval of copied version preserves manufacturing-order BOM references', () =>
    assert.deepEqual(referencesAfter, references)
  )
  const groups = await Promise.all(
    ['A', 'B'].map((suffix) =>
      prisma.sizeGroup.create({
        data: {
          name: `Reuse sizes ${stamp}-${suffix}`,
          sizes: { create: [{ code: 'M', label: 'Medium' }] },
        },
        include: { sizes: true },
      })
    )
  )
  const sizeStyles = await Promise.all(
    groups.map((g, i) =>
      prisma.style.create({
        data: {
          code: `REUSE-SIZE-${stamp}-${i}`,
          name: 'Size copy test',
          brandType: source.style.brandType,
          sizeGroupId: g.id,
          colors: ['Blue'],
        },
      })
    )
  )
  const sizedLine = { ...lines[0], sizes: [{ sizeId: groups[0].sizes[0].id, qtyPerUnit: 2 }] }
  const sizedSource = await api<ResponseBom>('/bom', {
    styleId: sizeStyles[0].id,
    color: 'Blue',
    baseSizeId: groups[0].sizes[0].id,
    lines: [sizedLine],
  })
  const sizedCopy = await api<ResponseBom>('/bom', {
    styleId: sizeStyles[1].id,
    color: 'Blue',
    copiedFromId: sizedSource.id,
    lines: [sizedLine],
  })
  const sizedSaved = await prisma.bOM.findUniqueOrThrow({
    where: { id: sizedCopy.id },
    include: { lines: { include: { sizes: true } } },
  })
  check('cross-style size mapping retains quantities using matching size codes', () => {
    assert.equal(sizedSaved.baseSizeId, groups[1].sizes[0].id)
    assert.equal(sizedSaved.lines[0].sizes[0].sizeId, groups[1].sizes[0].id)
    assert.equal(Number(sizedSaved.lines[0].sizes[0].qtyPerUnit), 2)
  })
  await prisma.size.update({ where: { id: groups[1].sizes[0].id }, data: { code: 'XL' } })
  await assert.rejects(
    () =>
      api('/bom', {
        styleId: sizeStyles[1].id,
        color: 'Blue',
        copiedFromId: sizedSource.id,
        lines: [sizedLine],
      }),
    /matching size/
  )
  check('incompatible size runs are rejected without dropping quantities', () => {})
  const clerk = jwt.sign(
    {
      id: admin.id,
      role: 'Clerk',
      permissions: ['masters:view', 'masters:create'],
      roleId: admin.roleId,
    },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' }
  )
  const visible = await api<Array<{ bom: Record<string, unknown> }>>(
    '/bom/similar',
    { styleId: target.id, color: 'Test colour', lines: [] },
    'POST',
    clerk
  )
  check('similarity results respect costing permissions', () =>
    assert.ok(
      visible.every(
        (m) => !('costLines' in m.bom) && !('sellingPrice' in m.bom) && !('costPerPiece' in m.bom)
      )
    )
  )
  await assert.rejects(
    () =>
      api(
        '/bom',
        { ...payload, costLines: [{ kind: 'LABOUR', name: 'Restricted', value: 1 }] },
        'POST',
        clerk
      ),
    /403/
  )
  check('copy flow cannot bypass costing-write permissions', () => {})
  console.log(`${count} checks passed`)
}
main()
  .catch((e) => {
    console.error(e.message)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
