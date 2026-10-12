/**
 * Code 128, set B: the barcode on a bundle sticker, readable by any handheld
 * scanner, which then types the bundle's number into whatever box has the
 * cursor. Written here rather than added as a package: it is one table and a
 * checksum.
 *
 * Each symbol is six widths — bar, space, bar, space, bar, space — adding up
 * to eleven modules; the stop symbol has a seventh, a final bar.
 */
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
const STOP = 106

/** The modules of the barcode, 1 for bar and 0 for space, without the quiet zones. */
export function code128Modules(text: string): string {
  const values = [...text].map((ch) => {
    const v = ch.charCodeAt(0) - 32
    if (v < 0 || v > 95) throw new Error(`"${ch}" cannot go in a barcode`)
    return v
  })
  const check = values.reduce((sum, v, i) => sum + v * (i + 1), START_B) % 103
  return [START_B, ...values, check, STOP]
    .map((symbol) =>
      [...PATTERNS[symbol]]
        .map((w, i) => (i % 2 === 0 ? '1' : '0').repeat(Number(w)))
        .join(''),
    )
    .join('')
}

/** The bars to draw, in modules from the left edge of the quiet zone, and the full width. */
export function code128Bars(text: string, quiet = 10) {
  const modules = code128Modules(text)
  const bars: Array<{ x: number; w: number }> = []
  for (let i = 0; i < modules.length; i++) {
    if (modules[i] !== '1') continue
    const start = i
    while (modules[i + 1] === '1') i++
    bars.push({ x: quiet + start, w: i - start + 1 })
  }
  return { bars, width: modules.length + quiet * 2 }
}
