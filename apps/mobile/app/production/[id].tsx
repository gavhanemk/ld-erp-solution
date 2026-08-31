import { ScrollView, Text, View, useWindowDimensions } from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import { api, type Single } from '@/lib/api'
import { useFetch } from '@/lib/useFetch'
import { shortDate, relativeDate } from '@/lib/format'
import {
  Screen, Card, Row, Badge, Loading, WakingServer, ErrorNotice,
  statusKind, prettyStatus,
} from '@/components/ui'
import { ProgressRow, SERIES } from '@/components/charts'

/**
 * One manufacturing order, all the way down.
 *
 * The question a supervisor actually has standing next to a line is "where has
 * this reached and what is holding it up", so the stages come first, then what
 * was logged and when, then what quality found.
 */

interface Entry {
  id: string
  entryDate: string
  stage: string
  target: number
  achieved: number
  rejection: number
  rework: number
}

interface QC {
  id: string
  qcDate: string
  checkedQty: number
  passedQty: number
  failedQty: number
  remarks: string | null
}

interface MO {
  id: string
  moNumber: string
  status: string
  plannedStartDate: string | null
  plannedEndDate: string | null
  totalPlannedQty: number
  totalCutQty: number
  totalStitchedQty: number
  totalFinishedQty: number
  totalPackedQty: number
  brand: { name: string } | null
  so: { soNumber: string; customer: { name: string } } | null
  lines: { id: string; style: { code: string; name: string } }[]
  productionEntries: Entry[]
  qcRecords: QC[]
}

export default function ManufacturingOrderDetail() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { width } = useWindowDimensions()
  const barWidth = width - 64

  const { data, loading, waking, error, reload } = useFetch(
    () => api.get<Single<MO>>(`/production/orders/${id}`).then((r) => r.data),
    [id],
  )

  const header = (
    <Stack.Screen
      options={{
        headerShown: true,
        title: data?.moNumber ?? 'Order',
        headerBackTitle: 'Production',
      }}
    />
  )

  if (waking) return <Screen>{header}<WakingServer /></Screen>
  if (loading && !data) return <Screen>{header}<Loading /></Screen>
  if (error) return <Screen>{header}<ErrorNotice message={error} onRetry={reload} /></Screen>
  if (!data) return null

  const stages = [
    ['Cut', data.totalCutQty],
    ['Stitched', data.totalStitchedQty],
    ['Finished', data.totalFinishedQty],
    ['Packed', data.totalPackedQty],
  ] as const

  return (
    <Screen>
      {header}
      <ScrollView contentContainerClassName="gap-3 px-4 py-4 pb-8">
        <Card>
          <View className="flex-row items-start justify-between gap-3">
            <View className="flex-1">
              <Text className="text-xs text-muted-foreground">For</Text>
              <Text className="mt-0.5 text-base font-semibold text-foreground">
                {data.so?.customer.name ?? 'Stock order'}
              </Text>
              {data.so ? (
                <Text className="mt-0.5 text-xs text-muted-foreground">
                  against {data.so.soNumber}
                </Text>
              ) : null}
            </View>
            <Badge label={prettyStatus(data.status)} kind={statusKind(data.status)} />
          </View>

          <View className="mt-4 border-t border-border pt-3">
            {data.brand ? <Row label="Brand" value={data.brand.name} /> : null}
            <Row label="Planned start" value={shortDate(data.plannedStartDate)} />
            <Row label="Planned finish" value={shortDate(data.plannedEndDate)} />
            <Row
              label="Planned quantity"
              value={data.totalPlannedQty.toLocaleString('en-IN')}
              strong
            />
          </View>
        </Card>

        <Text className="mt-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Where it has reached
        </Text>
        <Card>
          <View className="gap-4">
            {stages.map(([label, qty]) => (
              <ProgressRow
                key={label}
                label={label}
                achieved={qty}
                target={data.totalPlannedQty}
                width={barWidth}
                hint={`of ${data.totalPlannedQty.toLocaleString('en-IN')} planned`}
              />
            ))}
          </View>
        </Card>

        {data.lines.length ? (
          <>
            <Text className="mt-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Styles
            </Text>
            <Card>
              <View className="gap-2">
                {data.lines.map((l) => (
                  <View key={l.id} className="flex-row items-center justify-between">
                    <Text className="text-sm text-foreground">{l.style.name}</Text>
                    <Text className="text-xs text-muted-foreground">{l.style.code}</Text>
                  </View>
                ))}
              </View>
            </Card>
          </>
        ) : null}

        {data.productionEntries.length ? (
          <>
            <Text className="mt-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              What was logged
            </Text>
            {data.productionEntries.slice(0, 15).map((e) => (
              <Card key={e.id}>
                <View className="flex-row items-start justify-between gap-3">
                  <View className="flex-1">
                    <Text className="text-sm font-semibold text-foreground">
                      {prettyStatus(e.stage)}
                    </Text>
                    <Text className="mt-0.5 text-xs text-muted-foreground">
                      {relativeDate(e.entryDate)}
                    </Text>
                  </View>
                  <View className="items-end">
                    <Text className="text-base font-bold text-foreground">
                      {e.achieved.toLocaleString('en-IN')}
                    </Text>
                    {e.target > 0 ? (
                      <Text className="text-xs text-muted-foreground">
                        of {e.target.toLocaleString('en-IN')}
                      </Text>
                    ) : null}
                  </View>
                </View>
                {e.rejection > 0 || e.rework > 0 ? (
                  <View className="mt-2 flex-row gap-4 border-t border-border pt-2">
                    {e.rejection > 0 ? (
                      <Text className="text-xs" style={{ color: SERIES[3] }}>
                        {e.rejection.toLocaleString('en-IN')} rejected
                      </Text>
                    ) : null}
                    {e.rework > 0 ? (
                      <Text className="text-xs" style={{ color: SERIES[1] }}>
                        {e.rework.toLocaleString('en-IN')} reworked
                      </Text>
                    ) : null}
                  </View>
                ) : null}
              </Card>
            ))}
          </>
        ) : null}

        {data.qcRecords.length ? (
          <>
            <Text className="mt-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Quality
            </Text>
            {data.qcRecords.slice(0, 10).map((q) => {
              const failRate = q.checkedQty > 0 ? q.failedQty / q.checkedQty : 0
              return (
                <Card key={q.id}>
                  <View className="flex-row items-center justify-between">
                    <Text className="text-xs text-muted-foreground">{shortDate(q.qcDate)}</Text>
                    <Badge
                      label={`${Math.round(failRate * 100)}% failed`}
                      kind={failRate > 0.05 ? 'danger' : failRate > 0.02 ? 'warning' : 'success'}
                    />
                  </View>
                  <View className="mt-3">
                    <Row label="Checked" value={q.checkedQty.toLocaleString('en-IN')} />
                    <Row label="Passed" value={q.passedQty.toLocaleString('en-IN')} />
                    <Row label="Failed" value={q.failedQty.toLocaleString('en-IN')} />
                  </View>
                  {q.remarks ? (
                    <Text className="mt-2 border-t border-border pt-2 text-xs text-foreground">
                      {q.remarks}
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
