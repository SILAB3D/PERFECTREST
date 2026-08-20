package com.perfectrest.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

/**
 * Devuelve la monitorización a la vida.
 *
 * Atiende dos casos: el reinicio del dispositivo, y la alarma de vigilancia
 * que el propio servicio programa para rearmarse si Android lo mata o el
 * usuario desliza la app fuera de recientes. Sin esto, la detección se apagaba
 * en silencio y sólo volvía a haber datos al abrir la app.
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        boolean known = Intent.ACTION_BOOT_COMPLETED.equals(action)
            || Intent.ACTION_LOCKED_BOOT_COMPLETED.equals(action)
            || SleepMonitorService.ACTION_RESTART.equals(action);
        if (!known) return;

        SharedPreferences prefs =
            context.getSharedPreferences(SleepMonitorService.PREFS, Context.MODE_PRIVATE);
        // Sólo se reanuda si el usuario lo tenía activado.
        if (!prefs.getBoolean(SleepMonitorService.KEY_ENABLED, false)) return;

        Intent service = new Intent(context, SleepMonitorService.class);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(service);
            } else {
                context.startService(service);
            }
        } catch (Exception e) {
            // Android 12+ puede rechazar el arranque desde segundo plano si la
            // app no está en la lista blanca de batería. No hay nada que hacer
            // aquí, pero se reintenta en el siguiente ciclo de la alarma.
            SleepMonitorService.scheduleWatchdog(context);
        }
    }
}
