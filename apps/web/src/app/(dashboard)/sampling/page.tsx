'use client'
import { useCallback, useEffect, useState } from 'react'
import {
  FlaskConical,
  Plus,
  RefreshCw,
  Download,
  ArrowRight,
  Search,
  ClipboardList,
  Scissors,
  MessageSquare,
  PackageCheck,
} from 'lucide-react'
import { api, apiErrorMessage, can, type Paginated } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import { FormFrame } from '@/components/ui/FormFrame'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { Field } from '@/components/sampling/SampleSpecEditor'
import { SampleWorkspace } from '@/components/sampling/SampleWorkspace'
import { TechPackFields } from '@/components/sampling/SampleRequestEditor'
import type { SampleRequest, Lookups } from '@/components/sampling/types'
import { SAMPLE_STATE_LABEL, STYLE_STAGE_LABEL } from '@ld-erp/shared'

export default function SamplingPage() {
  const enabled = process.env.NEXT_PUBLIC_SAMPLING_ENABLED === 'true'
  const [data, setData] = useState<Paginated<SampleRequest> | null>(null),
    [lookups, setLookups] = useState<Lookups | null>(null),
    [selected, setSelected] = useState<SampleRequest | null>(null)
  const [q, setQ] = useState(''),
    [search, setSearch] = useState(''),
    [page, setPage] = useState(1),
    [tab, setTab] = useState('Requests'),
    [creating, setCreating] = useState(false)
  const [error, setError] = useState(''),
    [loading, setLoading] = useState(false)
  const load = useCallback(async () => {
    if (!enabled) return
    setLoading(true)
    setError('')
    try {
      const r = await api.get<Paginated<SampleRequest>>(
        `/sampling?page=${page}&limit=25&view=${encodeURIComponent(tab)}&q=${encodeURIComponent(search)}`
      )
      setData(r)
    } catch (e) {
      setError(apiErrorMessage(e, 'Could not load Sampling.'))
    } finally {
      setLoading(false)
    }
  }, [enabled, page, search, tab])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    if (enabled)
      api
        .get<{ data: Lookups }>('/sampling/lookups')
        .then((r) => setLookups(r.data))
        .catch((e) => setError(apiErrorMessage(e)))
  }, [enabled])
  const open = async (id: string) => {
    try {
      setError('')
      const r = await api.get<{ data: SampleRequest }>(`/sampling/${id}`)
      setSelected(r.data)
    } catch (e) {
      setError(apiErrorMessage(e))
    }
  }
  const exportCsv = async () => {
    setError('')
    try {
      const rows: SampleRequest[] = []
      let p = 1,
        totalPages = 1
      do {
        const r = await api.get<Paginated<SampleRequest>>(
          `/sampling?page=${p}&limit=100&export=true&view=${encodeURIComponent(tab)}&q=${encodeURIComponent(search)}`
        )
        rows.push(...r.data)
        totalPages = r.pagination.pages
        p++
      } while (p <= totalPages)
      const cell = (v: unknown) =>
        `"${String(v ?? '')
          .replace(/^[=+@-]/, "'$&")
          .replaceAll('"', '""')}"`
      const csv = [
        [
          'Request',
          'Title',
          'Buyer',
          'Brand',
          'Buyer style ref',
          'Style',
          'Owner',
          'Required',
          'Round',
          'State',
          'Handover',
        ],
        ...rows.map((r) => [
          r.number,
          r.title,
          r.customer?.name ?? 'Internal',
          r.brand.name,
          r.buyerStyleRef ?? '',
          r.style ? `${r.style.code} ${r.style.name}` : '',
          r.owner,
          r.requiredAt ?? '',
          r.rounds[0]?.revision,
          r.cancelledAt ? 'Cancelled' : SAMPLE_STATE_LABEL[r.rounds[0]?.state],
          r.rounds[0]?.handover?.acceptedAt ? 'Accepted' : r.rounds[0]?.handover ? 'Prepared' : '',
        ]),
      ]
        .map((r) => r.map(cell).join(','))
        .join('\r\n')
      const url = URL.createObjectURL(
          new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' })
        ),
        a = document.createElement('a')
      a.href = url
      a.download = 'sampling-register.csv'
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setError(apiErrorMessage(e, 'Could not export the register.'))
    }
  }
  if (!enabled)
    return <div className="glass-card p-5">Sampling is available in the isolated local pilot.</div>
  if (selected && lookups)
    return (
      <SampleWorkspace
        key={selected.id}
        initial={selected}
        lookups={lookups}
        back={() => {
          setSelected(null)
          void load()
        }}
      />
    )
  const rows = data?.data ?? []
  const views = [
    {
      key: 'Requests',
      label: 'All requests',
      help: 'Every sample and revision',
      icon: ClipboardList,
    },
    {
      key: 'Sampling floor',
      label: 'In progress',
      help: 'Materials, making and QC',
      icon: Scissors,
    },
    {
      key: 'Reviews',
      label: 'Ready for buyer / in review',
      help: 'Submission and buyer feedback',
      icon: MessageSquare,
    },
    {
      key: 'Handover',
      label: 'Approved & handover',
      help: 'Production package and acceptance',
      icon: PackageCheck,
    },
  ]
  const nextAction = (r: SampleRequest) =>
    r.cancelledAt
      ? 'View the cancellation record'
      : r.rounds[0]?.handover?.acceptedAt
        ? 'Handover complete'
        : r.rounds[0]?.handover
          ? 'Await production acceptance'
          : ({
              // The specification is prepared on the request's style, so that comes first.
              DRAFT: r.styleId
                ? 'Prepare the specification'
                : 'Add the tech pack and set the style',
              RELEASED: 'Continue materials, making or QC',
              QC_PASSED: 'Submit to the buyer',
              SUBMITTED: 'Record buyer feedback',
              CHANGES_REQUIRED: 'Start a correction round',
              REJECTED: 'Review feedback and next steps',
              APPROVED: 'Reconcile material and prepare handover',
            }[r.rounds[0]?.state] ?? 'Review request')
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="page-title">Sampling</h1>
          <p className="page-subtitle">
            Manage sample development, from the first buyer brief to production handover.
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-secondary" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} /> Refresh
          </button>
          {can('sampling', 'export') && (
            <button className="btn-secondary" onClick={() => void exportCsv()}>
              <Download size={15} /> Export CSV
            </button>
          )}
          {can('sampling', 'create') && (
            <button
              className="btn-primary"
              data-hotkey="new"
              onClick={() => setCreating(true)}
              disabled={!lookups}
            >
              <Plus size={15} /> New sample request
            </button>
          )}
        </div>
      </div>
      <div className="border-border bg-card flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-5 py-4 text-sm">
        {[
          'Request',
          'Technical preparation',
          'Sample making',
          'QC',
          'Buyer approval',
          'Handover',
        ].map((label, i) => (
          <span key={label} className="inline-flex items-center gap-3">
            <span className={i === 0 ? 'text-foreground font-semibold' : 'text-muted-foreground'}>
              {label}
            </span>
            {i < 5 && <ArrowRight size={13} className="text-muted-foreground" />}
          </span>
        ))}
        <p className="text-muted-foreground w-full pt-1 text-xs">
          Open a request to follow its stages. Revisions stay together as separate rounds under the
          same request.
        </p>
      </div>
      {error && (
        <p className="warn-text" role="alert">
          {error}
        </p>
      )}
      <div aria-label="Sampling views" className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
        {views.map(({ key: t, label, help, icon: Icon }) => (
          <button
            aria-pressed={t === tab}
            className={`flex items-start gap-3 rounded-xl border p-4 text-left transition-colors ${tab === t ? 'border-primary/50 bg-primary/10' : 'border-border bg-card hover:bg-muted/40'}`}
            key={t}
            onClick={() => {
              setTab(t)
              setPage(1)
            }}
          >
            <Icon
              size={18}
              className={`mt-0.5 shrink-0 ${tab === t ? 'text-primary' : 'text-muted-foreground'}`}
            />
            <span>
              <span className="block text-sm font-semibold">{label}</span>
              <span className="text-muted-foreground mt-1 block text-xs">{help}</span>
            </span>
          </button>
        ))}
      </div>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          setPage(1)
          setSearch(q)
        }}
      >
        <input
          className="form-input"
          style={{ flex: '1 1 260px', width: 'auto' }}
          aria-label="Search sample requests"
          placeholder="Search request, title, buyer reference, buyer style ref or style code…"
          data-hotkey="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button className="btn-secondary">
          <Search size={15} /> Search
        </button>
        {search && (
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              setQ('')
              setSearch('')
              setPage(1)
            }}
          >
            Clear search
          </button>
        )}
      </form>
      <div className="glass-card overflow-auto p-0">
        <table className="data-table w-full">
          <thead>
            <tr>
              <th>Request / buyer</th>
              <th>Owner</th>
              <th>Required</th>
              <th>Round</th>
              <th>Status / next action</th>
              <th>
                <span className="sr-only">Open request</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} data-row tabIndex={0}>
                <td>
                  <b>{r.number}</b>
                  <p>{r.title}</p>
                  <span className="text-muted-foreground text-xs">
                    {r.customer?.name ?? 'Internal development'} · {r.brand.name}
                  </span>
                  {(r.buyerStyleRef || r.style) && (
                    <span className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                      {r.buyerStyleRef && <span>Buyer style {r.buyerStyleRef}</span>}
                      {r.style && (
                        <span className="inline-flex items-center gap-1.5">
                          <span className="text-foreground font-mono">{r.style.code}</span>
                          {r.style.stage === 'DEVELOPMENT' && (
                            <span className="badge-warning">
                              {STYLE_STAGE_LABEL[r.style.stage]}
                            </span>
                          )}
                        </span>
                      )}
                    </span>
                  )}
                </td>
                <td>{r.owner}</td>
                <td>{r.requiredAt ? formatDate(r.requiredAt) : '—'}</td>
                <td>{r.rounds[0]?.revision}</td>
                <td>
                  <span className="badge-info">
                    {r.cancelledAt ? 'Cancelled' : SAMPLE_STATE_LABEL[r.rounds[0]?.state]}
                  </span>
                  <p className="text-muted-foreground mt-1 max-w-xs text-xs">{nextAction(r)}</p>
                </td>
                <td>
                  <button className="btn-secondary" data-row-open onClick={() => void open(r.id)}>
                    Open sample
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && (
          <div className="p-10 text-center">
            <FlaskConical size={28} className="text-muted-foreground mx-auto mb-3" />
            <p className="font-medium">
              {loading
                ? 'Loading requests…'
                : search
                  ? 'No matching sample requests'
                  : 'No requests in this view yet'}
            </p>
            <p className="text-muted-foreground mt-2 text-sm">
              {search
                ? 'Try a request number, title, buyer reference, buyer style reference or style code.'
                : tab === 'Requests'
                  ? 'Create a request to capture the buyer brief and prepare your first sample.'
                  : 'Requests appear here as they move through the sampling workflow.'}
            </p>
          </div>
        )}
      </div>
      <div className="flex items-center justify-between text-sm">
        <p>
          {data?.pagination.total ?? 0} requests · page {page} of{' '}
          {Math.max(1, data?.pagination.pages ?? 1)}
        </p>
        <div className="flex gap-2">
          <button
            className="btn-secondary"
            disabled={page === 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </button>
          <button
            className="btn-secondary"
            disabled={page >= (data?.pagination.pages ?? 1)}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      </div>
      {creating && lookups && (
        <CreateRequest
          lookups={lookups}
          close={() => setCreating(false)}
          done={(r) => {
            setCreating(false)
            setSelected(r)
            void load()
          }}
        />
      )}
    </div>
  )
}
function CreateRequest({
  lookups,
  close,
  done,
}: {
  lookups: Lookups
  close: () => void
  done: (r: SampleRequest) => void
}) {
  const [clientKey] = useState(() => crypto.randomUUID()),
    [title, setTitle] = useState(''),
    [customerId, setCustomer] = useState(''),
    [brandId, setBrand] = useState(''),
    [owner, setOwner] = useState(''),
    [buyerRef, setBuyerRef] = useState(''),
    [brief, setBrief] = useState(''),
    [requiredAt, setRequired] = useState(''),
    [techPack, setTechPack] = useState({ buyerStyleRef: '', season: '', garmentCategory: '' }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const save = async () => {
    setError('')
    setBusy(true)
    try {
      const r = await api.post<{ data: SampleRequest }>('/sampling', {
        clientKey,
        title,
        customerId: customerId || null,
        brandId,
        owner,
        buyerRef,
        brief,
        requiredAt: requiredAt || null,
        // Optional words from the tech pack; an empty box is saved as nothing.
        buyerStyleRef: techPack.buyerStyleRef.trim() || null,
        season: techPack.season.trim() || null,
        garmentCategory: techPack.garmentCategory.trim() || null,
      })
      done(r.data)
    } catch (e) {
      setError(apiErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <FormFrame
      icon={FlaskConical}
      title="New sample request"
      subtitle="Start with the buyer brief. The tech pack is attached in the next step."
      width="max-w-3xl"
      primaryInHeader={false}
      footerNote="Creates the request and opens Request & tech pack, to attach the tech pack and set up the style."
      busy={busy}
      error={error}
      onClose={close}
      primary={
        <button className="btn-primary" type="submit" form="sample-request-form" disabled={busy}>
          {busy ? 'Creating…' : 'Create & add tech pack'} <ArrowRight size={15} />
        </button>
      }
      footer={
        <button className="btn-secondary" disabled={busy} onClick={close}>
          Cancel
        </button>
      }
    >
      <form
        id="sample-request-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (!brandId) {
            setError('Choose a brand for this request.')
            return
          }
          void save()
        }}
      >
        <fieldset disabled={busy} className="grid gap-5 p-2 md:grid-cols-2">
          <div className="md:col-span-2">
            <h3 className="font-semibold">Buyer & sample request</h3>
            <p className="text-muted-foreground mt-1 text-sm">
              Fields marked * are required. One request can contain several sampling rounds.
            </p>
          </div>
          <Field
            label="Request title"
            required
            hint="A short name you will recognise in the register."
          >
            <input
              className="form-input"
              required
              maxLength={150}
              placeholder="e.g. Cotton shirt – autumn fit sample"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <Field label="Brand" required>
            <SmartSelect
              className="form-input"
              value={brandId}
              onChange={(e) => setBrand(e.target.value)}
            >
              <option value="">Pick brand</option>
              {lookups.brands.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </SmartSelect>
          </Field>
          <Field label="Buyer">
            <SmartSelect
              className="form-input"
              value={customerId}
              onChange={(e) => setCustomer(e.target.value)}
            >
              <option value="">Internal development</option>
              {lookups.customers.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </SmartSelect>
          </Field>
          <Field label="Buyer reference (optional)">
            <input
              className="form-input"
              value={buyerRef}
              onChange={(e) => setBuyerRef(e.target.value)}
            />
          </Field>
          <div className="border-border border-t pt-4 md:col-span-2">
            <h3 className="font-semibold">From the tech pack</h3>
            <p className="text-muted-foreground mt-1 text-sm">
              Optional. The tech pack file itself is attached once the request has been created, on
              the next screen.
            </p>
          </div>
          <TechPackFields
            lookups={lookups}
            value={techPack}
            onChange={(key, text) => setTechPack((t) => ({ ...t, [key]: text }))}
          />
          <div className="border-border border-t pt-4 md:col-span-2">
            <h3 className="font-semibold">Responsibility & requirements</h3>
          </div>
          <Field label="Sampling owner" required hint="Person coordinating this request.">
            <input
              className="form-input"
              required
              maxLength={100}
              placeholder="Owner's name"
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
            />
          </Field>
          <Field label="Required by (optional)">
            <input
              className="form-input"
              type="date"
              value={requiredAt}
              onChange={(e) => setRequired(e.target.value)}
            />
          </Field>
          <div className="md:col-span-2">
            <Field
              label="Buyer brief & design references"
              required
              hint="Describe the garment, intended sample, key requirements and any reference documents."
            >
              <textarea
                className="form-input"
                rows={4}
                required
                maxLength={4000}
                placeholder="What does the buyer need? Include design references and specific instructions."
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
              />
            </Field>
          </div>
        </fieldset>
      </form>
    </FormFrame>
  )
}
