import { useColorScheme } from 'react-native'
import { Tabs } from 'expo-router'
import { Home, CheckSquare, FileText, Sparkles, Menu } from 'lucide-react-native'
import { useAuth } from '@/lib/auth'

/**
 * The tab bar, drawn from the signed-in user's permissions.
 *
 * A tab whose href is null is not rendered, so a store keeper never sees the
 * approvals tab and a production supervisor never sees outstanding money. This
 * is tidiness, not security — the server checks every request again, so the
 * same rule holds even if a screen is reached another way.
 *
 * Five tabs is the ceiling. Beyond that the labels stop being readable on a
 * phone, which is why everything else lives behind More.
 */

// The tab bar takes real colour values, not class names, so these are the two
// role colours from tailwind.config.js written out. They must stay in step.
const TEAL = '#14b8a6'
const MUTED = '#64748b'

export default function TabsLayout() {
  const { can } = useAuth()
  const dark = useColorScheme() === 'dark'

  const bar = {
    backgroundColor: dark ? '#0f172a' : '#ffffff',
    borderTopColor: dark ? '#1e293b' : '#dfe3e8',
  }

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: TEAL,
        tabBarInactiveTintColor: MUTED,
        tabBarStyle: { ...bar, height: 60, paddingBottom: 8, paddingTop: 6 },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '500' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          href: can('dashboard', 'view') ? '/' : null,
          tabBarIcon: ({ color, size }) => <Home size={size} color={color} />,
        }}
      />

      <Tabs.Screen
        name="approvals"
        options={{
          title: 'Approvals',
          href: can('dashboard', 'view') ? '/approvals' : null,
          tabBarIcon: ({ color, size }) => <CheckSquare size={size} color={color} />,
        }}
      />

      <Tabs.Screen
        name="orders"
        options={{
          title: 'Orders',
          href: can('purchase', 'view') || can('sales', 'view') ? '/orders' : null,
          tabBarIcon: ({ color, size }) => <FileText size={size} color={color} />,
        }}
      />

      <Tabs.Screen
        name="ai"
        options={{
          title: 'Ask AI',
          href: can('ai', 'view') ? '/ai' : null,
          tabBarIcon: ({ color, size }) => <Sparkles size={size} color={color} />,
        }}
      />

      {/* Always present. Whatever a user's role, they need somewhere to find
          who they are signed in as and how to sign out. */}
      <Tabs.Screen
        name="more"
        options={{
          title: 'More',
          tabBarIcon: ({ color, size }) => <Menu size={size} color={color} />,
        }}
      />
    </Tabs>
  )
}
