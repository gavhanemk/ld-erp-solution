import { useState } from 'react'
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { api, type Paginated } from '@/lib/api'
import { useFetch } from '@/lib/useFetch'
import { useAuth } from '@/lib/auth'
import { money, shortDate } from '@/lib/format'
import {
  Screen, PageHeading, CardButton, Badge, Loading, WakingServer,
  Empty, ErrorNotice, statusKind, prettyStatus,
} from '@/components/ui'

interface OrderRow {
  id: string
  poNumber?: string
  soNumber?: string
  poDate?: string
  orderDate?: string
  totalAmount: string | number
  status: string
  supplier?: { name: string }
  customer?: { name: string }
}

type Side = 'purchase' | 'sales'

/** Two words, one row. Cheaper to read than a dropdown and always visible. */
function Switcher({
  value,
  options,
  onChange,
}: {
  value: Side
  options: { key: Side; label: string }[]
  onChange: (v: Side) => void
}) {
  return (
    <View className="mx-4 mb-4 flex-row rounded-lg bg-secondary p-1">
      {options.map((o) => {
        const on = o.key === value
        return (
          <Pressable
            key={o.key}
            onPress={() => onChange(o.key)}
            className={`flex-1 items-center justify-center rounded-md py-2.5 ${on ? 'bg-teal-500' : ''}`}
          >
            <Text
              className={`text-sm font-semibold ${on ? 'text-white' : 'text-muted-foreground'}`}
            >
              {o.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

export default function OrdersScreen() {
  const { can } = useAuth()
  const router = useRouter()

  const sides: { key: Side; label: string }[] = [
    ...(can('purchase', 'view') ? [{ key: 'purchase' as const, label: 'Purchase' }] : []),
    ...(can('sales', 'view') ? [{ key: 'sales' as const, label: 'Sales' }] : []),
  ]

  const [side, setSide] = useState<Side>(sides[0]?.key ?? 'purchase')

  const { data, loading, waking, error, reload } = useFetch(
    () => api.get<Paginated<OrderRow>>(`/${side}/orders?limit=50`).then((r) => r.data),
    [side],
  )

  if (waking) return <Screen><WakingServer /></Screen>

  const rows = data ?? []
  const buying = side === 'purchase'

  return (
    <Screen>
      <PageHeading
        title="Orders"
        subtitle={buying ? 'What you have ordered from suppliers' : 'What customers have ordered'}
      />

      {sides.length > 1 ? <Switcher value={side} options={sides} onChange={setSide} /> : null}

      {error ? <ErrorNotice message={error} onRetry={reload} /> : null}

      {loading && rows.length === 0 ? (
        <Loading />
      ) : !error && rows.length === 0 ? (
        <Empty
          title={buying ? 'No purchase orders yet' : 'No sales orders yet'}
          hint="They will appear here as soon as one is raised."
        />
      ) : (
        <ScrollView
          refreshControl={
            <RefreshControl refreshing={loading} onRefresh={reload} tintColor="#14b8a6" />
          }
          contentContainerClassName="gap-3 px-4 pb-8"
        >
          {rows.map((row) => (
            <CardButton
              key={row.id}
              onPress={() => router.push(`/${side}/${row.id}`)}
            >
              <View className="flex-row items-start justify-between gap-3">
                <View className="flex-1">
                  <Text className="text-sm font-semibold text-foreground">
                    {row.poNumber ?? row.soNumber}
                  </Text>
                  <Text className="mt-0.5 text-sm text-foreground">
                    {row.supplier?.name ?? row.customer?.name ?? '—'}
                  </Text>
                  <Text className="mt-1 text-xs text-muted-foreground">
                    {shortDate(row.poDate ?? row.orderDate)}
                  </Text>
                </View>
                <View className="items-end gap-2">
                  <Text className="text-base font-bold text-foreground">
                    ₹{money(row.totalAmount)}
                  </Text>
                  <Badge label={prettyStatus(row.status)} kind={statusKind(row.status)} />
                </View>
              </View>
            </CardButton>
          ))}
        </ScrollView>
      )}
    </Screen>
  )
}
