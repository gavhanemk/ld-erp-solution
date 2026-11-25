'use client'

/**
 * The company logo, made fit for the top of the menu.
 *
 * A logo is usually uploaded for the letterhead: a large square with wide
 * white borders, an emblem on top, the name in the middle and a tagline
 * underneath. Squeezed whole into a 40px tile the borders take half of it,
 * the tagline turns to grey mush, and the browser's quick resize leaves the
 * rest soft. So the menu gets its own picture, made once in the browser:
 *
 *  1. the white (or transparent) border is trimmed away;
 *  2. a stacked logo — parts separated by white rows — is cut to its first
 *     part, the emblem, when that part is a fair share of the whole; a logo
 *     in one piece is kept whole;
 *  3. it is shrunk in halves, then to the exact size the tile draws it at
 *     on this screen, which is what keeps the edges sharp.
 *
 * The documents still print the logo as uploaded.
 */

const SIZE = 34 // CSS pixels the mark is drawn at inside its tile

export async function makeLogoMark(src: string): Promise<string | null> {
  if (typeof window === 'undefined') return null
  const img = new Image()
  img.decoding = 'async'
  img.src = src
  try {
    await img.decode()
  } catch {
    return null
  }
  const w = img.naturalWidth
  const h = img.naturalHeight
  if (!w || !h) return null

  const full = document.createElement('canvas')
  full.width = w
  full.height = h
  const ctx = full.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(img, 0, 0)
  let data: Uint8ClampedArray
  try {
    data = ctx.getImageData(0, 0, w, h).data
  } catch {
    return null // a picture from another site that the browser will not let us read
  }

  // Ink is anything that is neither near-white nor see-through.
  const ink = (x: number, y: number) => {
    const i = (y * w + x) * 4
    return data[i + 3] > 24 && Math.min(data[i], data[i + 1], data[i + 2]) < 235
  }

  const rowInk = new Array<number>(h).fill(0)
  let left = w
  let right = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!ink(x, y)) continue
      rowInk[y]++
      if (x < left) left = x
      if (x > right) right = x
    }
  }
  if (right < 0) return null

  // The parts of a stacked logo: runs of rows with ink, split by blank rows.
  // Specks under a few rows tall are ignored.
  const bands: Array<[number, number]> = []
  let start = -1
  for (let y = 0; y <= h; y++) {
    const on = y < h && rowInk[y] > 2
    if (on && start < 0) start = y
    if (!on && start >= 0) {
      if (y - start > Math.max(4, h * 0.01)) bands.push([start, y - 1])
      start = -1
    }
  }
  if (!bands.length) return null

  const top = bands[0][0]
  const bottom = bands[bands.length - 1][1]
  let box = { x: left, y: top, w: right - left + 1, h: bottom - top + 1 }

  // The emblem, when the first part is a real picture rather than a thin line.
  if (bands.length > 1) {
    const [b0, b1] = bands[0]
    if (b1 - b0 + 1 >= (bottom - top + 1) * 0.25) {
      let l = w
      let r = -1
      for (let y = b0; y <= b1; y++)
        for (let x = 0; x < w; x++)
          if (ink(x, y)) {
            if (x < l) l = x
            if (x > r) r = x
          }
      if (r >= l) box = { x: l, y: b0, w: r - l + 1, h: b1 - b0 + 1 }
    }
  }

  // A little breathing room, so the mark does not touch the tile's edge.
  const pad = Math.round(Math.max(box.w, box.h) * 0.04)
  box = {
    x: Math.max(0, box.x - pad),
    y: Math.max(0, box.y - pad),
    w: Math.min(w, box.x + box.w + pad) - Math.max(0, box.x - pad),
    h: Math.min(h, box.y + box.h + pad) - Math.max(0, box.y - pad),
  }

  // Fit inside the square the tile draws, at this screen's pixel density.
  const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1))
  const target = Math.round(SIZE * dpr)
  const scale = Math.min(1, target / Math.max(box.w, box.h))
  const outW = Math.max(1, Math.round(box.w * scale))
  const outH = Math.max(1, Math.round(box.h * scale))

  let cur = document.createElement('canvas')
  cur.width = box.w
  cur.height = box.h
  cur.getContext('2d')!.drawImage(full, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h)
  // Halving step by step keeps fine lines instead of skipping over them.
  while (cur.width / 2 >= outW && cur.height / 2 >= outH) {
    const next = document.createElement('canvas')
    next.width = Math.round(cur.width / 2)
    next.height = Math.round(cur.height / 2)
    const nx = next.getContext('2d')!
    nx.imageSmoothingQuality = 'high'
    nx.drawImage(cur, 0, 0, next.width, next.height)
    cur = next
  }
  const out = document.createElement('canvas')
  out.width = outW
  out.height = outH
  const ox = out.getContext('2d')!
  ox.imageSmoothingQuality = 'high'
  ox.drawImage(cur, 0, 0, outW, outH)
  return out.toDataURL('image/png')
}
