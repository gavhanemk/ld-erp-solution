'use client'

import { useState } from 'react'
import { Bell, Search, Sun, Moon, Zap, ChevronDown } from 'lucide-react'
import Link from 'next/link'

interface TopBarProps {
  sidebarCollapsed: boolean
}

export function TopBar({ sidebarCollapsed: _ }: TopBarProps) {
  const [isDark, setIsDark] = useState(true)
  const [notifOpen, setNotifOpen] = useState(false)

  const greeting = () => {
    const h = new Date().getHours()
    if (h < 12) return 'Good Morning'
    if (h < 17) return 'Good Afternoon'
    return 'Good Evening'
  }

  return (
    <header className="h-16 border-b border-border flex items-center px-6 gap-4 sticky top-0 z-30 bg-background/80 backdrop-blur-md">
      {/* Greeting */}
      <div className="flex-1">
        <p className="text-sm font-medium text-foreground">
          {greeting()}, <span className="text-teal-400">Mahesh</span> 👋
        </p>
        <p className="text-xs text-muted-foreground">
          {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        </p>
      </div>

      {/* Search */}
      <div className="hidden md:flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary border border-border w-72 cursor-pointer hover:border-teal-500/30 transition-colors group">
        <Search size={14} className="text-muted-foreground group-hover:text-teal-400 transition-colors" />
        <span className="text-sm text-muted-foreground flex-1">Search anything...</span>
        <kbd className="text-[10px] text-muted-foreground bg-background px-1.5 py-0.5 rounded border border-border">⌘K</kbd>
      </div>

      {/* AI Quick Button */}
      <Link
        href="/ai"
        className="hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-teal-500/10 border border-teal-500/20 hover:bg-teal-500/20 transition-all text-xs font-medium text-teal-400"
      >
        <Zap size={13} />
        Ask AI
      </Link>

      {/* Notifications */}
      <div className="relative">
        <button
          id="notif-btn"
          onClick={() => setNotifOpen(!notifOpen)}
          className="relative p-2 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
        >
          <Bell size={18} />
          {/* Badge */}
          <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full ring-2 ring-background" />
        </button>

        {notifOpen && (
          <div className="absolute right-0 top-12 w-80 glass-card p-0 overflow-hidden animate-fade-in z-50">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between">
              <p className="text-sm font-semibold">Notifications</p>
              <span className="badge-info text-[10px]">3 new</span>
            </div>
            <div className="divide-y divide-border/50">
              {[
                { title: 'Low Stock Alert', desc: 'White Fabric below reorder level', time: '5m ago', color: 'amber' },
                { title: 'PO Approval Pending', desc: 'PO-2425-0012 awaiting your approval', time: '1h ago', color: 'teal' },
                { title: 'Payment Received', desc: '₹2.4L received from Rajan Traders', time: '2h ago', color: 'green' },
              ].map((n, i) => (
                <div key={i} className="px-4 py-3 hover:bg-white/[0.02] cursor-pointer transition-colors">
                  <p className="text-sm font-medium text-foreground">{n.title}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{n.desc}</p>
                  <p className="text-[10px] text-muted-foreground/60 mt-1">{n.time}</p>
                </div>
              ))}
            </div>
            <div className="px-4 py-2.5 border-t border-border text-center">
              <button className="text-xs text-teal-400 hover:text-teal-300 transition-colors">
                View all notifications
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Theme Toggle */}
      <button
        onClick={() => setIsDark(!isDark)}
        className="p-2 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
      >
        {isDark ? <Sun size={18} /> : <Moon size={18} />}
      </button>

      {/* User Avatar */}
      <button className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-secondary transition-colors">
        <div className="w-8 h-8 rounded-full bg-teal-500/20 border border-teal-500/30 flex items-center justify-center">
          <span className="text-xs font-bold text-teal-400">MG</span>
        </div>
        <ChevronDown size={14} className="text-muted-foreground" />
      </button>
    </header>
  )
}
