// The NativeWind preset is what turns className on a React Native view into a
// real style. Reanimated's plugin has to stay last — it rewrites function
// bodies, and anything running after it would be rewriting rewritten code.

module.exports = function (api) {
  api.cache(true)
  return {
    presets: [
      ['babel-preset-expo', { jsxImportSource: 'nativewind' }],
      'nativewind/babel',
    ],
    plugins: ['react-native-worklets/plugin'],
  }
}
