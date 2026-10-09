'use client'

/**
 * One line's pieces, size by size.
 *
 * The sizes come from the style's own size run, so a shirt shows S to XXL and a
 * kids' style shows 2 to 12; two lines on one order can carry different runs.
 * Each box has its size written above it rather than in a column header, for
 * that reason. The total is not typed: it is what the boxes add up to.
 *
 * `layout="grid"` is the phone form: three boxes to a row, big enough for a
 * thumb. `"row"` wraps along a table cell at a desk.
 */
export interface SizeOption {
  id: string
  code: string
  label: string
}

export function SizeQtyGrid({
  sizes,
  values,
  onChange,
  layout = 'row',
  disabled = false,
  name,
}: {
  sizes: SizeOption[]
  values: Record<string, string>
  onChange: (sizeId: string, value: string) => void
  layout?: 'row' | 'grid'
  disabled?: boolean
  /** What the boxes are for, for screen readers: "Line 2". */
  name: string
}) {
  return (
    <div className={layout === 'grid' ? 'grid grid-cols-3 gap-2' : 'flex flex-wrap gap-1.5'}>
      {sizes.map((s) => (
        <label
          key={s.id}
          className={`flex flex-col items-center gap-0.5 ${layout === 'grid' ? '' : 'w-14'}`}
          title={s.label}
        >
          <span className="text-muted-foreground text-[10px] font-medium leading-none">{s.code}</span>
          <input
            type="text"
            inputMode="numeric"
            className={`form-input px-1 text-center tabular-nums ${layout === 'grid' ? 'h-10 w-full text-sm' : 'h-8 w-14 text-xs'}`}
            value={values[s.id] ?? ''}
            placeholder="0"
            disabled={disabled}
            onChange={(e) => onChange(s.id, e.target.value.replace(/[^\d]/g, ''))}
            aria-label={`${name}, size ${s.label}`}
          />
        </label>
      ))}
    </div>
  )
}

/** What the boxes add up to. Blank and nonsense count as nothing. */
export function sumSizes(values: Record<string, string>): number {
  return Object.values(values).reduce((s, v) => s + (Number(v) || 0), 0)
}
