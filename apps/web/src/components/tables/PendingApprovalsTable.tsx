'use client'

import { CheckCircle2, Clock, Eye } from 'lucide-react'
import Link from 'next/link'

const approvals = [
  {
    id: 'A1',
    type: 'PO',
    number: 'PO-2425-0012',
    description: 'Sunrise Fabrics — White Cotton Fabric',
    amount: '₹1,20,000',
    requestedBy: 'Ravi Kumar',
    date: '21 Aug 2025',
    urgent: true,
  },
  {
    id: 'A2',
    type: 'SO',
    number: 'SO-2425-0045',
    description: 'Rajan Traders — 500 pcs Men\'s Shirt',
    amount: '₹2,25,000',
    requestedBy: 'Sales Team',
    date: '21 Aug 2025',
    urgent: false,
  },
  {
    id: 'A3',
    type: 'MR',
    number: 'MR-2425-0023',
    description: 'Line 2 — White Thread 50 rolls',
    amount: '—',
    requestedBy: 'Stitching Dept',
    date: '20 Aug 2025',
    urgent: false,
  },
  {
    id: 'A4',
    type: 'PO',
    number: 'PO-2425-0013',
    description: 'Mehta Buttons — Buttons & Accessories',
    amount: '₹28,500',
    requestedBy: 'Store Manager',
    date: '20 Aug 2025',
    urgent: false,
  },
]

const typeColors: Record<string, string> = {
  PO: 'badge-info',
  SO: 'badge-success',
  MR: 'badge-warning',
}

export function PendingApprovalsTable() {
  return (
    <div className="glass-card p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Clock size={15} className="text-amber-400" />
            Pending Approvals
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">{approvals.length} items waiting</p>
        </div>
        <Link href="/approvals" className="text-xs text-teal-400 hover:text-teal-300 transition-colors">
          View all
        </Link>
      </div>

      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Document</th>
              <th>Description</th>
              <th>Amount</th>
              <th>Requested By</th>
              <th>Date</th>
              <th className="text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {approvals.map((a) => (
              <tr key={a.id}>
                <td>
                  <span className={typeColors[a.type] || 'badge-neutral'}>
                    {a.type}
                  </span>
                </td>
                <td>
                  <span className="font-mono text-xs text-teal-400">{a.number}</span>
                  {a.urgent && (
                    <span className="ml-2 text-[10px] text-red-400 font-semibold">URGENT</span>
                  )}
                </td>
                <td className="max-w-[200px] truncate text-muted-foreground">{a.description}</td>
                <td className="font-semibold text-foreground">{a.amount}</td>
                <td className="text-muted-foreground">{a.requestedBy}</td>
                <td className="text-muted-foreground text-xs">{a.date}</td>
                <td>
                  <div className="flex items-center gap-2 justify-end">
                    <button
                      id={`approve-${a.id}`}
                      className="flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 transition-colors"
                    >
                      <CheckCircle2 size={12} />
                      Approve
                    </button>
                    <button
                      id={`view-${a.id}`}
                      className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                    >
                      <Eye size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
