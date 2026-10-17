import type { ReportFilter, ReportParams } from '../types'

/**
 * What both ITC-04 tables share: the return period, the GST unit codes, and
 * how a job worker is named on the form.
 *
 * ITC-04 is the principal's declaration of its own inputs sent to job workers
 * and received back (CGST rule 45(3)). It is filed half-yearly when the
 * year's turnover is above ₹5 crore — April to September by 25 October,
 * October to March by 25 April — and yearly otherwise, by 25 April. A
 * customer's material that we send on is the customer's to declare, never ours.
 */

/** The financial year now begins in this calendar year. */
function fyStart(d: Date) {
  const ist = new Date(d.getTime() + 5.5 * 3600_000)
  return ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1
}

/** The periods ITC-04 is filed for, newest first: this year and the two before it. */
function periodOptions() {
  const now = fyStart(new Date())
  const out: Array<{ value: string; label: string }> = []
  for (let y = now; y >= now - 2; y--) {
    out.push({ value: `${y}-H2`, label: `Oct ${y} – Mar ${y + 1} (half-year)` })
    out.push({ value: `${y}-H1`, label: `Apr – Sep ${y} (half-year)` })
    out.push({ value: `${y}-FY`, label: `Apr ${y} – Mar ${y + 1} (whole year)` })
  }
  return out
}

export const periodFilter: ReportFilter = {
  key: 'period',
  label: 'Return period',
  type: 'select',
  options: periodOptions(),
  emptyLabel: 'This half-year',
  wide: true,
  help: 'Half-yearly when the year’s turnover is above ₹5 crore, yearly otherwise. Empty: the half-year we are in.',
}

const ist = (y: number, m: number, d: number, end = false) =>
  new Date(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T${end ? '23:59:59.999' : '00:00:00'}+05:30`)

/** The period's first and last moment, its name, and when the return is due. */
export function periodOf(params: ReportParams) {
  let p = params.period
  if (!p || !/^\d{4}-(H1|H2|FY)$/.test(p)) {
    const now = new Date()
    const y = fyStart(now)
    const istMonth = new Date(now.getTime() + 5.5 * 3600_000).getUTCMonth()
    p = `${y}-${istMonth >= 3 && istMonth <= 8 ? 'H1' : 'H2'}`
  }
  const y = Number(p.slice(0, 4))
  const kind = p.slice(5)
  const from = kind === 'H2' ? ist(y, 10, 1) : ist(y, 4, 1)
  const to = kind === 'H1' ? ist(y, 9, 30, true) : ist(y + 1, 3, 31, true)
  const due = kind === 'H1' ? `25 Oct ${y}` : `25 Apr ${y + 1}`
  const label =
    kind === 'H1' ? `Apr – Sep ${y}` : kind === 'H2' ? `Oct ${y} – Mar ${y + 1}` : `Apr ${y} – Mar ${y + 1}`
  return { from, to, label, due, kind, chosen: !!params.period }
}

/**
 * The GST unit code (UQC) for one of our units. The form takes the GST list's
 * codes, not our own symbols; a unit with no code there is OTH.
 */
const UQC: Record<string, string> = {
  bag: 'BAG', bags: 'BAG', bdl: 'BDL', bundle: 'BDL', box: 'BOX', btl: 'BTL', bottle: 'BTL', can: 'CAN',
  cm: 'CMS', cms: 'CMS', ctn: 'CTN', carton: 'CTN', doz: 'DOZ', dozen: 'DOZ', gm: 'GMS', g: 'GMS', gms: 'GMS',
  grs: 'GRS', gross: 'GRS', kg: 'KGS', kgs: 'KGS', km: 'KME', ltr: 'LTR', l: 'LTR', litre: 'LTR', m: 'MTR',
  mtr: 'MTR', mtrs: 'MTR', meter: 'MTR', metre: 'MTR', ml: 'MLT', nos: 'NOS', no: 'NOS', pac: 'PAC', pkt: 'PAC',
  pack: 'PAC', pcs: 'PCS', pc: 'PCS', piece: 'PCS', pair: 'PRS', prs: 'PRS', roll: 'ROL', rol: 'ROL', rolls: 'ROL',
  set: 'SET', sets: 'SET', sqm: 'SQM', sqf: 'SQF', sqft: 'SQF', ton: 'TON', tonne: 'TON', tube: 'TUB', unit: 'UNT',
  units: 'UNT', yd: 'YDS', yds: 'YDS', yard: 'YDS', yards: 'YDS',
}
export const uqcOf = (symbol: string | null | undefined) => UQC[(symbol ?? '').trim().toLowerCase()] ?? (symbol ? 'OTH' : '')

/** The GST state codes, for naming an unregistered job worker's state the way the form does. */
const STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka',
  '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
}

export interface JobWorkerOnForm {
  name: string
  gstin: string | null
  state: string | null
  stateCode: string | null
}

/** How the form names a job worker: by GSTIN when registered, by state when not. */
export function party(s: { name: string; gstin: string | null; state: string | null; stateCode: string | null }): JobWorkerOnForm & { type: string; stateLabel: string } {
  const gstin = s.gstin?.trim().toUpperCase() || null
  const code = s.stateCode?.trim().padStart(2, '0') || gstin?.slice(0, 2) || null
  const stateName = (code && STATES[code]) || s.state?.trim() || null
  return {
    name: s.name,
    gstin,
    state: s.state,
    stateCode: code,
    type: gstin ? 'Registered' : 'Unregistered',
    stateLabel: gstin ? '' : code && stateName ? `${code}-${stateName}` : (stateName ?? ''),
  }
}
