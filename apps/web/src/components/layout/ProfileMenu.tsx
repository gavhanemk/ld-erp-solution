'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  CheckCircle2,
  ChevronDown,
  Crown,
  Eye,
  EyeOff,
  KeyRound,
  Keyboard,
  Loader2,
  LogOut,
  Settings,
  ShieldCheck,
  UserRound,
  type LucideIcon,
} from 'lucide-react'
import { api, ApiError, currentUser } from '@/lib/api'
import { canDo, canOpen, SUPER_ROLE, useAccess } from '@/lib/access'
import { settingsApi } from '@/lib/settingsApi'
import { signOut } from '@/lib/session'
import { useEscape } from '@/lib/useEscape'
import { cn } from '@/lib/utils'
import { FormFrame } from '@/components/ui/FormFrame'
import { Field } from '@/components/settings/ui'

/**
 * The initials at the right of the top bar, and the menu under them: who is
 * signed in and with what role, their profile, a new password, the keyboard
 * shortcuts, Settings when their role may open it, and signing out.
 *
 * It was a button that did nothing. Changing your own password lived only in
 * Settings → System, which most roles may not open, so most people had no way
 * to change theirs at all.
 */

/** "Mahesh Ghavane" -> "MG"; a single name gives its first two letters. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

type StoredUser = { name?: string; email?: string; role?: string; superAdmin?: boolean }

interface Me {
  id: string
  name: string
  email: string
  phone: string | null
  employeeCode: string | null
  lastLoginAt: string | null
  createdAt: string
  role: string
  superAdmin: boolean
}

export function ProfileMenu() {
  const router = useRouter()
  const access = useAccess()
  const [open, setOpen] = useState(false)
  const [user, setUser] = useState<StoredUser | null>(null)
  const [dialog, setDialog] = useState<'profile' | 'password' | null>(null)
  const [leaving, setLeaving] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // localStorage is browser-only; read again when the access arrives, as it
  // brings the role up to date.
  useEffect(() => {
    setUser(currentUser())
  }, [access])

  // A click anywhere else, or Escape, closes the menu.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  useEscape(() => setOpen(false), open)

  // From the keyboard: the first entry has focus when it opens, the arrows
  // move between entries.
  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [open])
  const onMenuKey = (e: React.KeyboardEvent) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    e.preventDefault()
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLElement)
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? items.length - 1
          : (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }

  const choose = (fn: () => void) => () => {
    setOpen(false)
    fn()
  }

  const role = access.role ?? user?.role ?? null
  const superAdmin = access.superAdmin || Boolean(user?.superAdmin) || role === SUPER_ROLE
  const mayOpenSettings = canOpen('/settings/company') || canOpen('/settings/people')

  return (
    <div ref={boxRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-secondary"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Your account${user?.name ? `: ${user.name}` : ''}`}
        title="Your account"
      >
        <Avatar name={user?.name} />
        <ChevronDown
          size={14}
          className={cn('hidden text-muted-foreground transition-transform sm:block', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Your account"
          onKeyDown={onMenuKey}
          // Solid, not glass: inside the top bar's own blur a glass card's blur
          // does nothing, and the page showed through the entries.
          className="animate-fade-in border-border bg-card absolute right-0 top-12 z-50 w-72 overflow-hidden rounded-xl border shadow-xl"
        >
          <div className="border-border flex items-center gap-3 border-b px-4 py-3.5">
            <Avatar name={user?.name} size="lg" />
            <div className="min-w-0">
              <p className="text-foreground truncate text-sm font-semibold">{user?.name ?? 'Signed in'}</p>
              {user?.email && <p className="text-muted-foreground truncate text-xs">{user.email}</p>}
              {role && <RoleBadge role={role} superAdmin={superAdmin} className="mt-1.5" />}
            </div>
          </div>

          <div className="py-1.5">
            <MenuItem icon={UserRound} label="My profile" hint="Your details and what you can open" onClick={choose(() => setDialog('profile'))} />
            <MenuItem icon={KeyRound} label="Change password" onClick={choose(() => setDialog('password'))} />
            <MenuItem
              icon={Keyboard}
              label="Keyboard shortcuts"
              kbd="Alt+/"
              onClick={choose(() => window.dispatchEvent(new Event('ld:shortcuts')))}
            />
            {mayOpenSettings && <MenuItem icon={Settings} label="Settings" onClick={choose(() => router.push('/settings'))} />}
          </div>

          <div className="border-border border-t py-1.5">
            <MenuItem
              icon={leaving ? Loader2 : LogOut}
              spin={leaving}
              label={leaving ? 'Signing out…' : 'Sign out'}
              danger
              onClick={() => {
                setLeaving(true)
                void signOut((href) => router.push(href))
              }}
            />
          </div>
        </div>
      )}

      {dialog === 'profile' && (
        <ProfileDialog onClose={() => setDialog(null)} onChangePassword={() => setDialog('password')} />
      )}
      {dialog === 'password' && <ChangePasswordDialog onClose={() => setDialog(null)} />}
    </div>
  )
}

function Avatar({ name, size = 'md' }: { name?: string; size?: 'md' | 'lg' | 'xl' }) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full border border-teal-500/30 bg-teal-500/20 font-bold text-teal-400',
        size === 'xl' ? 'h-14 w-14 text-lg' : size === 'lg' ? 'h-10 w-10 text-sm' : 'h-8 w-8 text-xs',
      )}
    >
      {name ? initialsOf(name) : '—'}
    </span>
  )
}

function RoleBadge({ role, superAdmin, className }: { role: string; superAdmin: boolean; className?: string }) {
  const Icon = superAdmin ? Crown : ShieldCheck
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        superAdmin ? 'border-amber-500/30 bg-amber-500/10 text-amber-500' : 'border-border bg-secondary text-muted-foreground',
        className,
      )}
    >
      <Icon size={11} />
      {role}
    </span>
  )
}

function MenuItem({
  icon: Icon,
  label,
  hint,
  kbd,
  danger,
  spin,
  onClick,
}: {
  icon: LucideIcon
  label: string
  hint?: string
  kbd?: string
  danger?: boolean
  spin?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        'hover:bg-secondary focus:bg-secondary flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition-colors focus:outline-none',
        danger ? 'text-red-500' : 'text-foreground',
      )}
    >
      <Icon size={16} className={cn(danger ? 'text-red-500' : 'text-muted-foreground', spin && 'animate-spin')} />
      <span className="min-w-0 flex-1">
        <span className="block">{label}</span>
        {hint && <span className="text-muted-foreground block text-[11px]">{hint}</span>}
      </span>
      {kbd && (
        <kbd className="border-border bg-background text-muted-foreground rounded border px-1.5 py-0.5 text-[10px]">{kbd}</kbd>
      )}
    </button>
  )
}

const when = (d: string | null, withTime = true) =>
  d
    ? new Date(d).toLocaleString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
      })
    : null

// ── My profile ───────────────────────────────────────────────────────────────

function ProfileDialog({ onClose, onChangePassword }: { onClose: () => void; onChangePassword: () => void }) {
  const access = useAccess()
  const [me, setMe] = useState<Me | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Read fresh: the copy kept in this browser may be from before an
  // administrator changed the name or the role.
  useEffect(() => {
    api
      .get<{ user: Me }>('/auth/me')
      .then((res) => setMe(res.user))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load your details.'))
  }, [])

  const superAdmin = Boolean(me?.superAdmin) || me?.role === SUPER_ROLE
  const screens = access.screens ?? []
  const openable = screens.filter((s) => canDo(s.key, 'view')).length
  const managePeople = canOpen('/settings/people')

  return (
    <FormFrame
      icon={UserRound}
      title="My profile"
      subtitle={me?.email}
      width="max-w-xl"
      primaryInHeader={false}
      primary={
        <button type="button" className="btn-primary" onClick={onChangePassword}>
          <KeyRound size={15} />
          Change password
        </button>
      }
      footer={
        <button type="button" className="btn-ghost" onClick={onClose}>
          Close
        </button>
      }
      error={error}
      onClose={onClose}
    >
      {!me && !error && (
        <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
          <Loader2 size={15} className="animate-spin" /> Loading your details…
        </div>
      )}

      {me && (
        <div className="space-y-4">
          <div className="border-border flex items-center gap-4 rounded-xl border p-4">
            <Avatar name={me.name} size="xl" />
            <div className="min-w-0">
              <p className="text-foreground truncate text-base font-semibold">{me.name}</p>
              <p className="text-muted-foreground truncate text-sm">{me.email}</p>
              <RoleBadge role={me.role} superAdmin={superAdmin} className="mt-2" />
            </div>
          </div>

          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Detail label="Sign-in email" value={me.email} />
            <Detail label="Phone" value={me.phone} />
            <Detail label="Employee code" value={me.employeeCode} />
            <Detail
              label="What you can open"
              value={
                superAdmin
                  ? 'Every screen and action'
                  : screens.length
                    ? `${openable} of ${screens.length} screens`
                    : null
              }
            />
            <Detail label="Signed in" value={when(me.lastLoginAt)} />
            <Detail label="Account made" value={when(me.createdAt, false)} />
          </dl>

          <p className="text-muted-foreground text-xs">
            Your name, email, phone and role are kept in Settings → People.{' '}
            {managePeople ? (
              <Link href="/settings/people" onClick={onClose} className="text-primary font-medium hover:underline">
                Open People
              </Link>
            ) : (
              'Ask an administrator to change them.'
            )}
          </p>
        </div>
      )}
    </FormFrame>
  )
}

function Detail({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="bg-secondary/50 min-w-0 rounded-lg px-3 py-2">
      <dt className="text-muted-foreground text-[11px]">{label}</dt>
      <dd className={cn('truncate text-sm', value ? 'text-foreground font-medium' : 'text-muted-foreground')} title={value ?? undefined}>
        {value || 'Not given'}
      </dd>
    </div>
  )
}

// ── Change password ──────────────────────────────────────────────────────────

type PwKey = 'current' | 'next' | 'confirm'

function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const [values, setValues] = useState<Record<PwKey, string>>({ current: '', next: '', confirm: '' })
  const [errors, setErrors] = useState<Partial<Record<PwKey, string>>>({})
  const [error, setError] = useState<string | null>(null)
  const [show, setShow] = useState(false)
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState(false)

  const set = (key: PwKey, v: string) => {
    setValues((s) => ({ ...s, [key]: v }))
    setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e))
  }
  const focus = (key: PwKey) => document.getElementById(`pw-${key}`)?.focus()

  // The server's rules (settings.schemas.ts), said here first so nobody waits
  // on a round trip to learn the password needs a number.
  const submit = async () => {
    const { current, next, confirm } = values
    const found: Partial<Record<PwKey, string>> = {}
    if (!current) found.current = 'Enter your current password'
    if (next.length < 8) found.next = 'Use at least 8 characters'
    else if (next.length > 72) found.next = 'Use at most 72 characters'
    else if (!/[A-Za-z]/.test(next)) found.next = 'Include at least one letter'
    else if (!/[0-9]/.test(next)) found.next = 'Include at least one number'
    else if (next === current) found.next = 'Choose a password different from the current one'
    if (!confirm) found.confirm = 'Type the new password again'
    else if (!found.next && confirm !== next) found.confirm = 'The two do not match'
    setErrors(found)
    setError(null)
    const first = (['current', 'next', 'confirm'] as PwKey[]).find((k) => found[k])
    if (first) {
      focus(first)
      return
    }

    setSaving(true)
    try {
      await settingsApi.changeOwnPassword(current, next)
      setDone(true)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'BAD_PASSWORD') {
        setErrors({ current: err.message })
        focus('current')
      } else if (err instanceof ApiError && err.code === 'SAME_PASSWORD') {
        setErrors({ next: err.message })
        focus('next')
      } else {
        setError(err instanceof ApiError ? err.message : 'Could not change the password. Is the server reachable?')
      }
    } finally {
      setSaving(false)
    }
  }

  const box = (key: PwKey, label: string, autoComplete: string, help?: string) => (
    <Field label={label} htmlFor={`pw-${key}`} required error={errors[key]} help={help}>
      <div className="relative">
        <input
          id={`pw-${key}`}
          type={show ? 'text' : 'password'}
          autoComplete={autoComplete}
          className="form-input pr-10"
          value={values[key]}
          onChange={(e) => set(key, e.target.value)}
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setShow((s) => !s)}
          className="text-muted-foreground hover:text-foreground absolute inset-y-0 right-0 flex w-10 items-center justify-center"
          aria-label={show ? 'Hide the passwords' : 'Show the passwords'}
          title={show ? 'Hide' : 'Show'}
        >
          {show ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      </div>
    </Field>
  )

  return (
    <FormFrame
      icon={KeyRound}
      title="Change password"
      subtitle="Your own sign-in only"
      width="max-w-lg"
      primaryInHeader={false}
      primary={
        done ? (
          <button type="button" className="btn-primary" onClick={onClose}>
            Done
          </button>
        ) : (
          <button type="button" className="btn-primary" onClick={() => void submit()} disabled={saving}>
            {saving && <Loader2 size={15} className="animate-spin" />}
            Change password
          </button>
        )
      }
      footer={
        !done && (
          <button type="button" className="btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
        )
      }
      error={error}
      onClose={onClose}
      busy={saving}
    >
      {done ? (
        <div className="flex items-start gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
          <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-emerald-500" />
          <div>
            <p className="text-foreground text-sm font-semibold">Your password is changed</p>
            <p className="text-muted-foreground mt-1 text-sm">
              You stay signed in here. Use the new password the next time you sign in, on this or any other device.
            </p>
          </div>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          {box('current', 'Current password', 'current-password')}
          {box('next', 'New password', 'new-password', 'At least 8 characters, with a letter and a number')}
          {/* As in every window: Enter goes on to the next box, Ctrl+S (⌘S) changes it. */}
          {box('confirm', 'Type the new password again', 'new-password')}
        </form>
      )}
    </FormFrame>
  )
}
