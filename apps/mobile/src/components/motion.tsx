import { useEffect, useRef, useState } from 'react'
import { Pressable, Text, View, type ViewStyle } from 'react-native'
import Animated, {
  FadeIn,
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  useReducedMotion,
} from 'react-native-reanimated'

/**
 * The app's movement, in one place.
 *
 * Motion here is meant to explain, not to entertain: things enter from the
 * direction they belong, a figure counts up so the eye follows it landing, a
 * button gives way slightly under a thumb. Nothing bounces for its own sake.
 *
 * Every piece checks whether the phone has been told to reduce motion. That
 * setting is switched on by people who get motion sickness from animation, and
 * ignoring it does real harm — so when it is on, everything below appears
 * instantly and finally rather than not at all.
 */

/** Slow enough to read as deliberate, fast enough not to be waited on. */
export const DURATION = 420
const STAGGER = 70

/**
 * One item appearing, slightly after the one before it.
 *
 * `index` does the staggering: passing 0, 1, 2 down a list makes the screen
 * assemble top to bottom, which is the order it is read in.
 */
export function Reveal({
  children,
  index = 0,
  from = 'bottom',
  style,
}: {
  children: React.ReactNode
  index?: number
  from?: 'bottom' | 'fade'
  style?: ViewStyle
}) {
  const reduced = useReducedMotion()

  if (reduced) return <View style={style}>{children}</View>

  const entering =
    from === 'fade'
      ? FadeIn.delay(index * STAGGER).duration(DURATION)
      : FadeInDown.delay(index * STAGGER)
          .duration(DURATION)
          .springify()
          .damping(18)

  return (
    <Animated.View entering={entering} style={style}>
      {children}
    </Animated.View>
  )
}

/**
 * A number that counts up to its value.
 *
 * Driven from JavaScript rather than the animation thread because the thing
 * being animated is the text itself, which has to be re-formatted on every
 * frame — Indian digit grouping and all. It runs for well under a second on a
 * handful of figures, which is what this is for; it is not for a list.
 */
export function CountUp({
  value,
  format,
  className,
  style,
  duration = 900,
}: {
  value: number
  format: (n: number) => string
  className?: string
  style?: object
  duration?: number
}) {
  const reduced = useReducedMotion()
  const [shown, setShown] = useState(reduced ? value : 0)
  const frame = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (reduced) {
      setShown(value)
      return
    }

    const start = Date.now()
    const from = 0

    const tick = () => {
      const t = Math.min(1, (Date.now() - start) / duration)
      // Ease out: fast at first, settling at the end, so the eye catches the
      // final figure rather than a blur.
      const eased = 1 - Math.pow(1 - t, 3)
      setShown(from + (value - from) * eased)
      if (t < 1) frame.current = requestAnimationFrame(tick)
      else setShown(value)
    }

    frame.current = requestAnimationFrame(tick)
    return () => {
      if (frame.current) cancelAnimationFrame(frame.current)
    }
  }, [value, duration, reduced])

  return (
    <Text className={className} style={style}>
      {format(shown)}
    </Text>
  )
}

/**
 * A pressable that gives way under a thumb.
 *
 * On a phone there is no cursor and no hover, so the only confirmation that a
 * tap registered is the thing moving. Without it people tap twice.
 */
export function Tappable({
  children,
  onPress,
  className,
  style,
  disabled,
}: {
  children: React.ReactNode
  onPress: () => void
  className?: string
  style?: ViewStyle
  disabled?: boolean
}) {
  const scale = useSharedValue(1)
  const reduced = useReducedMotion()

  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }))

  return (
    <Animated.View style={[animated, style]}>
      <Pressable
        onPress={onPress}
        disabled={disabled}
        onPressIn={() => {
          if (!reduced) scale.value = withSpring(0.97, { damping: 20, stiffness: 400 })
        }}
        onPressOut={() => {
          if (!reduced) scale.value = withSpring(1, { damping: 20, stiffness: 400 })
        }}
        className={className}
      >
        {children}
      </Pressable>
    </Animated.View>
  )
}

/**
 * Eases from 0 to 1 once, for anything that draws itself in — a line growing
 * up out of its baseline, a bar running out from zero.
 *
 * A plain number rather than a shared value, because what it drives is an SVG
 * path rebuilt from the data on each frame, and that has to happen where the
 * data lives.
 */
export function useDrawInValue(delay = 0, duration = 900) {
  const reduced = useReducedMotion()
  const [t, setT] = useState(reduced ? 1 : 0)
  const frame = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (reduced) {
      setT(1)
      return
    }
    const start = Date.now() + delay
    const tick = () => {
      const elapsed = Date.now() - start
      if (elapsed < 0) {
        frame.current = requestAnimationFrame(tick)
        return
      }
      const p = Math.min(1, elapsed / duration)
      setT(1 - Math.pow(1 - p, 3))
      if (p < 1) frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
    return () => {
      if (frame.current) cancelAnimationFrame(frame.current)
    }
  }, [delay, duration, reduced])

  return t
}
