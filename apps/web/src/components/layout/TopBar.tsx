'use client'

import { useCallback, useEffect, useState } from 'react'
import { Bell, Search, Sun, Moon, Zap, ChevronDown, BellOff, Menu } from 'lucide-react'
import Link from 'next/link'
import { api, currentUser } from '@/lib/api'
import { formatDate } from '@/lib/utils'

interface TopBarProps {
  sidebarCollapsed: boolean
  /** Opens the navigation drawer, on the screens where the sidebar is one. */
  onOpenMobileNav: () => void
}

interface Notification {
  id: string
  title: string
  message: string
  type: string
  isRead: boolean
  createdAt: string
}

/** "Mahesh Ghavane" -> "MG"; a single name gives its first two letters. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export function TopBar({ sidebarCollapsed: _, onOpenMobileNav }: TopBarProps) {
  const [isDark, setIsDark] = useState(true)
  const [notifOpen, setNotifOpen] = useState(false)
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [unread, setUnread] = useState(0)
  const [user, setUser] = useState<{ name?: string; role?: string } | null>(null)

  // localStorage is only readable in the browser, so this waits for mount.
  useEffect(() => {
    setUser(currentUser())

    const saved = localStorage.getItem('theme')
    const dark = saved !== 'light'
    setIsDark(dark)
    document.documentElement.classList.toggle('light', !dark)
  }, [])

  const loadNotifications = useCallback(async () => {
    try {
      const res = await api.get<{ success: boolean; data: Notification[]; unreadCount: number }>(
        '/notifications?limit=10',
      )
      setNotifications(res.data)
      setUnread(res.unreadCount ?? 0)
    } catch {
      // The bell is not worth an error banner; an empty list is honest enough.
      setNotifications([])
      setUnread(0)
    }
  }, [])

  useEffect(() => {
    void loadNotifications()
    const timer = setInterval(() => void loadNotifications(), 120_000)
    return () => clearInterval(timer)
  }, [loadNotifications])

  const toggleTheme = () => {
    const next = !isDark
    setIsDark(next)
    document.documentElement.classList.toggle('light', !next)
    localStorage.setItem('theme', next ? 'dark' : 'light')
  }

  const markAllRead = async () => {
    try {
      await api.patch('/notifications/read-all', {})
      await loadNotifications()
    } catch {
      // Leave the list as it is; the next refresh will correct it.
    }
  }

  const greeting = () => {
    const h = new Date().getHours()
    if (h < 12) return 'Good Morning'
    if (h < 17) return 'Good Afternoon'
    return 'Good Evening'
  }

  // The first name is friendlier in a greeting than the full name.
  const firstName = user?.name ? user.name.trim().split(/\s+/)[0] : null

  return (
    <header className="h-16 border-b border-border flex items-center px-4 sm:px-6 gap-3 sm:gap-4 sticky top-0 z-30 bg-background/80 backdrop-blur-md">
      {/* The only way to the menu below lg, where the sidebar is a drawer. */}
      <button
        onClick={onOpenMobileNav}
        className="btn-ghost -ml-1 shrink-0 p-2 lg:hidden"
        aria-label="Open the menu"
      >
        <Menu size={18} />
      </button>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">
          {greeting()}
          {firstName && (
            <>
              , <span className="text-teal-400">{firstName}</span> 👋
            </>
          )}
        </p>
        {/* Dropped on a phone. It is the least useful thing in the bar and
            the most expensive: a wrapped date was what pushed everything to
            the right of it off the edge of the screen. */}
        <p className="hidden truncate text-xs text-muted-foreground sm:block">
          {new Date().toLocaleDateString('en-IN', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          })}
        </p>
      </div>

      <div className="hidden md:flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary border border-border w-72 cursor-pointer hover:border-teal-500/30 transition-colors group">
        <Search size={14} className="text-muted-foreground group-hover:text-teal-400 transition-colors" />
        <span className="text-sm text-muted-foreground flex-1">Search anything...</span>
        <kbd className="text-[10px] text-muted-foreground bg-background px-1.5 py-0.5 rounded border border-border">
          ⌘K
        </kbd>
      </div>

      <Link
        href="/ai"
        className="hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-teal-500/10 border border-teal-500/20 hover:bg-teal-500/20 transition-all text-xs font-medium text-teal-400"
      >
        <Zap size={13} />
        Ask AI
      </Link>

      <div className="relative">
        <button
          id="notif-btn"
          onClick={() => setNotifOpen(!notifOpen)}
          className="relative p-2 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
          aria-label={`Notifications${unread > 0 ? `, ${unread} unread` : ''}`}
        >
          <Bell size={18} />
          {/* The dot appears only when something is genuinely unread. */}
          {unread > 0 && (
            <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full ring-2 ring-background" />
          )}
        </button>

        {notifOpen && (
          <div className="absolute right-0 top-12 w-80 glass-card p-0 overflow-hidden animate-fade-in z-50">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between">
              <p className="text-sm font-semibold">Notifications</p>
              {unread > 0 && <span className="badge-info text-[10px]">{unread} new</span>}
            </div>

            {notifications.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <BellOff size={18} className="text-muted-foreground mx-auto mb-2" />
                <p className="text-xs text-muted-foreground">Nothing to catch up on.</p>
              </div>
            ) : (
              <div className="divide-y divide-border/50 max-h-80 overflow-y-auto">
                {notifications.map((n) => (
                  <div
                    key={n.id}
                    className={`px-4 py-3 hover:bg-white/[0.02] transition-colors ${
                      n.isRead ? 'opacity-60' : ''
                    }`}
                  >
                    <p className="text-sm font-medium text-foreground">{n.title}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{n.message}</p>
                    <p className="text-[10px] text-muted-foreground/60 mt-1">
                      {formatDate(n.createdAt, 'relative')}
                    </p>
                  </div>
                ))}
              </div>
            )}

            {unread > 0 && (
              <div className="px-4 py-2.5 border-t border-border text-center">
                <button
                  onClick={() => void markAllRead()}
                  className="text-xs text-teal-400 hover:text-teal-300 transition-colors"
                >
                  Mark all as read
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <button
        onClick={toggleTheme}
        className="shrink-0 p-2 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
        aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      >
        {isDark ? <Sun size={18} /> : <Moon size={18} />}
      </button>

      <button className="flex shrink-0 items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-secondary transition-colors">
        <div className="w-8 h-8 shrink-0 rounded-full bg-teal-500/20 border border-teal-500/30 flex items-center justify-center">
          <span className="text-xs font-bold text-teal-400">
            {user?.name ? initialsOf(user.name) : '—'}
          </span>
        </div>
        <ChevronDown size={14} className="hidden text-muted-foreground sm:block" />
      </button>
    </header>
  )
}
