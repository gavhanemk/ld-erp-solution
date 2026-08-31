import { RefreshControl, ScrollView, Text, View, useWindowDimensions } from 'react-native'
import { useRouter } from 'expo-router'
import {
  TrendingUp, Package, Factory, ArrowDownLeft, ArrowUpRight, ChevronRight,
} from 'lucide-react-native'
import { api } from '@/lib/api'
import { useFetch } from '@/lib/useFetch'
import { useAuth } from '@/lib/auth'
import { shortMoney, money } from '@/lib/format'
import { Screen, Card, CardButton, Loading, WakingServer, ErrorNotice } from '@/components/ui'
import { TrendChart, BarList, ProgressRow, SERIES, type TrendPoint, type BarRow } from '@/components/charts'

interface Summary {
  activeOrders: number
  todayProduction: { achieved: number; target: number; efficiency: number; rejection: number }
  pendingApprovals: number
  revenueMTD: number
  outstandingReceivable: number
  outstandingPayable: number
}

interface StatusRow {
  status: string
  count: number
  value: number
}

/**
 * A status keeps its colour wherever it appears, and the colour is decided by
 * what the status means — never by how many orders happen to be in it today.
 * A reader who learns that cancelled is red must not find it teal tomorrow
 * because the counts moved.
 */
const STATUS_COLOUR: Record<string, number> = {
  DRAFT: 0,
  CONFIRMED: 1,
  IN_PRODUCTION: 1,
  PARTIALLY_DISPATCHED: 4,
  COMPLETED: 2,
  CANCELLED: 3,
}

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  CONFIRMED: 'Confirmed',
  IN_PRODUCTION: 'In production',
  PARTIALLY_DISPATCHED: 'Part dispatched',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
}

function greeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

/** A figure with a name and somewhere to go. */
function Tile({
  label,
  value,
  hint,
  icon,
  accent,
  onPress,
}: {
  label: string
  value: string
  hint?: string
  icon: React.ReactNode
  accent?: string
  onPress?: () => void
}) {
  const body = (
    <>
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center gap-2">
          {icon}
          <Text className="text-xs text-muted-foreground">{label}</Text>
        </View>
        {onPress ? <ChevronRight size={14} color="#64748b" /> : null}
      </View>
      <Text
        className="mt-2 text-2xl font-bold text-foreground"
        style={accent ? { color: accent } : undefined}
      >
        {value}
      </Text>
      {hint ? <Text className="mt-0.5 text-xs text-muted-foreground">{hint}</Text> : null}
    </>
  )

  return onPress ? (
    <CardButton onPress={onPress} className="flex-1">{body}</CardButton>
  ) : (
    <Card className="flex-1">{body}</Card>
  )
}

/** A heading above a block, so the page reads as sections rather than a pile. */
function SectionTitle({ children }: { children: string }) {
  return (
    <Text className="mt-5 mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </Text>
  )
}

