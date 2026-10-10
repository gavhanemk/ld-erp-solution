import { ScrollView, Text, View } from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import { api, type Single } from '@/lib/api'
import { useFetch } from '@/lib/useFetch'
import { money, shortDate } from '@/lib/format'
import {
  Screen, Card, Row, Badge, Loading, WakingServer, ErrorNotice,
  statusKind, prettyStatus,
} from '@/components/ui'

/** One sales order. Read only, for the same reason as the purchase one. */

/*
 * The fields as the API sends them. This read `qty` and `rate`, which an order
 * line has never had (they are `totalQty` and `unitPrice`), so every line
 * showed 0 pieces at ₹0.00.
 */
interface Line {
  id: string
  totalQty: string | number
  unitPrice: string | number
  amount: string | number
  color: string | null
  deliveredQty: string | number
  pendingQty: string | number
  item: { code: string; name: string; color: string | null }
  sizes?: { id: string; qty: string | number; size: { code: string; sequence: number } }[]
}

/** Pieces are counted, not money: whole numbers, Indian grouping. */
const pcs = (v: string | number) => Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })

/** "S 100 · M 250 · L 300", smallest size first. */
const sizeRun = (line: Line) =>
  [...(line.sizes ?? [])]
    .sort((a, b) => a.size.sequence - b.size.sequence)
    .map((s) => `${s.size.code} ${pcs(s.qty)}`)
    .join(' · ')

interface Order {
  id: string
  soNumber: string
  orderDate: string
  deliveryDate: string | null
  status: string
  notes: string | null
  totalAmount: string | number
  customer: { name: string; gstin?: string | null; phone?: string | null }
  brand?: { name: string } | null
  lines: Line[]
  manufacturingOrders?: { moNumber: string; status: string; totalPackedQty: number }[]
}

export default function SalesOrderDetail() {
  const { id } = useLocalSearchParams<{ id: string }>()

  const { data, loading, waking, error, reload } = useFetch(
    () => api.get<Single<Order>>(`/sales/orders/${id}`).then((r) => r.data),
    [id],
  )

  const header = (
    <Stack.Screen
      options={{
        headerShown: true,
        title: data?.soNumber ?? 'Sales order',
        headerBackTitle: 'Orders',
      }}
    />
  )

  if (waking) return <Screen>{header}<WakingServer /></Screen>
  if (loading && !data) return <Screen>{header}<Loading /></Screen>
  if (error) return <Screen>{header}<ErrorNotice message={error} onRetry={reload} /></Screen>
  if (!data) return null

  return (
    <Screen>
      {header}
      <ScrollView contentContainerClassName="gap-3 px-4 py-4 pb-8">
        <Card>
          <View className="flex-row items-start justify-between gap-3">
            <View className="flex-1">
              <Text className="text-xs text-muted-foreground">Customer</Text>
              <Text className="mt-0.5 text-base font-semibold text-foreground">
                {data.customer.name}
              </Text>
              {data.customer.gstin ? (
                <Text className="mt-0.5 text-xs text-muted-foreground">
                  GSTIN {data.customer.gstin}
                </Text>
              ) : null}
            </View>
            <Badge label={prettyStatus(data.status)} kind={statusKind(data.status)} />
          </View>

          <View className="mt-4 border-t border-border pt-3">
            <Row label="Order date" value={shortDate(data.orderDate)} />
            <Row label="Delivery by" value={shortDate(data.deliveryDate)} />
            {data.brand ? <Row label="Brand" value={data.brand.name} /> : null}
            <Row label="Total" value={`₹${money(data.totalAmount)}`} strong />
          </View>
        </Card>

        <Text className="mt-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          What they ordered
        </Text>

        {data.lines.map((line) => (
          <Card key={line.id}>
            <View className="flex-row items-start justify-between gap-3">
              <View className="flex-1">
                <Text className="text-sm font-semibold text-foreground">
                  {line.item.name}
                  {line.color || line.item.color ? ` · ${line.color || line.item.color}` : ''}
                </Text>
                <Text className="mt-0.5 text-xs text-muted-foreground">{line.item.code}</Text>
              </View>
              <Text className="text-sm font-bold text-foreground">₹{money(line.amount)}</Text>
            </View>
            <View className="mt-3 border-t border-border pt-2">
              <Row label="Pieces" value={pcs(line.totalQty)} />
              {line.sizes?.length ? <Row label="Sizes" value={sizeRun(line)} /> : null}
              <Row label="Rate" value={`₹${money(line.unitPrice)}`} />
              <Row label="Dispatched" value={`${pcs(line.deliveredQty)} · ${pcs(line.pendingQty)} to go`} />
            </View>
          </Card>
        ))}

        {data.manufacturingOrders?.length ? (
          <>
            <Text className="mt-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              In production
            </Text>
            {data.manufacturingOrders.map((mo) => (
              <Card key={mo.moNumber}>
                <View className="flex-row items-center justify-between">
                  <Text className="text-sm font-semibold text-foreground">{mo.moNumber}</Text>
                  <Badge label={prettyStatus(mo.status)} kind={statusKind(mo.status)} />
                </View>
                <View className="mt-2">
                  <Row label="Packed" value={money(mo.totalPackedQty)} />
                </View>
              </Card>
            ))}
          </>
        ) : null}

        {data.notes ? (
          <Card>
            <Text className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Note
            </Text>
            <Text className="mt-2 text-sm text-foreground">{data.notes}</Text>
          </Card>
        ) : null}
      </ScrollView>
    </Screen>
  )
}
