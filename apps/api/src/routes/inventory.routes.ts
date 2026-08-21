import { Router } from 'express'
const router = Router()
router.get('/stock', async (_, res) => res.json({ success: true, data: [] }))
router.get('/ledger', async (_, res) => res.json({ success: true, data: [] }))
router.get('/requisitions', async (_, res) => res.json({ success: true, data: [] }))
export default router
