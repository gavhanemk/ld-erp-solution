'use client'

import { useCallback, useEffect, useState } from 'react'
import { Plus, Pencil, KeyRound, Ban, RotateCcw, Search, Trash2, Users2 } from 'lucide-react'
import { ApiError, currentUser } from '@/lib/api'
import { settingsApi, type PermissionModule, type SettingsRole, type SettingsUser } from '@/lib/settingsApi'
import { LoadingRow, Notice, SettingsCard } from '@/components/settings/ui'
import { ResetPasswordDialog, UserDialog } from '@/components/settings/UserDialog'
import { RoleEditor } from '@/components/settings/RoleEditor'
import { formatDate } from '@/lib/utils'

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
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

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

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [u, r, p] = await Promise.all([
        settingsApi.users.list(),
        settingsApi.roles.list(),
        settingsApi.permissions(),
      ])
      setUsers(u.data)
      setRoles(r.data)
      setModules(p.data)
      setActions(p.actions)
    } catch (err) {
      setMessage({
        kind: 'error',
        text:
          err instanceof ApiError
            ? err.status === 403
              ? 'Your role does not allow managing people. Ask an administrator.'
              : err.message
            : 'Could not load users and roles.',
      })
    } finally {
      setLoading(false)
    }
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

  const term = search.trim().toLowerCase()
  const visible = term
    ? users.filter((u) =>
        [u.name, u.email, u.employeeCode ?? '', u.role.name].some((f) =>
          f.toLowerCase().includes(term),
        ),
      )
    : users

  return (
    <div className="space-y-6">
      {message && <Notice kind={message.kind}>{message.text}</Notice>}

      <SettingsCard
        title="People"
        description="Everyone who can sign in to the ERP."
        actions={
          <button
            className="btn-primary text-xs"
            onClick={() => setUserDialog({ open: true, user: null })}
            disabled={roles.length === 0}
          >
            <Plus size={14} /> Add person
          </button>
        }
      >
        {loading ? (
          <LoadingRow />
        ) : (
          <>
            <div className="flex items-center gap-2 px-3 py-2 mb-4 rounded-lg bg-secondary border border-border max-w-sm">
              <Search size={14} className="text-muted-foreground" />
              <input
                className="bg-transparent border-0 outline-none text-sm flex-1 text-foreground placeholder:text-muted-foreground"
                placeholder="Search name, email or role..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search people"
              />
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
                    {visible.map((u) => {
                      const status = STATUS_STYLE[u.status]
                      const isSelf = u.id === selfId

                      return (
                        <tr key={u.id}>
                          <td>
                            <div className="font-medium text-foreground">
                              {u.name}
                              {isSelf && <span className="badge-info ml-2">You</span>}
                            </div>
                            <div className="text-xs text-muted-foreground">{u.email}</div>
                            {u.employeeCode && (
                              <div className="text-xs text-muted-foreground font-mono">
                                {u.employeeCode}
                              </div>
                            )}
                          </td>
                          <td>{u.role.name}</td>
                          <td>
                            <span className={status.cls}>{status.label}</span>
                          </td>
                          <td className="text-xs text-muted-foreground">
                            {u.lastLoginAt ? formatDate(u.lastLoginAt, 'relative') : 'Never'}
                          </td>
                          <td className="text-right whitespace-nowrap">
                            <div className="flex justify-end gap-1">
                              <button
                                className="btn-ghost p-1.5"
                                onClick={() => setUserDialog({ open: true, user: u })}
                                title="Edit"
                                aria-label={`Edit ${u.name}`}
                              >
                                <Pencil size={15} />
                              </button>
                              <button
                                className="btn-ghost p-1.5"
                                onClick={() => setResetting(u)}
                                title="Reset password"
                                aria-label={`Reset password for ${u.name}`}
                              >
                                <KeyRound size={15} />
                              </button>
                              {u.status === 'ACTIVE' ? (
                                <button
                                  className="btn-ghost p-1.5 hover:text-red-400 disabled:opacity-40"
                                  onClick={() => void setStatus(u, 'INACTIVE')}
                                  disabled={busy || isSelf}
                                  title={
                                    isSelf ? 'You cannot deactivate your own account' : 'Deactivate'
                                  }
                                  aria-label={`Deactivate ${u.name}`}
                                >
                                  <Ban size={15} />
                                </button>
                              ) : (
                                <button
                                  className="btn-ghost p-1.5 hover:text-emerald-400"
                                  onClick={() => void setStatus(u, 'ACTIVE')}
                                  disabled={busy}
                                  title="Let them sign in again"
                                  aria-label={`Reactivate ${u.name}`}
                                >
                                  <RotateCcw size={15} />
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

            <p className="text-xs text-muted-foreground mt-4">
              People are never deleted — every document records who created and approved it. A
              deactivated account simply cannot sign in.
            </p>
          </>
        )}
      </SettingsCard>

      <SettingsCard
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
                className="p-4 rounded-lg border border-border bg-secondary/30 flex flex-col gap-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground truncate">{role.name}</p>
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
                    {role.unrestricted ? 'Full access' : `${role.permissions.length} permissions`}
                  </span>
                </div>

                <div className="flex items-center gap-2 mt-auto pt-2 border-t border-border/60">
                  <button
                    className="btn-ghost text-xs px-2 py-1"
                    onClick={() => setRoleDialog({ open: true, role })}
                  >
                    <Pencil size={13} />
                    {role.unrestricted ? 'View' : 'Change access'}
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
