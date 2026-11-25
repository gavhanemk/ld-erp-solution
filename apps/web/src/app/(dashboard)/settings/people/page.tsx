'use client'

import { useCallback, useEffect, useState } from 'react'
import { Plus, Pencil, KeyRound, Ban, RotateCcw, Search, ShieldCheck, Trash2, Users2, Crown } from 'lucide-react'
import { ApiError, currentUser } from '@/lib/api'
import { settingsApi, type PermissionModule, type SettingsRole, type SettingsUser } from '@/lib/settingsApi'
import { LoadingRow, Notice, SettingsCard } from '@/components/settings/ui'
import { ResetPasswordDialog, UserDialog } from '@/components/settings/UserDialog'
import { RoleEditor } from '@/components/settings/RoleEditor'
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

  /**
   * Deleting a person. The server refuses anyone the ERP has a record of and
   * says what it found; the refusal then offers to make them inactive, which
   * is what such an account needs.
   */
  const deleteUser = async (user: SettingsUser) => {
    if (
      !confirm(
        `Delete ${user.name} (${user.email})?

Only an account with nothing in the ERP can be deleted — one made by mistake, or a test sign-in. Anyone who has entered or approved anything is made inactive instead.

This cannot be undone.`,
      )
    )
      return
    setBusy(true)
    setMessage(null)
    try {
      const res = await settingsApi.users.remove(user.id)
      await load()
      setMessage({ kind: 'success', text: res.message })
    } catch (err) {
      setMessage({
        kind: 'error',
        text: err instanceof ApiError ? err.message : 'Could not delete.',
        inactivate:
          err instanceof ApiError && err.code === 'USER_HAS_RECORDS' && user.status === 'ACTIVE' ? user : undefined,
      })
    } finally {
      setBusy(false)
    }
  }

  const term = search.trim().toLowerCase()
  const shown = show === 'all' ? users : users.filter((u) => (show === 'active' ? u.status === 'ACTIVE' : u.status !== 'ACTIVE'))
  const visible = term
    ? shown.filter((u) =>
        [u.name, u.email, u.employeeCode ?? '', u.role.name].some((f) =>
          f.toLowerCase().includes(term),
        ),
      )
    : shown

  return (
    <div className="space-y-5">
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
      )}

      <SettingsCard
        icon={Users2}
        title="People"
        description={
          loading
            ? 'Everyone who can sign in to the ERP.'
            : `Everyone who can sign in to the ERP · ${users.filter((u) => u.status === 'ACTIVE').length} active of ${users.length}`
        }
        actions={
          <button
            className="btn-primary text-xs"
            onClick={() => setUserDialog({ open: true, user: null })}
            disabled={roles.length === 0}
            data-hotkey="new"
            aria-keyshortcuts="Alt+N"
          >
            <Plus size={14} /> Add person
          </button>
        }
      >
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
                          <td>{u.role.name}</td>
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
                                    onClick: () => void deleteUser(u),
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
      </SettingsCard>

      <SettingsCard
        icon={ShieldCheck}
        title="Roles"
        description="A role decides what someone can see and do. Change the role, and everyone on it changes with it."
        actions={
          <button
            className="btn-secondary text-xs"
            onClick={() => setRoleDialog({ open: true, role: null })}
          >
            <Plus size={14} /> New role
          </button>
        }
      >
        {loading ? (
          <LoadingRow />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {roles.map((role) => (
              <div
                key={role.id}
                className={`flex flex-col gap-3 rounded-lg border p-4 transition-colors ${
                  role.unrestricted ? 'border-amber-500/40 bg-amber-500/5' : 'border-border/70 hover:border-primary/40'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground truncate">
                      {role.unrestricted && <Crown size={14} className="shrink-0 text-amber-500" />}
                      {role.name}
                    </p>
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {role.description ?? 'No description'}
                    </p>
                  </div>
                  {role.isSystem && <span className="badge-neutral shrink-0">Built in</span>}
                </div>

                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Users2 size={12} />
                    {role.userCount} {role.userCount === 1 ? 'person' : 'people'}
                  </span>
                  <span>
                    {role.unrestricted
                      ? 'Every screen, always'
                      : `${new Set(role.permissions.filter((k) => k.endsWith(':view')).map((k) => k.split(':')[0])).size} screens · ${role.permissions.length} switches on`}
                  </span>
                </div>

                <div className="flex items-center gap-2 mt-auto pt-2 border-t border-border/60">
                  <button
                    className="btn-ghost text-xs px-2 py-1"
                    onClick={() => setRoleDialog({ open: true, role })}
                  >
                    <Pencil size={13} />
                    {role.unrestricted ? 'See access' : 'Change access'}
                  </button>

                  {!role.isSystem && (
                    <button
                      className="btn-ghost text-xs px-2 py-1 text-muted-foreground hover:text-red-400 ml-auto"
                      onClick={() => void deleteRole(role)}
                      disabled={busy}
                      aria-label={`Delete role ${role.name}`}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </SettingsCard>

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
