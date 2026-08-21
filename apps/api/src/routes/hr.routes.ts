import { Router } from 'express'
const router = Router()
router.get('/employees', async (_, res) => res.json({ success: true, data: [] }))
router.get('/attendance', async (_, res) => res.json({ success: true, data: [] }))
router.get('/payroll', async (_, res) => res.json({ success: true, data: [] }))
export default router
