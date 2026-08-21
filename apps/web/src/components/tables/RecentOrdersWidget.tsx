'use client'

import Link from 'next/link'
import { ExternalLink } from 'lucide-react'

const orders = [
  { id: 'SO-2425-0045', customer: 'Rajan Traders', brand: 'LD', style: 'SS-Slim-101', qty: 500, amount: '₹2,25,000', delivery: '28 Aug 2025', status: 'IN_PRODUCTION' },
  { id: 'SO-2425-0044', customer: 'Sunrise Fashion', brand: 'VHAGAR', style: 'VHG-Classic-002', qty: 200, amount: '₹1,20,000', delivery: '25 Aug 2025', status: 'CONFIRMED' },
  { id: 'SO-2425-0043', customer: 'Metro Garments', brand: 'LD', style: 'SS-Regular-205', qty: 1000, amount: '₹4,50,000', delivery: '30 Sep 2025', status: 'IN_PRODUCTION' },
  { id: 'SO-2425-0042', customer: 'JW: Aaryan Exports', brand: 'LD', style: 'JW-Export-301', qty: 2000, amount: '—', delivery: '15 Sep 2025', status: 'CUTTING' },
  { id: 'SO-2425-0041', customer: 'Balaji Textiles', brand: 'LD', style: 'SS-Slim-101', qty: 300, amount: '₹1,35,000', delivery: '10 Sep 2025', status: 'PARTIALLY_DISPATCHED' },
]

const statusMap: Record<string, { label: string; cls: string }> = {
  DRAFT: { label: 'Draft', cls: 'badge-neutral' },
  CONFIRMED: { label: 'Confirmed', cls: 'badge-info' },
  IN_PRODUCTION: { label: 'In Production', cls: 'badge-warning' },
  CUTTING: { label: 'Cutting', cls: 'badge-purple' },
  PARTIALLY_DISPATCHED: { label: 'Part Dispatched', cls: 'badge-success' },
  COMPLETED: { label: 'Completed', cls: 'badge-success' },
}

export function RecentOrdersWidget() {
  return (
    <div className="glass-card p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Recent Sales Orders</h3>
          <p className="text-xs text-muted-foreground mt-0.5">Latest {orders.length} orders</p>
        </div>
        <Link href="/sales/orders" className="btn-ghost text-xs">
          View all <ExternalLink size={12} />
        </Link>
      </div>

      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Order #</th>
              <th>Customer</th>
              <th>Brand</th>
              <th>Style</th>
              <th>Qty</th>
              <th>Amount</th>
              <th>Delivery</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => {
              const s = statusMap[o.status] || { label: o.status, cls: 'badge-neutral' }
              return (
                <tr key={o.id} className="cursor-pointer">
                  <td>
                    <Link href={`/sales/orders/${o.id}`} className="font-mono text-xs text-teal-400 hover:text-teal-300 transition-colors">
                      {o.id}
                    </Link>
                  </td>
                  <td className="font-medium text-foreground">{o.customer}</td>
                  <td>
                    <span className={o.brand === 'VHAGAR' ? 'vhagar-accent text-xs font-bold' : 'text-xs text-muted-foreground'}>
                      {o.brand}
                    </span>
                  </td>
                  <td className="text-muted-foreground text-xs font-mono">{o.style}</td>
                  <td className="font-semibold">{o.qty.toLocaleString()}</td>
                  <td className="font-semibold text-foreground">{o.amount}</td>
                  <td className="text-xs text-muted-foreground">{o.delivery}</td>
                  <td><span className={s.cls}>{s.label}</span></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
