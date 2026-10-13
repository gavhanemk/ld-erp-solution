'use client'

import { useMemo } from 'react'
import QRCode from 'qrcode'

/**
 * A QR code as crisp squares, drawn at whatever size its box is.
 *
 * Built from the module grid rather than an image, so it prints sharp on a
 * thermal label and an inkjet sheet alike, and never waits on a canvas.
 * Error correction M survives a scuffed or slightly creased sticker.
 */
export function QrCode({ text, size = '100%', className }: { text: string; size?: string; className?: string }) {
  const path = useMemo(() => {
    const qr = QRCode.create(text, { errorCorrectionLevel: 'M' })
    const n = qr.modules.size
    let d = ''
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (qr.modules.get(x, y)) d += `M${x} ${y}h1v1h-1z`
      }
    }
    return { d, n }
  }, [text])

  // One module of quiet border on every side: enough for a scanner, little enough for a 25 mm label.
  return (
    <svg
      viewBox={`-1 -1 ${path.n + 2} ${path.n + 2}`}
      style={{ width: size, height: size, display: 'block' }}
      className={className}
      shapeRendering="crispEdges"
      role="img"
      aria-label={text}
    >
      <rect x={-1} y={-1} width={path.n + 2} height={path.n + 2} fill="#fff" />
      <path d={path.d} fill="#000" />
    </svg>
  )
}
