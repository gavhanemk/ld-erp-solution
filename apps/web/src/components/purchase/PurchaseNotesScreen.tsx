'use client'

import { Fragment, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  AlertCircle,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileMinus,
  FilePlus2,
  Landmark,
  Pencil,
  Plus,
  Printer,
  RefreshCw,
  RotateCcw,
  Scale,
  Search,
  Send,
  Trash2,
  XCircle,
} from 'lucide-react'
import { api, apiErrorMessage, ApiError, can, masterResource, type Paginated } from '@/lib/api'
import { Pagination } from '@/components/tables/Pagination'
import { ActionMenu, type RowAction } from '@/components/tables/ActionMenu'
import { RowPanel } from '@/components/tables/RowPanel'
import { ExportButton } from '@/components/tables/ExportButton'
import { describeReport, downloadReport } from '@/lib/reportDownload'
import {
  asDate,
  asNumber,
  downloadRows,
  fetchEveryPage,
  type ExportColumn,
  type ExportFormat,
} from '@/lib/export'
import { formatDate } from '@/lib/utils'
import { presetFor, presets, ymd } from '@/lib/period'
import { PurchaseNoteDialog } from '@/components/purchase/PurchaseNoteDialog'
import { NoteDetail } from '@/components/purchase/NoteDetail'
import {
  DOC_WORDS,
  EFFECT_WORDS,
  GST_WORDS,
  ISSUER_WORDS,
  MODULE_WORDS,
  NOTE_STATUS,
  REASON_WORDS,
  money,
  type NoteDoc,
  type NoteGst,
  type NoteScreen,
  type NoteStatus,
  type PurchaseNote,
} from '@/components/purchase/noteTypes'

/**
 * The list of adjustments, as one screen wearing several names.
 *
 * Every kind wants the same table, the same filters, the same cards and the
 * same actions; what differs is the word in the heading and which `docType`
 * the rows are filtered to. Separate files would have been one of all of that
 * per kind, drifting from the first fix that only one of them got.
 *
 * The four cards are the position: what is still to send, what has gone out
 * and not come back, what has actually landed on a bill, and what was refused.
 * They answer the questions a purchase manager asks standing at the screen,
 * and they describe the same filter as the table under them — a card that
 * ignored the supplier filter would contradict the rows beneath it.
 */

const PER_PAGE = 25

/** What to do about it, when there is nothing on the screen. */
const EMPTY_HINT: Record<NoteScreen, string> = {
  DEBIT:
    'One is raised for you whenever a supplier bills above the order rate. You can also record a debit note a supplier has raised on you.',
  CREDIT: 'Record one when a supplier sends you a credit note.',
}

type Summary = Record<string, { count: number; amount: number }>

/**
 * What each card over the list stands for, as the filter that shows exactly
 * the notes it counted.
 *
 * Every one of these is a set, not a single state — which is the whole reason
 * the API's `status` takes a comma list. "Still to post" is the four states a
 * note can still be posted out of; "Waiting on Accounts" cuts across status
 * entirely and names a GST treatment instead, excluding cancelled notes
 * because nothing is owed on one and nobody has to classify it.
 *
 * These have to keep agreeing with what `cards` below counts. A card that
 * says 7 and then shows 5 rows when pressed is worse than a card that does
 * nothing at all, so the two are written next to each other deliberately.
 */
const CARD_FILTERS: Record<string, Record<string, string>> = {
  unposted: { status: 'DRAFT,SUBMITTED,APPROVED,REJECTED' },
  unclassified: {
    gstTreatment: 'NOT_REVIEWED',
    status: 'DRAFT,SUBMITTED,APPROVED,REJECTED,POSTED',
  },
  posted: { status: 'POSTED' },
  cancelled: { status: 'CANCELLED' },
}

/**
 * What a plain spreadsheet export carries.
 *
 * Wider than the table on screen: a column left out of a list to keep it
 * readable is exactly the column somebody exports in order to have. The tax
 * split is separated here for the same reason — on screen one "Tax" figure is
 * enough, and in a spreadsheet somebody is going to want to reconcile CGST
 * against a return.
 */
