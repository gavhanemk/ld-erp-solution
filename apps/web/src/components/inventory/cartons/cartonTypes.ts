/** A finished-goods carton as the screens show it (GET /fg-cartons, /fg-cartons/scan/:code). */
export interface Carton {
  id: string
  code: string
  status: 'PACKED' | 'DISPATCHED' | 'OPENED'
  store: { id: string; name: string }
  order: { id: string; soNumber: string; poRef: string | null; customer: string | null } | null
  challan: { id: string; dcNumber: string; status: string } | null
  notes: string | null
  printCount: number
  lastPrintedAt: string | null
  dispatchedAt: string | null
  openedAt: string | null
  openReason: string | null
  packedBy: string | null
  createdAt: string
  pieces: number
  items: Array<{
    itemId: string
    code: string
    name: string
    description: string | null
    colour: string | null
    style: string | null
    styleName: string | null
    grade: string
    sizes: Array<{ sizeId: string; code: string; qty: number }>
    pieces: number
  }>
}

/** A store's finished pieces, by item and size: in stock, sealed in cartons, free to pack. */
export interface StockItem {
  id: string
  code: string
  name: string
  description: string | null
  colour: string | null
  style: { id: string; code: string; name: string } | null
  sizes: Array<{ sizeId: string; code: string; sequence: number; grade: string; inStock: number; packed: number; free: number }>
}

/** An open order to pack or load cartons for. */
export interface CartonOrder {
  soId: string
  soNumber: string
  poRef: string | null
  customer: string
  itemIds: string[]
  packed: number
  drafts: Array<{ dcId: string; dcNumber: string; store: string; cartons: number }>
}

export const STATUS_LABEL: Record<Carton['status'], { label: string; cls: string }> = {
  PACKED: { label: 'In store', cls: 'badge-success' },
  DISPATCHED: { label: 'Dispatched', cls: 'badge-info' },
  OPENED: { label: 'Opened', cls: 'badge-neutral' },
}

/** "38×5 · 40×10": an item's sizes in a carton. */
export const sizesLine = (sizes: Array<{ code: string; qty: number }>) => sizes.map((s) => `${s.code}×${s.qty}`).join(' · ')

/** Opens carton stickers to print, in the tab given (opened on the click) or a new one. */
export const printCartons = (ids: string[], tab?: Window | null) => {
  if (!ids.length) {
    tab?.close()
    return
  }
  const url = `/print/fg-cartons?ids=${ids.join(',')}`
  if (tab && !tab.closed) tab.location.href = url
  else window.open(url, '_blank')
}
