'use client'

import { useMemo, useState } from 'react'
import { Barcode, FileSpreadsheet } from 'lucide-react'
import { StyleBarcodesDialog } from '@/components/masters/StyleBarcodesDialog'
import { ActiveBadge, MasterTable, type Column, type FilterDef } from '@/components/masters/MasterTable'
import { BRAND_LABEL, styleFormFields } from '@/components/masters/styleFormFields'
import { ImportStylesDialog } from '@/components/masters/ImportStylesDialog'

interface Style {
  id: string
  code: string
  name: string
  season: string | null
  brandType: 'LD_COTTON_MILLS' | 'VHAGAR' | 'CUSTOM'
  brand?: { id: string; name: string } | null
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

const baseColumns: Column<Style>[] = [
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
        {s.brand?.name ?? BRAND_LABEL[s.brandType] ?? s.brandType}
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
  const [barcodesFor, setBarcodesFor] = useState<string | null>(null)

  // The retail barcodes of a style's colours and sizes, one press from its row.
  const columns = useMemo<Column<Style>[]>(
    () => [
      ...baseColumns,
      {
        key: 'barcodes',
        header: '',
        render: (s) => (
          <button
            type="button"
            className="btn-secondary h-8 px-2.5 text-xs"
            onClick={(e) => {
              e.stopPropagation()
              setBarcodesFor(s.id)
            }}
            title="EAN-13 barcodes and MRP by size, for the retail tag"
          >
            <Barcode size={13} /> Barcodes
          </button>
        ),
      },
    ],
    [],
  )

  return (
    <>
      <MasterTable<Style>
        title="Styles & SKUs"
        entityName="Style"
        resource="styles"
        columns={columns}
        formFields={styleFormFields}
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
      {barcodesFor && <StyleBarcodesDialog styleId={barcodesFor} onClose={() => setBarcodesFor(null)} />}
      {importing && (
        <ImportStylesDialog onClose={() => setImporting(false)} onImported={() => setRefreshKey((k) => k + 1)} />
      )}
    </>
  )
}
