import * as dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Read env vars at native config-build time (matches the iOS Generated/
// pattern: env -> build constant).
dotenv.config();

const envPath = resolve(__dirname, '.env');
let edgeURL = process.env.COMET_EDGE_URL;
let workosClientId = process.env.COMET_WORKOS_CLIENT_ID;

if (!edgeURL || !workosClientId) {
  try {
    const text = readFileSync(envPath, 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
      if (!m) continue;
      if (m[1] === 'COMET_EDGE_URL' && !edgeURL) edgeURL = m[2];
      if (m[1] === 'COMET_WORKOS_CLIENT_ID' && !workosClientId) workosClientId = m[2];
    }
  } catch {
    // .env optional — defaults are baked below.
  }
}

export default {
  expo: {
    name: 'AgentDeski',
    slug: 'agentdeski',
    owner: 'namcyeon',
    version: '0.0.5',
    orientation: 'default',
    icon: './assets/icon.png',
    scheme: 'agentdeski',
    userInterfaceStyle: 'automatic',
    splash: {
      backgroundColor: '#060606',
      resizeMode: 'contain',
      image: './assets/splash.png',
    },
    ios: {
      supportsTablet: true,
      bundleIdentifier: 'com.npdev.agentdeski',
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
        UISupportedInterfaceOrientations: [
          'UIInterfaceOrientationPortrait',
          'UIInterfaceOrientationLandscapeLeft',
          'UIInterfaceOrientationLandscapeRight',
        ],
        NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
      },
    },
    android: {
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-icon.png',
        backgroundColor: '#060606',
      },
      package: 'com.npdev.agentdeski',
    },
    plugins: ['expo-font', 'expo-notifications', 'expo-updates', 'expo-dev-client'],
    updates: {
      url: 'https://u.expo.dev/83b80ffb-ca4f-4bac-b5f5-a6ad54a4d634',
    },
    runtimeVersion: {
      policy: 'appVersion',
    },
    extra: {
      edgeURL,
      workosClientId,
      eas: {
        projectId: '83b80ffb-ca4f-4bac-b5f5-a6ad54a4d634',
      },
    },
  },
};
