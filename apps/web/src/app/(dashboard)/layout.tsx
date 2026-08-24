'use client'

import { useEffect, useState } from 'react'
import { Sidebar } from '@/components/layout/Sidebar'
import { TopBar } from '@/components/layout/TopBar'
import { cn } from '@/lib/utils'
import { loadAppSettings } from '@/lib/appSettings'

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  // Display preferences are fetched once per session, before the first screen
  // renders dates or paginates a list.
  useEffect(() => {
    void loadAppSettings()
  }, [])

  return (
    <div className="min-h-screen bg-background">
      <Sidebar collapsed={sidebarCollapsed} onCollapse={setSidebarCollapsed} />

      <div
        className={cn(
          'transition-all duration-300 min-h-screen flex flex-col',
          sidebarCollapsed ? 'ml-[68px]' : 'ml-[260px]'
        )}
      >
        <TopBar sidebarCollapsed={sidebarCollapsed} />

        <main className="flex-1 p-6 overflow-auto">
          <div className="max-w-[1600px] mx-auto animate-fade-in">
            {children}
          </div>
        </main>
      </div>
    </div>
  )
}
