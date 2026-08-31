import { Alert, ScrollView, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import {
  Users, Package, IndianRupee, Boxes, Factory, Truck, UserCog,
  LogOut, ChevronRight, Clock,
} from 'lucide-react-native'
import { useAuth } from '@/lib/auth'
import { API_URL } from '@/lib/api'
import { Screen, PageHeading, Card, CardButton, Button, Badge } from '@/components/ui'

/**
 * Everything that does not earn a tab, plus who you are signed in as.
 *
 * The entries marked "soon" are modules the server cannot do yet. Showing them
 * greyed rather than hiding them is the same choice the web sidebar makes: a
 * store keeper can see that goods receipt is coming, instead of wondering
 * whether it exists and they lack permission.
 */

interface Entry {
  label: string
  hint: string
  icon: React.ReactNode
  href?: string
  /** Permission needed to see it at all. */
  needs?: [string, string]
  soon?: boolean
}

export default function More() {
  const { user, signOut, can } = useAuth()
  const router = useRouter()

  const entries: Entry[] = [
    {
      label: 'Outstanding',
      hint: 'Who owes what',
      icon: <IndianRupee size={18} color="#14b8a6" />,
      href: '/outstanding',
      needs: ['accounts', 'view'],
    },
    {
      label: 'Customers & suppliers',
      hint: 'Look up a party',
      icon: <Users size={18} color="#14b8a6" />,
      href: '/masters',
      needs: ['masters', 'view'],
    },
    {
      label: 'Items',
      hint: 'Search the item list',
      icon: <Package size={18} color="#14b8a6" />,
      href: '/masters?tab=items',
      needs: ['masters', 'view'],
    },
    {
      label: 'Goods receipt',
      hint: 'Receive against a purchase order',
      icon: <Truck size={18} color="#64748b" />,
      needs: ['purchase', 'view'],
      soon: true,
    },
    {
      label: 'Stock',
      hint: 'Balances and the stock ledger',
      icon: <Boxes size={18} color="#64748b" />,
      needs: ['inventory', 'view'],
      soon: true,
    },
    {
      label: 'Production',
      hint: 'Cutting, stitching, packing',
      icon: <Factory size={18} color="#64748b" />,
      needs: ['production', 'view'],
      soon: true,
    },
    {
      label: 'HR & payroll',
      hint: 'Attendance and salaries',
      icon: <UserCog size={18} color="#64748b" />,
      needs: ['hr', 'view'],
      soon: true,
    },
  ]

  const visible = entries.filter((e) => !e.needs || can(e.needs[0], e.needs[1]))

  function confirmSignOut() {
    Alert.alert('Sign out?', 'You will need your password to get back in.', [
      { text: 'Stay signed in', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => void signOut() },
    ])
  }

  return (
    <Screen>
      <PageHeading title="More" />

      <ScrollView contentContainerClassName="px-4 pb-8 gap-3">
        <Card>
          <Text className="text-base font-semibold text-foreground">{user?.name}</Text>
          <Text className="mt-0.5 text-xs text-muted-foreground">{user?.email}</Text>
          <View className="mt-3">
            <Badge label={user?.role ?? ''} kind="info" />
          </View>
        </Card>

        {visible.map((e) =>
          e.soon ? (
            <Card key={e.label} className="opacity-60">
              <View className="flex-row items-center gap-3">
                {e.icon}
                <View className="flex-1">
                  <View className="flex-row items-center gap-2">
                    <Text className="text-sm font-medium text-foreground">{e.label}</Text>
                    <View className="flex-row items-center gap-1 rounded-full bg-secondary px-2 py-0.5">
                      <Clock size={10} color="#64748b" />
                      <Text className="text-xs text-muted-foreground">soon</Text>
                    </View>
                  </View>
                  <Text className="mt-0.5 text-xs text-muted-foreground">{e.hint}</Text>
                </View>
              </View>
            </Card>
          ) : (
            <CardButton key={e.label} onPress={() => router.push(e.href as never)}>
              <View className="flex-row items-center gap-3">
                {e.icon}
                <View className="flex-1">
                  <Text className="text-sm font-medium text-foreground">{e.label}</Text>
                  <Text className="mt-0.5 text-xs text-muted-foreground">{e.hint}</Text>
                </View>
                <ChevronRight size={18} color="#64748b" />
              </View>
            </CardButton>
          ),
        )}

        <Button
          label="Sign out"
          kind="secondary"
          onPress={confirmSignOut}
          icon={<LogOut size={16} color="#94a3b8" />}
          className="mt-3"
        />

        <Text className="mt-2 text-center text-xs text-muted-foreground">
          LD ERP · connected to {API_URL.replace(/^https?:\/\//, '').replace(/\/api$/, '')}
        </Text>
      </ScrollView>
    </Screen>
  )
}
