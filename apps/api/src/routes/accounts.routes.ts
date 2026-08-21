import { Router } from 'express'
const router = Router()
router.get('/vouchers', async (_, res) => res.json({ success: true, data: [] }))
router.get('/ledger', async (_, res) => res.json({ success: true, data: [] }))
router.get('/gst', async (_, res) => res.json({ success: true, data: [] }))
export default router
