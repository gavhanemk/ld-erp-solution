/**
 * Draws the phone app's icons.
 *
 * The scaffold ships Expo's own artwork, which tells a person nothing about
 * whose app is on their phone. The mark is an LD monogram drawn as paths rather
 * than text, because the renderer here has no guarantee of any particular font
 * and a missing font produces a blank square.
 *
 * Run from the repo root:  node tools/make-app-icons.js
 * Only needed when the mark changes; the output is committed.
 */

const fs = require('fs')
const path = require('path')
const sharp = require('sharp')

const OUT = path.join(__dirname, '..', 'apps', 'mobile', 'assets')

// Straight from the design system: the app background and the primary teal.
const NAVY = '#0a0f1a'
const TEAL = '#14b8a6'

/**
 * The letters, as outlines in a 1024 box.
 *
 * L is a bar and a foot. D is a bar and a bowl, with the counter cut out by the
 * even-odd rule rather than by drawing a second shape in the background colour
 * — which would show as a seam anywhere the icon is masked onto a coloured
 * ground, as Android does.
 */
const L_PATH = 'M250 300 H340 V624 H520 V714 H250 Z'
const D_PATH =
  'M560 300 H700 C820 300 890 380 890 507 C890 634 820 714 700 714 H560 Z ' +
  'M650 390 V624 H700 C770 624 800 570 800 507 C800 444 770 390 700 390 Z'

/**
 * The two letters together span x 250-890 and y 300-714, which puts their
 * centre at 570,507 rather than the canvas centre of 512,512. Left uncorrected
 * the mark sits visibly right of middle — obvious once the icon is masked into
 * a circle. This nudge centres it.
 */
const mark = (fill) =>
  `<g transform="translate(-58,5)">` +
  `<path d="${L_PATH}" fill="${fill}"/>` +
  `<path d="${D_PATH}" fill="${fill}" fill-rule="evenodd"/>` +
  `</g>`

/** The full icon: mark on the app's own background. */
const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" fill="${NAVY}"/>
  <circle cx="512" cy="512" r="470" fill="${TEAL}" opacity="0.07"/>
  ${mark(TEAL)}
</svg>`

/**
 * Android masks the foreground to whatever shape the phone uses — circle,
 * squircle, teardrop — so the mark is scaled to two thirds and centred to keep
 * it inside the safe area whichever shape is applied.
 */
const foreground = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <g transform="translate(171,171) scale(0.667)">${mark(TEAL)}</g>
</svg>`

const background = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
  <rect width="1024" height="1024" fill="${NAVY}"/>
</svg>`

/** Themed icons are tinted by the launcher, so this one is a flat silhouette. */
const monochrome = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <g transform="translate(171,171) scale(0.667)">${mark('#ffffff')}</g>
</svg>`

/** The splash sits on the colour named in app.json, so it stays transparent. */
const splash = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <g transform="translate(205,205) scale(0.6)">${mark(TEAL)}</g>
</svg>`

const files = [
  ['icon.png', icon, 1024],
  ['android-icon-foreground.png', foreground, 1024],
  ['android-icon-background.png', background, 1024],
  ['android-icon-monochrome.png', monochrome, 1024],
  ['splash-icon.png', splash, 1024],
  ['favicon.png', icon, 48],
]

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  for (const [name, svg, size] of files) {
    await sharp(Buffer.from(svg)).resize(size, size).png().toFile(path.join(OUT, name))
    console.log('  wrote', name, size + 'px')
  }
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
