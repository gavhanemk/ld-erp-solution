import type { Metadata } from 'next'
import Link from 'next/link'
import { Plus, Filter, Download } from 'lucide-react'

export const metadata: Metadata = { title: 'Manufacturing Orders' }

const STATUS_CONFIG: Record<string, { label: string; cls: string; step: number }> = {
  DRAFT: { label: 'Draft', cls: 'badge-neutral', step: 0 },
  RELEASED: { label: 'Released', cls: 'badge-info', step: 1 },
  CUTTING: { label: 'Cutting', cls: 'badge-purple', step: 2 },
  STITCHING: { label: 'Stitching', cls: 'badge-warning', step: 3 },
  FINISHING: { label: 'Finishing', cls: 'badge-warning', step: 4 },
  QC: { label: 'QC', cls: 'badge-info', step: 5 },
  PACKING: { label: 'Packing', cls: 'badge-info', step: 6 },
  COMPLETED: { label: 'Completed', cls: 'badge-success', step: 7 },
}

const MOCK_MOS = [
  { id: 'MO-2425-0021', brand: 'LD Cotton Mills', soRef: 'SO-2425-0045', style: 'SS-Slim-101', color: 'White', qty: 500, cut: 500, stitched: 420, finished: 380, packed: 0, status: 'STITCHING', planned: '2025-08-28' },
  { id: 'MO-2425-0020', brand: 'VHAGAR', soRef: 'SO-2425-0044', style: 'VHG-Classic-002', color: 'Navy Blue', qty: 200, cut: 200, stitched: 200, finished: 200, packed: 180, status: 'PACKING', planned: '2025-08-25' },
  { id: 'MO-2425-0019', brand: 'LD Cotton Mills', soRef: 'SO-2425-0043', style: 'SS-Regular-205', color: 'Sky Blue', qty: 1000, cut: 600, stitched: 0, finished: 0, packed: 0, status: 'CUTTING', planned: '2025-09-30' },
]

export default function ProductionOrdersPage() {
  return (
    <div className="space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Manufacturing Orders</h1>
          <p className="page-subtitle">{MOCK_MOS.length} active orders</p>
        </div>
        <div className="flex items-center gap-3">
          <button className="btn-secondary"><Download size={15} /> Export</button>
          <Link href="/production/orders/new" className="btn-primary" id="new-mo-btn">
            <Plus size={15} /> New MO
          </Link>
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Active MOs', value: MOCK_MOS.length, color: 'text-teal-400' },
          { label: 'In Cutting', value: MOCK_MOS.filter(m => m.status === 'CUTTING').length, color: 'text-purple-400' },
          { label: 'In Stitching', value: MOCK_MOS.filter(m => m.status === 'STITCHING').length, color: 'text-amber-400' },
          { label: 'Total Planned', value: MOCK_MOS.reduce((s, m) => s + m.qty, 0).toLocaleString(), color: 'text-blue-400' },
        ].map((s) => (
          <div key={s.label} className="glass-card p-4 text-center">
            <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
            <p className="text-xs text-muted-foreground mt-1">{s.label}</p>
          </div>
        ))}
      </div>

      {/* MO Cards — Visual Pipeline View */}
      <div className="space-y-4">
        {MOCK_MOS.map((mo) => {
          const s = STATUS_CONFIG[mo.status] || { label: mo.status, cls: 'badge-neutral', step: 0 }
          const steps = ['CUTTING', 'STITCHING', 'FINISHING', 'QC', 'PACKING']
          const efficiencyPct = mo.qty > 0 ? Math.round((mo.stitched / mo.qty) * 100) : 0

          return (
            <div key={mo.id} className="glass-card p-5 hover:border-teal-500/20 transition-all">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <div className="flex items-center gap-3">
                    <Link href={`/production/orders/${mo.id}`} className="font-mono text-sm font-bold text-teal-400 hover:text-teal-300 transition-colors">
                      {mo.id}
                    </Link>
                    <span className={s.cls}>{s.label}</span>
                    <span className={mo.brand === 'VHAGAR' ? 'vhagar-accent text-xs font-bold' : 'text-xs text-muted-foreground'}>
                      {mo.brand}
                    </span>
                  </div>
                  <p className="text-sm text-foreground mt-1">
                    <span className="font-mono">{mo.style}</span>
                    <span className="text-muted-foreground"> · {mo.color} · Ref: {mo.soRef}</span>
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-xl font-bold text-foreground">{mo.qty.toLocaleString()}</p>
                  <p className="text-xs text-muted-foreground">Total pieces</p>
                </div>
              </div>

              {/* Production Pipeline */}
              <div className="grid grid-cols-5 gap-2 mb-4">
                {[
                  { label: 'Cut', qty: mo.cut },
                  { label: 'Stitched', qty: mo.stitched },
                  { label: 'Finished', qty: mo.finished },
                  { label: 'QC Pass', qty: mo.finished },
                  { label: 'Packed', qty: mo.packed },
                ].map((stage, i) => {
                  const pct = mo.qty > 0 ? Math.round((stage.qty / mo.qty) * 100) : 0
                  return (
                    <div key={i} className="text-center">
                      <div className="h-1.5 bg-secondary rounded-full mb-1.5 overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-700"
                          style={{
                            width: `${pct}%`,
                            background: pct === 100 ? '#10b981' : pct > 50 ? '#14b8a6' : '#f59e0b',
                          }}
                        />
                      </div>
                      <p className="text-xs font-semibold text-foreground">{stage.qty.toLocaleString()}</p>
                      <p className="text-[10px] text-muted-foreground">{stage.label}</p>
                    </div>
                  )
                })}
              </div>

              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Planned delivery: <span className="text-foreground font-medium">{mo.planned}</span></span>
                <span>Stitching progress: <span className={`font-bold ${efficiencyPct >= 80 ? 'text-emerald-400' : efficiencyPct >= 50 ? 'text-amber-400' : 'text-red-400'}`}>{efficiencyPct}%</span></span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
