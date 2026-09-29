import ExcelJS from 'exceljs'
import { Readable } from 'stream'
import { AppError } from '../middleware/errorHandler'

/**
 * What every spreadsheet import shares: a template with a navy header and
 * dropdowns fed from a Lists sheet, and a filled sheet read back into rows
 * keyed by the template's own columns.
 */

export interface SheetColumn<K extends string = string> {
  key: K
  /** The header text. A trailing * marks it required, for the person filling it. */
  head: string
  width: number
  /** A key of the lists given to `addDropdowns`, for a column picked from a master. */
  list?: string
  /** A comment on the header cell. */
  note?: string
}

/** A cell as text, whatever Excel stored: a number, rich text, a formula's result. */
export function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((r) => r.text).join('').trim()
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue)
    if ('text' in v) return String(v.text).trim()
  }
  return String(v).trim()
}

/** The first sheet of a template: columns, a navy header, notes, frozen top row. */
export function addTemplateSheet(wb: ExcelJS.Workbook, name: string, columns: SheetColumn[]) {
  const sheet = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] })
  sheet.columns = columns.map((c) => ({ header: c.head, key: c.key, width: c.width }))
  const head = sheet.getRow(1)
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF173A6C' } }
  head.height = 20
  columns.forEach((c, i) => {
    if (c.note) sheet.getCell(1, i + 1).note = c.note
  })
  return sheet
}

/**
 * Dropdowns on the template, fed from a Lists sheet so they follow whatever
 * is in the masters today. Not enforced: a new name can still be typed where
 * the import allows one (a new category), and the import checks the rest.
 */
export function addDropdowns(
  wb: ExcelJS.Workbook,
  sheet: ExcelJS.Worksheet,
  columns: SheetColumn[],
  lists: Record<string, string[]>,
  rows: number,
) {
  const listSheet = wb.addWorksheet('Lists')
  const where: Record<string, string> = {}
  Object.entries(lists).forEach(([key, values], i) => {
    const col = listSheet.getColumn(i + 1)
    col.width = 26
    listSheet.getCell(1, i + 1).value = key
    listSheet.getCell(1, i + 1).font = { bold: true }
    values.forEach((v, r) => (listSheet.getCell(r + 2, i + 1).value = v))
    where[key] = `Lists!$${col.letter}$2:$${col.letter}$${Math.max(2, values.length + 1)}`
  })
  columns.forEach((c, i) => {
    if (!c.list || !where[c.list]) return
    const letter = sheet.getColumn(i + 1).letter
    for (let r = 2; r <= rows + 1; r++) {
      sheet.getCell(`${letter}${r}`).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: [where[c.list]],
        showErrorMessage: false,
      }
    }
  })
}

/** A "How to fill" sheet: numbered lines for whoever opens the template cold. */
export function addHowToSheet(wb: ExcelJS.Workbook, lines: string[]) {
  const how = wb.addWorksheet('How to fill')
  how.getColumn(1).width = 110
  lines.forEach((t, i) => (how.getCell(i + 1, 1).value = `${i + 1}. ${t}`))
}

/**
 * The filled rows, keyed by the template's columns, matched on header text
 * (capitals, spaces and the * ignored) so a reordered sheet still reads.
 * Blank rows are skipped; the row number is the one Excel shows.
 */
export async function readSheetRows<K extends string>(
  file: Buffer,
  fileName: string,
  opts: { columns: SheetColumn<K>[]; sheetName: string; mustHave: K; mustHaveLabel: string; maxRows: number },
): Promise<Array<{ row: number; raw: Partial<Record<K, string>> }>> {
  const wb = new ExcelJS.Workbook()
  try {
    if (/\.csv$/i.test(fileName)) await wb.csv.read(Readable.from(file))
    // exceljs types its own Buffer; Node's is the same bytes.
    else await wb.xlsx.load(file as unknown as ExcelJS.Buffer)
  } catch {
    throw new AppError('That file could not be read. Save it as .xlsx (or .csv) and try again.', 400, 'BAD_FILE')
  }
  const sheet = wb.getWorksheet(opts.sheetName) ?? wb.worksheets[0]
  if (!sheet) throw new AppError('That file has no sheet in it.', 400, 'BAD_FILE')

  const norm = (s: string) => s.replace(/\*/g, '').trim().toLowerCase()
  const byHead = new Map(opts.columns.map((c) => [norm(c.head), c.key]))
  const colKey = new Map<number, K>()
  sheet.getRow(1).eachCell((cell, col) => {
    const key = byHead.get(norm(cellText(cell.value)))
    if (key) colKey.set(col, key)
  })
  if (![...colKey.values()].includes(opts.mustHave)) {
    throw new AppError(`The first row has no "${opts.mustHaveLabel}" column. Start from the template.`, 400, 'BAD_FILE')
  }

  const rows: Array<{ row: number; raw: Partial<Record<K, string>> }> = []
  sheet.eachRow((r, n) => {
    if (n === 1) return
    const raw: Partial<Record<K, string>> = {}
    r.eachCell((cell, col) => {
      const key = colKey.get(col)
      if (key) raw[key] = cellText(cell.value)
    })
    if (Object.values(raw).some((v) => v)) rows.push({ row: n, raw })
  })
  if (rows.length === 0) throw new AppError('The sheet has no rows filled in.', 400, 'EMPTY_FILE')
  if (rows.length > opts.maxRows) {
    throw new AppError(`That is ${rows.length} rows. Import at most ${opts.maxRows} at a time.`, 400, 'TOO_MANY_ROWS')
  }
  return rows
}
