/**
 * An EAN-13 retail barcode, drawn as SVG so it prints sharp at any size.
 *
 * The standard encoding: a start guard, six digits in the L/G sets chosen by
 * the first digit, a centre guard, six in the R set, an end guard — 95 modules
 * — with the digits printed underneath, the first one outside the bars. Quiet
 * zones of 11 and 7 modules either side, as scanners need.
 */
const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011']
const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111']
const R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100']
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL']

/** The 95 modules of a 13-digit code, and which of them are guard bars (drawn longer). */
function modules(ean: string): Array<{ on: boolean; guard: boolean }> {
  const d = ean.split('').map(Number)
  const parity = PARITY[d[0]]
  const out: Array<{ on: boolean; guard: boolean }> = []
  const push = (bits: string, guard: boolean) => bits.split('').forEach((b) => out.push({ on: b === '1', guard }))
  push('101', true)
  for (let i = 1; i <= 6; i++) push((parity[i - 1] === 'L' ? L : G)[d[i]], false)
  push('01010', true)
  for (let i = 7; i <= 12; i++) push(R[d[i]], false)
  push('101', true)
  return out
}

export function Ean13({ code, width, height }: { code: string; width: string; height: string }) {
  if (!/^\d{13}$/.test(code)) return null
  const mods = modules(code)
  const quietL = 11
  const total = quietL + 95 + 7
  const barH = 50
  const guardH = 55
  const textY = 62
  return (
    <svg viewBox={`0 0 ${total} 64`} width={width} height={height} preserveAspectRatio="none" style={{ display: 'block' }} aria-label={`Barcode ${code}`}>
      <rect x={0} y={0} width={total} height={64} fill="#fff" />
      {mods.map((m, i) => (m.on ? <rect key={i} x={quietL + i} y={0} width={1} height={m.guard ? guardH : barH} fill="#000" /> : null))}
      <g fontFamily="ui-monospace, Consolas, monospace" fontSize={9} fill="#000" textAnchor="middle">
        <text x={quietL - 5} y={textY}>
          {code[0]}
        </text>
        {code
          .slice(1, 7)
          .split('')
          .map((c, i) => (
            <text key={`l${i}`} x={quietL + 3 + i * 7 + 3.5} y={textY}>
              {c}
            </text>
          ))}
        {code
          .slice(7)
          .split('')
          .map((c, i) => (
            <text key={`r${i}`} x={quietL + 50 + i * 7 + 3.5} y={textY}>
              {c}
            </text>
          ))}
      </g>
    </svg>
  )
}
