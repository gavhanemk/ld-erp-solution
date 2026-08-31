import { ActivityIndicator, Pressable, Text, View, TextInput } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { AlertCircle, CheckCircle2, Inbox, Clock } from 'lucide-react-native'

/**
 * The pieces every screen is built from.
 *
 * The mobile counterpart of the component classes in
 * apps/web/src/app/globals.css. The same rule applies here as there: a screen
 * assembles these, it does not restyle a button of its own. If something is
 * needed twice, it belongs in this file.
 *
 * Colours are the role names from tailwind.config.js — bg-card, text-foreground
 * — never a colour typed into a screen. See docs/02-design-rules.md.
 */

export function Screen({ children }: { children: React.ReactNode }) {
  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      {children}
    </SafeAreaView>
  )
}

export function PageHeading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View className="px-4 pt-2 pb-4">
      <Text className="text-2xl font-bold text-foreground">{title}</Text>
      {subtitle ? <Text className="text-xs text-muted-foreground mt-0.5">{subtitle}</Text> : null}
    </View>
  )
}

export function Card({
  children,
  className = '',
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <View className={`bg-card border border-border rounded-xl p-4 ${className}`}>{children}</View>
  )
}

/** A tappable card. Used for list rows that open a detail screen. */
export function CardButton({
  children,
  onPress,
  className = '',
}: {
  children: React.ReactNode
  onPress: () => void
  className?: string
}) {
  return (
    <Pressable
      onPress={onPress}
      className={`bg-card border border-border rounded-xl p-4 active:opacity-70 ${className}`}
    >
      {children}
    </Pressable>
  )
}

type ButtonKind = 'primary' | 'secondary' | 'ghost' | 'danger'

const BUTTON_STYLE: Record<ButtonKind, { box: string; label: string }> = {
  primary: { box: 'bg-teal-500 active:bg-teal-600', label: 'text-white' },
  secondary: { box: 'bg-secondary border border-border active:opacity-70', label: 'text-foreground' },
  ghost: { box: 'active:opacity-60', label: 'text-muted-foreground' },
  danger: { box: 'bg-destructive active:opacity-80', label: 'text-white' },
}

/**
 * Minimum height is 48, not the 32 a mouse would need. A thumb is a blunt
 * instrument and this is used standing on a factory floor.
 */
export function Button({
  label,
  onPress,
  kind = 'primary',
  busy,
  disabled,
  icon,
  className = '',
}: {
  label: string
  onPress: () => void
  kind?: ButtonKind
  busy?: boolean
  disabled?: boolean
  icon?: React.ReactNode
  className?: string
}) {
  const style = BUTTON_STYLE[kind]
  const off = disabled || busy

  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={label}
      className={`min-h-[48px] flex-row items-center justify-center gap-2 rounded-lg px-4 ${style.box} ${off ? 'opacity-50' : ''} ${className}`}
    >
      {busy ? <ActivityIndicator size="small" color="#fff" /> : icon}
      <Text className={`text-sm font-semibold ${style.label}`}>{label}</Text>
    </Pressable>
  )
}

type BadgeKind = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'purple'

// The six meanings from docs/02-design-rules.md, and no seventh.
const BADGE_STYLE: Record<BadgeKind, string> = {
  success: 'bg-emerald-500/15 border-emerald-500/30',
  warning: 'bg-amber-500/15 border-amber-500/30',
  danger: 'bg-red-500/15 border-red-500/30',
  info: 'bg-teal-500/15 border-teal-500/30',
  neutral: 'bg-slate-500/15 border-slate-500/30',
  purple: 'bg-purple-500/15 border-purple-500/30',
}

const BADGE_TEXT: Record<BadgeKind, string> = {
  success: 'text-emerald-500',
  warning: 'text-amber-500',
  danger: 'text-red-500',
  info: 'text-teal-500',
  neutral: 'text-slate-500',
  purple: 'text-purple-500',
}

export function Badge({ label, kind = 'neutral' }: { label: string; kind?: BadgeKind }) {
  return (
    <View className={`self-start rounded-full border px-2.5 py-0.5 ${BADGE_STYLE[kind]}`}>
      <Text className={`text-xs font-medium ${BADGE_TEXT[kind]}`}>{label}</Text>
    </View>
  )
}

/** Maps a document status to one of the six meanings. Shared so a DRAFT looks
 *  the same on every screen. */
