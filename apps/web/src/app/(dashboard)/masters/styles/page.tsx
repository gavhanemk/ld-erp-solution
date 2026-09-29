'use client'

import { useState } from 'react'
import { FileSpreadsheet } from 'lucide-react'
import { ActiveBadge, MasterTable, type Column, type FilterDef } from '@/components/masters/MasterTable'
import type { FormField } from '@/components/masters/MasterFormDialog'
import { ImportStylesDialog } from '@/components/masters/ImportStylesDialog'

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
  sizeGroupId: string | null
  sizeGroup: { id: string; name: string } | null
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
    key: 'sizeGroup',
    header: 'Size Run',
    render: (s) =>
      s.sizeGroup ? (
        <span className="text-xs">{s.sizeGroup.name}</span>
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

/*
 * Four across, so the whole style fits without scrolling: what it is on the
 * first rows, how it is made on the next, and the size run beside its
 * colours on the last.
 */
const formFields: FormField[] = [
  { name: 'code', label: 'Style Code', required: true, placeholder: 'LD-SH-2701', section: 'Style' },
  {
    name: 'name',
    label: 'Style Name',
    required: true,
    placeholder: 'Slim Fit Formal Shirt',
    section: 'Style',
    span: 2,
  },
  {
    name: 'brandType',
    label: 'Brand',
    type: 'select',
    required: true,
    section: 'Style',
    options: Object.entries(BRAND_LABEL).map(([value, label]) => ({ value, label })),
  },
  { name: 'category', label: 'Garment Type', section: 'Style', placeholder: 'Shirt' },
  { name: 'season', label: 'Season', section: 'Style', placeholder: 'SS-26' },
  { name: 'fabricType', label: 'Fabric', section: 'Style', placeholder: 'Cotton Poplin' },
  { name: 'gsm', label: 'GSM', type: 'number', section: 'Style', placeholder: '120' },
  { name: 'collarType', label: 'Collar Type', section: 'Construction', placeholder: 'Cutaway' },
  { name: 'sleeveType', label: 'Sleeve Type', section: 'Construction', placeholder: 'Full sleeve' },
  { name: 'fit', label: 'Fit', section: 'Construction', placeholder: 'Slim' },
  {
    name: 'sizeGroupId',
    label: 'Size Run',
    type: 'select',
    section: 'Size & Colour',
    optionsFrom: { resource: 'size-groups' },
    help: 'The sizes it is cut in',
  },
  {
    name: 'colors',
    label: 'Colours',
    type: 'tags',
    section: 'Size & Colour',
    span: 3,
    placeholder: 'White, Sky Blue, Navy',
    help: 'Separate colours with commas',
  },
  { name: 'isActive', label: 'Active', type: 'checkbox', placeholder: 'Available for new orders', section: 'Size & Colour' },
]

/*
 * A dropdown for each thing a style is picked out by. Garment, season,
 * fabric, fit and colour are typed on the style, so their choices are the
 * values in use; each counts what it would leave.
 */
const filterDefs: FilterDef[] = [
  {
    key: 'brandType',
    label: 'Brand',
    facet: 'brandType',
    options: Object.entries(BRAND_LABEL).map(([value, label]) => ({ value, label })),
  },
  { key: 'category', label: 'Garment', facet: 'category', valuesFromFacet: true, noneLabel: 'Not set' },
  { key: 'season', label: 'Season', facet: 'season', valuesFromFacet: true, noneLabel: 'Not set' },
  { key: 'fabricType', label: 'Fabric', facet: 'fabricType', valuesFromFacet: true, noneLabel: 'Not set' },
  { key: 'fit', label: 'Fit', facet: 'fit', valuesFromFacet: true, noneLabel: 'Not set' },
  {
    key: 'sizeGroupId',
    label: 'Size Run',
    facet: 'sizeGroupId',
    optionsFrom: { resource: 'size-groups' },
    noneLabel: 'No size run',
  },
  { key: 'colour', label: 'Colour', facet: 'colour', valuesFromFacet: true, noneLabel: 'No colours' },
]

export default function StylesPage() {
  const [importing, setImporting] = useState(false)
  // Bumped after an import, so the list and its filter counts reload.
  const [refreshKey, setRefreshKey] = useState(0)

  return (
    <>
      <MasterTable<Style>
        title="Styles & SKUs"
        entityName="Style"
        resource="styles"
        columns={columns}
        formFields={formFields}
        formColumns={4}
        filterDefs={filterDefs}
        defaultSort="code"
        searchPlaceholder="Search style code, name, season, fabric..."
        emptyMessage="No styles yet. Add a style, then build its bill of materials."
        refreshKey={refreshKey}
        actions={
          <button type="button" className="btn-secondary" onClick={() => setImporting(true)}>
            <FileSpreadsheet size={16} /> Import
          </button>
        }
      />
      {importing && (
        <ImportStylesDialog onClose={() => setImporting(false)} onImported={() => setRefreshKey((k) => k + 1)} />
      )}
    </>
  )
}
