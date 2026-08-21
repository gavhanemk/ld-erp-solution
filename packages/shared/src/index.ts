// LD ERP Solution — Shared Types
// Used across web, mobile, and api packages

export type UserRole = 'Admin' | 'MD' | 'Accounts Manager' | 'Production Manager' | 'Store Manager' | 'HR Manager' | 'Sales'

export type SalesOrderStatus = 'DRAFT' | 'CONFIRMED' | 'IN_PRODUCTION' | 'PARTIALLY_DISPATCHED' | 'COMPLETED' | 'CANCELLED'
export type PurchaseOrderStatus = 'DRAFT' | 'SENT' | 'PARTIALLY_RECEIVED' | 'COMPLETED' | 'CANCELLED'
export type MOStatus = 'DRAFT' | 'RELEASED' | 'CUTTING' | 'STITCHING' | 'FINISHING' | 'QC' | 'PACKING' | 'COMPLETED' | 'CLOSED'
export type BrandType = 'LD_COTTON_MILLS' | 'VHAGAR' | 'CUSTOM'
export type ItemType = 'RAW_MATERIAL' | 'SEMI_FINISHED' | 'FINISHED_GOOD' | 'CONSUMABLE' | 'PACKING_MATERIAL' | 'TRIM'
export type PaymentMode = 'CASH' | 'CHEQUE' | 'NEFT' | 'RTGS' | 'UPI' | 'PDC'

export interface User {
  id: string
  name: string
  email: string
  role: UserRole
  permissions: string[]
  avatarUrl?: string
}

export interface APIResponse<T = unknown> {
  success: boolean
  data?: T
  message?: string
  errors?: unknown[]
  pagination?: {
    page: number
    limit: number
    total: number
    pages: number
  }
}

export interface KPIData {
  activeOrders: number
  todayProduction: {
    achieved: number
    target: number
    efficiency: string
    rejection: number
  }
  pendingApprovals: number
  revenueMTD: number
  outstandingReceivable: number
  outstandingPayable: number
}

export interface SalesOrder {
  id: string
  soNumber: string
  customer: { id: string; name: string; type: string }
  brand: { id: string; name: string; type: BrandType }
  status: SalesOrderStatus
  totalAmount: number
  deliveryDate?: string
  isJobWork: boolean
  createdAt: string
  updatedAt: string
}

export interface ProductionEntry {
  id: string
  moId: string
  entryDate: string
  department: string
  lineNumber?: string
  target: number
  achieved: number
  rejection: number
  efficiency?: number
}

export interface Notification {
  id: string
  title: string
  message: string
  type: 'LOW_STOCK' | 'APPROVAL_PENDING' | 'PAYMENT_RECEIVED' | 'OVERDUE' | 'PRODUCTION_ALERT' | 'SYSTEM'
  isRead: boolean
  createdAt: string
}

// Indian number formatting
export const formatINR = (amount: number): string => {
  if (amount >= 10000000) return `₹${(amount / 10000000).toFixed(2)} Cr`
  if (amount >= 100000) return `₹${(amount / 100000).toFixed(2)} L`
  if (amount >= 1000) return `₹${(amount / 1000).toFixed(1)}K`
  return `₹${amount.toLocaleString('en-IN')}`
}

export const MODULES = [
  'dashboard', 'masters', 'sales', 'purchase', 'inventory',
  'production', 'accounts', 'hr', 'vhagar', 'maintenance', 'ai', 'settings', 'admin'
] as const

export type Module = typeof MODULES[number]

export const ACTIONS = ['view', 'create', 'edit', 'delete', 'approve', 'export'] as const
export type Action = typeof ACTIONS[number]
