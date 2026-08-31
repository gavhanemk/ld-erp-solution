import Svg, { Path, G } from 'react-native-svg'

/**
 * The LD mark.
 *
 * The same outlines the app icon is cut from — tools/make-app-icons.js draws
 * that from these very paths — so the badge on the sign-in screen and the icon
 * on the home screen are the same shape rather than two drawings that happen to
 * resemble each other.
 */

const L_PATH = 'M250 300 H340 V624 H520 V714 H250 Z'
const D_PATH =
  'M560 300 H700 C820 300 890 380 890 507 C890 634 820 714 700 714 H560 Z ' +
  'M650 390 V624 H700 C770 624 800 570 800 507 C800 444 770 390 700 390 Z'

export function Logo({ size = 64, colour = '#14b8a6' }: { size?: number; colour?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 1024 1024">
      {/* Centres the letters, whose own bounding box sits right of the canvas
          middle. The same nudge the icon script applies. */}
      <G transform="translate(-58,5)">
        <Path d={L_PATH} fill={colour} />
        <Path d={D_PATH} fill={colour} fillRule="evenodd" />
      </G>
    </Svg>
  )
}
