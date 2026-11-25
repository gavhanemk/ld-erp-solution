'use client'

import { useCallback, useEffect, useState } from 'react'
import { Plus, Pencil, KeyRound, Ban, RotateCcw, Search, ShieldCheck, Trash2, Users2, Crown } from 'lucide-react'
import { ApiError, currentUser } from '@/lib/api'
import { settingsApi, type PermissionModule, type SettingsRole, type SettingsUser } from '@/lib/settingsApi'
import { LoadingRow, Notice } from '@/components/settings/ui'
import { HeaderStat, SectionHeader } from '@/components/settings/sections'
import { ResetPasswordDialog, UserDialog } from '@/components/settings/UserDialog'
import { RoleEditor } from '@/components/settings/RoleEditor'
import { DeleteUserDialog } from '@/components/settings/DeleteUserDialog'
import { formatDate } from '@/lib/utils'
import { ActionMenu } from '@/components/tables/ActionMenu'

const STATUS_STYLE: Record<SettingsUser['status'], { label: string; cls: string }> = {
  ACTIVE: { label: 'Active', cls: 'badge-success' },
  INACTIVE: { label: 'Inactive', cls: 'badge-neutral' },
  SUSPENDED: { label: 'Suspended', cls: 'badge-danger' },
}

export default function PeopleSettingsPage() {
  const [users, setUsers] = useState<SettingsUser[]>([])
  const [roles, setRoles] = useState<SettingsRole[]>([])
  const [modules, setModules] = useState<PermissionModule[]>([])
  const [actions, setActions] = useState<{ action: string; label: string }[]>([])

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string; inactivate?: SettingsUser } | null>(null)
  const [show, setShow] = useState<'all' | 'active' | 'inactive'>('all')
  // People or Roles & access, kept in the address (?tab=roles) so a link can open either.
  const [tab, setTabState] = useState<'people' | 'roles'>('people')
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('tab') === 'roles') setTabState('roles')
  }, [])
  const setTab = (t: 'people' | 'roles') => {
    setTabState(t)
    window.history.replaceState(null, '', t === 'roles' ? '?tab=roles' : window.location.pathname)
  }

  const [userDialog, setUserDialog] = useState<{ open: boolean; user: SettingsUser | null }>({
    open: false,
    user: null,
  })
  const [resetting, setResetting] = useState<SettingsUser | null>(null)
  const [roleDialog, setRoleDialog] = useState<{ open: boolean; role: SettingsRole | null }>({
    open: false,
    role: null,
  })

  const [selfId, setSelfId] = useState<string | null>(null)
  useEffect(() => {
    setSelfId(currentUser()?.id ?? null)
  }, [])

  /**
   * The people, the roles and the permission list, each asked for on its own.
   *
   * They used to go together, so one failed answer blanked all three and the
   * screen said only "Could not load users and roles." — with no way to tell
   * a refusal from a dropped connection. Now what did arrive is shown, a
   * dropped connection (a server waking up) is tried once more by itself, and
   * anything still missing is named, with the reason and a button to retry.
   */
  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    const fetchOnce = async <T extends { data?: unknown }>(fn: () => Promise<T>): Promise<T> => {
      const check = (res: T) => {
        if (!res || !Array.isArray(res.data)) throw new Error('the server sent back an empty answer')
        return res
      }
      try {
        return check(await fn())
      } catch (err) {
        if (err instanceof ApiError) throw err
        await new Promise((r) => setTimeout(r, 1500))
        return check(await fn())
      }
    }
    const [u, r, p] = await Promise.allSettled([
      fetchOnce(() => settingsApi.users.list()),
      fetchOnce(() => settingsApi.roles.list()),
      fetchOnce(() => settingsApi.permissions()),
    ])
    if (u.status === 'fulfilled') setUsers(u.value.data)
    if (r.status === 'fulfilled') setRoles(r.value.data)
    if (p.status === 'fulfilled') {
      setModules(p.value.data)
      setActions(p.value.actions ?? [])
    }

    const missing = [
      u.status === 'rejected' && { what: 'people', why: u.reason },
      r.status === 'rejected' && { what: 'roles', why: r.reason },
      p.status === 'rejected' && { what: 'the permission list', why: p.reason },
    ].filter(Boolean) as Array<{ what: string; why: unknown }>
    if (missing.length) {
      const why = missing[0].why
      const what = missing.map((m) => m.what).join(', ')
      setLoadError(
        why instanceof ApiError
          ? why.status === 403
            ? 'Your role does not allow managing people. Ask an administrator.'
            : `Could not load ${what}: ${why.message}`
          : `Could not load ${what}: the server did not answer${
              why instanceof Error && why.message ? ` (${why.message})` : ''
            }. Check the internet connection and try again.`,
      )
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const setStatus = async (user: SettingsUser, status: SettingsUser['status']) => {
    setBusy(true)
    setMessage(null)
    try {
      await settingsApi.users.update(user.id, { status })
      await load()
      setMessage({
        kind: 'success',
        text:
          status === 'ACTIVE'
            ? `${user.name} can sign in again.`
            : `${user.name} can no longer sign in.`,
      })
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not save.' })
    } finally {
      setBusy(false)
    }
  }

  const deleteRole = async (role: SettingsRole) => {
    if (!confirm(`Delete the role "${role.name}"? This cannot be undone.`)) return
    setBusy(true)
    setMessage(null)
    try {
      const res = await settingsApi.roles.remove(role.id)
      await load()
      setMessage({ kind: 'success', text: res.message })
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not delete.' })
    } finally {
      setBusy(false)
    }
  }

  const [deleting, setDeleting] = useState<SettingsUser | null>(null)

  // A message is shown where the eye is: the list can be long, and a result
  // written above it was out of sight halfway down.
  useEffect(() => {
    if (message) document.getElementById('people-notice')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [message])

  const term = search.trim().toLowerCase()
  const shown = show === 'all' ? users : users.filter((u) => (show === 'active' ? u.status === 'ACTIVE' : u.status !== 'ACTIVE'))
  const visible = term
    ? shown.filter((u) =>
        [u.name, u.email, u.employeeCode ?? '', u.role.name].some((f) =>
          f.toLowerCase().includes(term),
        ),
      )
    : shown

  const activeCount = users.filter((u) => u.status === 'ACTIVE').length
  const superCount = users.filter((u) => u.role.name === 'Super Admin').length

  return (
    <div className="space-y-5">
      <SectionHeader
        right={
          !loading && (
            <>
              <HeaderStat value={activeCount} label="can sign in" tone="emerald" />
              <HeaderStat value={users.length - activeCount} label="inactive" tone="muted" />
              <HeaderStat value={superCount} label="Super Admins" tone="amber" />
              <HeaderStat value={roles.length} label="roles" />
            </>
          )
        }
        below={
          <>
            <div role="tablist" aria-label="People or roles" className="border-border bg-card inline-flex rounded-xl border p-1 shadow-sm">
              {(
                [
                  ['people', Users2, 'People', users.length],
                  ['roles', ShieldCheck, 'Roles & access', roles.length],
                ] as const
              ).map(([key, Icon, label, n]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={tab === key}
                  onClick={() => setTab(key)}
                  className={`flex items-center gap-2 rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ${
                    tab === key ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                  }`}
                >
                  <Icon size={15} />
                  {label}
                  <span className={`rounded-full px-1.5 py-px text-[11px] tabular-nums ${tab === key ? 'bg-white/20' : 'bg-secondary text-foreground'}`}>
                    {n}
                  </span>
                </button>
              ))}
            </div>
            <p className="text-muted-foreground hidden min-w-0 flex-1 truncate text-xs xl:block">
              {tab === 'people'
                ? 'Everyone who can sign in. Make someone inactive when they leave; their name stays on what they did.'
                : 'A role decides which screens someone opens and what they can do there. Change a role, and everyone on it changes.'}
            </p>
            {tab === 'people' ? (
              <button
                className="btn-primary ml-auto text-xs"
                onClick={() => setUserDialog({ open: true, user: null })}
                disabled={roles.length === 0}
                data-hotkey="new"
                aria-keyshortcuts="Alt+N"
              >
                <Plus size={14} /> Add person
              </button>
            ) : (
              <button className="btn-primary ml-auto text-xs" onClick={() => setRoleDialog({ open: true, role: null })} data-hotkey="new">
                <Plus size={14} /> New role
              </button>
            )}
          </>
        }
      />

      {loadError && (
        <Notice
          kind="error"
          action={
            <button type="button" className="btn-secondary h-8 shrink-0 text-xs" onClick={() => void load()} disabled={loading}>
              <RotateCcw size={13} /> Try again
            </button>
          }
        >
          {loadError}
        </Notice>
      )}
      {message && (
        <div id="people-notice" className="scroll-mt-4">
        <Notice
          kind={message.kind}
          action={
            message.inactivate && (
              <button
                type="button"
                className="btn-secondary h-8 shrink-0 text-xs"
                disabled={busy}
                onClick={() => message.inactivate && void setStatus(message.inactivate, 'INACTIVE')}
              >
                <Ban size={13} /> Make inactive instead
              </button>
            )
          }
        >
          {message.text}
        </Notice>
        </div>
      )}

      {tab === 'people' && (
      <section className="border-border bg-card overflow-hidden rounded-xl border p-5 shadow-sm">
        {loading ? (
          <LoadingRow />
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-3">
            <div className="border-border bg-card focus-within:border-primary focus-within:ring-primary/20 flex h-9 w-full max-w-sm items-center gap-2 rounded-lg border px-3 shadow-sm focus-within:ring-2">
              <Search size={14} className="text-muted-foreground" />
              <input
                className="bg-transparent border-0 outline-none text-sm flex-1 text-foreground placeholder:text-muted-foreground"
                placeholder="Search name, email or role..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search people"
                data-hotkey="search"
              />
            </div>
            {/* Who to show: an inactive account is kept, so it has to be findable. */}
            <div className="border-border bg-secondary inline-flex rounded-lg border p-0.5 text-xs" role="tablist" aria-label="Show">
              {(
                [
                  ['all', `All ${users.length}`],
                  ['active', `Active ${users.filter((u) => u.status === 'ACTIVE').length}`],
                  ['inactive', `Inactive ${users.filter((u) => u.status !== 'ACTIVE').length}`],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={show === k}
                  onClick={() => setShow(k)}
                  className={`rounded-md px-3 py-1.5 font-medium transition-colors ${
                    show === k ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            </div>

            {visible.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4">
                {term ? 'Nobody matches that search.' : 'Nobody has been added yet.'}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="data-table w-full">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Role</th>
                      <th>Status</th>
                      <th>Last signed in</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((u, i) => {
                      const status = STATUS_STYLE[u.status]
                      const isSelf = u.id === selfId

                      return (
                        <tr key={u.id} data-row tabIndex={i === 0 ? 0 : -1}>
                          <td>
                            <div className="flex items-center gap-3">
                              <span className="bg-primary/10 text-primary flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold">
                                {u.name
                                  .split(/\s+/)
                                  .slice(0, 2)
                                  .map((w) => w.charAt(0).toUpperCase())
                                  .join('')}
                              </span>
                              <div className="min-w-0">
                                <div className="font-medium text-foreground">
                                  {u.name}
                                  {isSelf && <span className="badge-info ml-2">You</span>}
                                </div>
                                <div className="text-xs text-muted-foreground">{u.email}</div>
                                {u.employeeCode && (
                                  <div className="text-xs text-muted-foreground font-mono">{u.employeeCode}</div>
                                )}
                              </div>
                            </div>
                          </td>
                          <td>
                            <button
                              type="button"
                              className="text-foreground hover:text-primary inline-flex items-center gap-1.5 hover:underline"
                              onClick={() => {
                                const r = roles.find((x) => x.id === u.roleId)
                                if (r) setRoleDialog({ open: true, role: r })
                              }}
                              title={`See what ${u.role.name} can do`}
                            >
                              {u.role.name === 'Super Admin' ? (
                                <Crown size={13} className="text-amber-500" />
                              ) : (
                                <ShieldCheck size={13} className="text-muted-foreground" />
                              )}
                              {u.role.name}
                            </button>
                          </td>
                          <td>
                            <span className={status.cls}>{status.label}</span>
                          </td>
                          <td className="text-xs text-muted-foreground">
                            {u.lastLoginAt ? formatDate(u.lastLoginAt, 'relative') : 'Never'}
                          </td>
                          <td className="text-right whitespace-nowrap">
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                className="btn-ghost p-1.5"
                                onClick={() => setUserDialog({ open: true, user: u })}
                                data-row-open
                                title="Edit"
                                aria-label={`Edit ${u.name}`}
                              >
                                <Pencil size={15} />
                              </button>
                              <ActionMenu
                                label={`Actions for ${u.name}`}
                                items={[
                                  {
                                    key: 'password',
                                    label: 'Reset password',
                                    icon: <KeyRound size={14} />,
                                    onClick: () => setResetting(u),
                                  },
                                  u.status === 'ACTIVE'
                                    ? {
                                        key: 'inactive',
                                        label: 'Make inactive',
                                        icon: <Ban size={14} />,
                                        onClick: () => void setStatus(u, 'INACTIVE'),
                                        disabled: busy || isSelf,
                                        hint: isSelf ? 'Not your own account' : undefined,
                                      }
                                    : {
                                        key: 'active',
                                        label: 'Make active again',
                                        icon: <RotateCcw size={14} />,
                                        onClick: () => void setStatus(u, 'ACTIVE'),
                                        disabled: busy,
                                      },
                                  {
                                    key: 'delete',
                                    label: 'Delete',
                                    icon: <Trash2 size={14} />,
                                    danger: true,
                                    onClick: () => setDeleting(u),
                                    disabled: busy || isSelf,
                                    hint: isSelf ? 'Not your own account' : undefined,
                                  },
                                ]}
                              />
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <p className="text-xs text-muted-foreground mt-4">
              Make someone inactive when they leave: they can no longer sign in, and their name stays on
              everything they entered or approved. Delete is only for an account with nothing in the ERP
              — one made by mistake, or a test sign-in.
            </p>
          </>
        )}
      </section>
      )}

      {tab === 'roles' && (
        <section className="border-border bg-card overflow-hidden rounded-xl border shadow-sm">
          {loading ? (
            <div className="p-5">
              <LoadingRow />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="border-border bg-secondary/60 border-b">
                    {['Role', 'People', 'Access', ''].map((h, i) => (
                      <th
                        key={i}
                        className={`text-muted-foreground px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wider ${i === 3 ? 'text-right' : 'text-left'}`}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {roles.map((role, i) => {
                    const screens = new Set(role.permissions.filter((k) => k.endsWith(':view')).map((k) => k.split(':')[0]))
                    const modulesOn = new Set([...screens].map((k) => k.split('.')[0]))
                    const totalScreens = modules.reduce((n, m) => n + m.screens.length, 0)
                    const share = role.unrestricted ? 100 : totalScreens ? Math.round((screens.size / totalScreens) * 100) : 0
                    return (
                      <tr
                        key={role.id}
                        data-row
                        tabIndex={i === 0 ? 0 : -1}
                        className={`border-border/60 border-b last:border-0 ${role.unrestricted ? 'bg-amber-500/5' : 'hover:bg-secondary/40'}`}
                      >
                        <td className="px-5 py-3.5">
                          <div className="flex items-start gap-3">
                            <span
                              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${
                                role.unrestricted ? 'border-amber-500/30 bg-amber-500/10 text-amber-500' : 'border-primary/20 bg-primary/10 text-primary'
                              }`}
                            >
                              {role.unrestricted ? <Crown size={16} /> : <ShieldCheck size={16} />}
                            </span>
                            <div className="min-w-0">
                              <p className="text-foreground flex items-center gap-2 font-semibold">
                                {role.name}
                                {role.isSystem && <span className="badge-neutral">Built in</span>}
                              </p>
                              <p className="text-muted-foreground mt-0.5 text-xs">{role.description ?? 'No description'}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-5 py-3.5">
                          <button
                            type="button"
                            className="text-foreground hover:text-primary flex items-center gap-1.5 whitespace-nowrap text-sm"
                            onClick={() => {
                              setTab('people')
                              setSearch(role.name)
                            }}
                            title="Show the people on this role"
                          >
                            <Users2 size={14} className="text-muted-foreground" />
                            {role.userCount} {role.userCount === 1 ? 'person' : 'people'}
                          </button>
                        </td>
                        <td className="w-72 px-5 py-3.5">
                          <p className="text-foreground text-xs font-medium">
                            {role.unrestricted
                              ? 'Every screen and action, always'
                              : `${screens.size} of ${totalScreens} screens · ${modulesOn.size} modules`}
                          </p>
                          <div className="bg-secondary mt-1.5 h-1.5 rounded-full">
                            <div
                              className={`h-1.5 rounded-full ${role.unrestricted ? 'bg-amber-500' : 'bg-emerald-500'}`}
                              style={{ width: `${Math.max(share ? 3 : 0, share)}%` }}
                            />
                          </div>
                        </td>
                        <td className="w-56 px-5 py-3.5">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              type="button"
                              className={`${role.unrestricted ? 'btn-secondary' : 'btn-primary'} h-8 whitespace-nowrap text-xs`}
                              onClick={() => setRoleDialog({ open: true, role })}
                              data-row-open
                            >
                              <ShieldCheck size={13} />
                              {role.unrestricted ? 'See access' : 'Change access'}
                            </button>
                            {!role.isSystem && (
                              <button
                                type="button"
                                className="btn-ghost h-8 px-2 text-muted-foreground hover:text-red-500"
                                onClick={() => void deleteRole(role)}
                                disabled={busy}
                                title={`Delete role ${role.name}`}
                                aria-label={`Delete role ${role.name}`}
                              >
                                <Trash2 size={14} />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <UserDialog
        open={userDialog.open}
        user={userDialog.user}
        roles={roles}
        selfId={selfId}
        onClose={() => setUserDialog({ open: false, user: null })}
        onSaved={(text) => {
          setMessage({ kind: 'success', text })
          void load()
        }}
        onShowRole={(role) => setRoleDialog({ open: true, role })}
      />

      <DeleteUserDialog
        user={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={(text) => {
          setMessage({ kind: 'success', text })
          void load()
        }}
        onMakeInactive={(u) => setStatus(u, 'INACTIVE')}
      />

      <ResetPasswordDialog
        user={resetting}
        onClose={() => setResetting(null)}
        onDone={(text) => setMessage({ kind: 'success', text })}
      />

      <RoleEditor
        open={roleDialog.open}
        role={roleDialog.role}
        modules={modules}
        actions={actions}
        onClose={() => setRoleDialog({ open: false, role: null })}
        onSaved={(text) => {
          setMessage({ kind: 'success', text })
          void load()
        }}
      />
    </div>
  )
}
