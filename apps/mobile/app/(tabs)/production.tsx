import { useState } from 'react'
import { Pressable, RefreshControl, ScrollView, Text, View, useWindowDimensions } from 'react-native'
import { useRouter } from 'expo-router'
import { api, type Paginated } from '@/lib/api'
import { useFetch } from '@/lib/useFetch'
import { shortDate, relativeDate } from '@/lib/format'
import {
  Screen, PageHeading, Card, CardButton, Badge, Loading, WakingServer,
  Empty, ErrorNotice, statusKind, prettyStatus,
} from '@/components/ui'
import { ProgressRow, SERIES } from '@/components/charts'
import { Reveal } from '@/components/motion'

/**
 * The floor.
 *
 * Read only, because the server is read only here: it can say what was cut,
 * stitched and checked, but has nowhere to put a new entry yet. A supervisor
 * can see where every order stands without walking to the office; recording
 * today's output from the phone waits on the server side being built.
 */

interface MO {
  id: string
  moNumber: string
  status: string
  customer: string | null
  soNumber: string | null
  styles: string[]
  plannedEndDate: string | null
  totalPlannedQty: number
  totalCutQty: number
  totalStitchedQty: number
  totalFinishedQty: number
  totalPackedQty: number
}

interface Entry {
  id: string
  entryDate: string
  stage: string
  target: number
  achieved: number
  rejection: number
  mo: { moNumber: string } | null
}

interface QC {
  id: string
  qcDate: string
  checkedQty: number
  passedQty: number
  failedQty: number
  mo: { moNumber: string } | null
}

type Tab = 'orders' | 'today' | 'quality'

const TABS: { key: Tab; label: string }[] = [
  { key: 'orders', label: 'Orders' },
  { key: 'today', label: 'Output' },
  { key: 'quality', label: 'Quality' },
]

