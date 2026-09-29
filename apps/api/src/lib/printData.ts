import { prisma } from '@ld-erp/database'
import { AppError } from '../middleware/errorHandler'

/**
 * The letterhead and wording a printed document needs.
 *
 * Returned by the module that owns the document — a purchase clerk can print a
 * purchase order without also being allowed into Settings, which is where this
 * information is edited.
 */

export interface PrintHeader {
  company: {
    name: string
    legalName: string | null
    address: string | null
    city: string | null
    state: string | null
    stateCode: string | null
    pincode: string | null
    gstin: string | null
    pan: string | null
    phone: string | null
    email: string | null
    website: string | null
    logoUrl: string | null
    signatureUrl: string | null
    bankName: string | null
    bankBranch: string | null
    bankAccount: string | null
    bankIFSC: string | null
    upiId: string | null
  }
  template: {
    docType: string
    title: string
    termsText: string | null
    declaration: string | null
    footerNote: string | null
    showHsn: boolean
    showAmountInWords: boolean
    showBankDetails: boolean
    showSignature: boolean
    copies: string[]
  }
}

const DEFAULT_TITLES: Record<string, string> = {
  INV: 'TAX INVOICE',
  PO: 'PURCHASE ORDER',
  // Not an order, and the heading is the first thing that says so. A supplier
  // holding a sheet headed PURCHASE ORDER will treat it as one.
  ENQ: 'PURCHASE REQUISITION',
  DC: 'DELIVERY CHALLAN',
  JW: 'DELIVERY CHALLAN (JOB WORK)',
  // Our own booking record of a supplier's invoice, not a tax invoice we issue.
  // Calling it one on paper would be claiming to have raised it.
  PB: 'PURCHASE BILL',
  // What the mill's old system called it, word for word, because this is the
  // sheet a store keeper and a supplier's driver both already know by name.
  GRN: 'GOODS RECEIPT NOTE',
  // Ours, addressed to the supplier — a claim for money back.
  DN: 'DEBIT NOTE',
  // Goods physically leaving for the supplier. "Challan" because that is what
  // the security gate and the transporter both ask for by name; the debit note
  // it produces is a separate sheet with its own heading.
  PRC: 'PURCHASE RETURN CHALLAN',
  // Theirs. We are recording what they sent us, so the sheet says so rather
  // than pretending the mill issued a credit note to itself.
  SCN: "SUPPLIER'S CREDIT NOTE",
}

export async function getPrintHeader(docType: string): Promise<PrintHeader> {
  const company = await prisma.company.findFirst()
  if (!company) throw new AppError('Company profile is not set up yet', 409, 'NO_COMPANY')

  const template = await prisma.documentTemplate.findUnique({
    where: { companyId_docType: { companyId: company.id, docType } },
  })

  return {
    company: {
      name: company.name,
      legalName: company.legalName,
      address: company.address,
      city: company.city,
      state: company.state,
      stateCode: company.stateCode,
      pincode: company.pincode,
      gstin: company.gstin,
      pan: company.pan,
      phone: company.phone,
      email: company.email,
      website: company.website,
      logoUrl: company.logoUrl,
      signatureUrl: company.signatureUrl,
      bankName: company.bankName,
      bankBranch: company.bankBranch,
      bankAccount: company.bankAccount,
      bankIFSC: company.bankIFSC,
      upiId: company.upiId,
    },
    // Nothing has to be configured before a document can print. Sensible
    // defaults mean a new install can put paper in front of a supplier on day
    // one, and the wording can be tuned afterwards.
    template: {
      docType,
      title: template?.title ?? DEFAULT_TITLES[docType] ?? docType,
      termsText: template?.termsText ?? null,
      declaration: template?.declaration ?? null,
      footerNote: template?.footerNote ?? null,
      showHsn: template?.showHsn ?? true,
      showAmountInWords: template?.showAmountInWords ?? true,
      showBankDetails: template?.showBankDetails ?? docType === 'INV',
      showSignature: template?.showSignature ?? true,
      copies: template?.copies ?? [],
    },
  }
}

/**
 * Writes a rupee amount the way an Indian invoice does — lakh and crore, not
 * millions, and always ending in "Only".
 */
export function amountInWords(amount: number): string {
  const ones = [
    '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen',
    'Eighteen', 'Nineteen',
  ]
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

  const twoDigit = (n: number): string => {
    if (n < 20) return ones[n]
    return `${tens[Math.floor(n / 10)]}${n % 10 ? ' ' + ones[n % 10] : ''}`
  }

  const threeDigit = (n: number): string => {
    const hundred = Math.floor(n / 100)
    const rest = n % 100
    return [
      hundred ? `${ones[hundred]} Hundred` : '',
      rest ? twoDigit(rest) : '',
    ]
      .filter(Boolean)
      .join(' ')
  }

  const whole = Math.floor(Math.abs(amount))
  const paise = Math.round((Math.abs(amount) - whole) * 100)

  if (whole === 0 && paise === 0) return 'Rupees Zero Only'

  // Indian grouping: crore, lakh, thousand, then the last three digits.
  const parts: string[] = []
  const crore = Math.floor(whole / 10000000)
  const lakh = Math.floor((whole % 10000000) / 100000)
  const thousand = Math.floor((whole % 100000) / 1000)
  const remainder = whole % 1000

  if (crore) parts.push(`${threeDigit(crore)} Crore`)
  if (lakh) parts.push(`${threeDigit(lakh)} Lakh`)
  if (thousand) parts.push(`${threeDigit(thousand)} Thousand`)
  if (remainder) parts.push(threeDigit(remainder))

  const rupees = parts.join(' ')
  const sign = amount < 0 ? 'Minus ' : ''

  return paise > 0
    ? `${sign}Rupees ${rupees} and ${twoDigit(paise)} Paise Only`
    : `${sign}Rupees ${rupees} Only`
}
