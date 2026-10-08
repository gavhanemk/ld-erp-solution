import { useState } from 'react'
import { Alert, ScrollView, Text, View } from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import { Send, Ban } from 'lucide-react-native'
import * as Haptics from 'expo-haptics'
import { api, ApiError, type Single } from '@/lib/api'
import { useFetch } from '@/lib/useFetch'
import { useAuth } from '@/lib/auth'
import { money, shortDate } from '@/lib/format'
import {
  Screen, Card, Row, Badge, Button, Loading, WakingServer, ErrorNotice,
  SuccessNotice, statusKind, prettyStatus,
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
  placeOfSupplyCode?: string | null
  supplier: {
    name: string
    gstin?: string | null
    stateCode?: string | null
    phone?: string | null
  }
  deliveryWarehouse?: { name: string } | null
  lines: Line[]
}

export default function PurchaseOrderDetail() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { can } = useAuth()
  const [working, setWorking] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const { data, loading, waking, error, reload } = useFetch(
    () => api.get<Single<Order>>(`/purchase/orders/${id}`).then((r) => r.data),
    [id],
  )

  /**
   * Marking an order sent or cancelled, from wherever the phone happens to be.
   *
   * Both are one-way. Once a supplier is holding the paper the order cannot go
   * back to draft, and a cancelled one stays cancelled with its number — so
   * both ask first, which is not the case for approving, where the common
   * answer is yes and a confirmation on every one would make clearing a queue
   * twice the taps.
   */
  async function act(action: 'send' | 'cancel') {
    setWorking(action)
    setDone(null)
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)

    try {
      const res = await api.patch<{ message?: string }>(
        `/purchase/orders/${id}/${action}`,
        action === 'cancel' ? { reason: 'Cancelled from the phone' } : {},
      )
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      setDone(res.message ?? 'Saved.')
      await reload()
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)
      Alert.alert(
        'Could not save that',
        err instanceof ApiError ? err.message : 'Try again in a moment.',
      )
    } finally {
      setWorking(null)
    }
  }

  function confirm(action: 'send' | 'cancel', poNumber: string) {
    const copy = {
      send: {
        title: `Mark ${poNumber} as sent?`,
        body: 'It cannot be edited afterwards — the supplier is holding the paper.',
        ok: 'Mark as sent',
        style: 'default' as const,
      },
      cancel: {
        title: `Cancel ${poNumber}?`,
        body: 'The order stays on record with its number. It cannot be reopened.',
        ok: 'Cancel order',
        style: 'destructive' as const,
      },
    }[action]

    Alert.alert(copy.title, copy.body, [
      { text: 'Go back', style: 'cancel' },
      { text: copy.ok, style: copy.style, onPress: () => void act(action) },
    ])
  }

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
  // With no tax on the order the states decide which rows it shows, as on the
  // printed sheet. Every line at 0% from a registered supplier is not an
  // unregistered supplier.
  const theirState = data.supplier.stateCode || data.supplier.gstin?.slice(0, 2)
  const taxMode =
    igst > 0
      ? 'IGST'
      : cgst > 0
        ? 'CGST_SGST'
        : !data.supplier.gstin
          ? 'NONE'
          : !data.placeOfSupplyCode || theirState === data.placeOfSupplyCode
            ? 'CGST_SGST'
            : 'IGST'

  return (
    <Screen>
      {header}
      <ScrollView contentContainerClassName="gap-3 px-4 py-4 pb-8">
        {done ? <SuccessNotice message={done} /> : null}

        {/* Only a draft can be acted on, which is the server's rule, not a
            guess made here — it refuses anything else and says why. Showing
            buttons that are certain to be refused would be worse than showing
            none. */}
        {data.status === 'DRAFT' && can('purchase', 'edit') ? (
          <View className="flex-row gap-3">
            <Button
              label="Mark as sent"
              onPress={() => confirm('send', data.poNumber)}
              busy={working === 'send'}
              disabled={working !== null}
              icon={<Send size={16} color="#fff" />}
              className="flex-1"
            />
            <Button
              label="Cancel"
              kind="secondary"
              onPress={() => confirm('cancel', data.poNumber)}
              disabled={working !== null}
              icon={<Ban size={16} color="#94a3b8" />}
              className="flex-1"
            />
          </View>
        ) : null}

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
          {taxMode === 'CGST_SGST' ? (
            <>
              <Row label="CGST" value={`₹${money(data.cgst)}`} />
              <Row label="SGST" value={`₹${money(data.sgst)}`} />
            </>
          ) : taxMode === 'IGST' ? (
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
