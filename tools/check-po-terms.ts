/**
 * Purchase order terms (the user's report, 27 Nov 2026): terms changed in
 * Settings → Documents must reach the next purchase order made, and an order
 * already saved keeps its own terms until somebody chooses to bring it up to
 * date (the order form's "Use the current terms from Settings").
 *
 * What the sheet prints is `order.terms`, or Settings' terms when the order
 * has none — the same rule as the print page.
 *
 * Demo database (lderp_demo) only; the PO template is put back and the orders
 * it makes are deleted at the end. From the repo root:
 *
 *   DATABASE_URL="postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp" \
 *   E2E_EMAIL=... E2E_PASSWORD=... \
 *   E2E_API=http://localhost:5117/api npx tsx tools/check-po-terms.ts
 */
import { prisma } from '../packages/database/src/index'

const API = (process.env.E2E_API || 'http://localhost:5101/api').replace(/\/+$/, '')
let pass = 0, fail = 0
const check = (name: string, ok: boolean, extra?: unknown) => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra !== undefined ? `  — ${JSON.stringify(extra).slice(0, 300)}` : ''}`)
}

async function main() {
  const [{ current_database: db }] = await prisma.$queryRaw<{ current_database: string }[]>`select current_database()`
  if (db !== 'lderp_demo') { console.error('Refusing to run: not lderp_demo.'); process.exitCode = 2; return }
  const login = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: process.env.E2E_EMAIL, password: process.env.E2E_PASSWORD }) }).then((r) => r.json())
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${login.accessToken}` }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: r.status, body: (await r.json().catch(() => null)) as any }
  }

  const supplier = ((await call('GET', '/masters/suppliers?limit=20')).body.data as any[]).find((s) => !/vhagar/i.test(s.name) && s.gstin)
  const item = ((await call('GET', '/masters/items?limit=100')).body.data as any[]).find((i) => !/vhagar/i.test(i.name) && ['RAW_MATERIAL', 'TRIM', 'PACKING_MATERIAL'].includes(i.type))
  const original = ((await call('GET', '/settings/documents')).body.data.documents as any[]).find((d) => d.docType === 'PO')
  const setTemplate = (termsText: string | null) =>
    call('PATCH', '/settings/documents/PO', {
      title: original.title, termsText, declaration: original.declaration, footerNote: original.footerNote,
      showHsn: original.showHsn, showAmountInWords: original.showAmountInWords, showBankDetails: original.showBankDetails,
      showSignature: original.showSignature, copies: original.copies, isActive: original.isActive,
    })
  // What the order form does on a new order: fill the box from order-defaults.
  const newPo = async (terms?: string | null) => {
    const filled = terms === undefined ? (await call('GET', '/purchase/order-defaults')).body.data.terms : terms
    return (await call('POST', '/purchase/orders', { supplierId: supplier.id, terms: filled, lines: [{ itemId: item.id, qty: 5, unitRate: 100, gstRate: 12 }] })).body?.data as { id: string; poNumber: string }
  }
  const printed = async (id: string) => {
    const d = (await call('GET', `/purchase/orders/${id}/print`)).body?.data
    return d?.order?.terms || d?.template?.termsText || null
  }
  const stamp = Date.now().toString(36)
  const A = `Terms A ${stamp}: payment in 45 days.`
  const B = `Terms B ${stamp}: payment in 30 days, goods at supplier's risk until received.`
  const made: string[] = []

  try {
    await setTemplate(A)
    const first = await newPo(); made.push(first.id)
    check('1. a new order made with Settings terms A prints A', (await printed(first.id)) === A)

    const saved = await setTemplate(B)
    check('2. Settings terms changed to B', saved.status < 300, saved)
    const dflt = (await call('GET', '/purchase/order-defaults')).body?.data?.terms
    check('3. the order form now offers B for a new order', dflt === B, dflt)

    const second = await newPo(); made.push(second.id)
    check('4. the next order made prints B', (await printed(second.id)) === B)
    check('5. the order saved earlier still prints its own terms A', (await printed(first.id)) === A)

    // "Use the current terms from Settings" on the earlier order, then save.
    const upd = await call('PATCH', `/purchase/orders/${first.id}`, { terms: B })
    check('6. brought up to date, the earlier order prints B', upd.status < 300 && (await printed(first.id)) === B, upd.status)

    const blank = await newPo(null); made.push(blank.id)
    check('7. an order with its terms box left empty prints Settings terms B', (await printed(blank.id)) === B)
  } finally {
    for (const id of made.reverse()) {
      await call('DELETE', `/purchase/orders/${id}`)
      await call('DELETE', `/purchase/recycle-bin/${id}`)
    }
    await setTemplate(original.termsText ?? null)
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exitCode = 1
}
main().finally(() => prisma.$disconnect())
