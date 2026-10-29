// The example uses the library straight from the repo root (`file:..`), so
// Metro must watch the root, and must not pick up the root's own
// node_modules (a second copy of react / react-native) or its build output.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const root = path.resolve(__dirname, '..');
const escape = p => p.replace(/[/\\^$.*+?()[\]{}|]/g, '\\$&');

const config = getDefaultConfig(__dirname);

config.watchFolders = [root];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')];
config.resolver.blockList = [
  new RegExp(`^${escape(path.join(root, 'node_modules'))}[/\\\\].*`),
  new RegExp(`^${escape(path.join(root, 'lib'))}[/\\\\].*`),
];

module.exports = config;