const EXPORT_COLUMNS: ExportColumn<PurchaseNote>[] = [
  { header: 'Note No.', value: (n) => n.noteNumber },
  { header: 'Date', value: (n) => asDate(n.noteDate) },
  { header: 'Document', value: (n) => DOC_WORDS[n.docType]?.label ?? n.docType },
  { header: 'Issued By', value: (n) => ISSUER_WORDS[n.issuedBy] ?? n.issuedBy },
  { header: 'Status', value: (n) => NOTE_STATUS[n.status]?.label ?? n.status },
  { header: 'Supplier', value: (n) => n.supplier.name },
  { header: 'Supplier Code', value: (n) => n.supplier.code },
  { header: 'GSTIN', value: (n) => n.supplier.gstin ?? '' },
  { header: 'Against Bill', value: (n) => n.bill?.billNumber ?? '' },
  { header: 'Their Bill No.', value: (n) => n.bill?.supplierInvoiceNo ?? '' },
  { header: 'Their Note No.', value: (n) => n.supplierDocNo ?? '' },
  { header: 'Their Note Date', value: (n) => asDate(n.supplierDocDate) },
  { header: 'What Happened', value: (n) => REASON_WORDS[n.reason] ?? n.reason },
  { header: 'Detail', value: (n) => n.reasonNote ?? '' },
  {
    header: 'Effect',
    value: (n) => EFFECT_WORDS[n.effect]?.label ?? n.effect,
  },
  /* The accounts desk's classification travels with the export, because the
     first question asked of a sheet of adjustments is which of them are
     cleared to go through and which are still sitting with accounts. */
  { header: 'GST Treatment', value: (n) => GST_WORDS[n.gstTreatment]?.label ?? n.gstTreatment },
  { header: 'Classified By', value: (n) => n.gstTreatedBy?.name ?? '' },
  { header: 'Order No.', value: (n) => n.po?.poNumber ?? '' },
  { header: 'Receipt No.', value: (n) => n.grn?.grnNumber ?? '' },
  { header: 'Godown', value: (n) => n.warehouse?.name ?? '' },
  { header: 'LR No.', value: (n) => n.lrNumber ?? '' },
  { header: 'Vehicle', value: (n) => n.vehicleNo ?? '' },
  { header: 'Lines', value: (n) => n.lines.length },
  { header: 'Taxable', value: (n) => asNumber(n.taxableAmount) },
  { header: 'CGST', value: (n) => asNumber(n.cgst) },
  { header: 'SGST', value: (n) => asNumber(n.sgst) },
  { header: 'IGST', value: (n) => asNumber(n.igst) },
  { header: 'Other Charges', value: (n) => asNumber(n.otherCharges) },
  { header: 'Discount', value: (n) => asNumber(n.discountAmount) },
  { header: 'Round Off', value: (n) => asNumber(n.roundOff) },
  { header: 'Note Total', value: (n) => asNumber(n.totalAmount) },
  { header: 'Raised By', value: (n) => n.createdBy?.name ?? '' },
  { header: 'Approved By', value: (n) => n.approvedBy?.name ?? '' },
  { header: 'Posted On', value: (n) => asDate(n.postedAt) },
  { header: 'Closed Reason', value: (n) => n.closedReason ?? '' },
  { header: 'Notes', value: (n) => n.notes ?? '' },
]

