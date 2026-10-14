/**
 * Wash-care symbols for a retail label, in the shapes everyone knows: the tub,
 * the triangle, the square, the iron, the circle. Drawn as line SVG so they
 * print clean on a thermal label.
 */
export const WASH_CARE: Array<{ value: string; label: string }> = [
  { value: 'WASH_30', label: 'Machine wash 30°' },
  { value: 'WASH_40', label: 'Machine wash 40°' },
  { value: 'HAND_WASH', label: 'Hand wash' },
  { value: 'NO_WASH', label: 'Do not wash' },
  { value: 'NO_BLEACH', label: 'Do not bleach' },
  { value: 'TUMBLE_LOW', label: 'Tumble dry low' },
  { value: 'NO_TUMBLE', label: 'Do not tumble dry' },
  { value: 'LINE_DRY', label: 'Line dry' },
  { value: 'DRY_SHADE', label: 'Dry in shade' },
  { value: 'IRON_LOW', label: 'Iron low' },
  { value: 'IRON_MED', label: 'Iron medium' },
  { value: 'NO_IRON', label: 'Do not iron' },
  { value: 'DRY_CLEAN', label: 'Dry clean' },
  { value: 'NO_DRY_CLEAN', label: 'Do not dry clean' },
]

const S = { fill: 'none', stroke: '#000', strokeWidth: 1.6, strokeLinejoin: 'round' as const, strokeLinecap: 'round' as const }
const cross = <path d="M3 3 L21 21 M21 3 L3 21" {...S} />
const tub = <path d="M2 7 Q4.5 5 7 7 T12 7 T17 7 T22 7 L19.5 20 L4.5 20 Z" {...S} />
const iron = <path d="M3 18 L5 9 Q6 6 10 6 L17 6 Q20 6 21 9 L21 18 Z" {...S} />
const dot = (cx: number, cy: number) => <circle cx={cx} cy={cy} r={1.2} fill="#000" />

function Icon({ code }: { code: string }) {
  switch (code) {
    case 'WASH_30':
    case 'WASH_40':
      return (
        <>
          {tub}
          <text x={12} y={17} textAnchor="middle" fontSize={7.5} fontWeight={700} fontFamily="Inter, Arial, sans-serif">
            {code === 'WASH_30' ? '30' : '40'}
          </text>
        </>
      )
    case 'HAND_WASH':
      return (
        <>
          {tub}
          <path d="M9 15 L9 11 M11 15 L11 10 M13 15 L13 10.5 M15 15 L15 12 M8.5 15 Q12 18 15.5 15" {...S} strokeWidth={1.2} />
        </>
      )
    case 'NO_WASH':
      return (
        <>
          {tub}
          {cross}
        </>
      )
    case 'NO_BLEACH':
      return (
        <>
          <path d="M12 3 L22 20 L2 20 Z" {...S} />
          <path d="M5 6 L19 20 M19 6 L5 20" {...S} />
        </>
      )
    case 'TUMBLE_LOW':
    case 'NO_TUMBLE':
      return (
        <>
          <rect x={3} y={3} width={18} height={18} {...S} />
          <circle cx={12} cy={12} r={6.5} {...S} />
          {code === 'TUMBLE_LOW' ? dot(12, 12) : cross}
        </>
      )
    case 'LINE_DRY':
      return (
        <>
          <rect x={3} y={3} width={18} height={18} {...S} />
          <path d="M12 6.5 L12 17.5" {...S} />
        </>
      )
    case 'DRY_SHADE':
      return (
        <>
          <rect x={3} y={3} width={18} height={18} {...S} />
          <path d="M3 9 L9 3 M3 14 L14 3" {...S} />
        </>
      )
    case 'IRON_LOW':
    case 'IRON_MED':
    case 'NO_IRON':
      return (
        <>
          {iron}
          {code === 'IRON_LOW' && dot(12, 13.5)}
          {code === 'IRON_MED' && (
            <>
              {dot(9.5, 13.5)}
              {dot(14.5, 13.5)}
            </>
          )}
          {code === 'NO_IRON' && cross}
        </>
      )
    case 'DRY_CLEAN':
    case 'NO_DRY_CLEAN':
      return (
        <>
          <circle cx={12} cy={12} r={8.5} {...S} />
          {code === 'DRY_CLEAN' ? (
            <text x={12} y={15.5} textAnchor="middle" fontSize={9} fontWeight={700} fontFamily="Inter, Arial, sans-serif">
              P
            </text>
          ) : (
            cross
          )}
        </>
      )
    default:
      return null
  }
}

/** The symbols in a row, each `size` square. */
export function WashCareIcons({ codes, size }: { codes: string[]; size: string }) {
  const order = WASH_CARE.map((w) => w.value)
  const list = [...codes].filter((c) => order.includes(c)).sort((a, b) => order.indexOf(a) - order.indexOf(b))
  if (!list.length) return null
  return (
    <div style={{ display: 'flex', gap: '0.8mm', alignItems: 'center' }}>
      {list.map((c) => (
        <svg key={c} viewBox="0 0 24 24" width={size} height={size} aria-label={WASH_CARE.find((w) => w.value === c)?.label}>
          <Icon code={c} />
        </svg>
      ))}
    </div>
  )
}
