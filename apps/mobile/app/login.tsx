import { useState } from 'react'
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { LogIn } from 'lucide-react-native'
import { useAuth } from '@/lib/auth'
import { ApiError, API_URL } from '@/lib/api'
import { Button, Field, Input, ErrorNotice } from '@/components/ui'

export default function Login() {
  const { signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!email.trim() || !password) {
      setError('Enter your email and password.')
      return
    }

    setBusy(true)
    setError(null)
    try {
      await signIn(email, password)
      // The guard in _layout.tsx notices the new user and moves to the app.
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not sign in. Try again in a moment.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-background">
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerClassName="flex-grow justify-center px-6 py-10">
          <View className="mb-10 items-center">
            <View className="h-16 w-16 items-center justify-center rounded-2xl bg-teal-500">
              <Text className="text-xl font-bold text-white">LD</Text>
            </View>
            <Text className="mt-4 text-2xl font-bold text-foreground">LD ERP</Text>
            <Text className="mt-1 text-xs text-muted-foreground">LD Cotton Mills</Text>
          </View>

          {error ? <ErrorNotice message={error} /> : null}

          <Field label="Email">
            <Input
              value={email}
              onChangeText={setEmail}
              placeholder="you@ldcottonmills.com"
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              editable={!busy}
            />
          </Field>

          <Field label="Password">
            <Input
              value={password}
              onChangeText={setPassword}
              placeholder="Your password"
              secureTextEntry
              autoCapitalize="none"
              editable={!busy}
              onSubmitEditing={submit}
              returnKeyType="go"
            />
          </Field>

          <Button
            label={busy ? 'Signing in...' : 'Sign in'}
            onPress={submit}
            busy={busy}
            icon={<LogIn size={16} color="#fff" />}
            className="mt-2"
          />

          {/* Which server this build talks to. Invaluable the first time
              someone asks why the phone shows different figures to the web. */}
          <Text className="mt-8 text-center text-xs text-muted-foreground">
            {API_URL.replace(/^https?:\/\//, '').replace(/\/api$/, '')}
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}
