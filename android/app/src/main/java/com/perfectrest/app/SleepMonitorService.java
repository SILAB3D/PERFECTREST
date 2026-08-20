package com.perfectrest.app;

import android.app.AlarmManager;
import android.app.KeyguardManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Monitorización del uso del dispositivo en segundo plano.
 *
 * Android sólo entrega ACTION_SCREEN_OFF, ACTION_USER_PRESENT y los eventos de
 * carga a receptores registrados en código, no en el manifiesto, y sólo
 * mientras un componente de la app siga vivo. Por eso hace falta un servicio
 * en primer plano: es la única forma de seguir escuchando esos eventos
 * mientras el usuario duerme y la app está cerrada.
 *
 * Se registran dos disparadores independientes, cada uno activable desde los
 * ajustes de la app:
 *
 *   screen   SCREEN_OFF        -> USER_PRESENT        (deja de usarlo / vuelve)
 *   charger  POWER_CONNECTED   -> POWER_DISCONNECTED  (lo enchufa / lo suelta)
 *
 * El hueco entre los dos extremos es tiempo real sin usar el móvil, mucho más
 * preciso que deducirlo de cuándo se abre la app. Cuando supera el umbral
 * configurado se encola, etiquetado con el disparador que lo abrió y el que lo
 * cerró, para que la capa web lo evalúe como posible sesión de sueño. El
 * servicio no decide nada, sólo mide.
 *
 * Mantenerse vivo es la otra mitad del trabajo: START_STICKY no cubre que el
 * usuario deslice la app fuera de recientes ni que el sistema mate el proceso
 * de madrugada, así que el servicio se rearma con una alarma exacta periódica.
 * Sin eso, la detección se apagaba silenciosamente y sólo volvía a haber datos
 * al abrir la app, que es justo lo que se quería evitar.
 */
public class SleepMonitorService extends Service {

    public static final String PREFS = "perfectrest.monitor";
    public static final String KEY_LAST_USED = "lastUsedAt";
    public static final String KEY_GAPS = "pendingGaps";
    public static final String KEY_ENABLED = "serviceEnabled";
    public static final String KEY_MIN_GAP = "minGapMinutes";
    public static final String KEY_SCREEN_OFF_AT = "screenOffAt";
    public static final String KEY_PLUGGED_AT = "pluggedAt";
    /** Disparadores activos, separados por comas: "screen,charger". */
    public static final String KEY_TRIGGERS = "triggers";

    public static final String TRIGGER_SCREEN = "screen";
    public static final String TRIGGER_CHARGER = "charger";

    /** Acción con la que la alarma de vigilancia vuelve a levantar el servicio. */
    public static final String ACTION_RESTART = "com.perfectrest.app.RESTART_MONITOR";

    private static final String CHANNEL_ID = "perfectrest-monitor";
    private static final int NOTIFICATION_ID = 4711;
    /** Tope de huecos guardados: si la app no se abre en semanas, no crece sin fin. */
    private static final int MAX_GAPS = 60;
    /** Cada cuánto comprueba la alarma que el servicio sigue vivo. */
    private static final long WATCHDOG_INTERVAL_MS = 15 * 60_000L;

    private BroadcastReceiver receiver;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        startInForeground();
        registerDeviceReceiver();
        primeScreenState();
        scheduleWatchdog(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        prefs().edit().putBoolean(KEY_ENABLED, true).apply();
        // Los ajustes pueden haber cambiado entre dos arranques (el usuario
        // activa o desactiva un disparador), así que se vuelve a registrar.
        registerDeviceReceiver();
        scheduleWatchdog(this);
        // START_STICKY: si el sistema mata el servicio por memoria, lo recrea.
        return START_STICKY;
    }

