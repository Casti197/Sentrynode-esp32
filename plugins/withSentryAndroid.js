/**
 * Config plugin de SentryNode (Android).
 *
 * Expo genera la carpeta android/ en cada build (Continuous Native Generation),
 * así que los cambios al AndroidManifest se hacen aquí y no a mano:
 *
 *  1. Declara el servicio de react-native-background-actions con
 *     foregroundServiceType="connectedDevice". Desde Android 14 un Foreground
 *     Service sin tipo declarado lanza MissingForegroundServiceTypeException.
 *  2. Permite HTTP sin cifrar (cleartext): el ESP32 sirve http:// en la red
 *     local y Android lo bloquea por defecto en builds de release.
 */
const { withAndroidManifest, AndroidConfig } = require('expo/config-plugins');

const SERVICE_NAME = 'com.asterinet.react.bgactions.RNBackgroundActionsTask';

module.exports = function withSentryAndroid(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults;
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);

    app.$['android:usesCleartextTraffic'] = 'true';

    app.service = app.service ?? [];
    let service = app.service.find((s) => s.$['android:name'] === SERVICE_NAME);
    if (!service) {
      service = { $: { 'android:name': SERVICE_NAME } };
      app.service.push(service);
    }
    service.$['android:foregroundServiceType'] = 'connectedDevice';
    service.$['android:exported'] = 'false';
    return cfg;
  });
};
