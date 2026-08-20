package com.perfectrest.app;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Autoactualización desde las releases de GitHub.
 *
 * La capa web consulta la API de GitHub y decide si hay versión nueva; este
 * plugin hace las dos cosas que desde JavaScript son imposibles:
 *
 * 1. **Descargar la APK.** No se usa `fetch` por dos motivos. Pasar varios
 *    megas por el puente de Capacitor obliga a codificarlos en base64, un
 *    tercio más de memoria y en el hilo principal. Y sobre todo: la WebView
 *    corre en un origen `localhost`, así que sus peticiones pasan por CORS, y
 *    los assets de una release redirigen a un host que no manda
 *    `Access-Control-Allow-Origin`. Desde Java no hay CORS que valga.
 * 2. **Lanzar el instalador del sistema.** Android no permite que una app
 *    normal instale nada en silencio: hace falta un `Intent` con la APK
 *    expuesta como `content://` por el FileProvider, y el último toque lo da
 *    siempre el usuario.
 *
 * El APK se guarda en la caché, que el `file_paths.xml` de Capacitor ya expone,
 * de modo que no hacen falta permisos de almacenamiento.
 */
@CapacitorPlugin(name = "Updater")
public class UpdaterPlugin extends Plugin {

    /** Evento de progreso que escucha la interfaz mientras descarga. */
    private static final String EVENT_PROGRESS = "downloadProgress";
    private static final String DOWNLOAD_DIR = "updates";

    /**
     * Versión instalada y estado del permiso de instalación. Es la referencia
     * contra la que la web compara la última release publicada.
     */
    @PluginMethod
    public void getInfo(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            PackageManager pm = getContext().getPackageManager();
            PackageInfo info = pm.getPackageInfo(getContext().getPackageName(), 0);
            long code = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? info.getLongVersionCode()
                : info.versionCode;

            ret.put("versionCode", code);
            ret.put("versionName", info.versionName);
            ret.put("packageName", info.packageName);
            ret.put("canInstall", canInstall());
            call.resolve(ret);
        } catch (PackageManager.NameNotFoundException e) {
            call.reject("No se pudo leer la versión instalada", e);
        }
    }

    /**
     * Descarga la APK a la caché y va emitiendo el progreso. Si ya existe una
     * descarga completa de esa misma versión se reutiliza: es lo que permite
     * que, tras conceder el permiso de instalación en los ajustes del sistema,
     * el botón vuelva directo a «Instalar» sin repetir la descarga.
     */
    @PluginMethod
    public void download(final PluginCall call) {
        final String url = call.getString("url");
        final String version = call.getString("version", "latest");
        if (url == null || url.isEmpty()) {
            call.reject("Falta la URL de la descarga");
            return;
        }

        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                File dir = new File(getContext().getCacheDir(), DOWNLOAD_DIR);
                if (!dir.exists() && !dir.mkdirs()) {
                    call.reject("No se pudo crear la carpeta de descargas");
                    return;
                }
                File target = new File(dir, "perfectrest-" + version + ".apk");
                File partial = new File(dir, target.getName() + ".part");

                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setInstanceFollowRedirects(true);
                conn.setConnectTimeout(30_000);
                conn.setReadTimeout(60_000);
                // Sin esta cabecera GitHub devuelve la página HTML del asset en
                // vez del binario.
                conn.setRequestProperty("Accept", "application/octet-stream");
                conn.connect();

                int status = conn.getResponseCode();
                if (status < 200 || status >= 300) {
                    call.reject("La descarga devolvió " + status);
                    return;
                }

                long total = conn.getContentLengthLong();
                long written = 0;
                int lastPercent = -1;

                try (InputStream in = conn.getInputStream();
                     OutputStream out = new FileOutputStream(partial)) {
                    byte[] buffer = new byte[64 * 1024];
                    int read;
                    while ((read = in.read(buffer)) != -1) {
                        out.write(buffer, 0, read);
                        written += read;

                        if (total > 0) {
                            int percent = (int) (written * 100 / total);
                            // Sólo se notifica al cambiar de entero: si no, son
                            // cientos de mensajes por el puente para nada.
                            if (percent != lastPercent) {
                                lastPercent = percent;
                                JSObject progress = new JSObject();
                                progress.put("percent", percent);
                                progress.put("downloaded", written);
                                progress.put("total", total);
                                notifyListeners(EVENT_PROGRESS, progress);
                            }
                        }
                    }
                }

                // El renombrado va al final: así un fichero con el nombre
                // definitivo siempre es una descarga íntegra, nunca a medias.
                if (target.exists() && !target.delete()) {
                    call.reject("No se pudo reemplazar la descarga anterior");
                    return;
                }
                if (!partial.renameTo(target)) {
                    call.reject("No se pudo guardar la descarga");
                    return;
                }

                JSObject ret = new JSObject();
                ret.put("path", target.getAbsolutePath());
                ret.put("size", target.length());
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("No se pudo descargar la actualización: " + e.getMessage(), e);
            } finally {
                if (conn != null) conn.disconnect();
            }
        }).start();
    }

    /**
     * Abre el instalador del sistema con la APK descargada. A partir de aquí
     * todo es del usuario: Android enseña una pantalla con tono de advertencia
     * y el botón «Instalar de todos modos».
     */
    @PluginMethod
    public void install(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.isEmpty()) {
            call.reject("Falta la ruta de la APK");
            return;
        }

        File apk = new File(path);
        if (!apk.exists()) {
            call.reject("La descarga ya no está disponible");
            return;
        }

        if (!canInstall()) {
            call.reject("Falta el permiso para instalar aplicaciones desconocidas");
            return;
        }

        try {
            Uri uri = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                apk
            );
            Intent intent = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);

            JSObject ret = new JSObject();
            ret.put("launched", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("No se pudo abrir el instalador: " + e.getMessage(), e);
        }
    }

    /**
     * Abre los ajustes donde se concede «instalar apps desconocidas». En
     * Android 8+ ese permiso se da por aplicación y fuera de la app, así que la
     * interfaz tiene que releer el estado al volver al primer plano.
     */
    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            Intent intent = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
                    .setData(Uri.parse("package:" + getContext().getPackageName()))
                : new Intent(Settings.ACTION_SECURITY_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            ret.put("opened", true);
        } catch (Exception e) {
            ret.put("opened", false);
        }
        call.resolve(ret);
    }

    /** Borra las descargas ya instaladas o abandonadas. */
    @PluginMethod
    public void clearDownloads(PluginCall call) {
        File dir = new File(getContext().getCacheDir(), DOWNLOAD_DIR);
        File[] files = dir.listFiles();
        if (files != null) {
            for (File f : files) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
        }
        call.resolve();
    }

    private boolean canInstall() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
        Context context = getContext();
        return context.getPackageManager().canRequestPackageInstalls();
    }
}