    /**
     * El usuario ha deslizado la app fuera de recientes. En la mayoría de ROMs
     * eso mata el proceso entero, servicio incluido: se programa el rearranque
     * inmediato para no perder la noche.
     */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        if (prefs().getBoolean(KEY_ENABLED, false)) {
            scheduleRestart(this, 2_000L);
        }
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        unregisterDeviceReceiver();
        // Si el servicio muere sin que el usuario lo haya apagado, la alarma
        // pendiente lo devolverá a la vida en el próximo ciclo.
        if (prefs().getBoolean(KEY_ENABLED, false)) {
            scheduleRestart(this, 5_000L);
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private boolean triggerOn(String id) {
        String raw = prefs().getString(KEY_TRIGGERS, TRIGGER_SCREEN);
        for (String part : raw.split(",")) {
            if (part.trim().equals(id)) return true;
        }
        return false;
    }

    // --- Ciclo de vida en primer plano ---

    private void startInForeground() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // Android 14 exige declarar el tipo al entrar en primer plano, no
            // sólo en el manifiesto.
            startForeground(
                NOTIFICATION_ID,
                buildNotification(),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            );
        } else {
            startForeground(NOTIFICATION_ID, buildNotification());
        }
    }

    /**
     * Alarma de vigilancia. Se usa una alarma exacta porque las inexactas se
     * agrupan y pueden retrasarse horas en Doze, justo durante el sueño, y
     * porque disparar una exacta concede a la app una ventana temporal en la
     * que sí puede arrancar un servicio en primer plano desde segundo plano.
     */
    static void scheduleWatchdog(Context context) {
        scheduleRestart(context, WATCHDOG_INTERVAL_MS);
    }

    static void scheduleRestart(Context context, long delayMs) {
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarms == null) return;

        Intent intent = new Intent(context, BootReceiver.class).setAction(ACTION_RESTART);
        PendingIntent pending = PendingIntent.getBroadcast(
            context, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        long at = System.currentTimeMillis() + delayMs;
        try {
            alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending);
        } catch (SecurityException e) {
            // Sin permiso de alarmas exactas se degrada a una inexacta: menos
            // puntual, pero sigue rearmando el servicio.
            alarms.set(AlarmManager.RTC_WAKEUP, at, pending);
        }
    }

    static void cancelWatchdog(Context context) {
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarms == null) return;
        Intent intent = new Intent(context, BootReceiver.class).setAction(ACTION_RESTART);
        PendingIntent pending = PendingIntent.getBroadcast(
            context, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        alarms.cancel(pending);
    }

    // --- Escucha de eventos del dispositivo ---

    private void unregisterDeviceReceiver() {
        if (receiver == null) return;
        try {
            unregisterReceiver(receiver);
        } catch (IllegalArgumentException ignored) {
            // Ya estaba dado de baja.
        }
        receiver = null;
    }

    private void registerDeviceReceiver() {
        unregisterDeviceReceiver();

        IntentFilter filter = new IntentFilter();
        boolean any = false;

        if (triggerOn(TRIGGER_SCREEN)) {
            filter.addAction(Intent.ACTION_SCREEN_OFF);
            filter.addAction(Intent.ACTION_SCREEN_ON);
            filter.addAction(Intent.ACTION_USER_PRESENT);
            any = true;
        }
        if (triggerOn(TRIGGER_CHARGER)) {
            filter.addAction(Intent.ACTION_POWER_CONNECTED);
            filter.addAction(Intent.ACTION_POWER_DISCONNECTED);
            any = true;
        }
        if (!any) return;

        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                handleEvent(intent.getAction(), System.currentTimeMillis());
            }
        };

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(receiver, filter);
        }
    }

    private void handleEvent(String action, long now) {
        if (action == null) return;

        switch (action) {
            case Intent.ACTION_SCREEN_OFF:
                // Momento en que el uso termina: candidato a inicio del hueco.
                prefs().edit()
                    .putLong(KEY_SCREEN_OFF_AT, now)
                    .putLong(KEY_LAST_USED, now)
                    .apply();
                break;

            case Intent.ACTION_USER_PRESENT:
                // Desbloqueo real: la señal más fiable de que el usuario ha
                // vuelto al dispositivo.
                closeScreenGap(now);
                break;

            case Intent.ACTION_SCREEN_ON:
                // Sin bloqueo seguro (PIN, patrón o huella) Android nunca emite
                // USER_PRESENT: encender la pantalla es entonces la única señal
                // de vuelta disponible. Con bloqueo seguro se ignora, porque la
                // pantalla puede encenderse sola por una notificación sin que
                // el usuario coja el móvil.
                if (!keyguardSecure()) closeScreenGap(now);
                break;

            case Intent.ACTION_POWER_CONNECTED:
                prefs().edit().putLong(KEY_PLUGGED_AT, now).apply();
                break;

            case Intent.ACTION_POWER_DISCONNECTED:
                closeChargerGap(now);
                break;

            default:
                break;
        }
    }

    /**
     * Cierra el hueco abierto por la pantalla. Si superó el umbral, se encola;
     * en cualquier caso se marca el instante como último uso y se limpia el
     * candidato, de modo que un segundo desbloqueo seguido no vuelva a encolar
     * la misma noche.
     */
    private void closeScreenGap(long now) {
        long offAt = prefs().getLong(KEY_SCREEN_OFF_AT, 0L);
        if (offAt > 0 && now - offAt >= minGapMs()) {
            enqueueGap(offAt, now, TRIGGER_SCREEN, TRIGGER_SCREEN);
        }
        prefs().edit()
            .putLong(KEY_LAST_USED, now)
            .putLong(KEY_SCREEN_OFF_AT, 0L)
            .apply();
    }

    /**
     * Cierra el hueco abierto por el cargador. No toca `lastUsedAt`: enchufar o
     * desenchufar el móvil no implica usarlo, y confundirlo con uso real
     * falsearía el hueco de la pantalla.
     */
    private void closeChargerGap(long now) {
        long pluggedAt = prefs().getLong(KEY_PLUGGED_AT, 0L);
        if (pluggedAt > 0 && now - pluggedAt >= minGapMs()) {
            enqueueGap(pluggedAt, now, TRIGGER_CHARGER, TRIGGER_CHARGER);
        }
        prefs().edit().putLong(KEY_PLUGGED_AT, 0L).apply();
    }

    private long minGapMs() {
        return prefs().getInt(KEY_MIN_GAP, 180) * 60_000L;
    }

    /**
     * Si el servicio arranca con la pantalla ya apagada —tras un reinicio de
     * madrugada, o al rearmarlo la alarma de vigilancia— no habrá llegado el
     * SCREEN_OFF correspondiente. Se da por empezado el hueco en ese momento:
     * subestima la inactividad, pero no la pierde entera.
     */
    private void primeScreenState() {
        if (!triggerOn(TRIGGER_SCREEN)) return;
        if (prefs().getLong(KEY_SCREEN_OFF_AT, 0L) > 0) return;

        PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (power == null) return;

        if (!power.isInteractive()) {
            prefs().edit().putLong(KEY_SCREEN_OFF_AT, System.currentTimeMillis()).apply();
        }
    }

    /** ¿El dispositivo exige PIN, patrón o biometría para desbloquearse? */
    private boolean keyguardSecure() {
        KeyguardManager km = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
        return km != null && km.isKeyguardSecure();
    }

    /** Añade un hueco de inactividad a la cola que consumirá la capa web. */
    private void enqueueGap(long start, long end, String startTrigger, String endTrigger) {
        SharedPreferences p = prefs();
        JSONArray gaps;
        try {
            gaps = new JSONArray(p.getString(KEY_GAPS, "[]"));
        } catch (JSONException e) {
            gaps = new JSONArray();
        }

        try {
            JSONObject gap = new JSONObject();
            gap.put("start", start);
            gap.put("end", end);
            gap.put("startTrigger", startTrigger);
            gap.put("endTrigger", endTrigger);
            gaps.put(gap);
        } catch (JSONException e) {
            return;
        }

        // Se conservan los más recientes.
        while (gaps.length() > MAX_GAPS) {
            gaps.remove(0);
        }
        p.edit().putString(KEY_GAPS, gaps.toString()).apply();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;

        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Monitorización del sueño",
            // Mínima: la notificación es obligatoria para el servicio, pero no
            // debe sonar, vibrar ni aparecer en la pantalla de bloqueo.
            NotificationManager.IMPORTANCE_MIN
        );
        channel.setDescription("Mantiene activa la detección del sueño mientras duermes");
        channel.setShowBadge(false);
        channel.setLockscreenVisibility(Notification.VISIBILITY_SECRET);
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        PendingIntent pending = PendingIntent.getActivity(
            this, 0, open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("PerfectRest")
            .setContentText("Detectando tu descanso")
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .setShowWhen(false)
            .setContentIntent(pending)
            .build();
    }
}
