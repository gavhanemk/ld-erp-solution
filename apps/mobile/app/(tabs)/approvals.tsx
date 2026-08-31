import { useState } from 'react'
import { Alert, RefreshControl, ScrollView, Text, View } from 'react-native'
import { Check, X, AlertTriangle } from 'lucide-react-native'
import { api, ApiError } from '@/lib/api'
import { useFetch } from '@/lib/useFetch'
import { useAuth } from '@/lib/auth'
import { money, relativeDate } from '@/lib/format'
import {
  Screen, PageHeading, Card, Button, Badge, Loading, WakingServer,
  Empty, ErrorNotice, SuccessNotice,
} from '@/components/ui'

/**
 * Approve or reject, with a thumb.
 *
 * The reason a phone app is worth building at all: an MD standing on the shop
 * floor can clear the day's orders without going back to a desk. Everything
 * needed to decide — who, how much, how long it has waited — is on the card, so
 * nobody has to open a second screen to say yes.
 */

interface Approval {
  id: string
  type: 'PO' | 'SO' | 'MR'
  number: string
  description: string
  amount: number
  date: string
  urgent: boolean
}

const TYPE_LABEL: Record<Approval['type'], string> = {
  PO: 'Purchase order',
  SO: 'Sales order',
  MR: 'Material requisition',
}

export default function ApprovalsScreen() {
  const { can } = useAuth()
  const [working, setWorking] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const { data, loading, waking, error, reload } = useFetch(
    () =>
      api
        .get<{ success: boolean; data: Approval[] }>('/dashboard/pending-approvals?limit=50')
        .then((r) => r.data),
    [],
  )

  // The server governs approval by the module the document belongs to, so the
  // buttons follow the same rule rather than a rule of their own.
  const moduleFor: Record<Approval['type'], string> = {
    PO: 'purchase',
    SO: 'sales',
    MR: 'inventory',
  }

  async function act(item: Approval, decision: 'approve' | 'reject') {
    setWorking(item.id)
    setDone(null)
    try {
      await api.post(`/approvals/${item.type}/${item.id}/${decision}`,
        decision === 'reject' ? { reason: 'Rejected from the phone' } : {})
      setDone(`${item.number} ${decision === 'approve' ? 'approved' : 'rejected'}.`)
      await reload()
    } catch (err) {
      Alert.alert(
        'Could not save that',
        err instanceof ApiError ? err.message : 'Try again in a moment.',
      )
    } finally {
      setWorking(null)
    }
  }

  // Rejecting cannot be undone from here, so it asks first. Approving does not:
  // it is the common case, and a confirmation on every one would make clearing
  // twenty orders a forty-tap job.
  function confirmReject(item: Approval) {
    Alert.alert(
      `Reject ${item.number}?`,
      `${item.description} · ₹${money(item.amount)}`,
      [
        { text: 'Keep it', style: 'cancel' },
        { text: 'Reject', style: 'destructive', onPress: () => void act(item, 'reject') },
      ],
    )
  }

  if (waking) return <Screen><WakingServer /></Screen>
  if (loading && !data) return <Screen><Loading label="Loading approvals..." /></Screen>

  const items = data ?? []

  return (
    <Screen>
      <PageHeading
        title="Approvals"
        subtitle={items.length === 1 ? '1 item waiting' : `${items.length} items waiting`}
      />

      {error ? <ErrorNotice message={error} onRetry={reload} /> : null}
      {done ? <SuccessNotice message={done} /> : null}

      {!error && items.length === 0 ? (
        <Empty title="Nothing waiting" hint="Everything raised so far has been dealt with." />
      ) : (
        <ScrollView
          refreshControl={
            <RefreshControl refreshing={loading} onRefresh={reload} tintColor="#14b8a6" />
          }
          contentContainerClassName="gap-3 px-4 pb-8"
        >
          {items.map((item) => {
            const allowed = can(moduleFor[item.type], 'approve')
            const busy = working === item.id

            return (
              <Card key={`${item.type}-${item.id}`}>
                <View className="flex-row items-start justify-between gap-3">
                  <View className="flex-1">
                    <Text className="text-xs text-muted-foreground">{TYPE_LABEL[item.type]}</Text>
                    <Text className="mt-0.5 text-base font-semibold text-foreground">
                      {item.number}
                    </Text>
                    <Text className="mt-0.5 text-sm text-foreground">{item.description}</Text>
                  </View>
                  <View className="items-end gap-1">
                    <Text className="text-base font-bold text-foreground">
                      ₹{money(item.amount)}
                    </Text>
                    <Text className="text-xs text-muted-foreground">
                      {relativeDate(item.date)}
                    </Text>
                  </View>
                </View>

                {item.urgent ? (
                  <View className="mt-3 flex-row items-center gap-1.5">
                    <AlertTriangle size={13} color="#f59e0b" />
                    <Text className="text-xs text-amber-500">
                      Waiting longer than it should be
                    </Text>
                  </View>
                ) : null}

                {allowed ? (
                  <View className="mt-4 flex-row gap-3">
                    <Button
                      label="Approve"
                      onPress={() => void act(item, 'approve')}
                      busy={busy}
                      icon={<Check size={16} color="#fff" />}
                      className="flex-1"
                    />
                    <Button
                      label="Reject"
                      kind="secondary"
                      onPress={() => confirmReject(item)}
                      disabled={busy}
                      icon={<X size={16} color="#94a3b8" />}
                      className="flex-1"
                    />
                  </View>
                ) : (
                  <View className="mt-3">
                    <Badge label="You cannot approve this" kind="neutral" />
                  </View>
                )}
              </Card>
            )
          })}
        </ScrollView>
      )}
    </Screen>
  )
}