export function statusKind(status: string): BadgeKind {
  const s = (status || '').toUpperCase()
  if (['COMPLETED', 'APPROVED', 'PAID', 'RECEIVED', 'CONFIRMED'].includes(s)) return 'success'
  if (['PENDING', 'SENT', 'PARTIALLY_RECEIVED', 'PARTIALLY_DISPATCHED', 'IN_PRODUCTION'].includes(s))
    return 'warning'
  if (['CANCELLED', 'REJECTED', 'OVERDUE'].includes(s)) return 'danger'
  if (s === 'DRAFT') return 'info'
  return 'neutral'
}

/** Turns CONFIRMED into Confirmed, PARTIALLY_RECEIVED into Partly received. */
export function prettyStatus(status: string): string {
  if (!status) return ''
  const words = status.replace(/_/g, ' ').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function Field({
  label,
  error,
  help,
  children,
}: {
  label: string
  error?: string
  help?: string
  children: React.ReactNode
}) {
  return (
    <View className="mb-4">
      <Text className="text-sm font-medium text-foreground mb-1.5">{label}</Text>
      {children}
      {error ? (
        <Text className="text-xs text-red-500 mt-1">{error}</Text>
      ) : help ? (
        <Text className="text-xs text-muted-foreground mt-1">{help}</Text>
      ) : null}
    </View>
  )
}

export function Input(props: React.ComponentProps<typeof TextInput>) {
  return (
    <TextInput
      placeholderTextColor="#64748b"
      {...props}
      className={`min-h-[48px] rounded-lg border border-border bg-secondary px-3 text-base text-foreground ${props.className ?? ''}`}
    />
  )
}

/** A label on the left, a value on the right. The workhorse of every detail
 *  screen. */
export function Row({
  label,
  value,
  strong,
}: {
  label: string
  value: string | number
  strong?: boolean
}) {
  return (
    <View className="flex-row items-center justify-between py-1.5">
      <Text className="text-xs text-muted-foreground">{label}</Text>
      <Text className={`text-sm ${strong ? 'font-bold text-foreground' : 'text-foreground'}`}>
        {value}
      </Text>
    </View>
  )
}

export function Loading({ label = 'Loading...' }: { label?: string }) {
  return (
    <View className="flex-1 items-center justify-center gap-3 py-12">
      <ActivityIndicator />
      <Text className="text-sm text-muted-foreground">{label}</Text>
    </View>
  )
}

/**
 * Shown while the free hosting plan wakes the server up. A spinner alone for
 * fifty seconds reads as a broken app; saying what is happening does not.
 */
export function WakingServer() {
  return (
    <View className="flex-1 items-center justify-center gap-3 px-8 py-12">
      <Clock size={28} color="#f59e0b" />
      <Text className="text-sm font-semibold text-foreground">Waking the server</Text>
      <Text className="text-xs text-muted-foreground text-center">
        It sleeps when nobody has used it for a while. This takes up to a minute the first time
        each day.
      </Text>
    </View>
  )
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <View className="flex-1 items-center justify-center gap-2 px-8 py-12">
      <Inbox size={28} color="#64748b" />
      <Text className="text-sm font-semibold text-foreground text-center">{title}</Text>
      {hint ? <Text className="text-xs text-muted-foreground text-center">{hint}</Text> : null}
    </View>
  )
}

/** Always shows the message the API sent — it is already written for a person.
 *  See the words section of docs/02-design-rules.md. */
export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <View className="m-4 rounded-lg border border-red-500/40 bg-red-500/5 p-4 gap-3">
      <View className="flex-row items-start gap-2">
        <AlertCircle size={16} color="#ef4444" />
        <Text className="flex-1 text-sm text-red-500">{message}</Text>
      </View>
      {onRetry ? <Button label="Try again" kind="secondary" onPress={onRetry} /> : null}
    </View>
  )
}

export function SuccessNotice({ message }: { message: string }) {
  return (
    <View className="m-4 flex-row items-start gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-4">
      <CheckCircle2 size={16} color="#10b981" />
      <Text className="flex-1 text-sm text-emerald-500">{message}</Text>
    </View>
  )
}

/** The honest placeholder for a module the server cannot do yet. */
export function ComingSoon({ what, why }: { what: string; why?: string }) {
  return (
    <View className="flex-1 items-center justify-center gap-2 px-8">
      <Text className="text-lg font-semibold text-foreground text-center">{what}</Text>
      <Text className="text-sm text-muted-foreground text-center">
        {why ?? 'Not built yet. It will appear here as soon as it is ready.'}
      </Text>
    </View>
  )
}
