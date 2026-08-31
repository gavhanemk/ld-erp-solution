import { Alert, ScrollView, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import {
  Sparkles, Users, Package, IndianRupee, Boxes, Factory, Truck, UserCog,
  LogOut, ChevronRight, Clock, Monitor, FileText, Receipt, Wallet,
  ClipboardList, Settings as SettingsIcon, ShieldCheck,
} from 'lucide-react-native'
import { useAuth } from '@/lib/auth'
import { API_URL } from '@/lib/api'
import { Screen, PageHeading, Card, CardButton, Button, Badge } from '@/components/ui'
import { Reveal } from '@/components/motion'
import { SERIES } from '@/components/charts'

/**
 * Everything the ERP has, and where each part actually stands.
 *
 * Three states, because two would be a lie. "Soon" and "on the web" are not the
 * same thing at all — one means nobody can do it yet, the other means it works
 * and simply has no phone screen. Telling a store keeper that stock is "coming
 * soon" when it does not exist anywhere is honest; saying it about document
 * numbering, which has worked on the web for weeks, is not.
 */

type State =
  /** Works from the phone. */
  | 'live'
  /** Can be read on the phone; changing it is done on the web. */
  | 'read'
  /** Exists, but only on the web. */
  | 'web'
  /** The server cannot do this at all yet. */
  | 'soon'

interface Entry {
  label: string
  hint: string
  icon: React.ReactNode
  state: State
  href?: string
  /** Permission needed to see it at all. */
  needs?: [string, string]
}

interface Group {
  title: string
  entries: Entry[]
}

const STATE_BADGE: Record<Exclude<State, 'live'>, { label: string; kind: 'info' | 'neutral' }> = {
  read: { label: 'view only', kind: 'info' },
  web: { label: 'on the web', kind: 'neutral' },
  soon: { label: 'soon', kind: 'neutral' },
}

const teal = SERIES[0]
const grey = '#64748b'

export default function More() {
  const { user, signOut, can } = useAuth()
  const router = useRouter()

  const groups: Group[] = [
    {
      title: 'Sales',
      entries: [
        {
          label: 'Sales orders',
          hint: 'What customers have ordered',
          icon: <FileText size={18} color={teal} />,
          state: 'live',
          href: '/orders',
          needs: ['sales', 'view'],
        },
        {
          label: 'Outstanding',
          hint: 'Who owes what, oldest first',
          icon: <IndianRupee size={18} color={teal} />,
          state: 'live',
          href: '/outstanding',
          needs: ['accounts', 'view'],
        },
        {
          label: 'Invoices',
          hint: 'Tax invoices raised',
          icon: <Receipt size={18} color={teal} />,
          state: 'read',
          href: '/invoices',
          needs: ['sales', 'view'],
        },
      ],
    },
    {
      title: 'Purchase',
      entries: [
        {
          label: 'Purchase orders',
          hint: 'Raise, send and cancel from here',
          icon: <FileText size={18} color={teal} />,
          state: 'live',
          href: '/orders',
          needs: ['purchase', 'view'],
        },
        {
          label: 'Goods receipt',
          hint: 'Receive against a purchase order',
          icon: <Truck size={18} color={grey} />,
          state: 'soon',
          needs: ['purchase', 'view'],
        },
        {
          label: 'Purchase bills',
          hint: 'Supplier invoices against orders',
          icon: <Receipt size={18} color={grey} />,
          state: 'soon',
          needs: ['purchase', 'view'],
        },
        {
          label: 'Supplier payments',
          hint: 'What has been paid out',
          icon: <Wallet size={18} color={grey} />,
          state: 'soon',
          needs: ['accounts', 'view'],
        },
      ],
    },
    {
      title: 'Production',
      entries: [
        {
          label: 'Manufacturing orders',
          hint: 'Cut, stitched and packed against plan',
          icon: <Factory size={18} color={teal} />,
          state: 'read',
          href: '/production',
          needs: ['production', 'view'],
        },
        {
          label: 'Recording output',
          hint: 'Logging what a line made today',
          icon: <ClipboardList size={18} color={grey} />,
          state: 'soon',
          needs: ['production', 'create'],
        },
      ],
    },
    {
      title: 'Stock',
      entries: [
        {
          label: 'Stock balances',
          hint: 'What is on hand, store by store',
          icon: <Boxes size={18} color={teal} />,
          state: 'read',
          href: '/stock',
          needs: ['inventory', 'view'],
        },
        {
          // Approving one already works from the Approvals tab. Raising and
          // issuing stay on the web: handing material over is a counter with a
          // keyboard on it, and getting a quantity wrong with a thumb is how a
          // cutting room starts a lay it cannot finish.
          label: 'Material requisitions',
          hint: 'Approve here; raise and issue on the web',
          icon: <ClipboardList size={18} color={grey} />,
          state: 'web',
          needs: ['inventory', 'view'],
        },
      ],
    },
    {
      title: 'Master data',
      entries: [
        {
          label: 'Customers & suppliers',
          hint: 'Look somebody up, call them',
          icon: <Users size={18} color={teal} />,
          state: 'read',
          href: '/masters',
          needs: ['masters', 'view'],
        },
        {
          label: 'Items',
          hint: 'Codes, HSN and units',
          icon: <Package size={18} color={teal} />,
          state: 'read',
          href: '/masters?tab=items',
          needs: ['masters', 'view'],
        },
      ],
    },
    {
      title: 'Accounts & people',
      entries: [
        {
          label: 'Vouchers and ledger',
          hint: 'The books themselves',
          icon: <Wallet size={18} color={grey} />,
          state: 'soon',
          needs: ['accounts', 'view'],
        },
        {
          label: 'GST returns',
          hint: 'What has to be filed',
          icon: <ShieldCheck size={18} color={grey} />,
          state: 'soon',
          needs: ['accounts', 'view'],
        },
        {
          label: 'HR & payroll',
          hint: 'Attendance and salaries',
          icon: <UserCog size={18} color={grey} />,
          state: 'soon',
          needs: ['hr', 'view'],
        },
      ],
    },
    {
      title: 'Setup',
      entries: [
        {
          label: 'Company & documents',
          hint: 'Numbering, print templates, tax rates',
          icon: <SettingsIcon size={18} color={grey} />,
          state: 'web',
          needs: ['settings', 'view'],
        },
        {
          label: 'People & roles',
          hint: 'Who can do what',
          icon: <Users size={18} color={grey} />,
          state: 'web',
          needs: ['settings', 'view'],
        },
      ],
    },
  ]

  function confirmSignOut() {
    Alert.alert('Sign out?', 'You will need your password to get back in.', [
      { text: 'Stay signed in', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => void signOut() },
    ])
  }

  let revealIndex = 0

  return (
    <Screen>
      <PageHeading title="Everything" subtitle="Every part of the ERP, and where it stands" />

      <ScrollView contentContainerClassName="px-4 pb-10">
        <Reveal index={revealIndex++}>
          <Card>
            <Text className="text-base font-semibold text-foreground">{user?.name}</Text>
            <Text className="mt-0.5 text-xs text-muted-foreground">{user?.email}</Text>
            <View className="mt-3">
              <Badge label={user?.role ?? ''} kind="info" />
            </View>
          </Card>
        </Reveal>

        {can('ai', 'view') ? (
          <Reveal index={revealIndex++}>
            <CardButton onPress={() => router.push('/ai')} className="mt-3">
              <View className="flex-row items-center gap-3">
                <View
                  className="h-10 w-10 items-center justify-center rounded-xl"
                  style={{ backgroundColor: 'rgba(245,158,11,0.14)' }}
                >
                  <Sparkles size={20} color={SERIES[1]} />
                </View>
                <View className="flex-1">
                  <Text className="text-sm font-semibold text-foreground">Ask AI</Text>
                  <Text className="mt-0.5 text-xs text-muted-foreground">
                    Ask about your orders, stock or money in plain words
                  </Text>
                </View>
                <ChevronRight size={18} color={grey} />
              </View>
            </CardButton>
          </Reveal>
        ) : null}

        {groups.map((group) => {
          const visible = group.entries.filter((e) => !e.needs || can(e.needs[0], e.needs[1]))
          if (!visible.length) return null

          return (
            <Reveal key={group.title} index={revealIndex++}>
              <Text className="mb-2 mt-6 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {group.title}
              </Text>
              <View className="gap-2">
                {visible.map((e) => {
                  const usable = e.state === 'live' || e.state === 'read'
                  const badge = e.state === 'live' ? null : STATE_BADGE[e.state]

                  const inner = (
                    <View className="flex-row items-center gap-3">
                      {e.icon}
                      <View className="flex-1">
                        <View className="flex-row items-center gap-2">
                          <Text className="text-sm font-medium text-foreground">{e.label}</Text>
                          {badge ? (
                            <View className="flex-row items-center gap-1 rounded-full bg-secondary px-2 py-0.5">
                              {e.state === 'soon' ? <Clock size={10} color={grey} /> : null}
                              {e.state === 'web' ? <Monitor size={10} color={grey} /> : null}
                              <Text className="text-xs text-muted-foreground">{badge.label}</Text>
                            </View>
                          ) : null}
                        </View>
                        <Text className="mt-0.5 text-xs text-muted-foreground">{e.hint}</Text>
                      </View>
                      {usable && e.href ? <ChevronRight size={18} color={grey} /> : null}
                    </View>
                  )

                  return usable && e.href ? (
                    <CardButton key={e.label} onPress={() => router.push(e.href as never)}>
                      {inner}
                    </CardButton>
                  ) : (
                    <Card key={e.label} className="opacity-55">
                      {inner}
                    </Card>
                  )
                })}
              </View>
            </Reveal>
          )
        })}

        <Button
          label="Sign out"
          kind="secondary"
          onPress={confirmSignOut}
          icon={<LogOut size={16} color="#94a3b8" />}
          className="mt-8"
        />

        <Text className="mt-3 text-center text-xs text-muted-foreground">
          LD ERP · {API_URL.replace(/^https?:\/\//, '').replace(/\/api$/, '')}
        </Text>
      </ScrollView>
    </Screen>
  )
}
