const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Help Metro handle .loro binary snapshots if ever bundled.
config.resolver.assetExts.push('loro');

module.exports = config;
