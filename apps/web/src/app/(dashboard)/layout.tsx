'use client'

import { useEffect, useState } from 'react'
import { Sidebar } from '@/components/layout/Sidebar'
import { TopBar } from '@/components/layout/TopBar'
import { cn } from '@/lib/utils'
import { loadAppSettings } from '@/lib/appSettings'

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  // Display preferences are fetched once per session, before the first screen
  // renders dates or paginates a list.
  useEffect(() => {
    void loadAppSettings()
  }, [])

  /**
   * Publishes the sidebar's current width so anything outside this markup can
   * line up with it.
   *
   * A dialog is rendered into the document body, not into this tree, so it
   * cannot read `sidebarCollapsed` from here. Without this it would have to
   * guess, and a guess would be wrong every time somebody collapsed the
   * sidebar.
   */
  useEffect(() => {
    /*
     * Below lg the sidebar is a drawer over the page rather than a column
     * beside it, so it takes no width in the layout and anything lining up
     * with it must line up with nothing. Reported as 0px there, which is what
     * the purchase order form's overlay reads to decide where to start.
     *
     * Matched with the same 1024px Tailwind uses for `lg`, and re-read on
     * resize — somebody turning a tablet from portrait to landscape crosses
     * this line without reloading.
     */
    const publish = () => {
      const beside = window.matchMedia('(min-width: 1024px)').matches
      document.documentElement.style.setProperty(
        '--sidebar-current-width',
        !beside ? '0px' : sidebarCollapsed ? '68px' : '260px',
      )
    }
    publish()
    window.addEventListener('resize', publish)
    return () => window.removeEventListener('resize', publish)
  }, [sidebarCollapsed])

  return (
<div className="min-h-screen bg-background">
      <Sidebar
        collapsed={sidebarCollapsed}
        onCollapse={setSidebarCollapsed}
        mobileOpen={mobileNavOpen}
        onMobileClose={() => setMobileNavOpen(false)}
      />

      {/* The page behind the drawer, dimmed and tappable to shut it. Only
          where the sidebar is a drawer; from lg up there is nothing to
          dismiss. */}
      {mobileNavOpen && (
        <div
          className="fixed inset-0 z-[35] bg-black/50 backdrop-blur-sm lg:hidden"
          onClick={() => setMobileNavOpen(false)}
          aria-hidden
        />
      )}

      <div
        className={cn(
          'transition-all duration-300 min-h-screen flex flex-col min-w-0',
          /* No margin below lg: the sidebar is over the page there, not
             beside it, and a 260px margin on a 390px screen was the whole
             problem. */
          sidebarCollapsed ? 'lg:ml-[68px]' : 'lg:ml-[260px]'
        )}
      >
        <TopBar
          sidebarCollapsed={sidebarCollapsed}
          onOpenMobileNav={() => setMobileNavOpen(true)}
        />

        {/* 16px of padding on a phone rather than 24px. On a 390px screen
            the old padding was 12% of the width.

            `min-w-0` here and on the column above, so neither refuses to
            go narrower than its content's own minimum.

            No width cap: on a wide screen the lists use all of it, rather
            than sitting in a 1600px column with empty space either side. */}
        <main className="min-w-0 flex-1 overflow-auto p-4 sm:p-6 lg:px-4">
          <div className="min-w-0 animate-fade-in">
            {children}
          </div>
        </main>
      </div>
    </div>
  )
}
