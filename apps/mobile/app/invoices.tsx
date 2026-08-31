import { RefreshControl, ScrollView, Text, View } from 'react-native'
import { Stack } from 'expo-router'
import { api } from '@/lib/api'
import { useFetch } from '@/lib/useFetch'
import { money, shortDate } from '@/lib/format'
import {
  Screen, Card, Badge, Loading, WakingServer, Empty, ErrorNotice,
  statusKind, prettyStatus,
} from '@/components/ui'
import { Reveal } from '@/components/motion'

/**
 * Tax invoices raised, newest first.
 *
 * Read only, and it will stay that way. Raising an invoice means an irreversible
 * document number, a GST split and a legal record — that belongs on a keyboard
 * with the whole order in front of you, not on a phone in a corridor.
 */

interface Invoice {
  id: string
  invoiceNumber: string
  invoiceDate: string
  dueDate: string | null
  totalAmount: string | number
  paidAmount: string | number
  balanceAmount: string | number
  status: string
  customer: { name: string }
}

export default function Invoices() {
  const { data, loading, waking, error, reload } = useFetch(
    () => api.get<{ data: Invoice[] }>('/sales/invoices').then((r) => r.data),
    [],
  )

  const header = (
    <Stack.Screen options={{ headerShown: true, title: 'Invoices', headerBackTitle: 'Back' }} />
  )

  if (waking) return <Screen>{header}<WakingServer /></Screen>
  if (loading && !data) return <Screen>{header}<Loading /></Screen>

  const rows = data ?? []

  return (
    <Screen>
      {header}

      {error ? <ErrorNotice message={error} onRetry={reload} /> : null}

      {!error && rows.length === 0 ? (
        <Empty title="No invoices yet" hint="They will appear here once you raise one." />
      ) : (
        <ScrollView
          refreshControl={
            <RefreshControl refreshing={loading} onRefresh={reload} tintColor="#14b8a6" />
          }
          contentContainerClassName="gap-3 px-4 py-4 pb-8"
        >
          {rows.map((inv, i) => (
            <Reveal key={inv.id} index={Math.min(i, 6)}>
              <Card>
                <View className="flex-row items-start justify-between gap-3">
                  <View className="flex-1">
                    <Text className="text-sm font-semibold text-foreground">
                      {inv.customer.name}
                    </Text>
                    <Text className="mt-0.5 text-xs text-muted-foreground">
                      {inv.invoiceNumber} · {shortDate(inv.invoiceDate)}
                    </Text>
                  </View>
                  <View className="items-end gap-2">
                    <Text className="text-base font-bold text-foreground">
                      ₹{money(inv.totalAmount)}
                    </Text>
                    <Badge label={prettyStatus(inv.status)} kind={statusKind(inv.status)} />
                  </View>
                </View>

                {/* Only shown when something is still owed. On a paid invoice
                    the two figures are the same and the row says nothing. */}
                {Number(inv.balanceAmount) > 0 ? (
                  <View className="mt-3 flex-row justify-between border-t border-border pt-2">
                    <Text className="text-xs text-muted-foreground">
                      Paid ₹{money(inv.paidAmount)}
                    </Text>
                    <Text className="text-xs font-semibold text-foreground">
                      ₹{money(inv.balanceAmount)} still due
                    </Text>
                  </View>
                ) : null}
              </Card>
            </Reveal>
          ))}
        </ScrollView>
      )}
    </Screen>
  )
}
