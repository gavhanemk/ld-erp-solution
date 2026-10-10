/**
 * What GET /api/dashboard/overview sends. A module the signed-in role may not
 * see arrives as null, and its cards are left out rather than shown at nought.
 */

type Change = number | null

export interface StageCount {
  status: string
  label: string
  count: number
  value: number
}

export interface Partner {
  id: string
  name: string
  value: number
  orders: number
}

export interface Ageing {
  total: number
  overdue: number
  overdueCount: number
  dueWeek: number
  buckets: Array<{ key: string; label: string; value: number; count: number }>
}

export interface Check {
  key: string
  module: 'sales' | 'purchase' | 'inventory' | 'production' | 'accounts' | 'approvals'
  label: string
  clear: string
  count: number
  value: number | null
  tone: 'rose' | 'amber' | 'violet' | 'blue'
  href: string | null
}

export interface TrendPoint {
  key: string
  label: string
  booked?: number
  ordered?: number
  received?: number
  stockIn?: number
  stockOut?: number
  produced?: number
  invoiced?: number
  billed?: number
  collected?: number
  paid?: number
}

export interface HomeData {
  generatedAt: string
  today: string
  period: { days: number; from: string; to: string; bucket: 'day' | 'week' | 'month' }
  sales: {
    openOrders: number
    openValue: number
    late: number
    dueWeek: number
    drafts: number
    booked: { value: number; orders: number; change: Change }
    status: StageCount[]
    customers: Partner[]
  } | null
  purchase: {
    openOrders: number
    openValue: number
    late: number
    lateValue: number
    drafts: number
    unbilled: number
    unbilledValue: number
    ordered: { value: number; orders: number; change: Change }
    received: number
    status: StageCount[]
    suppliers: Partner[]
  } | null
  inventory: {
    stockValue: number
    items: number
    byType: Array<{ type: string; label: string; value: number; items: number }>
    toReorder: number
    comingUp: number
    reorder: Array<{ itemId: string; name: string; uom: string; onHand: number; reorderLevel: number; cover: number; low: boolean }>
    mrPending: number
    mrToIssue: number
    jobWorkOpen: number
    jobWorkLate: number
    period: { inValue: number; outValue: number; received: number; issued: number; moves: number }
  } | null
  production: {
    today: { target: number; achieved: number; rejection: number; efficiency: number | null }
    lines: Array<{ line: string; isJobWork: boolean; target: number; achieved: number; rejection: number; efficiency: number | null }>
    fortnight: Array<{ day: string; target: number; achieved: number; rejection: number }>
    stages: Array<{ status: string; label: string; count: number; planned: number }>
    activeOrders: number
    lateOrders: number
    made: { pieces: number; change: Change }
  } | null
  money: {
    receivable: Ageing
    payable: Ageing
    invoiced: { value: number; change: Change }
    billed: { value: number; change: Change }
    collected: { value: number; change: Change }
    paid: { value: number; change: Change }
  } | null
  trend: TrendPoint[]
  checks: Check[]
  activity: {
    heat: Array<{ day: string; total: number; byModule: Record<string, number> }>
    modules: Array<{ module: string; total: number; created: number; changed: number; approved: number; removed: number }>
    feed: Array<{ id: string; at: string; user: string; module: string; action: string; entityType: string; label: string | null }>
  }
}

export interface Approval {
  id: string
  type: 'PO' | 'SO' | 'MR'
  number: string
  description: string
  amount: number | null
  date: string
  urgent: boolean
  /** Who raised it, who therefore may not approve it. */
  raisedById?: string | null
}
