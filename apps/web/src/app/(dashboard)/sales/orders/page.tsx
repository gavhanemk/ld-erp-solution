import type { Metadata } from 'next'
import Link from 'next/link'
import { Plus, Filter, Download, Search } from 'lucide-react'

export const metadata: Metadata = { title: 'Sales Orders' }

const STATUS_CONFIG: Record<string, { label: string; cls: string }> = {
  DRAFT: { label: 'Draft', cls: 'badge-neutral' },
  CONFIRMED: { label: 'Confirmed', cls: 'badge-info' },
  IN_PRODUCTION: { label: 'In Production', cls: 'badge-warning' },
  PARTIALLY_DISPATCHED: { label: 'Part Dispatched', cls: 'badge-success' },
  COMPLETED: { label: 'Completed', cls: 'badge-success' },
  CANCELLED: { label: 'Cancelled', cls: 'badge-danger' },
}

// Mock data — replace with API call
const MOCK_ORDERS = [
  { id: '1', soNumber: 'SO-2425-0045', customer: 'Rajan Traders', brand: 'LD Cotton Mills', style: 'SS-Slim-101', totalQty: 500, totalAmount: 225000, deliveryDate: '2025-08-28', status: 'IN_PRODUCTION', isJobWork: false },
  { id: '2', soNumber: 'SO-2425-0044', customer: 'Sunrise Fashion', brand: 'VHAGAR', style: 'VHG-Classic-002', totalQty: 200, totalAmount: 120000, deliveryDate: '2025-08-25', status: 'CONFIRMED', isJobWork: false },
  { id: '3', soNumber: 'SO-2425-0043', customer: 'Metro Garments', brand: 'LD Cotton Mills', style: 'SS-Regular-205', totalQty: 1000, totalAmount: 450000, deliveryDate: '2025-09-30', status: 'IN_PRODUCTION', isJobWork: false },
  { id: '4', soNumber: 'SO-2425-0042', customer: 'Aaryan Exports', brand: 'LD Cotton Mills', style: 'JW-Export-301', totalQty: 2000, totalAmount: 0, deliveryDate: '2025-09-15', status: 'IN_PRODUCTION', isJobWork: true },
  { id: '5', soNumber: 'SO-2425-0041', customer: 'Balaji Textiles', brand: 'LD Cotton Mills', style: 'SS-Slim-101', totalQty: 300, totalAmount: 135000, deliveryDate: '2025-09-10', status: 'PARTIALLY_DISPATCHED', isJobWork: false },
]

export default function SalesOrdersPage() {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Sales Orders</h1>
          <p className="page-subtitle">{MOCK_ORDERS.length} active orders</p>
        </div>
        <div className="flex items-center gap-3">
          <button className="btn-secondary">
            <Download size={16} />
            Export
          </button>
          <Link href="/sales/orders/new" className="btn-primary" id="new-so-btn">
            <Plus size={16} />
            New Order
          </Link>
        </div>
      </div>

      {/* Filters */}
      <div className="glass-card p-4 flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-60 flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary border border-border">
          <Search size={15} className="text-muted-foreground" />
          <input placeholder="Search order #, customer, style..." className="bg-transparent text-sm text-foreground placeholder:text-muted-foreground flex-1 focus:outline-none" />
        </div>
        <select className="form-input w-auto">
          <option value="">All Status</option>
          {Object.entries(STATUS_CONFIG).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <select className="form-input w-auto">
          <option value="">All Brands</option>
          <option>LD Cotton Mills</option>
          <option>VHAGAR</option>
        </select>
        <select className="form-input w-auto">
          <option value="">All Types</option>
          <option value="false">Regular</option>
          <option value="true">Job Work</option>
        </select>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Total Orders', value: MOCK_ORDERS.length, color: 'text-foreground' },
          { label: 'In Production', value: MOCK_ORDERS.filter(o => o.status === 'IN_PRODUCTION').length, color: 'text-amber-400' },
          { label: 'Total Qty', value: MOCK_ORDERS.reduce((s, o) => s + o.totalQty, 0).toLocaleString(), color: 'text-teal-400' },
          { label: 'Total Value', value: `₹${(MOCK_ORDERS.reduce((s, o) => s + o.totalAmount, 0) / 100000).toFixed(1)}L`, color: 'text-emerald-400' },
        ].map((stat) => (
          <div key={stat.label} className="glass-card p-4 text-center">
            <p className={`text-2xl font-bold ${stat.color}`}>{stat.value}</p>
            <p className="text-xs text-muted-foreground mt-1">{stat.label}</p>
          </div>
        ))}
      </div>

      {/* Orders Table */}
      <div className="glass-card p-6">
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Order #</th>
                <th>Customer</th>
                <th>Brand</th>
                <th>Style</th>
                <th>Type</th>
                <th className="text-right">Qty</th>
                <th className="text-right">Amount</th>
                <th>Delivery</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {MOCK_ORDERS.map((order) => {
                const s = STATUS_CONFIG[order.status] || { label: order.status, cls: 'badge-neutral' }
                const isOverdue = new Date(order.deliveryDate) < new Date() && order.status !== 'COMPLETED'

                return (
                  <tr key={order.id}>
                    <td>
                      <Link href={`/sales/orders/${order.id}`} className="font-mono text-xs text-teal-400 hover:text-teal-300 transition-colors">
                        {order.soNumber}
                      </Link>
                    </td>
                    <td className="font-medium">{order.customer}</td>
                    <td>
                      <span className={order.brand === 'VHAGAR' ? 'vhagar-accent font-bold text-xs' : 'text-muted-foreground text-xs'}>
                        {order.brand}
                      </span>
                    </td>
                    <td className="font-mono text-xs text-muted-foreground">{order.style}</td>
                    <td>
                      {order.isJobWork
                        ? <span className="badge-purple">Job Work</span>
                        : <span className="badge-neutral">Regular</span>}
                    </td>
                    <td className="text-right font-semibold">{order.totalQty.toLocaleString()}</td>
                    <td className="text-right font-semibold">
                      {order.totalAmount ? `₹${(order.totalAmount / 1000).toFixed(1)}K` : '—'}
                    </td>
                    <td className={isOverdue ? 'text-red-400 text-xs font-semibold' : 'text-muted-foreground text-xs'}>
                      {order.deliveryDate}
                      {isOverdue && ' ⚠️'}
                    </td>
                    <td><span className={s.cls}>{s.label}</span></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
