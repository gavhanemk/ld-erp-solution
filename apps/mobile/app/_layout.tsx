import '../global.css'

import { useEffect } from 'react'
import { View, ActivityIndicator } from 'react-native'
import { Stack, useRouter, useSegments } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { AuthProvider, useAuth } from '@/lib/auth'

/**
 * The shell every screen sits inside.
 *
 * Its one job beyond providing the sign-in state is the guard below: a signed
 * out user cannot reach the app, and a signed in one is not left staring at the
 * sign-in screen.
 */

function Guard({ children }: { children: React.ReactNode }) {
  const { user, restoring } = useAuth()
  const segments = useSegments()
  const router = useRouter()

  useEffect(() => {
    // Nothing is decided until the stored session has been read back, or the
    // app would bounce to sign-in for a moment on every cold start.
    if (restoring) return

    const onLoginScreen = segments[0] === 'login'

    if (!user && !onLoginScreen) router.replace('/login')
    else if (user && onLoginScreen) router.replace('/')
  }, [user, restoring, segments, router])

  if (restoring) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator />
      </View>
    )
  }

  return <>{children}</>
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AuthProvider>
        {/* Follows the phone's own light or dark setting, like the web app
            follows the browser's. */}
        <StatusBar style="auto" />
        <Guard>
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="login" />
            <Stack.Screen name="(tabs)" />
          </Stack>
        </Guard>
      </AuthProvider>
    </GestureHandlerRootView>
  )
}
