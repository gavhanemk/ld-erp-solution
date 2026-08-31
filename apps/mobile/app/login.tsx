import { useState } from 'react'
import {
  ActivityIndicator, KeyboardAvoidingView, Platform,
  ScrollView, Text, TextInput, View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { StatusBar } from 'expo-status-bar'
import { ArrowRight, AlertCircle } from 'lucide-react-native'
import Animated, { FadeIn, FadeInDown, FadeInUp } from 'react-native-reanimated'
import { useAuth } from '@/lib/auth'
import { ApiError, API_URL } from '@/lib/api'
import { Aurora } from '@/components/Aurora'
import { Logo } from '@/components/Logo'
import { Tappable, DURATION } from '@/components/motion'

/**
 * The first thing anyone sees.
 *
 * Held dark whatever the phone's theme, because the drifting colour behind it
 * only works on a dark ground — so the text here is written in explicit light
 * values rather than the theme's, which would go black on the light setting and
 * disappear.
 *
 * The screen assembles itself top to bottom in the order it is read: the mark,
 * then the name, then what it wants from you. Each step waits for the one
 * before it, which is what makes it feel deliberate rather than merely quick.
 */

const INK = '#e6edf5'
const MUTED = '#8aa0b8'

/** Glass, so the form reads as sitting above the colour rather than punched
 *  out of it. */
const FIELD = {
  backgroundColor: 'rgba(255,255,255,0.06)',
  borderColor: 'rgba(255,255,255,0.14)',
  borderWidth: 1,
}

export default function Login() {
  const { signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [focused, setFocused] = useState<string | null>(null)

  async function submit() {
    if (!email.trim() || !password) {
      setError('Enter your email and password.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await signIn(email, password)
      // The guard in _layout.tsx sees the new user and moves on.
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in. Try again in a moment.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <View className="flex-1" style={{ backgroundColor: '#0a0f1a' }}>
      <StatusBar style="light" />
      <Aurora />

      <SafeAreaView className="flex-1">
        <KeyboardAvoidingView
          className="flex-1"
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView
            contentContainerClassName="flex-grow justify-center px-6 py-10"
            keyboardShouldPersistTaps="handled"
          >
            <Animated.View
              entering={FadeIn.duration(700)}
              className="mb-12 items-center"
            >
              <Animated.View
                entering={FadeInDown.duration(700).springify().damping(16)}
                className="h-20 w-20 items-center justify-center rounded-3xl"
                style={{
                  backgroundColor: 'rgba(20,184,166,0.12)',
                  borderWidth: 1,
                  borderColor: 'rgba(20,184,166,0.35)',
                }}
              >
                <Logo size={48} />
              </Animated.View>

              <Animated.Text
                entering={FadeInDown.delay(160).duration(DURATION)}
                className="mt-5 text-3xl font-bold"
                style={{ color: INK, letterSpacing: -0.5 }}
              >
                LD ERP
              </Animated.Text>

              <Animated.Text
                entering={FadeInDown.delay(240).duration(DURATION)}
                className="mt-1 text-sm"
                style={{ color: MUTED }}
              >
                LD Cotton Mills · Bhiwandi
              </Animated.Text>
            </Animated.View>

            {error ? (
              <Animated.View
                entering={FadeIn.duration(240)}
                className="mb-5 flex-row items-start gap-2 rounded-xl p-3"
                style={{
                  backgroundColor: 'rgba(239,68,68,0.12)',
                  borderWidth: 1,
                  borderColor: 'rgba(239,68,68,0.35)',
                }}
              >
                <AlertCircle size={16} color="#fca5a5" />
                <Text className="flex-1 text-sm" style={{ color: '#fca5a5' }}>
                  {error}
                </Text>
              </Animated.View>
            ) : null}

            <Animated.View entering={FadeInUp.delay(340).duration(DURATION)}>
              <Text className="mb-2 text-xs font-medium" style={{ color: MUTED }}>
                EMAIL
              </Text>
              <Animated.View
                className="rounded-xl"
                style={[
                  FIELD,
                  focused === 'email' ? { borderColor: 'rgba(20,184,166,0.7)' } : null,
                ]}
              >
                <Field
                  value={email}
                  onChangeText={setEmail}
                  placeholder="you@ldcottonmills.com"
                  autoCapitalize="none"
                  autoComplete="email"
                  keyboardType="email-address"
                  editable={!busy}
                  onFocus={() => setFocused('email')}
                  onBlur={() => setFocused(null)}
                />
              </Animated.View>
            </Animated.View>

            <Animated.View entering={FadeInUp.delay(420).duration(DURATION)} className="mt-5">
              <Text className="mb-2 text-xs font-medium" style={{ color: MUTED }}>
                PASSWORD
              </Text>
              <Animated.View
                className="rounded-xl"
                style={[
                  FIELD,
                  focused === 'password' ? { borderColor: 'rgba(20,184,166,0.7)' } : null,
                ]}
              >
                <Field
                  value={password}
                  onChangeText={setPassword}
                  placeholder="Your password"
                  secureTextEntry
                  autoCapitalize="none"
                  editable={!busy}
                  onFocus={() => setFocused('password')}
                  onBlur={() => setFocused(null)}
                  onSubmitEditing={submit}
                  returnKeyType="go"
                />
              </Animated.View>
            </Animated.View>

            <Animated.View entering={FadeInUp.delay(520).duration(DURATION)} className="mt-8">
              <Tappable onPress={submit} disabled={busy}>
                <View
                  className="min-h-[54px] flex-row items-center justify-center gap-2 rounded-xl"
                  style={{
                    backgroundColor: busy ? 'rgba(20,184,166,0.6)' : '#14b8a6',
                    shadowColor: '#14b8a6',
                    shadowOffset: { width: 0, height: 6 },
                    shadowOpacity: 0.35,
                    shadowRadius: 16,
                    elevation: 6,
                  }}
                >
                  {busy ? <ActivityIndicator size="small" color="#04231f" /> : null}
                  <Text className="text-base font-bold" style={{ color: '#04231f' }}>
                    {busy ? 'Signing in' : 'Sign in'}
                  </Text>
                  {!busy ? <ArrowRight size={18} color="#04231f" /> : null}
                </View>
              </Tappable>
            </Animated.View>

            {/* Which server this build talks to — invaluable the first time
                somebody asks why the phone shows different figures. */}
            <Animated.Text
              entering={FadeIn.delay(900).duration(600)}
              className="mt-10 text-center text-xs"
              style={{ color: 'rgba(138,160,184,0.6)' }}
            >
              {API_URL.replace(/^https?:\/\//, '').replace(/\/api$/, '')}
            </Animated.Text>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  )
}

/** The input itself, kept plain so the glass wrapper above owns the look. */
function Field(props: React.ComponentProps<typeof TextInput>) {
  return (
    <TextInput
      {...props}
      placeholderTextColor="rgba(138,160,184,0.55)"
      style={{
        minHeight: 52,
        paddingHorizontal: 16,
        fontSize: 16,
        color: INK,
      }}
    />
  )
}
