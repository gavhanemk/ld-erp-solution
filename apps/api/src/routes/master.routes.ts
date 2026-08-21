import { Router } from 'express'
const router = Router()

router.get('/customers', async (req, res) => res.json({ success: true, data: [] }))
router.get('/suppliers', async (req, res) => res.json({ success: true, data: [] }))
router.get('/items', async (req, res) => res.json({ success: true, data: [] }))
router.get('/styles', async (req, res) => res.json({ success: true, data: [] }))
router.get('/bom', async (req, res) => res.json({ success: true, data: [] }))
router.get('/warehouses', async (req, res) => res.json({ success: true, data: [] }))
router.get('/departments', async (req, res) => res.json({ success: true, data: [] }))
router.get('/uoms', async (req, res) => res.json({ success: true, data: [] }))

export default router
