import type { RefinementCtx } from 'zod'

/**
 * India's GST state codes: the two digits a GSTIN starts with.
 *
 * The code decides CGST+SGST against IGST on every invoice, so a party whose
 * state code says one thing and whose GSTIN says another is taxed wrongly on
 * every document raised against it. 25 (Daman and Diu) merged into 26 in 2020
 * and 28 is the old Andhra Pradesh; both still appear on older registrations.
 */
export const GST_STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '25': 'Daman and Diu',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '28': 'Andhra Pradesh (old)',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
}

/** One registration on a party: its GSTIN and the state code and PAN said beside it. */
interface Registration {
  gstin?: string | null
  stateCode?: string | null
  pan?: string | null
}

/**
 * Holds a GSTIN, its state code and a PAN to each other, and names the field
 * that disagrees. `paths` says where each lives on this record, since a
 * customer keeps its state as billingStateCode and a supplier as stateCode.
 */
export function checkRegistration(
  r: Registration,
  paths: { stateCode: string; pan?: string },
  ctx: RefinementCtx,
): void {
  if (r.stateCode && !GST_STATES[r.stateCode]) {
    ctx.addIssue({
      code: 'custom',
      path: [paths.stateCode],
      message: `${r.stateCode} is not a GST state code. Maharashtra is 27, Gujarat 24.`,
    })
    return
  }
  const gstin = r.gstin?.toUpperCase()
  if (!gstin) return

  const fromGstin = gstin.slice(0, 2)
  if (r.stateCode && r.stateCode !== fromGstin) {
    ctx.addIssue({
      code: 'custom',
      path: [paths.stateCode],
      message: `The GSTIN is registered in ${GST_STATES[fromGstin] ?? fromGstin} (${fromGstin}), but this says ${GST_STATES[r.stateCode] ?? r.stateCode} (${r.stateCode}). Leave it empty and it is taken from the GSTIN.`,
    })
  }
  if (paths.pan && r.pan && r.pan.toUpperCase() !== gstin.slice(2, 12)) {
    ctx.addIssue({
      code: 'custom',
      path: [paths.pan],
      message: `The PAN inside the GSTIN is ${gstin.slice(2, 12)}. Leave it empty and it is taken from the GSTIN.`,
    })
  }
}

/** The state code and PAN a GSTIN already carries, for a party that left them empty. */
export const fromGstin = (gstin?: string | null) =>
  gstin ? { stateCode: gstin.slice(0, 2), pan: gstin.slice(2, 12) } : null

/** The state's name for its code, so the two cannot disagree. */
export const stateName = (code?: string | null) => (code ? (GST_STATES[code] ?? null) : null)
