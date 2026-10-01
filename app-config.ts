/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  CENTRAL APP BRANDING HELPER
 *  Reads settings from `app-config.json` (the single configuration file).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import branding from './app-config.json';

export const APP_NAME = branding.appName || 'ShakTranslate';

const rawPrefix = branding.appNamePrefix !== undefined ? branding.appNamePrefix : APP_NAME;
const rawSuffix = branding.appNameSuffix !== undefined ? branding.appNameSuffix : '';

/**
 * Optional two-part branding for the logo:
 * e.g., "IIGF " in white + "Translate" in emerald green.
 */
export const APP_NAME_PREFIX =
  rawPrefix && rawSuffix && APP_NAME.trim() === `${rawPrefix} ${rawSuffix}` && !rawPrefix.endsWith(' ') && !rawSuffix.startsWith(' ')
    ? `${rawPrefix} `
    : rawPrefix;
export const APP_NAME_SUFFIX = rawSuffix;

/** Lower-case, no-spaces variant — used as the deep-link scheme and service slug */
export const APP_NAME_LOWER = (branding.appName.toLowerCase().replace(/[^a-z0-9]/gi, ''));

/** Reverse-DNS identifier used as iOS bundleIdentifier and Android package */
export const APP_BUNDLE_ID = `com.cis.${APP_NAME_LOWER}`;

/**
 * App icon / logo image path string.
 */
export const APP_LOGO_IMAGE: string = (branding as any).logoImage || (branding as any).logo || './assets/IMG_8753.JPG.jpeg';

/**
 * Splash / opening screen image path string.
 */
export const APP_SPLASH_IMAGE: string = (branding as any).openingScreenImage || (branding as any).openingScreen || (branding as any).splashImage || './assets/IMG_8759.JPG.jpeg';

/**
 * Image require resolution for React Native bundling.
 * Maps configured path strings to bundled assets.
 */
const ASSETS_MAP: Record<string, any> = {
  './assets/IMG_8753.JPG.jpeg': require('./assets/logo-cropped.png'),
  './assets/IMG_8759.JPG.jpeg': require('./assets/IMG_8759.JPG.jpeg'),
  './assets/logo.png': require('./assets/logo-cropped.png'),
  './assets/logo.jpeg': require('./assets/logo-cropped.png'),
  './assets/logo-cropped.png': require('./assets/logo-cropped.png'),
  './assets/splash.jpeg': require('./assets/IMG_8759.JPG.jpeg'),
  './assets/splash.png': require('./assets/IMG_8759.JPG.jpeg'),
  './assets/icon.png': require('./assets/icon.png'),
  './assets/splash-icon.png': require('./assets/splash-icon.png'),
};

export const APP_LOGO = ASSETS_MAP[APP_LOGO_IMAGE] || require('./assets/logo-cropped.png');
export const APP_OPENING_SCREEN = ASSETS_MAP[APP_SPLASH_IMAGE] || require('./assets/IMG_8759.JPG.jpeg');