function PurchaseNotesScreenInner({ moduleType }: { moduleType: NoteScreen }) {
  const words = MODULE_WORDS[moduleType]

  const router = useRouter()
  const searchParams = useSearchParams()
  /*
   * A receipt arriving from "Raise a note" beside a rejected line on the
   * goods-receipt screen. `fromBill` rides along once that receipt has a
   * bill — the note is then raised against the bill line, checked for real,
   * rather than against the receipt with nothing to check it against.
   */
  const fromGrn = searchParams.get('fromGrn')
  const fromBill = searchParams.get('fromBill')

  const [rows, setRows] = useState<PurchaseNote[]>([])
  const [summary, setSummary] = useState<Summary>({})
  /* Counted by the server across the whole filtered set, not off the page in
     front of us — this card can be pressed now, and a number that meant "on
     this page" would stop matching the rows the press produces. */
  const [unclassified, setUnclassified] = useState({ count: 0, amount: 0 })
  /** Which card is pressed, if any. One of the keys in `CARD_FILTERS`. */
  const [card, setCard] = useState('')
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<PurchaseNote | null>(null)

  useEffect(() => {
    if (fromGrn) setDialogOpen(true)
  }, [fromGrn])

  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')

  /*
   * A search handed over in the address — the link from a return challan to
   * the document next to it in the chain. Without it the link lands on the
   * whole list and the clerk types the number they just clicked.
   */
  useEffect(() => {
    const q = searchParams.get('q')
    if (q) {
      setSearch(q)
      setDebounced(q)
    }
  }, [searchParams])

  const [status, setStatus] = useState('')
  const [reason, setReason] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [suppliers, setSuppliers] = useState<Array<{ id: string; name: string }>>([])
  /*
   * Whether the two date boxes are showing.
   *
   * Held rather than derived from the dates: "Between…" has to stay chosen
   * while both boxes are still empty, and a value derived from empty dates
   * would close the boxes the moment they were opened.
   */
  const [custom, setCustom] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 350)
    return () => clearTimeout(t)
  }, [search])

  useEffect(() => {
    setPage(1)
  }, [debounced, card, status, reason, supplierId, fromDate, toDate])

  useEffect(() => {
    void (async () => {
      try {
        const list = await masterResource<{ id: string; name: string }>('suppliers').list({
          limit: 500,
        })
        setSuppliers([...list.data].sort((a, b) => a.name.localeCompare(b.name)))
      } catch {
        // The filter comes up empty; the list still loads.
      }
    })()
  }, [])

  /**
   * The filter, written once.
   *
   * The list, the grid export and the report all read it. Three copies is how
   * an Export button quietly hands back a different set of rows than the one
   * on the screen it was pressed from — with nothing in the file to say so.
   */
  const filters = useCallback(() => {
    const p: Record<string, string> = {}
    if (debounced) p.q = debounced
    // A pressed card and the status box are two ways of saying the same kind
    // of thing, so only one of them speaks. Choosing either clears the other,
    // which is why this can prefer the card without hiding a live filter.
    if (card) Object.assign(p, CARD_FILTERS[card])
    else if (status) p.status = status
    if (reason) p.reason = reason
    if (supplierId) p.supplierId = supplierId
    if (fromDate) p.from = fromDate
    if (toDate) p.to = toDate
    return p
  }, [debounced, card, status, reason, supplierId, fromDate, toDate])

  const query = useCallback(
    (p: number, limit: number) =>
      `/purchase/notes?${new URLSearchParams({
        ...filters(),
        page: String(p),
        limit: String(limit),
        // Every kind this screen covers, in one request. The Debit Notes
        // screen carries our own claims and the supplier's debit notes,
        // because both are debit notes.
        docType: words.kinds.join(','),
      })}`,
    [filters, moduleType, words.kinds]
  )

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<
        Paginated<PurchaseNote> & {
          summary: Summary
          unclassified?: { count: number; amount: number }
        }
      >(query(page, PER_PAGE))
      setRows(res.data)
      setSummary(res.summary ?? {})
      setUnclassified(res.unclassified ?? { count: 0, amount: 0 })
      setTotal(res.pagination.total)
      setPages(res.pagination.pages)
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 403
            ? `Your role does not allow viewing ${words.one}s.`
            : err.message
          : 'Could not reach the server. Is the API running?'
      )
    } finally {
      setLoading(false)
    }
  }, [query, page, words.one])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * The rows on screen, as a spreadsheet — every page of them, not just the
   * twenty-five being looked at.
   */
  const exportList = async (format: ExportFormat) => {
    setError(null)
    try {
      const {
        rows: all,
        total: found,
        truncated,
      } = await fetchEveryPage<PurchaseNote>((p) => query(p, 100))
      if (all.length === 0) {
        setMessage(`Nothing to export — no ${words.one}s match these filters.`)
        return
      }
      await downloadRows({
        rows: all,
        columns: EXPORT_COLUMNS,
        name: moduleType === 'DEBIT' ? 'debit-notes' : 'credit-notes',
        sheet: words.title,
        format,
      })
      setMessage(
        truncated
          ? `Exported the first ${all.length} of ${found}. Narrow the filters to get the rest.`
          : `Exported ${all.length} ${all.length === 1 ? words.one : `${words.one}s`}.`
      )
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not build the export.')
    }
  }

  /**
   * The same filter, as a report rather than a grid.
   *
   * Every filter on this bar goes up with it, so the workbook answers the
   * question the screen was showing. The report prints what was applied on its
   * own face, which is what makes the two checkable against each other.
   */
  const exportReport = async () => {
    setError(null)
    try {
      setMessage(
        describeReport(
          await downloadReport('note-register', 'xlsx', { ...filters(), type: moduleType })
        )
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The report could not be built.')
    }
  }

  /**
   * Accounts says what a note is for GST.
   *
   * A prompt rather than a dialog, deliberately: it is a decision taken by
   * one desk on one note, and a modal with a Save button would be the fourth
   * screen in a module that already has enough. The wording is the section
   * number and the plain sentence, because "34(1)" alone is not something to
   * pick from a list at speed.
   */
  const classify = async (note: PurchaseNote) => {
    const choices: NoteGst[] = [
      'GST_CREDIT_NOTE',
      'GST_DEBIT_NOTE',
      'ITC_REVERSAL_ONLY',
      'NO_GST_IMPACT',
    ]
    const menu = choices.map((c, i) => `${i + 1}. ${GST_WORDS[c].label} — ${GST_WORDS[c].hint}`)
    const answer = window.prompt(
      `How is ${note.noteNumber} to be treated for GST?\n\n${menu.join('\n')}\n\nEnter 1-${choices.length}:`,
      ''
    )
    if (!answer) return
    const pickIndex = Number(answer.trim()) - 1
    const picked = choices[pickIndex]
    if (!picked) {
      setError(`"${answer}" is not one of the choices. Nothing was changed.`)
      return
    }
    const gstNote = window.prompt('Anything to record against that? (optional)', '') ?? null

    setBusy(true)
    setError(null)
    try {
      const res = await api.patch<{ message?: string }>(
        `/purchase/notes/${note.id}/gst-treatment`,
        { gstTreatment: picked, gstNote: gstNote?.trim() || null }
      )
      setMessage(res.message ?? `${note.noteNumber} classified.`)
      await load()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not go through.')
    } finally {
      setBusy(false)
    }
  }

  const act = async (note: PurchaseNote, what: 'post' | 'cancel') => {
    let reasonText: string | null = null

    if (what === 'cancel') {
      const undoing = note.status === 'POSTED'
      if (
        !window.confirm(
          undoing
            ? `${note.noteNumber} has been posted. Cancelling puts the adjustment back on ${note.bill?.billNumber ?? 'the bill'}${note.warehouse ? ' and the goods back into stock' : ''}. Go ahead?`
            : `Cancel ${note.noteNumber}?`
        )
      ) {
        return
      }
      reasonText = window.prompt('Why is it being cancelled? (optional)') ?? null
    }

    if (
      what === 'post' &&
      !window.confirm(
        `Posting ${note.noteNumber} changes what ${note.supplier.name} is owed. Go ahead?`
      )
    ) {
      return
    }

    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const res = await api.post<{ message?: string }>(
        `/purchase/notes/${note.id}/${what}`,
        reasonText ? { reason: reasonText } : {}
      )
      await load()
      if (res.message) setMessage(res.message)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save.'))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (note: PurchaseNote) => {
    if (!window.confirm(`Delete ${note.noteNumber}? Its number will not be reused.`)) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.delete<{ message?: string }>(`/purchase/notes/${note.id}`)
      await load()
      if (res.message) setMessage(res.message)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete.')
    } finally {
      setBusy(false)
    }
  }

  /*
   * What this desk is allowed to do, read once.
   *
   * Posting has its own right, separate from approving: the purchase manager
   * agrees the mill is owed the money and accounts decide when it comes off
   * the payable. Read at the top rather than per row — the answer cannot
   * change between two rows of the same table.
   */
  const mayEdit = can('purchase', 'edit')
  const mayPost = can('purchase', 'post')
  const mayDelete = can('purchase', 'delete')
  const mayCreate = can('purchase', 'create')

  /**
   * What can be done to this row, in the order of the workflow.
   *
   * Offered by state *and* by right, rather than always shown and sometimes
   * refused: a menu of six things of which four throw is a menu nobody trusts.
   * Print is always there — anybody who can see a note can put it on paper.
   */
  const rowActions = (n: PurchaseNote): RowAction[] => {
    const items: RowAction[] = []

    /* Two things a live note can have done to it, and both are offered from
       the moment it exists. The submit-and-approve pair in between was
       removed: it queued every adjustment behind a second person for a
       decision `purchase:post` already gates. */
    const live = n.status !== 'POSTED' && n.status !== 'CANCELLED'

    if (live && mayEdit) {
      items.push({
        key: 'edit',
        label: 'Edit',
        icon: <Pencil size={14} />,
        onClick: () => {
          setEditing(n)
          setDialogOpen(true)
        },
      })
    }

    /* Classifying is the accounts desk's, and it no longer blocks anything —
       so it is offered on a posted note as readily as on a draft. A
       misclassification is corrected by correcting it, not by cancelling a
       note that is right in every other respect and burning its number. */
    if (mayPost && n.status !== 'CANCELLED') {
      items.push({
        key: 'classify',
        label: n.gstTreatment === 'NOT_REVIEWED' ? 'Classify for GST' : 'Change the GST treatment',
        icon: <Scale size={14} />,
        onClick: () => void classify(n),
      })
    }

    if (live && mayPost) {
      items.push({
        key: 'post',
        label: 'Post to the bill',
        icon: <Landmark size={14} />,
        onClick: () => void act(n, 'post'),
        /* Not disabled. An unclassified note posts; the menu says what is
           still outstanding rather than standing in the way of it. */
        hint:
          n.gstTreatment === 'NOT_REVIEWED'
            ? 'Accounts has not classified it for GST yet'
            : undefined,
      })
    }

    items.push({
      key: 'print',
      label: 'Print',
      icon: <Printer size={14} />,
      href: `/print/purchase-note/${n.id}`,
      newTab: true,
    })

    if (n.purchaseReturn) {
      items.push({
        key: 'challan',
        label: `Open return challan ${n.purchaseReturn.returnNumber}`,
        icon: <Printer size={14} />,
        href: '/print/purchase-return/' + n.purchaseReturn.id,
        newTab: true,
      })
    }

    if (n.status !== 'CANCELLED' && mayEdit && !n.purchaseReturn) {
      items.push({
        key: 'cancel',
        label: n.status === 'POSTED' ? 'Cancel and reverse' : 'Cancel note',
        icon: <Ban size={14} />,
        danger: true,
        onClick: () => void act(n, 'cancel'),
      })
    }

    if (n.status === 'DRAFT' && mayDelete && !n.purchaseReturn) {
      items.push({
        key: 'delete',
        label: 'Delete draft',
        icon: <Trash2 size={14} />,
        danger: true,
        onClick: () => void remove(n),
      })
    }

    return items
  }

  const anyFilter = Boolean(card || search || status || reason || supplierId || fromDate || toDate)

  /** Which named period the dates are, or "custom" while the boxes are open. */
  const period = custom ? 'custom' : presetFor(fromDate, toDate)

  const pickPeriod = (value: string) => {
    if (value === 'custom') {
      setCustom(true)
      return
    }
    setCustom(false)
    const p = presets().find((x) => x.label === value)
    // No period clears the dates rather than inventing a range.
    setFromDate(p ? ymd(p.from) : '')
    setToDate(p ? ymd(p.to) : '')
  }

  const cards = useMemo(() => {
    const at = (k: NoteStatus) => summary[k] ?? { count: 0, amount: 0 }
    /* Every state a note can still be posted out of. The middle three are
       left over from the approval workflow and no new note reaches them, but
       a row written before the change is still genuinely "still to post" —
       including REJECTED, whose own hint says it can be edited and posted. */
    const waiting = {
      count:
        at('DRAFT').count + at('SUBMITTED').count + at('APPROVED').count + at('REJECTED').count,
      amount:
        at('DRAFT').amount + at('SUBMITTED').amount + at('APPROVED').amount + at('REJECTED').amount,
    }
    return [
      {
        key: 'unposted',
        label: 'Still to post',
        value: String(waiting.count),
        sub: `₹${money(waiting.amount)} not yet on a bill`,
        tone: 'text-foreground',
      },
      {
        key: 'unclassified',
        label: 'Waiting on Accounts',
        value: String(unclassified.count),
        sub: unclassified.count
          ? 'not classified for GST — posting still works'
          : 'every note here is classified',
        tone: unclassified.count ? 'text-amber-400' : 'text-muted-foreground',
      },
      {
        key: 'posted',
        label: 'Posted',
        value: `₹${money(at('POSTED').amount)}`,
        sub: `${at('POSTED').count} note${at('POSTED').count === 1 ? '' : 's'} on the payable`,
        tone: 'text-emerald-400',
      },
      {
        /* CANCELLED alone. It used to add REJECTED in as well, which put every
           rejected note on two cards at once — this one and "Still to post" —
           so the four numbers summed to more than the list held. A rejected
           note can still be edited and posted, so "still to post" is the one
           that was telling the truth about it. */
        key: 'cancelled',
        label: 'Cancelled',
        value: String(at('CANCELLED').count),
        sub: `₹${money(at('CANCELLED').amount)} claimed nothing`,
        tone: 'text-muted-foreground',
      },
    ]
  }, [summary, unclassified.count])

  const Icon = moduleType === 'CREDIT' ? FilePlus2 : FileMinus

  return (
    <div className="space-y-5">
      <div className="page-header flex-wrap gap-3">
        <div>
          <h1 className="page-title">{words.title}</h1>
          <p className="page-subtitle hidden sm:block">{words.subtitle}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          <ExportButton onExport={exportList} onReport={exportReport} disabled={loading} />
          {mayCreate && (
            <button
              className="btn-primary"
              onClick={() => {
                setEditing(null)
                setDialogOpen(true)
              }}
            >
              <Plus size={15} />
              <span className="hidden sm:inline">{words.newLabel}</span>
              <span className="sm:hidden">New</span>
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3">
          <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}
      {message && (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3">
          <p className="text-sm text-emerald-400">{message}</p>
          <button
            className="text-emerald-400/70 hover:text-emerald-400"
            onClick={() => setMessage(null)}
            aria-label="Dismiss"
          >
            <XCircle size={15} />
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {/* Pressable, because each of these already describes a set of rows
            and the list underneath can show exactly that set. Pressing the one
            already pressed clears it, so the card is the way back out as well
            as the way in — there is nothing to hunt for afterwards. Choosing a
            status in the box below clears the card for the same reason: two
            controls narrowing the same thing, only one of them showing what it
            did, is how a filter starts lying about itself. */}
        {cards.map((c) => {
          const on = card === c.key
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => {
                setCard(on ? '' : c.key)
                setStatus('')
                setPage(1)
              }}
              aria-pressed={on}
              title={on ? `Showing only these — press to clear` : `Show only these`}
              className={`glass-card cursor-pointer p-2 text-left transition-colors ${
                on ? 'ring-primary bg-primary/5 ring-2' : 'hover:bg-secondary/40'
              }`}
            >
              <p className="text-muted-foreground text-[10px] leading-tight">{c.label}</p>
              <p className={`text-sm font-semibold tabular-nums leading-tight ${c.tone}`}>
                {c.value}
              </p>
              <p className="text-muted-foreground mt-0.5 text-[10px] leading-snug">{c.sub}</p>
            </button>
          )
        })}
      </div>

      <div className="glass-card overflow-hidden p-0">
        {/* ── One row on a desk, wrapping on a phone ────────────────────────
         *
         * Every filter — search, period, status, reason, supplier — lives in
         * one flex-wrap row. On a desk there is room for all of it on one
         * line. On a phone the same row wraps: search and the period pick
         * share the first line (as they always have), the three selects
         * wrap to their own line below, sized equally by flex-1.
         *
         * The date range still collapses to one control. Two date boxes and
         * a search field cannot share a 360px row and stay usable, so the
         * named periods do the ordinary case, and the two boxes appear
         * underneath only when somebody asks for a range that is not one of
         * them.
         */}
        <div className="border-border space-y-2 border-b px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="border-field-edge bg-field flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2.5 py-1.5">
              <Search size={14} className="text-muted-foreground shrink-0" />
              <input
                className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 border-0 bg-transparent text-sm outline-none"
                placeholder="Note or bill number, supplier…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label={`Search ${words.one}s`}
              />
            </div>

            <select
              className="form-input h-8 w-[8.25rem] shrink-0 py-0 text-xs"
              value={period}
              onChange={(e) => pickPeriod(e.target.value)}
              aria-label="Period"
            >
              <option value="">Any date</option>
              {presets().map((x) => (
                <option key={x.label} value={x.label}>
                  {x.label}
                </option>
              ))}
              <option value="custom">Between…</option>
            </select>

            {/* The two boxes, on the row on a desk and underneath on a phone. */}
            <div className={`${custom ? 'flex' : 'hidden'} shrink-0 items-center gap-1.5 sm:flex`}>
              <input
                type="date"
                className="form-input hidden h-8 w-[8.5rem] py-0 text-xs sm:block"
                value={fromDate}
                max={toDate || undefined}
                onChange={(e) => setFromDate(e.target.value)}
                aria-label="Raised on or after"
              />
              <span className="text-muted-foreground hidden shrink-0 text-xs sm:inline">to</span>
              <input
                type="date"
                className="form-input hidden h-8 w-[8.5rem] py-0 text-xs sm:block"
                value={toDate}
                min={fromDate || undefined}
                onChange={(e) => setToDate(e.target.value)}
                aria-label="Raised on or before"
              />
            </div>

            <select
              className="form-input h-8 min-w-0 flex-1 basis-0 py-0 text-xs sm:w-36 sm:flex-none sm:basis-auto"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value)
                // The card and this box narrow the same thing. Letting both
                // stand would leave one of them describing a filter that is
                // not the one being applied.
                setCard('')
              }}
              aria-label="Filter by status"
            >
              <option value="">Any status</option>
              {Object.entries(NOTE_STATUS).map(([v, st]) => (
                <option key={v} value={v}>
                  {st.label}
                </option>
              ))}
            </select>

            <select
              className="form-input h-8 min-w-0 flex-1 basis-0 py-0 text-xs sm:w-40 sm:flex-none sm:basis-auto"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              aria-label="Filter by reason"
            >
              <option value="">Any reason</option>
              {Object.entries(REASON_WORDS).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>

            <select
              className="form-input h-8 min-w-0 flex-1 basis-0 py-0 text-xs sm:w-44 sm:flex-none sm:basis-auto"
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
              aria-label="Filter by supplier"
            >
              <option value="">All suppliers</option>
              {suppliers.map((sup) => (
                <option key={sup.id} value={sup.id}>
                  {sup.name}
                </option>
              ))}
            </select>

            {anyFilter && (
              <button
                className="btn-ghost h-8 shrink-0 px-2 text-xs"
                onClick={() => {
                  setCard('')
                  setSearch('')
                  setStatus('')
                  setReason('')
                  setSupplierId('')
                  setFromDate('')
                  setToDate('')
                  setCustom(false)
                }}
              >
                Clear
              </button>
            )}

            <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">
              {total} {total === 1 ? words.one : `${words.one}s`}
            </span>
          </div>

          {/* The same two date boxes again, full-width, for a phone once a
            custom range is asked for — the compact pair above stays hidden
            on that width. */}
          {custom && (
            <div className="flex items-center gap-1.5 sm:hidden">
              <input
                type="date"
                className="form-input h-8 min-w-0 flex-1 py-0 text-xs"
                value={fromDate}
                max={toDate || undefined}
                onChange={(e) => setFromDate(e.target.value)}
                aria-label="Raised on or after"
              />
              <span className="text-muted-foreground shrink-0 text-xs">to</span>
              <input
                type="date"
                className="form-input h-8 min-w-0 flex-1 py-0 text-xs"
                value={toDate}
                min={fromDate || undefined}
                onChange={(e) => setToDate(e.target.value)}
                aria-label="Raised on or before"
              />
            </div>
          )}
        </div>

        {/* Cards below the width a ten-column table can still be read at,
          the table itself above it — the same `list-scope` switch every
          other purchase list uses, keyed to how wide this list actually
          renders rather than to the window, so a phone never gets a table
          it has to drag sideways to read. */}
        <div className="list-scope">
          <div className="list-cards divide-border divide-y">
            {loading && rows.length === 0 ? (
              <p className="text-muted-foreground px-3 py-10 text-center text-sm">Loading…</p>
            ) : rows.length === 0 ? (
              <div className="px-3 py-12 text-center">
                <Icon size={26} className="text-muted-foreground mx-auto mb-2 opacity-40" />
                <p className="text-foreground text-sm font-medium">
                  {anyFilter ? `No ${words.one}s match those filters` : `No ${words.one}s yet`}
                </p>
                <p className="text-muted-foreground mt-1 text-xs">
                  {anyFilter ? 'Clear the filters to see everything.' : EMPTY_HINT[moduleType]}
                </p>
              </div>
            ) : (
              rows.map((n) => {
                const open = expanded === n.id
                const tax = Number(n.cgst) + Number(n.sgst) + Number(n.igst)
                const s = NOTE_STATUS[n.status]
                return (
                  <div key={n.id} className="p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-foreground font-mono text-xs font-semibold">
                            {n.noteNumber}
                          </span>
                          <span className={s.cls} title={s.hint}>
                            {s.label}
                          </span>
                          {n.purchaseReturn && (
                            <span className="text-primary font-mono text-[11px]">
                              from {n.purchaseReturn.returnNumber}
                            </span>
                          )}
                        </div>
                        <p className="text-foreground mt-1 font-medium leading-snug">
                          {n.supplier.name}
                        </p>
                        <p className="text-muted-foreground mt-0.5 font-mono text-[10px]">
                          {n.supplier.code}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <span className="text-foreground font-semibold tabular-nums">
                          ₹{money(n.totalAmount)}
                        </span>
                        {n.effect === 'INCREASES_PAYABLE' && (
                          <p className="text-[10px] text-amber-400">adds to payable</p>
                        )}
                      </div>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span className="text-foreground text-xs">
                        {DOC_WORDS[n.docType]?.short ?? n.docType}
                      </span>
                      <span
                        className={`badge ${EFFECT_WORDS[n.effect]?.cls ?? 'badge-neutral'} text-[10px]`}
                        title={EFFECT_WORDS[n.effect]?.hint}
                      >
                        {EFFECT_WORDS[n.effect]?.label ?? n.effect}
                      </span>
                      {n.gstTreatment === 'NOT_REVIEWED' && n.status !== 'CANCELLED' && (
                        <span
                          className="text-[10px] text-amber-400/90"
                          title={GST_WORDS.NOT_REVIEWED.hint}
                        >
                          GST not classified
                        </span>
                      )}
                    </div>

                    <dl className="mt-2.5 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                      <dt className="text-muted-foreground">Date</dt>
                      <dd className="text-foreground min-w-0">
                        {formatDate(n.noteDate)}
                        {n.supplierDocNo ? ` · their ${n.supplierDocNo}` : ''}
                      </dd>

                      <dt className="text-muted-foreground">Against bill</dt>
                      <dd className="min-w-0">
                        {n.bill ? (
                          <>
                            <span className="text-foreground">{n.bill.billNumber}</span>{' '}
                            <span className="text-muted-foreground">
                              · {n.bill.supplierInvoiceNo ?? formatDate(n.bill.billDate)}
                            </span>
                          </>
                        ) : (
                          <span
                            className="text-amber-400/90"
                            title={n.withoutBillReason ?? undefined}
                          >
                            No bill linked
                          </span>
                        )}
                      </dd>

                      <dt className="text-muted-foreground">What happened</dt>
                      <dd className="text-foreground min-w-0 break-words">
                        {REASON_WORDS[n.reason] ?? n.reason}
                        {n.reasonNote && (
                          <span className="text-muted-foreground mt-0.5 block text-[11px]">
                            {n.reasonNote}
                          </span>
                        )}
                      </dd>

                      <dt className="text-muted-foreground">Taxable / Tax</dt>
                      <dd className="text-foreground min-w-0 tabular-nums">
                        ₹{money(n.taxableAmount)} + ₹{money(tax)}
                      </dd>
                    </dl>

                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                      <button
                        onClick={() => setExpanded(open ? null : n.id)}
                        className="bg-primary/10 text-primary hover:bg-primary/20 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors"
                        aria-expanded={open}
                      >
                        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        {open
                          ? 'Hide lines'
                          : `${n.lines.length} line${n.lines.length === 1 ? '' : 's'}`}
                      </button>
                      <ActionMenu label={n.noteNumber} items={rowActions(n)} />
                    </div>

                    {open && (
                      <div className="mt-2.5">
                        <RowPanel
                          icon={Icon}
                          title={`${n.noteNumber} — ${REASON_WORDS[n.reason] ?? n.reason}`}
                          note={`${n.lines.length} line${n.lines.length === 1 ? '' : 's'}`}
                        >
                          <NoteDetail note={n} />
                        </RowPanel>
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </div>

          <div className="list-rows overflow-x-auto">
            <table className="w-full min-w-[60rem] text-sm">
              <thead>
                <tr className="border-border bg-secondary/60 border-b text-left">
                  <th className="w-8 px-3 py-2"></th>
                  <th className="text-muted-foreground px-3 py-2 text-xs font-medium">Note</th>
                  {/* Whose paper it is. On the Debit Notes screen our own claim
                  sits next to the supplier's debit note and the two move the
                  money opposite ways, so this is not decoration. */}
                  <th className="text-muted-foreground px-3 py-2 text-xs font-medium">Document</th>
                  <th className="text-muted-foreground px-3 py-2 text-xs font-medium">Supplier</th>
                  <th className="text-muted-foreground px-3 py-2 text-xs font-medium">
                    Against bill
                  </th>
                  <th className="text-muted-foreground px-3 py-2 text-xs font-medium">
                    What happened
                  </th>
                  <th className="text-muted-foreground px-3 py-2 text-right text-xs font-medium">
                    Taxable
                  </th>
                  <th className="text-muted-foreground px-3 py-2 text-right text-xs font-medium">
                    Tax
                  </th>
                  <th className="text-muted-foreground px-3 py-2 text-right text-xs font-medium">
                    Total
                  </th>
                  <th className="text-muted-foreground px-3 py-2 text-xs font-medium">Status</th>
                  <th className="w-10 px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {loading && rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={11}
                      className="text-muted-foreground px-3 py-10 text-center text-sm"
                    >
                      Loading…
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={11} className="px-3 py-12 text-center">
                      <Icon size={26} className="text-muted-foreground mx-auto mb-2 opacity-40" />
                      <p className="text-foreground text-sm font-medium">
                        {anyFilter
                          ? `No ${words.one}s match those filters`
                          : `No ${words.one}s yet`}
                      </p>
                      <p className="text-muted-foreground mt-1 text-xs">
                        {anyFilter
                          ? 'Clear the filters to see everything.'
                          : EMPTY_HINT[moduleType]}
                      </p>
                    </td>
                  </tr>
                ) : (
                  rows.map((n) => {
                    const open = expanded === n.id
                    const tax = Number(n.cgst) + Number(n.sgst) + Number(n.igst)
                    const s = NOTE_STATUS[n.status]
                    return (
                      <Fragment key={n.id}>
                        <tr className="border-border/60 hover:bg-secondary/40 border-b transition-colors">
                          <td className="px-3 py-2">
                            <button
                              onClick={() => setExpanded(open ? null : n.id)}
                              className="text-muted-foreground hover:text-foreground"
                              aria-label={open ? 'Hide detail' : 'Show detail'}
                              aria-expanded={open}
                            >
                              {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                            </button>
                          </td>
                          <td className="px-3 py-2">
                            <p className="text-foreground text-[13px] font-medium">
                              {n.noteNumber}
                            </p>
                            <p className="text-muted-foreground text-[11px]">
                              {formatDate(n.noteDate)}
                              {n.supplierDocNo ? ` · their ${n.supplierDocNo}` : ''}
                            </p>
                            {n.purchaseReturn && (
                              <a
                                href={'/print/purchase-return/' + n.purchaseReturn.id}
                                target="_blank"
                                rel="noreferrer"
                                className="text-primary font-mono text-[11px] hover:underline"
                                title="The return challan the goods left on"
                              >
                                from {n.purchaseReturn.returnNumber}
                              </a>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <p className="text-foreground text-[13px]">
                              {DOC_WORDS[n.docType]?.short ?? n.docType}
                            </p>
                            {/* The direction in words, tinted. "Debit" and
                            "credit" do not tell a buyer which way the money
                            went; "we pay them more" does. */}
                            <span
                              className={`badge ${EFFECT_WORDS[n.effect]?.cls ?? 'badge-neutral'} mt-0.5 text-[10px]`}
                              title={EFFECT_WORDS[n.effect]?.hint}
                            >
                              {EFFECT_WORDS[n.effect]?.label ?? n.effect}
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            <p className="text-foreground truncate text-[13px]">
                              {n.supplier.name}
                            </p>
                            <p className="text-muted-foreground text-[11px]">{n.supplier.code}</p>
                          </td>
                          <td className="px-3 py-2">
                            {n.bill ? (
                              <>
                                <p className="text-foreground text-[13px]">{n.bill.billNumber}</p>
                                <p className="text-muted-foreground text-[11px]">
                                  {n.bill.supplierInvoiceNo ?? formatDate(n.bill.billDate)}
                                </p>
                              </>
                            ) : (
                              <span
                                className="text-[12px] text-amber-400/90"
                                title={n.withoutBillReason ?? undefined}
                              >
                                No bill linked
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <p className="text-foreground text-[13px]">
                              {REASON_WORDS[n.reason] ?? n.reason}
                            </p>
                            {n.reasonNote && (
                              <p className="text-muted-foreground max-w-[16rem] truncate text-[11px]">
                                {n.reasonNote}
                              </p>
                            )}
                          </td>
                          <td className="text-foreground px-3 py-2 text-right text-[13px] tabular-nums">
                            ₹{money(n.taxableAmount)}
                          </td>
                          <td className="text-muted-foreground px-3 py-2 text-right text-[13px] tabular-nums">
                            ₹{money(tax)}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <span className="text-foreground text-[13px] font-semibold tabular-nums">
                              ₹{money(n.totalAmount)}
                            </span>
                            {n.effect === 'INCREASES_PAYABLE' && (
                              <span className="block text-[10px] text-amber-400">
                                adds to payable
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <span className={s.cls} title={s.hint}>
                              {s.label}
                            </span>
                            {/* Amber, and only when it is outstanding. The GST
                            treatment stopped being a gate on posting, so this
                            mark is the whole of what keeps it from being
                            forgotten — it has to be on the row, not buried in
                            a panel somebody opens. */}
                            {n.gstTreatment === 'NOT_REVIEWED' && n.status !== 'CANCELLED' && (
                              <span
                                className="mt-0.5 block text-[10px] text-amber-400/90"
                                title={GST_WORDS.NOT_REVIEWED.hint}
                              >
                                GST not classified
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <ActionMenu label={n.noteNumber} items={rowActions(n)} />
                          </td>
                        </tr>
                        {open && (
                          <tr className="bg-secondary/20">
                            <td colSpan={11} className="px-3 pb-3 pt-1">
                              <RowPanel
                                icon={Icon}
                                title={`${n.noteNumber} — ${REASON_WORDS[n.reason] ?? n.reason}`}
                                note={`${n.lines.length} line${n.lines.length === 1 ? '' : 's'}`}
                              >
                                <NoteDetail note={n} />
                              </RowPanel>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        <Pagination page={page} pages={pages} onPageChange={setPage} busy={loading || busy} />
      </div>

      <PurchaseNoteDialog
        open={dialogOpen}
        moduleType={words.raises}
        record={editing}
        initialGrnId={fromGrn}
        initialBillId={fromBill}
        onClose={() => {
          setDialogOpen(false)
          setEditing(null)
          // Arriving here was "Raise a note" on a receipt, not a visit to
          // this list in its own right — so closing the form, saved or
          // not, goes back to the Goods Receipt screen it was raised from
          // rather than stranding the user on a notes list they never
          // asked for.
          if (fromGrn) router.replace('/purchase/grn')
        }}
        onSaved={() => {
          void load()
        }}
      />
    </div>
  )
}

export function PurchaseNotesScreen(props: { moduleType: NoteScreen }) {
  // useSearchParams needs a Suspense boundary or the whole route opts out of
  // static rendering and Next refuses to build.
  return (
    <Suspense fallback={<p className="text-muted-foreground text-sm">Loading...</p>}>
      <PurchaseNotesScreenInner {...props} />
    </Suspense>
  )
}
