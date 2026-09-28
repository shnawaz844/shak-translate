/**
 * Backend App Branding Configuration
 * ────────────────────────────────────
 * Keep this in sync with the root `app-config.ts` (frontend).
 * Changing APP_NAME here renames all backend log / service references.
 *
 * NOTE: The root app-config.ts is the PRIMARY source of truth.
 *       Update BOTH files when renaming the app.
 */

const fs = require('fs');
const path = require('path');

let configName = 'ShakTranslate';
try {
  const jsonPath = path.resolve(__dirname, '../app-config.json');
  if (fs.existsSync(jsonPath)) {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    if (data && data.appName) configName = data.appName;
  }
} catch (e) {
  // Use fallback if file is unreadable or not found
}

const APP_NAME = process.env.APP_NAME || configName;
const APP_NAME_LOWER = APP_NAME.toLowerCase().replace(/\s+/g, '');

module.exports = { APP_NAME, APP_NAME_LOWER };
