import type { Metadata } from 'next'
import { KPICards } from '@/components/charts/KPICards'
import { RevenueChart } from '@/components/charts/RevenueChart'
import { OrderStatusChart } from '@/components/charts/OrderStatusChart'
import { PendingApprovalsTable } from '@/components/tables/PendingApprovalsTable'
import { ProductionSummaryWidget } from '@/components/charts/ProductionSummaryWidget'
import { AIAssistantWidget } from '@/components/ai/AIAssistantWidget'
import { RecentOrdersWidget } from '@/components/tables/RecentOrdersWidget'
import { LowStockWidget } from '@/components/tables/LowStockWidget'

export const metadata: Metadata = {
  title: 'Dashboard',
}

export default function DashboardPage() {
  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="page-subtitle">Overview of LD Cotton Mills operations</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground bg-secondary border border-border px-3 py-1.5 rounded-lg">
          <span className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
          Live Data
        </div>
      </div>

      {/* KPI Cards Row */}
      <KPICards />

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <RevenueChart />
        </div>
        <OrderStatusChart />
      </div>

      {/* Production Summary */}
      <ProductionSummaryWidget />

      {/* Bottom Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Pending Approvals */}
        <div className="lg:col-span-2">
          <PendingApprovalsTable />
        </div>

        {/* Right Column */}
        <div className="space-y-6">
          <LowStockWidget />
          <AIAssistantWidget />
        </div>
      </div>

      {/* Recent Orders */}
      <RecentOrdersWidget />
    </div>
  )
}
