import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { prisma } from '../packages/database/src/index'
import {
  compareRoutings,
  type ComparableRouting,
  type ComparableRoutingStep,
} from '../packages/shared/src/index'
import { routingInclude, updateRouting } from '../apps/api/src/services/routing.service'
import { updateRoutingSchema } from '../apps/api/src/schemas/master.schemas'
import { similarRoutings } from '../apps/api/src/services/routingSimilarity.service'
import { applyRouting } from '../apps/api/src/services/route.service'
import { trackRoutingSelect } from '../apps/api/src/services/styleTrack.service'

const requireApi = createRequire(new URL('../apps/api/package.json', import.meta.url))
const jwt = requireApi('jsonwebtoken')
let passed = 0
function check(label: string, fn: () => void) {
  fn()
  passed++
  console.log(`PASS ${label}`)
}
const step = (
  operationId: string,
  sequence: number,
  extra: Partial<ComparableRoutingStep> = {}
): ComparableRoutingStep => ({ operationId, sequence, departmentId: 'dept', smv: 10, ...extra })
const route = (
  steps: ComparableRoutingStep[],
  extra: Partial<ComparableRouting> = {}
): ComparableRouting => ({ steps, styleId: 'style', ...extra })
async function main() {
  const original = route([step('cut', 1), step('sew', 2), step('qc', 3), step('pack', 4)])
  check('numeric strings normalize; style names and routing names are not comparison keys', () =>
    assert.ok(
      compareRoutings(original, route(original.steps.map((s) => ({ ...s, smv: '10.000' })))).exact
    )
  )
  check('sequence changes are highlighted even with identical processes', () => {
    const c = compareRoutings(
      route([step('cut', 1), step('qc', 2), step('sew', 3), step('pack', 4)]),
      original
    )
    assert.equal(c.kind, 'SIMILAR')
    assert.ok(c.differences.includes('Sequence'))
    assert.equal(c.unchanged, 2)
  })
  check('all applicable step settings are compared', () => {
    const c = compareRoutings(
      route([
        step('cut', 1, {
          departmentId: 'other',
          workstationId: 'line',
          contractorId: 'person',
          execution: 'OUTSOURCED',
          skip: 'WITH_APPROVAL',
          smv: 12,
          ratePerPiece: 8,
          instructions: 'Check seams',
          isQcStep: true,
        }),
        ...original.steps.slice(1),
      ]),
      original
    )
    assert.equal(c.differences.length, 9)
    assert.equal(c.exact, false)
  })
  check('added and removed processes are partial matches', () => {
    const c = compareRoutings(route([...original.steps.slice(0, 3), step('wash', 4)]), original)
    assert.equal(c.kind, 'PARTIAL')
    assert.ok(c.similar)
    assert.equal(c.matched, 3)
    assert.ok(c.rows.some((r) => r.kind === 'added'))
    assert.ok(c.rows.some((r) => r.kind === 'removed'))
  })
  check('repeated processes match one-to-one and reserve unchanged configurations', () => {
    const c = compareRoutings(
      route([step('sew', 1, { smv: 12 }), step('sew', 2, { smv: 10 })]),
      route([step('sew', 1, { smv: 10 }), step('sew', 2, { smv: 20 })])
    )
    assert.equal(c.matched, 2)
    assert.equal(c.rows[1].existing?.smv, 10)
    assert.equal(
      compareRoutings(route([step('sew', 1), step('sew', 2)]), route([step('sew', 1)])).matched,
      1
    )
  })
  check('different applicability and fabric are never exact', () => {
    const c = compareRoutings(original, {
      ...original,
      styleId: null,
      category: 'Shirt',
      fabricItemId: 'linen',
    })
    assert.deepEqual(c.differences, ['Applicability', 'Fabric'])
    assert.equal(c.kind, 'SIMILAR')
    assert.ok(
      compareRoutings(
        { ...original, styleId: null, category: 'SHIRT' },
        { ...original, styleId: null, category: ' shirt ' }
      ).exact
    )
  })
  check('generic cutting and packing alone do not warn for unrelated styles', () => {
    assert.equal(
      compareRoutings(
        route([step('cut', 1), step('pack', 2)]),
        route([step('cut', 1), step('pack', 2)], { styleId: 'different' })
      ).similar,
      false
    )
    assert.equal(compareRoutings(route([]), route([])).exact, false)
  })
  check('radically different execution settings do not produce noisy suggestions', () => {
    const other = route(
      original.steps.map((s) => ({
        ...s,
        departmentId: 'other',
        workstationId: 'outside',
        contractorId: 'other',
        execution: 'OUTSOURCED',
        skip: 'OPTIONAL',
        smv: 90,
        ratePerPiece: 200,
        isQcStep: true,
      }))
    )
    assert.equal(compareRoutings(original, other).similar, false)
  })
  if (!process.env.ROUTING_TEST_DB) return
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
  const api = async (path: string, body?: unknown, method = 'POST', expected = 200) => {
    const response = await fetch(`http://localhost:5127/api/masters${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json = (await response.json()) as any
    assert.equal(response.status, expected, JSON.stringify(json))
    return json
  }
  let source = await prisma.routing.findFirstOrThrow({
    where: { code: 'RT-SH-PLAIN' },
    include: routingInclude,
  })
  if (!source._count.mos) {
    const brand = await prisma.brand.findFirstOrThrow()
    await prisma.$transaction(async (tx) => {
      const mo = await tx.manufacturingOrder.create({
        data: {
          moNumber: `ROUTING-HISTORY-${Date.now()}`,
          brandId: brand.id,
          createdById: admin.id,
          totalPlannedQty: 10,
          lines: { create: { styleId: source.styleId!, color: 'Test', totalQty: 10 } },
        },
      })
      await applyRouting(tx, mo.id, source.id)
      await tx.manufacturingOrder.update({
        where: { id: mo.id },
        data: { progress: 'IN_PROGRESS', totalCutQty: 3 },
      })
    })
    source = await prisma.routing.findUniqueOrThrow({
      where: { id: source.id },
      include: routingInclude,
    })
  }
  assert.ok(source._count.mos > 0, 'History test requires an existing MO on the source')
  const snapshot = JSON.stringify(source)
  const mosBefore = JSON.stringify(
    await prisma.manufacturingOrder.findMany({
      where: { routingId: source.id },
      include: { steps: true },
      orderBy: { id: 'asc' },
    })
  )
  const steps = source.steps.map((s) => ({
    ...s,
    smv: s.smv == null ? null : Number(s.smv),
    ratePerPiece: s.ratePerPiece == null ? null : Number(s.ratePerPiece),
  }))
  const payload = {
    name: `Routing reuse test ${Date.now()}`,
    styleId: null,
    category: 'Routing test',
    fabricItemId: source.fabricItemId,
    isActive: false,
    notes: 'Copied routing test notes',
    steps,
    copiedFromId: source.id,
    copiedFromVersion: source.version,
    copiedFromUpdatedAt: source.updatedAt.toISOString(),
    creationKey: randomUUID(),
  }
  const created = (await api('/routings', payload, 'POST', 201)).data
  const tracked = await prisma.routing.findUniqueOrThrow({
    where: { id: created.id },
    select: trackRoutingSelect,
  })
  check('style tracker supplies copy provenance and contractor IDs for every step', () => {
    assert.equal((tracked.copiedFrom as any).id, source.id)
    assert.ok(tracked.steps.every((s) => 'contractorId' in s && 'contractor' in s))
  })
  check(
    'copy creates independent version one with new step IDs, source provenance and availability',
    () => {
      assert.notEqual(created.id, source.id)
      assert.equal(created.version, 1)
      assert.equal(created.isLocked, false)
      assert.equal(created.isActive, false)
      assert.equal(created.copiedFrom.id, source.id)
      assert.equal(created.copiedFrom.version, source.version)
      assert.equal(created.notes, payload.notes)
      assert.ok(created.steps.every((s: any) => !source.steps.some((old) => old.id === s.id)))
      assert.ok(
        compareRoutings(
          { ...created, styleId: source.styleId, category: source.category },
          { ...source, steps }
        ).exact
      )
    }
  )
  const duplicates = await Promise.all([
    api('/routings', payload, 'POST', 201),
    api('/routings', payload, 'POST', 201),
  ])
  check('concurrent retries create only one routing', () =>
    assert.ok(duplicates.every((r) => r.data.id === created.id))
  )
  await api('/routings', { ...payload, name: 'Changed after first save' }, 'POST', 409)
  const creates = await prisma.auditLog.count({
    where: { entityType: 'Routing', entityId: created.id, action: 'CREATE' },
  })
  check('retries keep one creation audit and reject changed payloads under the same save key', () =>
    assert.equal(creates, 1)
  )
  const matches = (
    await api('/routings/similar', {
      styleId: null,
      category: payload.category,
      fabricItemId: payload.fabricItemId,
      steps,
    })
  ).data
  check('database similarity finds exact stopped routes and cross-style similar routes', () => {
    assert.ok(matches.some((m: any) => m.routing.id === created.id && m.kind === 'EXACT'))
    assert.ok(matches.some((m: any) => m.routing.id === source.id && m.kind === 'SIMILAR'))
  })
  const byRef = await api(`/routings?q=${source.code}`, undefined, 'GET')
  const byProcess = await api(
    `/routings?q=${encodeURIComponent(source.steps[0].operation.name)}&limit=200`,
    undefined,
    'GET'
  )
  check('search covers references and process names', () => {
    assert.ok(byRef.data.some((r: any) => r.id === source.id))
    assert.ok(byProcess.data.some((r: any) => r.id === source.id))
  })
  const suggestions = (
    await api('/routings/similar', {
      styleId: source.styleId,
      fabricItemId: source.fabricItemId,
      steps: [],
    })
  ).data
  check(
    'empty style route suggests suitable existing configurations without assigning anything',
    () => {
      assert.ok(suggestions.some((m: any) => m.routing.id === source.id))
      assert.ok(suggestions.every((m: any) => m.kind === 'SUGGESTED' && m.routing.isActive))
    }
  )
  const editedSteps = steps.map((s, i) => ({
    ...s,
    smv: i === 1 ? 11.123 : s.smv,
    skip: i === 1 ? 'OPTIONAL' : s.skip,
  }))
  const edited = (await api(`/routings/${created.id}`, { steps: editedSteps }, 'PATCH')).data
  const sourceAfter = await prisma.routing.findUnique({
    where: { id: source.id },
    include: routingInclude,
  })
  const mosAfter = JSON.stringify(
    await prisma.manufacturingOrder.findMany({
      where: { routingId: source.id },
      include: { steps: true },
      orderBy: { id: 'asc' },
    })
  )
  check(
    'editing copy increments only its version; original routing and MO history remain unchanged',
    () => {
      assert.equal(edited.version, 2)
      assert.equal(JSON.stringify(sourceAfter), snapshot)
      assert.equal(mosAfter, mosBefore)
    }
  )
  await api(`/routings/${created.id}`, { isLocked: true }, 'PATCH')
  await api(`/routings/${created.id}`, { steps: editedSteps }, 'PATCH', 400)
  const locked = (await api(`/routings/${created.id}`, undefined, 'GET')).data
  const copiedLocked = (
    await api(
      '/routings',
      {
        ...payload,
        creationKey: randomUUID(),
        copiedFromId: locked.id,
        copiedFromVersion: locked.version,
        copiedFromUpdatedAt: locked.updatedAt,
        steps: editedSteps,
      },
      'POST',
      201
    )
  ).data
  check(
    'locked routing can be copied without unlocking or overwriting it; legacy skip retained',
    () => {
      assert.equal(copiedLocked.isLocked, false)
      assert.equal(copiedLocked.steps[1].skip, 'OPTIONAL')
      assert.equal(Number(copiedLocked.steps[1].smv), 11.123)
    }
  )
  await api(
    '/routings',
    { ...payload, creationKey: randomUUID(), copiedFromId: created.id, copiedFromVersion: 1 },
    'POST',
    409
  )
  check('stale source preview is rejected before creation', () => assert.ok(true))
  const rollback = new Error('ROLLBACK routing regression')
  try {
    await prisma.$transaction(
      async (tx) => {
        const before = JSON.stringify(
          await tx.manufacturingOrder.findMany({
            where: { routingId: source.id },
            include: { steps: true },
            orderBy: { id: 'asc' },
          })
        )
        await tx.routing.update({ where: { id: source.id }, data: { isLocked: false } })
        const result = await updateRouting(
          tx,
          source.id,
          updateRoutingSchema.parse({ steps: editedSteps }),
          admin.id
        )
        const after = JSON.stringify(
          await tx.manufacturingOrder.findMany({
            where: { routingId: source.id },
            include: { steps: true },
            orderBy: { id: 'asc' },
          })
        )
        check(
          'existing version-update behavior preserves assigned MO versions and progress',
          () => {
            assert.equal(result.routing.version, source.version + 1)
            assert.equal(after, before)
          }
        )
        throw rollback
      },
      { timeout: 20000 }
    )
  } catch (e) {
    if (e !== rollback) throw e
  }
  await api(`/routings/${created.id}`, { isLocked: false }, 'PATCH')
  await api(`/routings/${created.id}`, undefined, 'DELETE')
  const audit = await prisma.auditLog.findFirstOrThrow({
    where: { entityId: created.id, action: 'DELETE', entityType: 'Routing' },
    orderBy: { createdAt: 'desc' },
  })
  const restored = (await api(`/routings/deleted/${audit.id}/restore`, {}, 'POST', 201)).data
  check('delete/restore retains copied-source history and routing version', () => {
    assert.equal(restored.copiedFrom.id, source.id)
    assert.equal(restored.version, 2)
    assert.equal(restored.isActive, false)
  })
  const surviving = await prisma.routing.findUniqueOrThrow({ where: { id: copiedLocked.id } })
  check('copy provenance survives deletion of its original source', () =>
    assert.equal((surviving.copiedFrom as any).id, created.id)
  )
  const deniedToken = jwt.sign(
    { id: admin.id, role: 'Test viewer', permissions: ['masters:view'] },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' }
  )
  const denied = await fetch('http://localhost:5127/api/masters/routings', {
    method: 'POST',
    headers: { authorization: `Bearer ${deniedToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  check('view permission does not grant permission to create a copy', () =>
    assert.equal(denied.status, 403)
  )
  try {
    await prisma.$transaction(
      async (tx) => {
        const prefix = randomUUID()
        const ids = Array.from({ length: 1001 }, (_, i) => `${prefix}-${i}`)
        await tx.routing.createMany({
          data: ids.map((id, i) => ({
            id,
            code: id,
            name: 'Similarity load fixture',
            category: prefix,
            updatedAt: new Date(Date.now() + i * 1000),
          })),
        })
        const testSteps = steps.map((s) => ({
          sequence: s.sequence,
          operationId: s.operationId,
          departmentId: s.departmentId,
          smv: 3.141,
          isQcStep: s.isQcStep,
          execution: s.execution,
          skip: s.skip,
        }))
        await tx.routingStep.createMany({
          data: ids.flatMap((id, i) =>
            testSteps.map((s) => ({ ...s, routingId: id, smv: i === 0 ? 3.141 : 4.125 }))
          ),
        })
        const start = Date.now()
        const found = await similarRoutings(tx, {
          styleId: null,
          category: prefix,
          steps: testSteps,
        })
        check('1001-route search finds an older exact match with a bounded response', () => {
          assert.equal(found[0].routing.id, ids[0])
          assert.equal(found[0].kind, 'EXACT')
          assert.ok(found.length <= 8)
        })
        console.log(`Similarity query with 1001 extra routings: ${Date.now() - start} ms`)
        throw rollback
      },
      { timeout: 30000 }
    )
  } catch (e) {
    if (e !== rollback) throw e
  }
  console.log(`Local fixtures: ${restored.id}, ${copiedLocked.id}`)
}
main()
  .then(() => console.log(`${passed} routing reuse checks passed`))
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
