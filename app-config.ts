/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  CENTRAL APP BRANDING HELPER
 *  Reads settings from `app-config.json` (the single configuration file).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import branding from './app-config.json';

export const APP_NAME = branding.appName || 'ShakTranslate';

/**
 * Optional two-part branding for the logo:
 * e.g., "Shak" in white + "Translate" in emerald green.
 */
export const APP_NAME_PREFIX = branding.appNamePrefix !== undefined ? branding.appNamePrefix : APP_NAME;
export const APP_NAME_SUFFIX = branding.appNameSuffix !== undefined ? branding.appNameSuffix : '';

/** Lower-case, no-spaces variant — used as the deep-link scheme and service slug */
export const APP_NAME_LOWER = (branding.appName.toLowerCase().replace(/[^a-z0-9]/gi, ''));

/** Reverse-DNS identifier used as iOS bundleIdentifier and Android package */
export const APP_BUNDLE_ID = `com.cis.${APP_NAME_LOWER}`;
