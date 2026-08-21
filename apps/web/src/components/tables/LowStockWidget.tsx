'use client'

import { AlertTriangle } from 'lucide-react'

const items = [
  { id: 'I1', name: 'White Poplin Fabric', code: 'FAB-001', stock: '42 mtr', reorder: '100 mtr', status: 'critical' },
  { id: 'I2', name: 'White Thread (50s)', code: 'THR-012', stock: '8 rolls', reorder: '20 rolls', status: 'low' },
  { id: 'I3', name: 'Button 14mm White', code: 'BTN-034', stock: '1200 pcs', reorder: '2000 pcs', status: 'low' },
]

export function LowStockWidget() {
  return (
    <div className="glass-card p-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-red-500/10 border border-red-500/20">
            <AlertTriangle size={14} className="text-red-400" />
          </div>
          <h3 className="text-xs font-semibold text-foreground">Low Stock Alerts</h3>
        </div>
        <span className="badge-danger">{items.length} items</span>
      </div>

      <div className="space-y-3">
        {items.map((item) => (
          <div key={item.id} className="flex items-center gap-3">
            <div className={`w-2 h-2 rounded-full shrink-0 ${item.status === 'critical' ? 'bg-red-500 animate-pulse' : 'bg-amber-500'}`} />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-foreground truncate">{item.name}</p>
              <p className="text-[10px] text-muted-foreground">{item.code} · Stock: <span className={item.status === 'critical' ? 'text-red-400 font-semibold' : 'text-amber-400 font-semibold'}>{item.stock}</span></p>
            </div>
          </div>
        ))}
      </div>

      <button className="mt-4 w-full text-xs text-teal-400 hover:text-teal-300 transition-colors py-1.5 border border-teal-500/20 rounded-lg hover:bg-teal-500/5">
        Create Purchase Requisition
      </button>
    </div>
  )
}
