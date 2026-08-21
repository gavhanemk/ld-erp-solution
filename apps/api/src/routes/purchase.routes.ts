import { Router } from 'express'
const router = Router()
router.get('/orders', async (_, res) => res.json({ success: true, data: [] }))
router.get('/grn', async (_, res) => res.json({ success: true, data: [] }))
router.get('/invoices', async (_, res) => res.json({ success: true, data: [] }))
router.get('/payments', async (_, res) => res.json({ success: true, data: [] }))
export default router
