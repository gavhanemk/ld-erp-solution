import { useMemo, useState } from 'react'
import { RefreshControl, ScrollView, Text, TextInput, View } from 'react-native'
import { Stack, useRouter } from 'expo-router'
import { Search, AlertTriangle, ChevronRight } from 'lucide-react-native'
import { api } from '@/lib/api'
import { useFetch } from '@/lib/useFetch'
import { shortMoney } from '@/lib/format'
import {
  Screen, Card, CardButton, Loading, WakingServer, Empty, ErrorNotice,
} from '@/components/ui'
import { Reveal } from '@/components/motion'
import { SERIES } from '@/components/charts'

/**
 * What is on hand, in the godown, on a phone.
 *
 * Read only, and that is the right answer rather than a limitation. The person
 * who most needs this screen is standing in front of a rack deciding whether to
 * start a lay — they need the number, not a keyboard. Moving stock is a
 * document, and a document belongs on a desk.
 *
 * Search filters on the phone rather than round-tripping to the server: the
 * whole balance list for a mill this size is a few hundred rows, it is already
 * loaded, and a store with poor signal should not have to wait to type.
 */

interface StockRow {
  itemId: string
  itemCode: string
  itemName: string
  uom: string
  categoryName: string
  reorderLevel: number | null
  warehouseId: string
  warehouseName: string
  ownership: 'OWNED' | 'CUSTOMER_OWNED'
  ownerName: string | null
  qty: number
  value: number
  avgRate: number
  isLow: boolean
}

interface StockResponse {
  data: StockRow[]
  summary: { lines: number; totalValue: number; lowCount: number }
}

const qtyFmt = (v: number) =>
  v.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })

export default function StockScreen() {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [lowOnly, setLowOnly] = useState(false)

  const { data, loading, waking, error, reload } = useFetch(
    () => api.get<StockResponse>('/inventory/stock'),
    [],
  )

  const rows = useMemo(() => {
    const all = data?.data ?? []
    const q = search.trim().toLowerCase()
    return all
      .filter((r) => (lowOnly ? r.isLow : true))
      .filter(
        (r) =>
          !q ||
          r.itemName.toLowerCase().includes(q) ||
          r.itemCode.toLowerCase().includes(q) ||
          r.warehouseName.toLowerCase().includes(q),
      )
  }, [data, search, lowOnly])

  const header = (
    <Stack.Screen options={{ headerShown: true, title: 'Stock', headerBackTitle: 'More' }} />
  )

  if (waking) return <Screen>{header}<WakingServer /></Screen>
  if (loading && !data) return <Screen>{header}<Loading /></Screen>

  const summary = data?.summary

  return (
    <Screen>
      {header}

      <View className="px-4 pt-3 pb-1 gap-3">
        {summary ? (
          <View className="flex-row gap-3">
            <Card className="flex-1">
              <Text className="text-xs text-muted-foreground">Stock value</Text>
              <Text className="mt-1 text-xl font-bold text-foreground">
                {shortMoney(summary.totalValue)}
              </Text>
            </Card>
            <CardButton className="flex-1" onPress={() => setLowOnly((v) => !v)}>
              <Text className="text-xs text-muted-foreground">Below reorder</Text>
              <Text
                className="mt-1 text-xl font-bold"
                style={{ color: summary.lowCount > 0 ? SERIES[1] : undefined }}
              >
                {summary.lowCount}
              </Text>
              <Text className="mt-0.5 text-xs text-muted-foreground">
                {lowOnly ? 'showing only these' : 'tap to filter'}
              </Text>
            </CardButton>
          </View>
        ) : null}

        <View
          className="flex-row items-center gap-2 rounded-xl px-3 py-2.5"
          style={{ backgroundColor: 'rgba(148,163,184,0.10)' }}
        >
          <Search size={15} color="#64748b" />
          <TextInput
            className="flex-1 text-sm text-foreground"
            placeholder="Search item or store"
            placeholderTextColor="#64748b"
            value={search}
            onChangeText={setSearch}
            autoCorrect={false}
          />
        </View>
      </View>

      {error ? <ErrorNotice message={error} onRetry={reload} /> : null}

      {!error && rows.length === 0 ? (
        <Empty
          title={search || lowOnly ? 'Nothing matches' : 'No stock yet'}
          hint={
            search || lowOnly
              ? 'Try a different search.'
              : 'Stock appears here once opening balances are entered on the web.'
          }
        />
      ) : (
        <ScrollView
          refreshControl={
            <RefreshControl refreshing={loading} onRefresh={reload} tintColor="#14b8a6" />
          }
          contentContainerClassName="gap-2 px-4 py-3 pb-8"
        >
          {rows.map((r, i) => (
            <Reveal key={`${r.itemId}-${r.warehouseId}-${r.ownerName ?? ''}`} index={Math.min(i, 6)}>
              <CardButton onPress={() => router.push(`/stock/${r.itemId}`)}>
                <View className="flex-row items-start justify-between gap-3">
                  <View className="flex-1">
                    <Text className="text-sm font-semibold text-foreground">{r.itemName}</Text>
                    <Text className="mt-0.5 text-xs text-muted-foreground">
                      {r.warehouseName}
                      {r.ownership === 'CUSTOMER_OWNED'
                        ? ` · ${r.ownerName ?? 'customer'}'s material`
                        : ''}
                    </Text>
                  </View>

                  <View className="items-end">
                    <View className="flex-row items-center gap-1.5">
                      {r.isLow ? <AlertTriangle size={13} color={SERIES[1]} /> : null}
                      <Text
                        className="text-base font-bold"
                        style={r.isLow ? { color: SERIES[1] } : undefined}
                      >
                        {qtyFmt(r.qty)}
                      </Text>
                      <Text className="text-xs text-muted-foreground">{r.uom}</Text>
                    </View>
                    {r.ownership === 'OWNED' ? (
                      <Text className="mt-0.5 text-xs text-muted-foreground">
                        {shortMoney(r.value)}
                      </Text>
                    ) : null}
                  </View>

                  <ChevronRight size={14} color="#64748b" style={{ marginTop: 2 }} />
                </View>
              </CardButton>
            </Reveal>
          ))}
        </ScrollView>
      )}
    </Screen>
  )
}
