import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.perfectrest.app',
  appName: 'PerfectRest',
  webDir: 'dist',
  android: {
    // Evita el fondo blanco al arrancar antes de que pinte la web.
    backgroundColor: '#090D1A',
  },
  plugins: {
    LocalNotifications: {
      smallIcon: 'ic_stat_icon',
      iconColor: '#8E7BFF',
    },
  },
};

export default config;
