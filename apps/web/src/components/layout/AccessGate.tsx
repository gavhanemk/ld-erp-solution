'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Lock } from 'lucide-react'
import { canOpen, loadAccess, useAccess } from '@/lib/access'

/**
 * Turns a page away when the signed-in role may not open it.
 *
 * The menu already leaves such a page out, but an address can still be typed,
 * bookmarked or followed from a link. Without this the page would open and
 * every request on it come back refused — a screen of red boxes that says
 * nothing about why. The server stays the guard either way.
 *
 * Access is read when the app opens and every five minutes after, so a role
 * changed in Settings → People reaches an open screen without a sign-out.
 */
export function AccessGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const access = useAccess()

  useEffect(() => {
    void loadAccess()
    const timer = setInterval(() => void loadAccess(), 5 * 60_000)
    return () => clearInterval(timer)
  }, [])

  if (!access.loaded || canOpen(pathname)) return <>{children}</>

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="border-border bg-card max-w-md rounded-xl border p-8 text-center shadow-sm">
        <span className="bg-secondary mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full">
          <Lock size={20} className="text-muted-foreground" />
        </span>
        <h1 className="text-foreground text-lg font-semibold">This screen is not open to your role</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          You are signed in as <span className="text-foreground font-medium">{access.role}</span>. Ask an
          administrator to allow it in Settings → People if you need it.
        </p>
        <Link href="/dashboard" className="btn-primary mt-5 inline-flex">
          Back to the dashboard
        </Link>
      </div>
    </div>
  )
}