export default function HomeScreen() {
  const { user } = useAuth()
  const router = useRouter()
  const { width } = useWindowDimensions()

  // Card padding is 16 each side, and the screen adds 16 each side.
  const chartWidth = width - 64

  /**
   * The three calls are settled together rather than raced: a dashboard that
   * blanks because one widget's endpoint is slow is worse than one that shows
   * what it has. Each block below renders from whichever parts arrived.
   */
  const { data, loading, waking, error, reload } = useFetch(async () => {
    const [summary, trend, status] = await Promise.allSettled([
      api.get<{ data: Summary }>('/dashboard/summary'),
      api.get<{ data: TrendPoint[] }>('/dashboard/revenue-trend'),
      api.get<{ data: StatusRow[] }>('/dashboard/order-status'),
    ])
    return {
      summary: summary.status === 'fulfilled' ? summary.value.data : null,
      trend: trend.status === 'fulfilled' ? trend.value.data : [],
      status: status.status === 'fulfilled' ? status.value.data : [],
    }
  }, [])

  if (waking) return <Screen><WakingServer /></Screen>
  if (loading && !data) return <Screen><Loading /></Screen>

  const s = data?.summary
  const trend = data?.trend ?? []

  const statusRows: BarRow[] = (data?.status ?? [])
    .filter((r) => r.count > 0)
    .map((r) => ({
      label: STATUS_LABEL[r.status] ?? r.status,
      value: r.count,
      colour: STATUS_COLOUR[r.status] ?? 0,
      hint: r.value > 0 ? shortMoney(r.value) : undefined,
    }))

  return (
    <Screen>
      <ScrollView
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={reload} tintColor="#14b8a6" />
        }
        contentContainerClassName="pb-10"
      >
        <View className="px-4 pt-2 pb-1">
          <Text className="text-xs text-muted-foreground">{greeting()}</Text>
          <Text className="text-2xl font-bold text-foreground">
            {user?.name?.split(' ')[0] ?? 'there'}
          </Text>
        </View>

        {error ? <ErrorNotice message={error} onRetry={reload} /> : null}

        {s ? (
          <View className="px-4">
            <View className="mt-4 flex-row gap-3">
              <Tile
                label="Waiting for you"
                value={String(s.pendingApprovals)}
                hint={s.pendingApprovals === 1 ? 'item to approve' : 'items to approve'}
                icon={<Package size={14} color={SERIES[1]} />}
                accent={s.pendingApprovals > 0 ? SERIES[1] : undefined}
                onPress={() => router.push('/approvals')}
              />
              <Tile
                label="Active orders"
                value={String(s.activeOrders)}
                hint="in hand"
                icon={<TrendingUp size={14} color={SERIES[0]} />}
                onPress={() => router.push('/orders')}
              />
            </View>

            {/* The headline figure, then the shape behind it. The number is
                what gets read; the chart is what gives it meaning. */}
            <SectionTitle>Money</SectionTitle>
            <Card>
              <Text className="text-xs text-muted-foreground">Invoiced this month</Text>
              <Text className="mt-1 text-3xl font-bold text-foreground">
                ₹{money(s.revenueMTD)}
              </Text>
              {trend.length > 1 ? (
                <View className="mt-4">
                  <TrendChart data={trend} width={chartWidth} />
                </View>
              ) : (
                <Text className="mt-3 text-xs text-muted-foreground">
                  Not enough history yet to draw a trend.
                </Text>
              )}
            </Card>

            <View className="mt-3 flex-row gap-3">
              <Tile
                label="They owe us"
                value={shortMoney(s.outstandingReceivable)}
                icon={<ArrowDownLeft size={14} color={SERIES[2]} />}
                onPress={() => router.push('/outstanding')}
              />
              <Tile
                label="We owe them"
                value={shortMoney(s.outstandingPayable)}
                icon={<ArrowUpRight size={14} color={SERIES[3]} />}
              />
            </View>

            <SectionTitle>Today on the floor</SectionTitle>
            <Card>
              <View className="mb-3 flex-row items-center gap-2">
                <Factory size={14} color={SERIES[0]} />
                <Text className="text-xs text-muted-foreground">Production</Text>
              </View>
              <ProgressRow
                label="Pieces made"
                achieved={s.todayProduction.achieved}
                target={s.todayProduction.target}
                width={chartWidth}
              />
              {s.todayProduction.rejection > 0 ? (
                <Text className="mt-3 text-xs" style={{ color: SERIES[3] }}>
                  {s.todayProduction.rejection.toLocaleString('en-IN')} rejected today
                </Text>
              ) : null}
            </Card>

            {statusRows.length > 0 ? (
              <>
                <SectionTitle>Sales orders</SectionTitle>
                <Card>
                  <BarList rows={statusRows} width={chartWidth} />
                </Card>
              </>
            ) : null}
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  )
}