export default function Production() {
  const [tab, setTab] = useState<Tab>('orders')
  const { width } = useWindowDimensions()
  const router = useRouter()
  const barWidth = width - 64

  const { data, loading, waking, error, reload } = useFetch(async () => {
    if (tab === 'orders') {
      const r = await api.get<Paginated<MO>>('/production/orders?limit=50')
      return { kind: 'orders' as const, rows: r.data }
    }
    if (tab === 'today') {
      const r = await api.get<{ data: Entry[] }>('/production/entries?limit=100')
      return { kind: 'today' as const, rows: r.data }
    }
    const r = await api.get<{ data: QC[] }>('/production/qc?limit=50')
    return { kind: 'quality' as const, rows: r.data }
  }, [tab])

  if (waking) return <Screen><WakingServer /></Screen>

  return (
    <Screen>
      <PageHeading title="Production" subtitle="What is on the floor today" />

      <View className="mx-4 mb-4 flex-row rounded-lg bg-secondary p-1">
        {TABS.map((t) => {
          const on = t.key === tab
          return (
            <Pressable
              key={t.key}
              onPress={() => setTab(t.key)}
              className={`flex-1 items-center justify-center rounded-md py-2.5 ${on ? 'bg-teal-500' : ''}`}
            >
              <Text className={`text-sm font-semibold ${on ? 'text-white' : 'text-muted-foreground'}`}>
                {t.label}
              </Text>
            </Pressable>
          )
        })}
      </View>

      {error ? <ErrorNotice message={error} onRetry={reload} /> : null}

      {loading && !data ? (
        <Loading />
      ) : !error && (!data || data.rows.length === 0) ? (
        <Empty
          title={
            tab === 'orders'
              ? 'No manufacturing orders'
              : tab === 'today'
                ? 'Nothing recorded yet'
                : 'No quality checks recorded'
          }
          hint="They will appear here as the floor logs them."
        />
      ) : (
        <ScrollView
          refreshControl={
            <RefreshControl refreshing={loading} onRefresh={reload} tintColor="#14b8a6" />
          }
          contentContainerClassName="gap-3 px-4 pb-8"
        >
          {data?.kind === 'orders'
            ? (data.rows as MO[]).map((mo, i) => (
                <Reveal key={mo.id} index={Math.min(i, 6)}>
                  <CardButton onPress={() => router.push(`/production/${mo.id}`)}>
                    <View className="flex-row items-start justify-between gap-3">
                      <View className="flex-1">
                        <Text className="text-sm font-semibold text-foreground">
                          {mo.moNumber}
                        </Text>
                        <Text className="mt-0.5 text-sm text-foreground">
                          {mo.customer ?? 'Stock order'}
                        </Text>
                        {mo.styles.length ? (
                          <Text className="mt-1 text-xs text-muted-foreground">
                            {mo.styles.slice(0, 3).join(', ')}
                            {mo.styles.length > 3 ? ` +${mo.styles.length - 3}` : ''}
                          </Text>
                        ) : null}
                      </View>
                      <View className="items-end gap-2">
                        <Badge label={prettyStatus(mo.status)} kind={statusKind(mo.status)} />
                        {mo.plannedEndDate ? (
                          <Text className="text-xs text-muted-foreground">
                            by {shortDate(mo.plannedEndDate)}
                          </Text>
                        ) : null}
                      </View>
                    </View>

                    {/* Where the order has actually reached, stage by stage.
                        Each is measured against the same planned quantity, so
                        the bars are comparable down the card. */}
                    <View className="mt-4 gap-3 border-t border-border pt-3">
                      {(
                        [
                          ['Cut', mo.totalCutQty],
                          ['Stitched', mo.totalStitchedQty],
                          ['Packed', mo.totalPackedQty],
                        ] as const
                      ).map(([label, qty]) => (
                        <ProgressRow
                          key={label}
                          label={label}
                          achieved={qty}
                          target={mo.totalPlannedQty}
                          width={barWidth}
                          hint={`of ${mo.totalPlannedQty.toLocaleString('en-IN')} planned`}
                        />
                      ))}
                    </View>
                  </CardButton>
                </Reveal>
              ))
            : null}

          {data?.kind === 'today'
            ? (data.rows as Entry[]).map((e, i) => (
                <Reveal key={e.id} index={Math.min(i, 6)}>
                  <Card>
                    <View className="flex-row items-start justify-between gap-3">
                      <View className="flex-1">
                        <Text className="text-sm font-semibold text-foreground">
                          {prettyStatus(e.stage)}
                        </Text>
                        <Text className="mt-0.5 text-xs text-muted-foreground">
                          {e.mo?.moNumber ?? '—'} · {relativeDate(e.entryDate)}
                        </Text>
                      </View>
                      {e.rejection > 0 ? (
                        <Badge label={`${e.rejection} rejected`} kind="danger" />
                      ) : null}
                    </View>
                    <View className="mt-3">
                      <ProgressRow
                        label="Made"
                        achieved={e.achieved}
                        target={e.target}
                        width={barWidth}
                      />
                    </View>
                  </Card>
                </Reveal>
              ))
            : null}

          {data?.kind === 'quality'
            ? (data.rows as QC[]).map((q, i) => {
                const failRate = q.checkedQty > 0 ? q.failedQty / q.checkedQty : 0
                return (
                  <Reveal key={q.id} index={Math.min(i, 6)}>
                    <Card>
                      <View className="flex-row items-start justify-between gap-3">
                        <View className="flex-1">
                          <Text className="text-sm font-semibold text-foreground">
                            {q.mo?.moNumber ?? 'Quality check'}
                          </Text>
                          <Text className="mt-0.5 text-xs text-muted-foreground">
                            {shortDate(q.qcDate)}
                          </Text>
                        </View>
                        <Badge
                          label={`${Math.round(failRate * 100)}% failed`}
                          kind={failRate > 0.05 ? 'danger' : failRate > 0.02 ? 'warning' : 'success'}
                        />
                      </View>
                      <View className="mt-3 flex-row gap-6">
                        <View>
                          <Text className="text-xs text-muted-foreground">Checked</Text>
                          <Text className="text-base font-semibold text-foreground">
                            {q.checkedQty.toLocaleString('en-IN')}
                          </Text>
                        </View>
                        <View>
                          <Text className="text-xs text-muted-foreground">Passed</Text>
                          <Text
                            className="text-base font-semibold"
                            style={{ color: SERIES[2] }}
                          >
                            {q.passedQty.toLocaleString('en-IN')}
                          </Text>
                        </View>
                        <View>
                          <Text className="text-xs text-muted-foreground">Failed</Text>
                          <Text
                            className="text-base font-semibold"
                            style={{ color: q.failedQty > 0 ? SERIES[3] : undefined }}
                          >
                            {q.failedQty.toLocaleString('en-IN')}
                          </Text>
                        </View>
                      </View>
                    </Card>
                  </Reveal>
                )
              })
            : null}
        </ScrollView>
      )}
    </Screen>
  )
}
