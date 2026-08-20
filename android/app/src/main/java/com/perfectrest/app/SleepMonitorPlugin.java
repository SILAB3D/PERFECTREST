package com.perfectrest.app;

import android.app.ActivityManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.text.TextUtils;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Puente entre la capa web y {@link SleepMonitorService}.
 *
 * La web decide qué hacer con los datos; este plugin sólo arranca y para el
 * servicio, le dice qué disparadores debe escuchar y entrega los huecos de
 * inactividad registrados mientras la app estaba cerrada.
 */
@CapacitorPlugin(name = "SleepMonitor")
public class SleepMonitorPlugin extends Plugin {

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(SleepMonitorService.PREFS, Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void start(PluginCall call) {
        int minGap = call.getInt("minGapMinutes", 180);

        // Sin lista de disparadores se asume el de pantalla, que es el
        // comportamiento histórico del servicio.
        String triggers = SleepMonitorService.TRIGGER_SCREEN;
        JSArray raw = call.getArray("triggers");
        if (raw != null) {
            List<String> ids = new ArrayList<>();
            for (int i = 0; i < raw.length(); i++) {
                String id = raw.optString(i, null);
                if (id != null && !id.isEmpty()) ids.add(id);
            }
            // String.join es de API 26 y el mínimo soportado es menor.
            if (!ids.isEmpty()) triggers = TextUtils.join(",", ids);
        }

        prefs().edit()
            .putInt(SleepMonitorService.KEY_MIN_GAP, minGap)
            .putString(SleepMonitorService.KEY_TRIGGERS, triggers)
            .apply();

        Intent intent = new Intent(getContext(), SleepMonitorService.class);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getContext().startForegroundService(intent);
            } else {
                getContext().startService(intent);
            }
        } catch (Exception e) {
            call.reject("No se pudo iniciar el servicio: " + e.getMessage());
            return;
        }

        JSObject ret = new JSObject();
        ret.put("running", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        // El flag va antes de parar: el servicio consulta al morir si debe
        // rearmarse, y con esto sabe que la parada es deliberada.
        prefs().edit().putBoolean(SleepMonitorService.KEY_ENABLED, false).apply();
        SleepMonitorService.cancelWatchdog(getContext());
        getContext().stopService(new Intent(getContext(), SleepMonitorService.class));

        JSObject ret = new JSObject();
        ret.put("running", false);
        call.resolve(ret);
    }

    @PluginMethod
    public void isRunning(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("running", serviceRunning());
        ret.put("enabled", prefs().getBoolean(SleepMonitorService.KEY_ENABLED, false));
        ret.put("batteryExempt", batteryExempt());
        ret.put("lastUsedAt", prefs().getLong(SleepMonitorService.KEY_LAST_USED, 0L));
        call.resolve(ret);
    }

    /**
     * Devuelve los huecos de inactividad acumulados. No los borra: la web los
     * descarta explícitamente con {@link #clearGaps} una vez procesados, para
     * que un cierre inesperado no pierda una noche.
     */
    @PluginMethod
    public void getGaps(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            ret.put("gaps", new JSONArray(prefs().getString(SleepMonitorService.KEY_GAPS, "[]")));
        } catch (JSONException e) {
            ret.put("gaps", new JSONArray());
        }
        ret.put("lastUsedAt", prefs().getLong(SleepMonitorService.KEY_LAST_USED, 0L));
        ret.put("screenOffAt", prefs().getLong(SleepMonitorService.KEY_SCREEN_OFF_AT, 0L));
        call.resolve(ret);
    }

    /**
     * Descarta los huecos ya procesados. Se conserva todo lo que termine
     * después de `until`: entre que la web lee la cola y la limpia, el servicio
     * puede haber encolado un hueco nuevo que no debe perderse.
     */
    @PluginMethod
    public void clearGaps(PluginCall call) {
        long until = call.getLong("until", 0L);
        JSONArray kept = new JSONArray();

        try {
            JSONArray current = new JSONArray(prefs().getString(SleepMonitorService.KEY_GAPS, "[]"));
            for (int i = 0; i < current.length(); i++) {
                JSONObject gap = current.optJSONObject(i);
                if (gap != null && gap.optLong("end", 0L) > until) {
                    kept.put(gap);
                }
            }
        } catch (JSONException e) {
            // Cola corrupta: se vacía, que es lo que haría de todas formas.
        }

        prefs().edit().putString(SleepMonitorService.KEY_GAPS, kept.toString()).apply();
        call.resolve();
    }

    /**
     * Abre el diálogo del sistema para eximir la app del ahorro de batería.
     * Es la diferencia entre que el servicio sobreviva la noche o que Android
     * lo pare a las pocas horas y no se detecte nada.
     */
    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        JSObject ret = new JSObject();

        if (batteryExempt()) {
            ret.put("requested", false);
            call.resolve(ret);
            return;
        }

        try {
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                .setData(Uri.parse("package:" + getContext().getPackageName()))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            ret.put("requested", true);
        } catch (Exception e) {
            // Algunas ROMs no exponen el diálogo directo; queda la pantalla
            // general de optimización de batería.
            try {
                getContext().startActivity(
                    new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                );
                ret.put("requested", true);
            } catch (Exception inner) {
                ret.put("requested", false);
            }
        }

        call.resolve(ret);
    }

    private boolean batteryExempt() {
        PowerManager power = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        return power != null && power.isIgnoringBatteryOptimizations(getContext().getPackageName());
    }

    @SuppressWarnings("deprecation")
    private boolean serviceRunning() {
        ActivityManager manager = (ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
        if (manager == null) return false;
        // getRunningServices sigue informando de los servicios de la propia
        // app, que es lo único que se consulta aquí.
        for (ActivityManager.RunningServiceInfo info : manager.getRunningServices(Integer.MAX_VALUE)) {
            if (SleepMonitorService.class.getName().equals(info.service.getClassName())) {
                return true;
            }
        }
        return false;
    }
}
