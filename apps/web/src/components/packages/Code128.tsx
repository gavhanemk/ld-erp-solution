/*
 * A Code 128 barcode as SVG: the straight-line barcode any handheld scanner
 * reads, for desks that have one of those rather than a camera. It carries the
 * same code as the QR beside it (PK-000053), so either can be scanned.
 *
 * Letters go in code set B; a run of digits switches to set C, two digits a
 * bar pattern, which keeps "PK-000053" short enough to scan on a small label.
 */

/** Bar and space widths of the 107 symbols, 0–105 and the stop. */
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
]
const START_B = 104
const START_C = 105
const TO_C = 99
const TO_B = 100
const STOP = 106

const digitsFrom = (s: string, i: number) => {
  let n = 0
  while (i + n < s.length && s.charCodeAt(i + n) >= 48 && s.charCodeAt(i + n) <= 57) n++
  return n
}

/** The symbol values for `text`, start and check digit included. Printable ASCII only. */
export function code128Values(text: string): number[] {
  const out: number[] = []
  let i = 0
  let set: 'B' | 'C'
  const lead = digitsFrom(text, 0)
  if (lead === text.length && lead >= 4 && lead % 2 === 0) {
    set = 'C'
    out.push(START_C)
  } else {
    set = 'B'
    out.push(START_B)
  }
  while (i < text.length) {
    const run = digitsFrom(text, i)
    // Worth switching to pairs for four digits at the end, or six in the middle.
    const worth = run >= 6 || (run >= 4 && i + run === text.length)
    if (set === 'B' && worth) {
      if (run % 2 === 1) {
        out.push(text.charCodeAt(i) - 32)
        i++
      }
      out.push(TO_C)
      set = 'C'
    }
    if (set === 'C') {
      if (digitsFrom(text, i) >= 2) {
        out.push(Number(text.slice(i, i + 2)))
        i += 2
        continue
      }
      out.push(TO_B)
      set = 'B'
    }
    const c = text.charCodeAt(i)
    out.push(c >= 32 && c <= 127 ? c - 32 : 0)
    i++
  }
  const check = out.reduce((sum, v, k) => sum + v * (k === 0 ? 1 : k), 0) % 103
  return [...out, check, STOP]
}

/** Each module, dark or light, quiet zones included. */
function modules(text: string): boolean[] {
  const quiet = Array<boolean>(10).fill(false)
  const bars: boolean[] = []
  for (const v of code128Values(text)) {
    PATTERNS[v].split('').forEach((w, k) => {
      for (let n = 0; n < Number(w); n++) bars.push(k % 2 === 0)
    })
  }
  return [...quiet, ...bars, ...quiet]
}

/** The barcode, stretched to the box it is given. */
export function Code128({ text, height = '100%', width = '100%' }: { text: string; height?: string; width?: string }) {
  const m = modules(text)
  const runs: Array<{ x: number; w: number }> = []
  m.forEach((on, x) => {
    if (!on) return
    const last = runs[runs.length - 1]
    if (last && last.x + last.w === x) last.w++
    else runs.push({ x, w: 1 })
  })
  return (
    <svg
      viewBox={`0 0 ${m.length} 10`}
      preserveAspectRatio="none"
      shapeRendering="crispEdges"
      style={{ width, height, display: 'block' }}
      role="img"
      aria-label={`Barcode ${text}`}
    >
      <rect width={m.length} height={10} fill="#fff" />
      {runs.map((r) => (
        <rect key={r.x} x={r.x} y={0} width={r.w} height={10} fill="#000" />
      ))}
    </svg>
  )
}
