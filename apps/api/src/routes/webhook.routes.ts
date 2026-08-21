import { Router } from 'express'
const router = Router()

// WhatsApp webhook verification
router.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']

  if (mode === 'subscribe' && token === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    res.status(200).send(challenge)
  } else {
    res.sendStatus(403)
  }
})

// WhatsApp incoming message
router.post('/whatsapp', async (req, res) => {
  const body = req.body
  // Process incoming WhatsApp messages and route to AI service
  console.log('WhatsApp webhook:', JSON.stringify(body, null, 2))
  res.sendStatus(200)
})

export default router
