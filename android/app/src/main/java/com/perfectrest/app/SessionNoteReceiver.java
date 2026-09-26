package com.perfectrest.app;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

import androidx.core.app.RemoteInput;

/**
 * Recoge el comentario escrito con el botón «Comentar» del aviso al despertar.
 *
 * No toca la sesión: a esta hora la app lleva horas cerrada y la noche sólo
 * existe como hueco en la cola del servicio. El comentario queda guardado
 * junto al intervalo del hueco y la capa web lo adjunta a la sesión en cuanto
 * se abre y la propone.
 */
public class SessionNoteReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!SleepMonitorService.ACTION_ADD_NOTE.equals(intent.getAction())) return;

        Bundle results = RemoteInput.getResultsFromIntent(intent);
        CharSequence raw = results == null
            ? null
            : results.getCharSequence(SleepMonitorService.REMOTE_INPUT_NOTE);
        String text = raw == null ? "" : raw.toString().trim();

        long start = intent.getLongExtra(SleepMonitorService.EXTRA_START, 0L);
        long end = intent.getLongExtra(SleepMonitorService.EXTRA_END, 0L);
        if (!text.isEmpty() && end > start) {
            SleepMonitorService.addNote(context, start, end, text);
        }

        // Android deja la respuesta en línea girando hasta que el aviso se
        // actualiza: se rehace con el comentario a la vista, o con el botón
        // otra vez si se envió vacío.
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null || end <= start) return;
        try {
            manager.notify(
                SleepMonitorService.SUMMARY_NOTIFICATION_ID,
                SleepMonitorService.buildSummary(context, start, end, text.isEmpty() ? null : text)
            );
        } catch (SecurityException e) {
            /* sin permiso de notificaciones el comentario ya está guardado igualmente */
        }
    }
}
