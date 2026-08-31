import { RefreshControl, ScrollView, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { TrendingUp, Package, Factory, IndianRupee, ArrowDownLeft, ArrowUpRight } from 'lucide-react-native'
import { api } from '@/lib/api'
import { useFetch } from '@/lib/useFetch'
import { useAuth } from '@/lib/auth'
import { shortMoney } from '@/lib/format'
import { Screen, PageHeading, Card, CardButton, Loading, WakingServer, ErrorNotice } from '@/components/ui'

interface Summary {
  activeOrders: number
  todayProduction: { achieved: number; target: number; efficiency: number; rejection: number }
  pendingApprovals: number
  revenueMTD: number
  outstandingReceivable: number
  outstandingPayable: number
  generatedAt: string
}

function greeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

/** One figure, big enough to read at arm's length. */
function Tile({
  label,
  value,
  hint,
  icon,
  onPress,
}: {
  label: string
  value: string
  hint?: string
  icon: React.ReactNode
  onPress?: () => void
}) {
  const body = (
    <>
      <View className="flex-row items-center gap-2">
        {icon}
        <Text className="text-xs text-muted-foreground">{label}</Text>
      </View>
      <Text className="mt-2 text-2xl font-bold text-foreground">{value}</Text>
      {hint ? <Text className="mt-0.5 text-xs text-muted-foreground">{hint}</Text> : null}
    </>
  )

  return onPress ? (
    <CardButton onPress={onPress} className="flex-1">
      {body}
    </CardButton>
  ) : (
    <Card className="flex-1">{body}</Card>
  )
}

export default function HomeScreen() {
  const { user } = useAuth()
  const router = useRouter()

  const { data, loading, waking, error, reload } = useFetch(
    () => api.get<{ success: boolean; data: Summary }>('/dashboard/summary').then((r) => r.data),
    [],
  )

  if (waking) return <Screen><WakingServer /></Screen>
  if (loading && !data) return <Screen><Loading /></Screen>

  return (
    <Screen>
      <ScrollView
        refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} tintColor="#14b8a6" />}
        contentContainerClassName="pb-8"
      >
        <View className="px-4 pt-2">
          <Text className="text-xs text-muted-foreground">{greeting()}</Text>
          <Text className="text-2xl font-bold text-foreground">
            {user?.name?.split(' ')[0] ?? 'there'}
          </Text>
        </View>

        {error ? <ErrorNotice message={error} onRetry={reload} /> : null}

        {data ? (
          <View className="gap-3 px-4 pt-5">
            <View className="flex-row gap-3">
              <Tile
                label="Waiting for you"
                value={String(data.pendingApprovals)}
                hint={data.pendingApprovals === 1 ? 'item to approve' : 'items to approve'}
                icon={<Package size={14} color="#f59e0b" />}
                onPress={() => router.push('/approvals')}
              />
              <Tile
                label="Active orders"
                value={String(data.activeOrders)}
                hint="in hand"
                icon={<TrendingUp size={14} color="#14b8a6" />}
                onPress={() => router.push('/orders')}
              />
            </View>

            <Card>
              <View className="flex-row items-center gap-2">
                <Factory size={14} color="#14b8a6" />
                <Text className="text-xs text-muted-foreground">Today&apos;s production</Text>
              </View>
              <View className="mt-2 flex-row items-end gap-2">
                <Text className="text-2xl font-bold text-foreground">
                  {data.todayProduction.achieved.toLocaleString('en-IN')}
                </Text>
                <Text className="pb-1 text-xs text-muted-foreground">
                  {/* The API reports a real target, so zero means nobody set
                      one — which is worth saying rather than showing "0%". */}
                  {data.todayProduction.target > 0
                    ? `of ${data.todayProduction.target.toLocaleString('en-IN')} · ${data.todayProduction.efficiency}%`
                    : 'no target set'}
                </Text>
              </View>
            </Card>

            <Card>
              <View className="flex-row items-center gap-2">
                <IndianRupee size={14} color="#14b8a6" />
                <Text className="text-xs text-muted-foreground">This month</Text>
              </View>
              <Text className="mt-2 text-2xl font-bold text-foreground">
                {shortMoney(data.revenueMTD)}
              </Text>
              <Text className="mt-0.5 text-xs text-muted-foreground">invoiced</Text>
            </Card>

            <View className="flex-row gap-3">
              <Tile
                label="They owe us"
                value={shortMoney(data.outstandingReceivable)}
                icon={<ArrowDownLeft size={14} color="#10b981" />}
                onPress={() => router.push('/outstanding')}
              />
              <Tile
                label="We owe them"
                value={shortMoney(data.outstandingPayable)}
                icon={<ArrowUpRight size={14} color="#f87171" />}
              />
            </View>
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  )
}
