import '../global.css'

import { useCallback, useEffect, useState } from 'react'
import { View } from 'react-native'
import { Stack, useRouter, useSegments } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { AuthProvider, useAuth } from '@/lib/auth'
import { Welcome } from '@/components/Welcome'
import { Aurora } from '@/components/Aurora'

/**
 * The shell every screen sits inside.
 *
 * Two jobs beyond holding the sign-in state. The guard keeps a signed-out
 * person out of the app and a signed-in one off the sign-in screen. And the
 * opening moment: a cold start has to wait for the stored session to be read
 * back, so rather than a blank screen or a spinner, that wait carries the
 * mill's mark and a greeting.
 */

function Shell() {
  const { user, restoring } = useAuth()
  const segments = useSegments()
  const router = useRouter()

  // Shown once per launch, over whatever is behind it.
  const [greeted, setGreeted] = useState(false)
  const finishGreeting = useCallback(() => setGreeted(true), [])

  useEffect(() => {
    // Nothing is decided until the stored session has been read back, or the
    // app would bounce to sign-in for a moment on every cold start.
    if (restoring) return

    const onLoginScreen = segments[0] === 'login'

    if (!user && !onLoginScreen) router.replace('/login')
    else if (user && onLoginScreen) router.replace('/')
  }, [user, restoring, segments, router])

  /**
   * The greeting covers the restore, and stays a moment longer for someone who
   * is signed in. A person who is signed out goes straight to the sign-in
   * screen instead — being greeted by name and then asked who you are would be
   * a strange way to open an app.
   */
  const showGreeting = !greeted && (restoring || Boolean(user))

  return (
    <View className="flex-1 bg-background">
      <StatusBar style={showGreeting ? 'light' : 'auto'} />

      {/* While the session is being read there is nothing to show underneath,
          so the colour stands in for it and the change is never visible. */}
      {restoring ? <Aurora /> : null}

      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="login" />
        <Stack.Screen name="(tabs)" />
      </Stack>

      {showGreeting ? <Welcome name={user?.name} onDone={finishGreeting} /> : null}
    </View>
  )
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AuthProvider>
        <Shell />
      </AuthProvider>
    </GestureHandlerRootView>
  )
}
