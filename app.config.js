/**
 * Expo Dynamic App Configuration
 * ────────────────────────────────
 * Automatically applies branding from `app-config.json` to the base `app.json`.
 *
 * Any changes made in `app-config.json` (such as appName, appNamePrefix, etc.)
 * are instantly reflected in the Expo build, deep linking scheme, bundle IDs,
 * and native OS permission dialogs.
 */

const fs = require('fs');
const path = require('path');

module.exports = ({ config }) => {
  let branding = { appName: 'ShakTranslate' };
  try {
    const raw = fs.readFileSync(path.resolve(__dirname, 'app-config.json'), 'utf8');
    branding = JSON.parse(raw);
  } catch (e) {
    console.warn('[app.config.js] Could not read app-config.json, using defaults', e.message);
  }

  const appName = branding.appName || config.name || 'ShakTranslate';
  const scheme = (branding.scheme || appName.toLowerCase().replace(/[^a-z0-9]/gi, '')).toLowerCase();
  const bundleId = branding.bundleId || `com.cis.${scheme}`;

  const updatedPlugins = (config.plugins || []).map((plugin) => {
    if (Array.isArray(plugin)) {
      const [name, opts] = plugin;
      if (name === '@siteed/audio-studio' && opts && opts.iosConfig) {
        return [
          name,
          {
            ...opts,
            iosConfig: {
              ...opts.iosConfig,
              microphoneUsageDescription: `Allow ${appName} to access your microphone to record speech for translation.`,
            },
          },
        ];
      }
      if (name === 'expo-audio' && opts) {
        return [
          name,
          {
            ...opts,
            microphonePermission: `Allow ${appName} to access your microphone to record speech for translation.`,
          },
        ];
      }
      if (name === 'expo-camera' && opts) {
        return [
          name,
          {
            ...opts,
            cameraPermission: `Allow ${appName} to access your camera to scan QR codes for joining sessions.`,
          },
        ];
      }
      if (name === 'expo-image-picker' && opts) {
        return [
          name,
          {
            ...opts,
            photosPermission: `Allow ${appName} to access your photos to update your profile picture.`,
          },
        ];
      }
    }
    return plugin;
  });

  return {
    ...config,
    name: appName,
    scheme: scheme,
    ios: {
      ...config.ios,
      bundleIdentifier: bundleId,
    },
    android: {
      ...config.android,
      package: bundleId,
      intentFilters: [
        {
          action: 'VIEW',
          autoVerify: true,
          data: [{ scheme: scheme }],
          category: ['BROWSABLE', 'DEFAULT'],
        },
      ],
    },
    plugins: updatedPlugins,
  };
};
