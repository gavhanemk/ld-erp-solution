import { useEffect } from 'react'
import { useWindowDimensions, View } from 'react-native'
import Svg, { Circle, Defs, RadialGradient, Stop, Rect } from 'react-native-svg'
import Animated, {
  useSharedValue,
  useAnimatedProps,
  withRepeat,
  withTiming,
  Easing,
  useReducedMotion,
} from 'react-native-reanimated'

const AnimatedCircle = Animated.createAnimatedComponent(Circle)

/**
 * The slow colour behind the sign-in screen.
 *
 * Three soft lights drifting over the app's own navy. They are radial
 * gradients rather than circles with a low opacity, because a circle at 25%
 * still reads as a circle — the falloff is the whole effect.
 *
 * A looping background is the kind of thing that quietly eats a battery, so
 * this is deliberately cheap: three shapes, no blur, positions driven on the
 * animation thread so the JavaScript side does nothing per frame. It also stops
 * entirely when the phone asks for reduced motion, which leaves a still image
 * that looks the same.
 */

interface Light {
  colour: string
  r: number
  from: { x: number; y: number }
  to: { x: number; y: number }
  seconds: number
  opacity: number
}

export function Aurora({ children }: { children?: React.ReactNode }) {
  const { width, height } = useWindowDimensions()
  const reduced = useReducedMotion()

  // Positions as fractions of the screen, so it composes the same on a small
  // phone and a tablet.
  const lights: Light[] = [
    {
      colour: '#14b8a6',
      r: width * 0.72,
      from: { x: 0.12, y: 0.16 },
      to: { x: 0.46, y: 0.3 },
      seconds: 14,
      opacity: 0.5,
    },
    {
      colour: '#0d9488',
      r: width * 0.62,
      from: { x: 0.9, y: 0.32 },
      to: { x: 0.62, y: 0.12 },
      seconds: 18,
      opacity: 0.42,
    },
    {
      colour: '#f59e0b',
      r: width * 0.5,
      from: { x: 0.78, y: 0.82 },
      to: { x: 0.3, y: 0.92 },
      seconds: 22,
      opacity: 0.22,
    },
  ]

  return (
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
      <Svg width={width} height={height}>
        <Defs>
          {lights.map((l, i) => (
            <RadialGradient key={i} id={`glow${i}`} cx="50%" cy="50%" r="50%">
              <Stop offset="0" stopColor={l.colour} stopOpacity={l.opacity} />
              <Stop offset="0.55" stopColor={l.colour} stopOpacity={l.opacity * 0.35} />
              <Stop offset="1" stopColor={l.colour} stopOpacity="0" />
            </RadialGradient>
          ))}
        </Defs>

        <Rect width={width} height={height} fill="#0a0f1a" />

        {lights.map((l, i) => (
          <DriftingLight
            key={i}
            light={l}
            width={width}
            height={height}
            gradient={`url(#glow${i})`}
            still={reduced}
          />
        ))}
      </Svg>

      {children}
    </View>
  )
}

function DriftingLight({
  light,
  width,
  height,
  gradient,
  still,
}: {
  light: Light
  width: number
  height: number
  gradient: string
  still: boolean
}) {
  // 0 at one end of the drift, 1 at the other, reversing forever.
  const t = useSharedValue(0)

  useEffect(() => {
    if (still) return
    t.value = withRepeat(
      withTiming(1, { duration: light.seconds * 1000, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    )
  }, [t, light.seconds, still])

  const props = useAnimatedProps(() => {
    const p = t.value
    return {
      cx: (light.from.x + (light.to.x - light.from.x) * p) * width,
      cy: (light.from.y + (light.to.y - light.from.y) * p) * height,
    }
  })

  return (
    <AnimatedCircle
      animatedProps={props}
      cx={light.from.x * width}
      cy={light.from.y * height}
      r={light.r}
      fill={gradient}
    />
  )
}
