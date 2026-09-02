import { DEFAULT_MODEL, getAiConfig, type AiProvider } from '../lib/aiConfig'
import { AppError } from '../middleware/errorHandler'
import { buildSystemPrompt, misPrompt } from './ai/prompt'
import { runConversation, type Turn } from './ai/providers'
import { ERP_TOOLS, toolsFor } from './ai/tools'

/**
 * The assistant.
 *
 * Three pieces sit behind this file and each answers one question:
 *
 *   ai/tools.ts      what it may look up, and who is allowed to
 *   ai/prompt.ts     what it knows before anyone asks
 *   ai/providers.ts  how to say all that to OpenAI or to Gemini
 *
 * Nothing here knows which provider is in use, and nothing in the routes knows
 * either. That is the point: the model behind the assistant is a setting on a
 * screen, not a decision baked into the code.
 */

export type { Turn as AIMessage }

/**
 * Built per request rather than once at start-up, because the key and the model
 * are set from Settings and can change without restarting the server.
 */
async function ready() {
  const config = await getAiConfig()

  if (!config.apiKey) {
    throw new AppError(
      'The assistant has no API key yet. Add one in Settings → Assistant.',
      409,
      'AI_NOT_CONFIGURED',
    )
  }
  if (!config.enabled) {
    throw new AppError('The assistant is switched off in Settings.', 409, 'AI_DISABLED')
  }

  return {
    provider: config.provider,
    apiKey: config.apiKey,
    model: config.model || DEFAULT_MODEL[config.provider],
  }
}

export async function chatWithERP(
  messages: Turn[],
  _userId: string,
  userName: string,
  userRole: string,
  userPermissions: string[] = [],
): Promise<string> {
  if (messages.length === 0) {
    throw new AppError('There is nothing to answer.', 400, 'NO_MESSAGE')
  }

  const { provider, apiKey, model } = await ready()
  const tools = toolsFor(userRole, userPermissions)
  const systemPrompt = await buildSystemPrompt({ userName, userRole, allowed: tools })

  return runConversation(
    {
      provider,
      apiKey,
      model,
      systemPrompt,
      tools,
      turns: messages,
      caller: { role: userRole, permissions: userPermissions },
    },
    userName,
  )
}

/**
 * The daily summary, for the owner. Not narrowed by role — it is generated on a
 * schedule rather than by somebody asking, so there is no asking person to
 * narrow it to, and it goes to whoever owns the business.
 */
export async function generateDailyMISReport(date: Date = new Date()): Promise<string> {
  const { provider, apiKey, model } = await ready()

  const systemPrompt = await buildSystemPrompt({
    userName: 'the owner',
    userRole: 'Admin',
    allowed: ERP_TOOLS,
  })

  return runConversation(
    {
      provider,
      apiKey,
      model,
      systemPrompt,
      tools: ERP_TOOLS,
      turns: [{ role: 'user', content: misPrompt(date) }],
      caller: { role: 'Admin', permissions: [] },
    },
    'the owner',
  )
}

/**
 * A one-line round trip used by Settings to say whether the assistant actually
 * works. A saved key is not the same as a working key — it can be revoked,
 * mistyped, or out of credit — and this screen should not claim otherwise.
 */
export async function testAssistant(): Promise<{ ok: true; provider: AiProvider; model: string }> {
  const { provider, apiKey, model } = await ready()

  await runConversation(
    {
      provider,
      apiKey,
      model,
      systemPrompt: 'Reply with the single word: ready',
      tools: [],
      turns: [{ role: 'user', content: 'Are you there?' }],
      caller: { role: 'Admin', permissions: [] },
    },
    'the system',
  )

  return { ok: true, provider, model }
}
