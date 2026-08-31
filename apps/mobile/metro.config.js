// Metro, taught about the workspace.
//
// The default config assumes an app sitting on its own with one node_modules
// beside it. Two things have to be said out loud here: which folders to watch,
// so an edit in packages/shared reaches the phone; and where packages live,
// since in a workspace they are installed at the root rather than next to the
// app.
//
// Note the repo installs with a flat node_modules — see the .npmrc at the root.
// Metro resolves the entry point from the workspace root and cannot follow
// pnpm's default nested layout, so without that the app does not bundle at all.

const { getDefaultConfig } = require('expo/metro-config')
const { withNativeWind } = require('nativewind/metro')
const path = require('path')

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, '../..')

const config = getDefaultConfig(projectRoot)

// Watch the whole workspace, so editing packages/shared reloads the app.
config.watchFolders = [workspaceRoot]

// The app's own node_modules first, then the root — that is where the flat
// install actually puts almost everything.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
]

module.exports = withNativeWind(config, { input: './global.css' })
