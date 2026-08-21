import { Router } from 'express'
const router = Router()
router.get('/', async (_, res) => res.json({ success: true, data: [] }))
export default router
