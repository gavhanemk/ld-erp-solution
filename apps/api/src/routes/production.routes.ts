import { Router } from 'express'
const router = Router()
router.get('/orders', async (_, res) => res.json({ success: true, data: [] }))
router.get('/cutting', async (_, res) => res.json({ success: true, data: [] }))
router.get('/entries', async (_, res) => res.json({ success: true, data: [] }))
router.get('/qc', async (_, res) => res.json({ success: true, data: [] }))
export default router
