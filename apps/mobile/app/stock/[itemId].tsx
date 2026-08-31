import { ScrollView, Text, View } from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import { api } from '@/lib/api'
import { useFetch } from '@/lib/useFetch'
import { money, shortDate } from '@/lib/format'
import {
  Screen, Card, Row, Badge, Loading, WakingServer, ErrorNotice,
} from '@/components/ui'
import { SERIES } from '@/components/charts'

/**
 * One item: where it is, and the last movements against it.
 *
 * The movement list is here because the question asked in a godown is almost
 * never "how much is there" on its own — it is "how much is there, and where
 * did the rest go".
 */

interface WarehouseRow {
  warehouseId: string
  warehouseName: string
  ownership: 'OWNED' | 'CUSTOMER_OWNED'
  ownerName: string | null
  qty: number
  value: number
  avgRate: number
}

interface Movement {
  id: string
  transactionType: string
  inQty: string | number
  outQty: string | number
  closingStock: string | number
  transactionDate: string
  notes: string | null
  warehouse: { name: string }
}

interface Detail {
  item: {
    id: string
    code: string
    name: string
    reorderLevel: string | number | null
    uom: { symbol: string }
    category: { name: string }
  }
  byWarehouse: WarehouseRow[]
  totals: { qty: number; value: number }
  movements: Movement[]
}

const MOVEMENT: Record<string, string> = {
  OPENING: 'Opening',
  PURCHASE: 'Received',
  SALE: 'Sold',
  ISSUE: 'Issued',
  PRODUCTION: 'Produced',
  TRANSFER: 'Transfer',
  ADJUSTMENT: 'Count',
  RETURN: 'Returned',
}

const qtyFmt = (v: number) =>
  v.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })

export default function StockItemScreen() {
  const { itemId } = useLocalSearchParams<{ itemId: string }>()

  const { data, loading, waking, error, reload } = useFetch(
    () => api.get<{ data: Detail }>(`/inventory/stock/${itemId}`).then((r) => r.data),
    [itemId],
  )

  const header = (
    <Stack.Screen
      options={{ headerShown: true, title: data?.item.code ?? 'Item', headerBackTitle: 'Stock' }}
    />
  )

  if (waking) return <Screen>{header}<WakingServer /></Screen>
  if (loading && !data) return <Screen>{header}<Loading /></Screen>
  if (error) return <Screen>{header}<ErrorNotice message={error} onRetry={reload} /></Screen>
  if (!data) return null

  const { item, byWarehouse, totals, movements } = data
  const reorder = item.reorderLevel === null ? null : Number(item.reorderLevel)
  const isLow = reorder !== null && totals.qty <= reorder

  return (
    <Screen>
      {header}
      <ScrollView contentContainerClassName="gap-3 px-4 py-4 pb-8">
        <Card>
          <View className="flex-row items-start justify-between gap-3">
            <View className="flex-1">
              <Text className="text-base font-semibold text-foreground">{item.name}</Text>
              <Text className="mt-0.5 text-xs text-muted-foreground">
                {item.code} · {item.category.name}
              </Text>
            </View>
            {isLow ? <Badge label="Below reorder" kind="warning" /> : null}
          </View>

          <View className="mt-4 border-t border-border pt-3">
            <Row
              label="On hand"
              value={`${qtyFmt(totals.qty)} ${item.uom.symbol}`}
              strong
            />
            <Row label="Carried at" value={`₹${money(totals.value)}`} />
            <Row
              label="Reorder level"
              value={reorder === null ? '—' : `${qtyFmt(reorder)} ${item.uom.symbol}`}
            />
          </View>
        </Card>

        <Text className="mt-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Where it is
        </Text>
        <Card>
          {byWarehouse.length === 0 ? (
            <Text className="text-sm text-muted-foreground">None on hand anywhere.</Text>
          ) : (
            <View className="gap-2">
              {byWarehouse.map((w) => (
                <View
                  key={`${w.warehouseId}-${w.ownerName ?? ''}`}
                  className="flex-row items-center justify-between"
                >
                  <View className="flex-1">
                    <Text className="text-sm text-foreground">{w.warehouseName}</Text>
                    {w.ownership === 'CUSTOMER_OWNED' ? (
                      <Text className="text-xs" style={{ color: SERIES[4] }}>
                        {w.ownerName ?? 'customer'}&apos;s material — not ours
                      </Text>
                    ) : null}
                  </View>
                  <Text className="text-sm font-semibold text-foreground">
                    {qtyFmt(w.qty)} {item.uom.symbol}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </Card>

        {movements.length ? (
          <>
            <Text className="mt-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              What has happened to it
            </Text>
            {movements.slice(0, 25).map((m) => {
              const inQty = Number(m.inQty)
              const outQty = Number(m.outQty)
              return (
                <Card key={m.id}>
                  <View className="flex-row items-start justify-between gap-3">
                    <View className="flex-1">
                      <Text className="text-sm font-semibold text-foreground">
                        {MOVEMENT[m.transactionType] ?? m.transactionType}
                      </Text>
                      <Text className="mt-0.5 text-xs text-muted-foreground">
                        {shortDate(m.transactionDate)} · {m.warehouse.name}
                      </Text>
                    </View>
                    <View className="items-end">
                      <Text
                        className="text-base font-bold"
                        style={{ color: inQty > 0 ? SERIES[2] : SERIES[3] }}
                      >
                        {inQty > 0 ? `+${qtyFmt(inQty)}` : `−${qtyFmt(outQty)}`}
                      </Text>
                      <Text className="text-xs text-muted-foreground">
                        left {qtyFmt(Number(m.closingStock))}
                      </Text>
                    </View>
                  </View>
                  {m.notes ? (
                    <Text className="mt-2 border-t border-border pt-2 text-xs text-muted-foreground">
                      {m.notes}
                    </Text>
                  ) : null}
                </Card>
              )
            })}
          </>
        ) : null}
      </ScrollView>
    </Screen>
  )
}
