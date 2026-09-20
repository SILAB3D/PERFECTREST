package com.perfectrest.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

/**
 * Devuelve la monitorización a la vida.
 *
 * Atiende tres casos:
 *
 *   1. El reinicio del dispositivo.
 *   2. La alarma de vigilancia que el propio servicio programa para rearmarse
 *      si Android lo mata o el usuario desliza la app fuera de recientes.
 *   3. La reinstalación de la propia app.
 *
 * El tercero no es un detalle. PerfectRest se actualiza sola con cada push a
 * main, y al instalar una versión nueva Android detiene la app por completo:
 * mata el servicio y cancela todas sus alarmas, incluida la de vigilancia. Sin
 * atender MY_PACKAGE_REPLACED, cada actualización dejaba la detección apagada
 * hasta que el usuario volviera a abrir la app por su cuenta —y como no hay
 * nada visible que falle, podían pasar semanas.
 */
public class BootReceiver extends BroadcastReceiver {

    /** Algunas ROMs (HTC, ciertas Xiaomi) emiten esto en vez de BOOT_COMPLETED. */
    private static final String QUICKBOOT = "android.intent.action.QUICKBOOT_POWERON";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        boolean known = Intent.ACTION_BOOT_COMPLETED.equals(action)
            || Intent.ACTION_LOCKED_BOOT_COMPLETED.equals(action)
            || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
            || QUICKBOOT.equals(action)
            || SleepMonitorService.ACTION_RESTART.equals(action);
        if (!known) return;

        SharedPreferences prefs =
            context.getSharedPreferences(SleepMonitorService.PREFS, Context.MODE_PRIVATE);
        // Sólo se reanuda si el usuario lo tenía activado.
        if (!prefs.getBoolean(SleepMonitorService.KEY_ENABLED, false)) return;

        // Se anota antes de intentarlo: si el arranque falla, en el registro
        // queda el intento seguido del error, que es lo que permite ver que la
        // alarma sí disparaba y lo que fallaba era arrancar.
        SleepMonitorService.logEvent(context, null, "service", "rearme (" + shortName(action) + ")");

        Intent service = new Intent(context, SleepMonitorService.class);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(service);
            } else {
                context.startService(service);
            }
        } catch (Exception e) {
            // Android 12+ puede rechazar el arranque desde segundo plano si la
            // app no está en la lista blanca de batería. Se anota para que
            // Ajustes lo explique, y se reintenta en el siguiente ciclo.
            String message = "Android no dejó rearrancar el servicio en segundo plano. "
                + "Desactiva la optimización de batería para PerfectRest.";
            prefs.edit().putString(SleepMonitorService.KEY_LAST_ERROR, message).apply();
            SleepMonitorService.logEvent(context, null, "error", message);
        }
        // La alarma se reprograma pase lo que pase: tras una reinstalación no
        // queda ninguna pendiente, y si el arranque falló hay que reintentarlo.
        SleepMonitorService.scheduleWatchdog(context);
    }

    /** Nombre corto de la causa del rearme, para que la línea del registro se lea. */
    private static String shortName(String action) {
        if (SleepMonitorService.ACTION_RESTART.equals(action)) return "vigilante";
        if (Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) return "actualización";
        return "arranque del móvil";
    }
}
