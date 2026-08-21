'use client'

import { useState, useRef, useEffect } from 'react'
import {
  Bot, Send, Mic, MicOff, Trash2, Plus, Clock, Zap, User,
  Download, Share2, Copy, ChevronDown, Sparkles
} from 'lucide-react'
import { cn } from '@/lib/utils'

interface Message {
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
  isLoading?: boolean
}

const quickPrompts = [
  { icon: '📊', label: "Today's Summary", prompt: "Give me today's complete business summary" },
  { icon: '🏭', label: "Production Status", prompt: "What is today's production status and efficiency for each line?" },
  { icon: '📦', label: "Low Stock", prompt: "Show me all items that are below reorder level" },
  { icon: '💰', label: "Outstanding Dues", prompt: "Show me all outstanding customer receivables overdue by 30+ days" },
  { icon: '✅', label: "Pending Approvals", prompt: "What are all the pending approvals right now?" },
  { icon: '📋', label: "Active Orders", prompt: "List all active sales orders with delivery dates" },
  { icon: '📈', label: "Revenue MTD", prompt: "What is our revenue and collection this month?" },
  { icon: '🔧', label: "Machine Status", prompt: "Any machine breakdowns or maintenance due today?" },
]

export default function AIPage() {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'assistant',
      content: `👋 **Namaste! I'm your LD ERP AI Assistant.**

I have live access to your entire ERP — orders, production, inventory, finance, and HR. Ask me anything in **English, Hindi, or Hinglish**.

Here are some things I can do:
- 📊 Give you instant business summaries
- 🏭 Check production efficiency & line-wise output
- 💰 Show outstanding receivables & payables
- ✅ Tell you pending approvals & take action
- 📦 Alert you about low stock
- 📈 Generate reports & insights
- 📱 Send daily MIS to WhatsApp

*Try the quick prompts below or type your question!*`,
      timestamp: new Date(),
    },
  ])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [conversationId, setConversationId] = useState<string>()
  const [isListening, setIsListening] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const sendMessage = async (text?: string) => {
    const msg = text || input.trim()
    if (!msg || isLoading) return

    setInput('')
    const userMsg: Message = { role: 'user', content: msg, timestamp: new Date() }
    const loadingMsg: Message = { role: 'assistant', content: '', timestamp: new Date(), isLoading: true }

    setMessages((m) => [...m, userMsg, loadingMsg])
    setIsLoading(true)

    try {
      const token = localStorage.getItem('access_token') || ''
      const apiMessages = [...messages, userMsg]
        .filter((m) => !m.isLoading)
        .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', content: m.content }))

      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ messages: apiMessages, conversationId }),
      })

      const data = await res.json()

      if (data.success) {
        setConversationId(data.data.conversationId)
        setMessages((m) => [
          ...m.slice(0, -1),
          { role: 'assistant', content: data.data.response, timestamp: new Date() },
        ])
      } else {
        setMessages((m) => [
          ...m.slice(0, -1),
          { role: 'assistant', content: '❌ Sorry, I encountered an error. Please try again.', timestamp: new Date() },
        ])
      }
    } catch {
      setMessages((m) => [
        ...m.slice(0, -1),
        { role: 'assistant', content: '⚠️ Network error. Please check your connection and try again.', timestamp: new Date() },
      ])
    } finally {
      setIsLoading(false)
      inputRef.current?.focus()
    }
  }

  const clearConversation = () => {
    setMessages([{
      role: 'assistant',
      content: '🔄 New conversation started. How can I help you?',
      timestamp: new Date(),
    }])
    setConversationId(undefined)
  }

  const toggleVoice = () => {
    if (!('webkitSpeechRecognition' in window)) return
    setIsListening(!isListening)
    // Voice implementation placeholder
  }

  const copyMessage = (content: string) => {
    navigator.clipboard.writeText(content)
  }

  const formatMessage = (content: string) => {
    // Basic markdown formatting
    return content
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/\n/g, '<br/>')
      .replace(/- (.*?)(<br\/>|$)/g, '• $1<br/>')
  }

  return (
    <div className="flex h-[calc(100vh-5rem)] gap-6">
      {/* Sidebar - Conversation History */}
      <div className="hidden lg:flex flex-col w-64 glass-card p-4 shrink-0">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-foreground">Conversations</h3>
          <button onClick={clearConversation} className="btn-ghost p-1.5 text-xs">
            <Plus size={14} />
          </button>
        </div>

        {/* Active Conversation */}
        <div className="flex-1 space-y-1">
          <div className="px-3 py-2.5 rounded-lg bg-teal-500/10 border border-teal-500/20 cursor-pointer">
            <p className="text-xs font-medium text-teal-300 truncate">Current Session</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">{messages.length} messages</p>
          </div>
        </div>

        {/* Send MIS button */}
        <div className="mt-4 pt-4 border-t border-border">
          <button className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 hover:bg-amber-500/15 transition-all text-xs font-medium text-amber-400">
            <Zap size={13} />
            Send Daily MIS
          </button>
        </div>
      </div>

      {/* Main Chat */}
      <div className="flex-1 flex flex-col glass-card overflow-hidden">
        {/* Chat Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className="w-10 h-10 rounded-xl bg-teal-500/15 border border-teal-500/20 flex items-center justify-center">
                <Bot size={20} className="text-teal-400" />
              </div>
              <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-emerald-400 rounded-full border-2 border-background" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">LD ERP Assistant</p>
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Sparkles size={10} className="text-teal-400" />
                Powered by Google Gemini · Live ERP Access
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button onClick={() => copyMessage(messages.map(m => `${m.role}: ${m.content}`).join('\n\n'))}
              className="btn-ghost p-2" title="Copy conversation">
              <Copy size={15} />
            </button>
            <button onClick={clearConversation} className="btn-ghost p-2 text-muted-foreground hover:text-red-400" title="Clear">
              <Trash2 size={15} />
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4 no-scrollbar">
          {messages.map((msg, i) => (
            <div key={i} className={cn('flex gap-3 animate-fade-in', msg.role === 'user' && 'flex-row-reverse')}>
              {/* Avatar */}
              <div className={cn(
                'w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-0.5',
                msg.role === 'assistant'
                  ? 'bg-teal-500/15 border border-teal-500/20'
                  : 'bg-secondary border border-border'
              )}>
                {msg.role === 'assistant'
                  ? <Bot size={16} className="text-teal-400" />
                  : <User size={16} className="text-muted-foreground" />}
              </div>

              {/* Bubble */}
              <div className={cn('max-w-[75%]', msg.role === 'user' ? 'items-end' : 'items-start', 'flex flex-col gap-1')}>
                <div className={msg.role === 'user' ? 'ai-bubble-user' : 'ai-bubble-assistant'}>
                  {msg.isLoading ? (
                    <div className="flex gap-1 py-1">
                      {[0, 150, 300].map((d) => (
                        <span
                          key={d}
                          className="w-2 h-2 bg-teal-400 rounded-full animate-bounce"
                          style={{ animationDelay: `${d}ms` }}
                        />
                      ))}
                    </div>
                  ) : (
                    <div
                      className="leading-relaxed"
                      dangerouslySetInnerHTML={{ __html: formatMessage(msg.content) }}
                    />
                  )}
                </div>

                <div className={cn('flex items-center gap-1', msg.role === 'user' && 'flex-row-reverse')}>
                  <span className="text-[10px] text-muted-foreground">
                    {msg.timestamp.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  {msg.role === 'assistant' && !msg.isLoading && (
                    <button
                      onClick={() => copyMessage(msg.content)}
                      className="p-0.5 text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <Copy size={11} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Quick Prompts */}
        <div className="px-6 py-3 border-t border-border/50 no-scrollbar overflow-x-auto">
          <div className="flex gap-2 min-w-max">
            {quickPrompts.map((qp) => (
              <button
                key={qp.label}
                onClick={() => sendMessage(qp.prompt)}
                disabled={isLoading}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border border-border bg-secondary/50 text-muted-foreground hover:text-foreground hover:border-teal-500/30 hover:bg-teal-500/5 transition-all whitespace-nowrap disabled:opacity-40"
              >
                <span>{qp.icon}</span>
                {qp.label}
              </button>
            ))}
          </div>
        </div>

        {/* Input */}
        <div className="px-6 py-4 border-t border-border shrink-0">
          <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-secondary border border-border focus-within:border-teal-500/40 transition-colors">
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() } }}
              placeholder="Ask anything about your business... (Enter to send)"
              className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
              disabled={isLoading}
            />

            <button
              onClick={toggleVoice}
              className={cn(
                'p-1.5 rounded-lg transition-all',
                isListening
                  ? 'text-red-400 bg-red-500/10 animate-pulse'
                  : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
              )}
            >
              {isListening ? <MicOff size={16} /> : <Mic size={16} />}
            </button>

            <button
              id="ai-send-btn"
              onClick={() => sendMessage()}
              disabled={!input.trim() || isLoading}
              className={cn(
                'p-2 rounded-lg transition-all',
                input.trim() && !isLoading
                  ? 'bg-teal-500 text-white hover:bg-teal-400 shadow-glow-teal'
                  : 'bg-secondary text-muted-foreground cursor-not-allowed'
              )}
            >
              <Send size={16} />
            </button>
          </div>

          <p className="text-[10px] text-muted-foreground mt-2 text-center">
            AI can make mistakes. Verify important data before taking action.
          </p>
        </div>
      </div>
    </div>
  )
}
