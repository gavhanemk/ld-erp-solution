import OpenAI from 'openai'
import {
  GoogleGenerativeAI,
  FunctionDeclarationSchemaType as SchemaType,
  type FunctionDeclaration,
  type FunctionDeclarationSchemaProperty,
} from '@google/generative-ai'
import { logger } from '../../utils/logger'
import { AppError } from '../../middleware/errorHandler'
import type { AiProvider } from '../../lib/aiConfig'
import { executeTool, type Caller, type ErpTool } from './tools'

/**
 * One conversation, run against whichever provider is configured.
 *
 * The two APIs disagree about almost everything — the shape of a tool, the name
 * of the assistant's role, how a tool result is handed back — but the ERP does
 * not care. Everything above this file works in one vocabulary, and each
 * provider gets its own translation here. That is what makes swapping provider
 * a setting rather than a rewrite.
 */

export interface Turn {
  role: 'user' | 'model'
  content: string
}

export interface RunOptions {
  provider: AiProvider
  apiKey: string
  model: string
  systemPrompt: string
  tools: ErpTool[]
  turns: Turn[]
  /** Who is asking. Some tools mix subjects and narrow their own answer. */
  caller: Caller
}

/**
 * A model that keeps calling tools without ever answering would otherwise loop
 * until the request times out. Six rounds is far more than any real question
 * needs — the deepest is "what do we have, and why" at three.
 */
const MAX_TOOL_ROUNDS = 6

/**
 * Drops an answer that is its own exact double.
 *
 * Models occasionally emit a short reply twice in one message — it happened
 * here with a question that had been handed to it almost fully formed. No real
 * answer is exactly itself repeated, so keeping one copy is safe, and a
 * question asked twice reads to the person as a fault in the software.
 */
function deduplicate(text: string): string {
  const trimmed = text.trim()
  const half = Math.floor(trimmed.length / 2)
  if (trimmed.length < 20 || trimmed.length % 2 === 0) {
    const [a, b] = [trimmed.slice(0, half), trimmed.slice(half)]
    if (a && a === b) return a.trim()
  }
  // The commoner shape: the same line, twice, separated by a newline.
  const lines = trimmed.split('\n').map((l) => l.trim())
  if (lines.length === 2 && lines[0] && lines[0] === lines[1]) return lines[0]
  return trimmed
}

/** Runs one tool, never throwing: a failed lookup is an answer, not a crash. */
async function runTool(
  name: string,
  rawArgs: string | Record<string, unknown>,
  allowed: Set<string>,
  userName: string,
  caller: Caller,
): Promise<string> {
  if (!allowed.has(name)) {
    // A second gate. The model is only offered the tools this person may use,
    // but that must not be the only thing standing between a role and data it
    // is not allowed to see.
    return JSON.stringify({
      error: `${userName}'s role does not have access to this information.`,
    })
  }

  let args: Record<string, unknown> = {}
  try {
    args = typeof rawArgs === 'string' ? (rawArgs ? JSON.parse(rawArgs) : {}) : rawArgs
  } catch {
    return JSON.stringify({ error: 'Those arguments could not be read.' })
  }

  try {
    return JSON.stringify(await executeTool(name, args, caller))
  } catch (err) {
    logger.error(`AI tool ${name} failed: ${(err as Error).message}`)
    return JSON.stringify({ error: (err as Error).message })
  }
}

// ── OpenAI ──────────────────────────────────────────────────────────────────

function openAiTools(tools: ErpTool[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

async function runOpenAi(opts: RunOptions, userName: string): Promise<string> {
  const client = new OpenAI({ apiKey: opts.apiKey })
  const allowed = new Set(opts.tools.map((t) => t.name))

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: opts.systemPrompt },
    ...opts.turns.map((t) =>
      t.role === 'user'
        ? ({ role: 'user', content: t.content } as const)
        : ({ role: 'assistant', content: t.content } as const),
    ),
  ]

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const completion = await client.chat.completions.create({
      model: opts.model,
      messages,
      ...(opts.tools.length ? { tools: openAiTools(opts.tools) } : {}),
    })

    const choice = completion.choices[0]
    const message = choice?.message
    if (!message) throw new AppError('The assistant sent back nothing.', 502, 'AI_EMPTY')

    if (!message.tool_calls?.length) {
      return message.content
        ? deduplicate(message.content)
        : 'I could not put an answer together for that.'
    }

    messages.push(message)

    const results = await Promise.all(
      message.tool_calls.map(async (call) => {
        // Only function calls carry a name and arguments; anything else the
        // provider may add later is not a tool this ERP knows how to run.
        const fn = 'function' in call ? call.function : null
        return {
          role: 'tool' as const,
          tool_call_id: call.id,
          content: fn
            ? await runTool(fn.name, fn.arguments, allowed, userName, opts.caller)
            : JSON.stringify({ error: 'Unsupported tool call.' }),
        }
      }),
    )
    messages.push(...results)
  }

  return 'That took too many lookups to answer. Try asking for one thing at a time.'
}

