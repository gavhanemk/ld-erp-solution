'use client'

import { ActiveBadge, MasterTable, type Column } from '@/components/masters/MasterTable'
import type { FormField } from '@/components/masters/MasterFormDialog'

interface Style {
  id: string
  code: string
  name: string
  season: string | null
  brandType: 'LD_COTTON_MILLS' | 'VHAGAR' | 'CUSTOM'
  category: string | null
  collarType: string | null
  sleeveType: string | null
  fit: string | null
  fabricType: string | null
  gsm: number | null
  sizeSet: string[]
  colors: string[]
  isActive: boolean
}

const BRAND_LABEL: Record<Style['brandType'], string> = {
  LD_COTTON_MILLS: 'LD Cotton Mills',
  VHAGAR: 'VHAGAR',
  CUSTOM: 'Custom',
}

const columns: Column<Style>[] = [
  { key: 'code', header: 'Style Code', sortable: true, className: 'font-mono text-xs text-teal-400' },
  { key: 'name', header: 'Style Name', sortable: true, className: 'font-medium' },
  {
    key: 'brandType',
    header: 'Brand',
    render: (s) => (
      <span
        className={
          s.brandType === 'VHAGAR' ? 'vhagar-accent font-bold text-xs' : 'text-muted-foreground text-xs'
        }
      >
        {BRAND_LABEL[s.brandType] ?? s.brandType}
      </span>
    ),
  },
  {
    key: 'category',
    header: 'Garment',
    render: (s) => s.category ?? <span className="text-muted-foreground">—</span>,
  },
  { key: 'season', header: 'Season', sortable: true },
  {
    key: 'fabric',
    header: 'Fabric',
    render: (s) => (
      <span className="text-xs">
        {s.fabricType ?? '—'}
        {s.gsm ? <span className="text-muted-foreground"> · {s.gsm} GSM</span> : null}
      </span>
    ),
  },
  {
    key: 'construction',
    header: 'Construction',
    render: (s) => {
      const parts = [s.collarType, s.sleeveType, s.fit].filter(Boolean)
      return parts.length ? (
        <span className="text-xs text-muted-foreground">{parts.join(' · ')}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      )
    },
  },
  {
    key: 'sizeSet',
    header: 'Sizes',
    render: (s) =>
      s.sizeSet?.length ? (
        <span className="font-mono text-xs">{s.sizeSet.join('/')}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    key: 'colors',
    header: 'Colours',
    align: 'center',
    render: (s) =>
      s.colors?.length ? (
        <span className="badge-neutral" title={s.colors.join(', ')}>
          {s.colors.length}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  { key: 'isActive', header: 'Status', render: (s) => <ActiveBadge isActive={s.isActive} /> },
]

const formFields: FormField[] = [
  { name: 'code', label: 'Style Code', required: true, placeholder: 'SS-SLIM-101', section: 'Identity' },
  { name: 'name', label: 'Style Name', required: true, placeholder: 'Slim Fit Formal Shirt', section: 'Identity' },
  {
    name: 'brandType',
    label: 'Brand',
    type: 'select',
    required: true,
    section: 'Identity',
    options: Object.entries(BRAND_LABEL).map(([value, label]) => ({ value, label })),
  },
  { name: 'category', label: 'Garment Type', section: 'Identity', placeholder: 'Shirt' },
  { name: 'season', label: 'Season', section: 'Identity', placeholder: 'SS26' },
  { name: 'collarType', label: 'Collar Type', section: 'Construction', placeholder: 'Cutaway' },
  { name: 'sleeveType', label: 'Sleeve Type', section: 'Construction', placeholder: 'Full sleeve' },
  { name: 'fit', label: 'Fit', section: 'Construction', placeholder: 'Slim' },
  { name: 'fabricType', label: 'Fabric', section: 'Construction', placeholder: 'Cotton Poplin' },
  { name: 'gsm', label: 'GSM', type: 'number', section: 'Construction', placeholder: '120' },
  {
    name: 'sizeSet',
    label: 'Size Set',
    type: 'tags',
    section: 'Size & Colour',
    span: 2,
    placeholder: 'S, M, L, XL, XXL',
    help: 'Separate sizes with commas, in the order they should appear',
  },
  {
    name: 'colors',
    label: 'Colours',
    type: 'tags',
    section: 'Size & Colour',
    span: 2,
    placeholder: 'White, Sky Blue, Navy',
    help: 'Separate colours with commas',
  },
  { name: 'isActive', label: 'Active', type: 'checkbox', placeholder: 'Available for new orders', section: 'Size & Colour' },
]

export default function StylesPage() {
  return (
    <MasterTable<Style>
      title="Styles & SKUs"
      entityName="Style"
      resource="styles"
      columns={columns}
      formFields={formFields}
      defaultSort="code"
      searchPlaceholder="Search style code, name, season, fabric..."
      emptyMessage="No styles yet. Add a style, then build its bill of materials."
    />
  )
}
