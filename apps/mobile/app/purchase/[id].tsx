import { ScrollView, Text, View } from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import { api, type Single } from '@/lib/api'
import { useFetch } from '@/lib/useFetch'
import { money, shortDate } from '@/lib/format'
import {
  Screen, Card, Row, Badge, Loading, WakingServer, ErrorNotice,
  statusKind, prettyStatus,
} from '@/components/ui'

/**
 * One purchase order, in full.
 *
 * Read only. Editing an order on a phone is a good way to get a figure wrong
 * with a thumb, and the web screen already does it properly — so this shows
 * everything and changes nothing.
 */

interface Line {
  id: string
  description: string | null
  hsnCode: string | null
  qty: string
  unitRate: string
  discount: string
  gstRate: string
  amount: string
  item: { code: string; name: string; uom?: { symbol: string } | null }
}

interface Order {
  id: string
  poNumber: string
  poDate: string
  deliveryDate: string | null
  status: string
  notes: string | null
  terms: string | null
  subtotal: string
  discountAmount: string
  taxableAmount: string
  cgst: string
  sgst: string
  igst: string
  roundOff: string
  totalAmount: string
  supplier: { name: string; gstin?: string | null; phone?: string | null }
  deliveryWarehouse?: { name: string } | null
  lines: Line[]
}

export default function PurchaseOrderDetail() {
  const { id } = useLocalSearchParams<{ id: string }>()

  const { data, loading, waking, error, reload } = useFetch(
    () => api.get<Single<Order>>(`/purchase/orders/${id}`).then((r) => r.data),
    [id],
  )

  const header = (
    <Stack.Screen
      options={{
        headerShown: true,
        title: data?.poNumber ?? 'Purchase order',
        headerBackTitle: 'Orders',
      }}
    />
  )

  if (waking) return <Screen>{header}<WakingServer /></Screen>
  if (loading && !data) return <Screen>{header}<Loading /></Screen>
  if (error) return <Screen>{header}<ErrorNotice message={error} onRetry={reload} /></Screen>
  if (!data) return null

  const cgst = Number(data.cgst)
  const igst = Number(data.igst)

  return (
    <Screen>
      {header}
      <ScrollView contentContainerClassName="gap-3 px-4 py-4 pb-8">
        <Card>
          <View className="flex-row items-start justify-between gap-3">
            <View className="flex-1">
              <Text className="text-xs text-muted-foreground">Supplier</Text>
              <Text className="mt-0.5 text-base font-semibold text-foreground">
                {data.supplier.name}
              </Text>
              {data.supplier.gstin ? (
                <Text className="mt-0.5 text-xs text-muted-foreground">
                  GSTIN {data.supplier.gstin}
                </Text>
              ) : (
                <Text className="mt-0.5 text-xs text-amber-500">Not registered under GST</Text>
              )}
            </View>
            <Badge label={prettyStatus(data.status)} kind={statusKind(data.status)} />
          </View>

          <View className="mt-4 border-t border-border pt-3">
            <Row label="Order date" value={shortDate(data.poDate)} />
            <Row label="Wanted by" value={shortDate(data.deliveryDate)} />
            <Row label="Deliver to" value={data.deliveryWarehouse?.name ?? '—'} />
          </View>
        </Card>

        <Text className="mt-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          What was ordered
        </Text>

        {data.lines.map((line, i) => (
          <Card key={line.id}>
            <View className="flex-row items-start justify-between gap-3">
              <View className="flex-1">
                <Text className="text-sm font-semibold text-foreground">{line.item.name}</Text>
                <Text className="mt-0.5 text-xs text-muted-foreground">
                  {line.item.code}
                  {line.hsnCode ? ` · HSN ${line.hsnCode}` : ''}
                </Text>
                {line.description ? (
                  <Text className="mt-1 text-xs text-foreground">{line.description}</Text>
                ) : null}
              </View>
              <Text className="text-sm font-bold text-foreground">₹{money(line.amount)}</Text>
            </View>

            <View className="mt-3 border-t border-border pt-2">
              <Row
                label="Quantity"
                value={`${money(line.qty)} ${line.item.uom?.symbol ?? ''}`.trim()}
              />
              <Row label="Rate" value={`₹${money(line.unitRate)}`} />
              {Number(line.discount) > 0 ? (
                <Row label="Discount" value={`${Number(line.discount)}%`} />
              ) : null}
              <Row label="GST" value={`${Number(line.gstRate)}%`} />
            </View>
          </Card>
        ))}

        <Card className="mt-2">
          <Row label="Subtotal" value={`₹${money(data.subtotal)}`} />
          {Number(data.discountAmount) > 0 ? (
            <Row label="Discount" value={`-₹${money(data.discountAmount)}`} />
          ) : null}
          <Row label="Taxable value" value={`₹${money(data.taxableAmount)}`} />

          {/* Which tax rows appear follows what the server worked out from the
              two state codes, so the phone can never disagree with the paper. */}
          {cgst > 0 ? (
            <>
              <Row label="CGST" value={`₹${money(data.cgst)}`} />
              <Row label="SGST" value={`₹${money(data.sgst)}`} />
            </>
          ) : igst > 0 ? (
            <Row label="IGST" value={`₹${money(data.igst)}`} />
          ) : (
            <Text className="py-1.5 text-xs text-muted-foreground">
              No GST — this supplier is not registered.
            </Text>
          )}

          {Number(data.roundOff) !== 0 ? (
            <Row label="Rounding" value={money(data.roundOff)} />
          ) : null}

          <View className="mt-2 border-t border-border pt-3">
            <Row label="Total" value={`₹${money(data.totalAmount)}`} strong />
          </View>
        </Card>

        {data.terms ? (
          <Card>
            <Text className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Terms
            </Text>
            <Text className="mt-2 text-sm text-foreground">{data.terms}</Text>
          </Card>
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
