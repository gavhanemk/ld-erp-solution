'use client'

import { Bot, Send, Zap, Mic } from 'lucide-react'
import { useState } from 'react'
import Link from 'next/link'

const suggestions = [
  "Today's production?",
  "Pending POs",
  "Low stock alerts",
  "Outstanding dues",
]

export function AIAssistantWidget() {
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<{ role: 'user' | 'ai'; text: string }[]>([
    { role: 'ai', text: '👋 Hi! Ask me anything about your ERP — orders, stock, production, or accounts.' },
  ])
  const [loading, setLoading] = useState(false)

  const handleSend = async (text?: string) => {
    const msg = text || input
    if (!msg.trim()) return
    setMessages((m) => [...m, { role: 'user', text: msg }])
    setInput('')
    setLoading(true)

    // Simulate AI response (replace with real API call)
    await new Promise((r) => setTimeout(r, 1200))
    setMessages((m) => [
      ...m,
      { role: 'ai', text: `Fetching data for: "${msg}"... (Connect AI API to get real answers)` },
    ])
    setLoading(false)
  }

  return (
    <div className="glass-card p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-teal-500/15 border border-teal-500/20 flex items-center justify-center">
            <Bot size={14} className="text-teal-400" />
          </div>
          <div>
            <p className="text-xs font-semibold text-foreground">AI Assistant</p>
            <p className="text-[10px] text-muted-foreground flex items-center gap-1">
              <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full" />
              Online · Gemini
            </p>
          </div>
        </div>
        <Link href="/ai" className="text-[10px] text-teal-400 hover:text-teal-300 transition-colors">
          Full chat →
        </Link>
      </div>

      {/* Messages */}
      <div className="space-y-2 mb-3 max-h-32 overflow-y-auto no-scrollbar">
        {messages.slice(-3).map((m, i) => (
          <div
            key={i}
            className={m.role === 'user' ? 'ai-bubble-user text-right' : 'ai-bubble-assistant'}
          >
            {m.text}
          </div>
        ))}
        {loading && (
          <div className="ai-bubble-assistant">
            <div className="flex gap-1">
              <span className="w-1.5 h-1.5 bg-teal-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 bg-teal-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1.5 h-1.5 bg-teal-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
        )}
      </div>

      {/* Quick suggestions */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {suggestions.map((s) => (
          <button
            key={s}
            onClick={() => handleSend(s)}
            className="text-[10px] px-2 py-1 rounded-full bg-secondary border border-border text-muted-foreground hover:text-teal-400 hover:border-teal-500/30 transition-colors"
          >
            {s}
          </button>
        ))}
      </div>

      {/* Input */}
      <div className="flex items-center gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          placeholder="Ask anything..."
          className="flex-1 text-xs bg-secondary border border-border rounded-lg px-3 py-2 text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-teal-500/50"
        />
        <button
          onClick={() => handleSend()}
          className="p-2 rounded-lg bg-teal-500/10 border border-teal-500/20 text-teal-400 hover:bg-teal-500/20 transition-colors"
        >
          <Send size={13} />
        </button>
      </div>
    </div>
  )
}
