import { useEffect } from 'react'
import { Text, View } from 'react-native'
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
  withSpring,
  Easing,
  useReducedMotion,
  runOnJS,
} from 'react-native-reanimated'
import { Aurora } from './Aurora'
import { Logo } from './Logo'

/**
 * The moment between opening the app and using it.
 *
 * A cold start has to wait for the stored session to be read back anyway, and
 * that wait is otherwise a blank screen or a spinner. This puts the mill's own
 * mark in it and greets whoever is holding the phone.
 *
 * It is deliberately short. A splash that outstays the work it is covering is
 * an obstacle, not a welcome — so it holds for a beat and leaves, and it gets
 * out of the way immediately for anyone who has asked for reduced motion.
 */

const HOLD_MS = 1500

function greeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

export function Welcome({ name, onDone }: { name?: string | null; onDone: () => void }) {
  const reduced = useReducedMotion()

  const scale = useSharedValue(reduced ? 1 : 0.7)
  const ringScale = useSharedValue(1)
  const ringOpacity = useSharedValue(0)

  useEffect(() => {
    if (reduced) {
      const t = setTimeout(onDone, 300)
      return () => clearTimeout(t)
    }

    // The mark arrives with a little weight behind it rather than fading up.
    scale.value = withSpring(1, { damping: 12, stiffness: 140 })

    // One ring travelling outward — a pulse, not a throbbing loop, which would
    // read as "still loading" and make the wait feel longer than it is.
    ringOpacity.value = withDelay(
      220,
      withSequence(
        withTiming(0.5, { duration: 200 }),
        withTiming(0, { duration: 900, easing: Easing.out(Easing.quad) }),
      ),
    )
    ringScale.value = withDelay(
      220,
      withTiming(2.4, { duration: 1100, easing: Easing.out(Easing.quad) }),
    )

    const t = setTimeout(onDone, HOLD_MS)
    return () => clearTimeout(t)
  }, [reduced, onDone, scale, ringOpacity, ringScale])

  const markStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }))
  const ringStyle = useAnimatedStyle(() => ({
    opacity: ringOpacity.value,
    transform: [{ scale: ringScale.value }],
  }))

  return (
    <Animated.View
      exiting={FadeOut.duration(420)}
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 50 }}
    >
      <Aurora />

      <View className="flex-1 items-center justify-center">
        <View className="items-center justify-center">
          {/* Sits behind the badge and expands past it. pointerEvents none so a
              tap during the pulse still reaches whatever is underneath. */}
          <Animated.View
            pointerEvents="none"
            style={[
              {
                position: 'absolute',
                height: 88,
                width: 88,
                borderRadius: 44,
                borderWidth: 1.5,
                borderColor: 'rgba(20,184,166,0.55)',
              },
              ringStyle,
            ]}
          />

          <Animated.View
            style={[
              {
                height: 88,
                width: 88,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 28,
                backgroundColor: 'rgba(20,184,166,0.12)',
                borderWidth: 1,
                borderColor: 'rgba(20,184,166,0.35)',
              },
              markStyle,
            ]}
          >
            <Logo size={52} />
          </Animated.View>
        </View>

        <Animated.Text
          entering={FadeIn.delay(320).duration(520)}
          className="mt-8 text-sm"
          style={{ color: '#8aa0b8' }}
        >
          {greeting()}
        </Animated.Text>

        <Animated.Text
          entering={FadeIn.delay(440).duration(520)}
          className="mt-1 text-2xl font-bold"
          style={{ color: '#e6edf5' }}
        >
          {name?.split(' ')[0] ?? 'Welcome'}
        </Animated.Text>

        <Animated.Text
          entering={FadeIn.delay(700).duration(520)}
          className="mt-6 text-xs"
          style={{ color: 'rgba(138,160,184,0.7)' }}
        >
          LD ERP · LD Cotton Mills
        </Animated.Text>
      </View>
    </Animated.View>
  )
}
