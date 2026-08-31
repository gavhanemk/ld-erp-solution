import { Linking, RefreshControl, ScrollView, Text, View, Pressable } from 'react-native'
import { Stack } from 'expo-router'
import { Phone } from 'lucide-react-native'
import { api } from '@/lib/api'
import { useFetch } from '@/lib/useFetch'
import { money, shortDate } from '@/lib/format'
import {
  Screen, Card, Badge, Loading, WakingServer, Empty, ErrorNotice,
} from '@/components/ui'

/**
 * Who owes us money, oldest due first.
 *
 * The one screen where a phone genuinely beats a laptop: the customer's number
 * is one tap from the figure, so a follow-up call happens standing in the
 * corridor instead of being written on a slip and forgotten.
 */

interface Invoice {
  id: string
  invoiceNumber: string
  invoiceDate: string
  dueDate: string | null
  totalAmount: string | number
  balanceAmount: string | number
  status: string
  customer: { name: string; phone: string | null }
}

function overdueDays(dueDate: string | null): number {
  if (!dueDate) return 0
  const days = Math.floor((Date.now() - new Date(dueDate).getTime()) / 86400000)
  return days > 0 ? days : 0
}

export default function Outstanding() {
  const { data, loading, waking, error, reload } = useFetch(
    () => api.get<{ success: boolean; data: Invoice[] }>('/sales/outstanding').then((r) => r.data),
    [],
  )

  const header = (
    <Stack.Screen options={{ headerShown: true, title: 'Outstanding', headerBackTitle: 'More' }} />
  )

  if (waking) return <Screen>{header}<WakingServer /></Screen>
  if (loading && !data) return <Screen>{header}<Loading /></Screen>

  const rows = data ?? []
  const total = rows.reduce((s, r) => s + Number(r.balanceAmount || 0), 0)

  return (
    <Screen>
      {header}

      {error ? <ErrorNotice message={error} onRetry={reload} /> : null}

      {!error && rows.length === 0 ? (
        <Empty title="Nothing outstanding" hint="Every invoice raised so far has been paid." />
      ) : (
        <>
          <View className="border-b border-border px-4 py-4">
            <Text className="text-xs text-muted-foreground">Total owed to you</Text>
            <Text className="mt-1 text-2xl font-bold text-foreground">₹{money(total)}</Text>
            <Text className="mt-0.5 text-xs text-muted-foreground">
              across {rows.length} {rows.length === 1 ? 'invoice' : 'invoices'}
            </Text>
          </View>

          <ScrollView
            refreshControl={
              <RefreshControl refreshing={loading} onRefresh={reload} tintColor="#14b8a6" />
            }
            contentContainerClassName="gap-3 px-4 py-4 pb-8"
          >
            {rows.map((inv) => {
              const late = overdueDays(inv.dueDate)
              return (
                <Card key={inv.id}>
                  <View className="flex-row items-start justify-between gap-3">
                    <View className="flex-1">
                      <Text className="text-sm font-semibold text-foreground">
                        {inv.customer.name}
                      </Text>
                      <Text className="mt-0.5 text-xs text-muted-foreground">
                        {inv.invoiceNumber} · {shortDate(inv.invoiceDate)}
                      </Text>
                    </View>
                    <View className="items-end gap-1.5">
                      <Text className="text-base font-bold text-foreground">
                        ₹{money(inv.balanceAmount)}
                      </Text>
                      {late > 0 ? (
                        <Badge label={`${late} days late`} kind="danger" />
                      ) : inv.dueDate ? (
                        <Badge label={`Due ${shortDate(inv.dueDate)}`} kind="warning" />
                      ) : null}
                    </View>
                  </View>

                  {/* Only offered when there is a number to call. An empty tel:
                      link opens the dialler with nothing in it. */}
                  {inv.customer.phone ? (
                    <Pressable
                      onPress={() => void Linking.openURL(`tel:${inv.customer.phone}`)}
                      accessibilityRole="button"
                      accessibilityLabel={`Call ${inv.customer.name}`}
                      className="mt-3 min-h-[44px] flex-row items-center justify-center gap-2 rounded-lg border border-border bg-secondary active:opacity-70"
                    >
                      <Phone size={15} color="#14b8a6" />
                      <Text className="text-sm font-medium text-foreground">
                        Call {inv.customer.phone}
                      </Text>
                    </Pressable>
                  ) : null}
                </Card>
              )
            })}
          </ScrollView>
        </>
      )}
    </Screen>
  )
}