// ── Gemini ──────────────────────────────────────────────────────────────────

/**
 * Gemini wants its own enum for types rather than the JSON Schema strings the
 * rest of the system uses, so the shape is translated rather than duplicated.
 * Keeping one definition means a tool cannot drift between providers.
 */
const GEMINI_TYPE: Record<string, SchemaType> = {
  string: SchemaType.STRING,
  number: SchemaType.NUMBER,
  boolean: SchemaType.BOOLEAN,
  object: SchemaType.OBJECT,
  array: SchemaType.ARRAY,
}

function geminiTools(tools: ErpTool[]): FunctionDeclaration[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: {
      type: SchemaType.OBJECT,
      properties: Object.fromEntries(
        Object.entries(t.parameters.properties).map(([key, prop]) => [
          key,
          {
            type: GEMINI_TYPE[prop.type] ?? SchemaType.STRING,
            description: prop.enum ? `${prop.description}. One of: ${prop.enum.join(', ')}` : prop.description,
          } as FunctionDeclarationSchemaProperty,
        ]),
      ),
      ...(t.parameters.required?.length ? { required: t.parameters.required } : {}),
    },
  }))
}

async function runGemini(opts: RunOptions, userName: string): Promise<string> {
  const genAI = new GoogleGenerativeAI(opts.apiKey)
  const allowed = new Set(opts.tools.map((t) => t.name))

  const model = genAI.getGenerativeModel({
    model: opts.model,
    systemInstruction: opts.systemPrompt,
    ...(opts.tools.length ? { tools: [{ functionDeclarations: geminiTools(opts.tools) }] } : {}),
  })

  const chat = model.startChat({
    history: opts.turns.slice(0, -1).map((t) => ({
      role: t.role,
      parts: [{ text: t.content }],
    })),
  })

  let response = (await chat.sendMessage(opts.turns[opts.turns.length - 1].content)).response

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const calls = response.functionCalls()
    if (!calls?.length) return deduplicate(response.text()) || 'I could not put an answer together for that.'

    const replies = await Promise.all(
      calls.map(async (call) => ({
        functionResponse: {
          name: call.name,
          response: {
            result: JSON.parse(
              await runTool(
                call.name,
                call.args as Record<string, unknown>,
                allowed,
                userName,
                opts.caller,
              ),
            ),
          },
        },
      })),
    )
    response = (await chat.sendMessage(replies)).response
  }

  return 'That took too many lookups to answer. Try asking for one thing at a time.'
}

// ── The one thing the rest of the system calls ──────────────────────────────

export async function runConversation(opts: RunOptions, userName: string): Promise<string> {
  try {
    return opts.provider === 'gemini'
      ? await runGemini(opts, userName)
      : await runOpenAi(opts, userName)
  } catch (err) {
    // Everything below is somebody else's server having a bad day. Passing the
    // raw provider error to a store keeper helps nobody, so each is turned into
    // a sentence that says what to do about it.
    const message = (err as Error).message ?? ''
    const status = (err as { status?: number }).status

    if (status === 401 || /api key|unauthor|invalid_api_key/i.test(message)) {
      throw new AppError(
        'The AI key was refused. Check it in Settings → Assistant.',
        502,
        'AI_KEY_REJECTED',
      )
    }
    if (status === 429 || /quota|rate.?limit|insufficient_quota/i.test(message)) {
      throw new AppError(
        'The AI account is out of credit or being called too fast. Try again in a minute.',
        502,
        'AI_RATE_LIMITED',
      )
    }
    if (status === 404 || /model.*(not found|does not exist)/i.test(message)) {
      throw new AppError(
        `The model "${opts.model}" is not available on this account. Pick another in Settings → Assistant.`,
        502,
        'AI_MODEL_UNAVAILABLE',
      )
    }

    logger.error(`AI (${opts.provider}/${opts.model}) failed: ${message}`)
    throw new AppError(
      'The assistant could not be reached just now. Try again in a moment.',
      502,
      'AI_UNAVAILABLE',
    )
  }
}
