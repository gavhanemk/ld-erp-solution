import { useEffect, useState } from 'react'
import { Linking, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import { Phone, Search } from 'lucide-react-native'
import { masterResource } from '@/lib/api'
import { useFetch } from '@/lib/useFetch'
import {
  Screen, Card, Input, Badge, Loading, WakingServer, Empty, ErrorNotice,
} from '@/components/ui'

/**
 * Looking someone up.
 *
 * Read only, and deliberately so. Adding a customer means a GSTIN, a state
 * code, credit terms and a billing address — a job for a keyboard. What this is
 * for is standing in front of somebody and needing their number or their GST
 * number in five seconds.
 */

type Tab = 'customers' | 'suppliers' | 'items'

interface Party {
  id: string
  code: string
  name: string
  phone?: string | null
  gstin?: string | null
  city?: string | null
  isActive?: boolean
  hsnCode?: string | null
  uom?: { symbol: string } | null
}

const TABS: { key: Tab; label: string }[] = [
  { key: 'customers', label: 'Customers' },
  { key: 'suppliers', label: 'Suppliers' },
  { key: 'items', label: 'Items' },
]

export default function Masters() {
  const params = useLocalSearchParams<{ tab?: string }>()
  const [tab, setTab] = useState<Tab>(
    TABS.some((t) => t.key === params.tab) ? (params.tab as Tab) : 'customers',
  )
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')

  // Typing should not fire a request per keystroke — the same 350ms the web
  // master tables use.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 350)
    return () => clearTimeout(timer)
  }, [search])

  const { data, loading, waking, error, reload } = useFetch(
    () =>
      masterResource<Party>(tab)
        .list({ limit: 50, active: true, q: query || undefined })
        .then((r) => r.data),
    [tab, query],
  )

  const header = (
    <Stack.Screen options={{ headerShown: true, title: 'Look up', headerBackTitle: 'More' }} />
  )

  if (waking) return <Screen>{header}<WakingServer /></Screen>

  const rows = data ?? []

  return (
    <Screen>
      {header}

      <View className="flex-row gap-2 px-4 pt-3">
        {TABS.map((t) => {
          const on = t.key === tab
          return (
            <Pressable
              key={t.key}
              onPress={() => setTab(t.key)}
              className={`flex-1 items-center rounded-lg py-2.5 ${on ? 'bg-teal-500' : 'bg-secondary'}`}
            >
              <Text
                className={`text-sm font-semibold ${on ? 'text-white' : 'text-muted-foreground'}`}
              >
                {t.label}
              </Text>
            </Pressable>
          )
        })}
      </View>

      <View className="flex-row items-center gap-2 px-4 py-3">
        <Search size={16} color="#64748b" />
        <Input
          value={search}
          onChangeText={setSearch}
          placeholder={`Search ${tab}`}
          autoCapitalize="none"
          className="flex-1"
        />
      </View>

      {error ? <ErrorNotice message={error} onRetry={reload} /> : null}

      {loading && rows.length === 0 ? (
        <Loading />
      ) : !error && rows.length === 0 ? (
        <Empty
          title={query ? `Nothing matching "${query}"` : `No ${tab} yet`}
          hint={query ? 'Try a shorter search.' : undefined}
        />
      ) : (
        <ScrollView
          refreshControl={
            <RefreshControl refreshing={loading} onRefresh={reload} tintColor="#14b8a6" />
          }
          contentContainerClassName="gap-3 px-4 pb-8"
        >
          {rows.map((row) => (
            <Card key={row.id}>
              <View className="flex-row items-start justify-between gap-3">
                <View className="flex-1">
                  <Text className="text-sm font-semibold text-foreground">{row.name}</Text>
                  <Text className="mt-0.5 text-xs text-muted-foreground">{row.code}</Text>
                </View>
                {tab === 'items' && row.uom ? (
                  <Badge label={row.uom.symbol} kind="neutral" />
                ) : null}
              </View>

              {row.gstin ? (
                <Text className="mt-2 text-xs text-muted-foreground">GSTIN {row.gstin}</Text>
              ) : null}
              {row.hsnCode ? (
                <Text className="mt-2 text-xs text-muted-foreground">HSN {row.hsnCode}</Text>
              ) : null}
              {row.city ? (
                <Text className="mt-0.5 text-xs text-muted-foreground">{row.city}</Text>
              ) : null}

              {row.phone ? (
                <Pressable
                  onPress={() => void Linking.openURL(`tel:${row.phone}`)}
                  accessibilityRole="button"
                  accessibilityLabel={`Call ${row.name}`}
                  className="mt-3 min-h-[44px] flex-row items-center justify-center gap-2 rounded-lg border border-border bg-secondary active:opacity-70"
                >
                  <Phone size={15} color="#14b8a6" />
                  <Text className="text-sm font-medium text-foreground">{row.phone}</Text>
                </Pressable>
              ) : null}
            </Card>
          ))}
        </ScrollView>
      )}
    </Screen>
  )
}
