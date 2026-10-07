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

  // ── Image branding ────────────────────────────────────────────────────────
  // Change `logoImage` / `openingScreenImage` in app-config.json to swap assets in one go.
  const logoImage = branding.logoImage || branding.logo || './assets/icon.png';
  const splashImage = branding.openingScreenImage || branding.openingScreen || branding.splashImage || './assets/splash-icon.png';

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
      // Apply splashImage from branding config to expo-splash-screen plugin
      if (name === 'expo-splash-screen' && opts) {
        return [
          name,
          {
            ...opts,
            image: splashImage,
            resizeMode: 'cover',
            backgroundColor: '#182527',
          },
        ];
      }
    }
    return plugin;
  });

  return {
    ...config,
    name: appName,
    // Apply logo from branding to the top-level icon
    icon: fs.existsSync(path.resolve(__dirname, 'assets/icon.png'))
      ? './assets/icon.png'
      : logoImage,
    scheme: scheme,
    ios: {
      ...config.ios,
      bundleIdentifier: bundleId,
    },
    android: {
      ...config.android,
      package: bundleId,
      // Apply dark background & adaptive icon foreground
      adaptiveIcon: {
        ...(config.android && config.android.adaptiveIcon),
        backgroundColor: '#182527',
        foregroundImage: fs.existsSync(path.resolve(__dirname, 'assets/android-icon-foreground.png'))
          ? './assets/android-icon-foreground.png'
          : logoImage,
        backgroundImage: './assets/android-icon-background.png',
      },
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
