# PerfectRest

Aplicación móvil para mejorar los horarios de sueño: fija una meta de descanso,
calcula la hora de acostarse que encaja con los ciclos de sueño y registra
cuánto duermes para enseñarte la tendencia.

Stack: **Vite + React + TypeScript**, empaquetada para Android con **Capacitor**.
Durante el desarrollo corre en el navegador; el APK se genera con el SDK de
Android ya instalado en la máquina.

---

## Puesta en marcha

```bash
npm install
npm run dev        # http://localhost:5173
```

Otros comandos:

| Comando | Qué hace |
| --- | --- |
| `npm run dev` | Servidor de desarrollo con recarga en caliente |
| `npm run build` | Compila a `dist/` (lo que consume el APK) |
| `npm run typecheck` | Comprueba tipos sin compilar |
| `npm run check` | Ejecuta las comprobaciones de dominio y de render |
| `npm run icons` | Regenera los PNG del icono desde `public/logo.svg` |
| `npm run release` | Compila y firma la APK de release en `release/` |
| `npm run preview` | Sirve el build de producción |

Para probar en el móvil dentro de la misma red, `npm run dev -- --host` y abre
la IP que imprime Vite. Es la forma más rápida de ver la app a tamaño real sin
generar todavía el APK.

---

## Los tres módulos

### Módulo 1 — Metas de sueño y avisos

Pantalla **Metas**. Tres formas de personalizar la meta:

- **Toda la semana**: un único objetivo para los siete días.
- **Semana + finde**: un horario de lunes a viernes y otro para sábado y domingo.
- **Día a día**: cada día por separado.

El estado guarda siempre los siete días; el modo sólo decide cuáles se editan a
la vez, así que cambiar de modo nunca pierde los valores anteriores
([`src/lib/schedule.ts`](src/lib/schedule.ts)).

De cada día se define la **hora de despertar** y las **horas objetivo**. A
partir de ahí se derivan tres avisos, con un margen de tolerancia deliberadamente
estrecho (±15 min por defecto), porque la regularidad pesa más que la duración
puntual:

1. **Aviso previo** (30 min antes) para ir bajando el ritmo.
2. **Aviso a la hora exacta** de acostarse.
3. **Aviso de retraso** al agotarse el margen, si está activado.

En el APK se programan como notificaciones locales con repetición semanal, de
modo que siguen disparándose con la app cerrada. En el navegador se usa la
Notification API mientras la pestaña está abierta
([`src/lib/notifications.ts`](src/lib/notifications.ts)).

### Módulo 2 — Hora de acostarse según los ciclos

Pantalla **Ciclos**. El sueño avanza en ciclos de unos 90 minutos; despertar al
final de uno, en fase ligera, evita la inercia de sueño de interrumpir una fase
profunda. El cálculo encaja un número entero de ciclos entre el momento de
dormirse y el de despertar, sumando la latencia (lo que se tarda en caer
dormido) ([`src/lib/cycles.ts`](src/lib/cycles.ts)).

Funciona en los dos sentidos:

- **Quiero despertar a las…** → a qué horas conviene acostarse (3 a 7 ciclos).
- **Me acuesto ahora** → a qué horas conviene poner la alarma.

La opción recomendada es la que menos se desvía de la meta del día. El anillo
muestra la noche completa con la composición estimada de cada ciclo: el sueño
profundo domina los primeros y el REM se alarga hacia el final.

Ambos parámetros son ajustables, porque la duración del ciclo varía entre 70 y
120 minutos según la persona.

### Módulo 3 — Monitorización por inactividad y estadísticas

Pantalla **Datos**. La duración del sueño se deduce del **tiempo que el
dispositivo pasa sin usarse**, nunca del tiempo que pasa sin abrirse la app.
Esa señal puede venir de varios sitios, y cada uno es un **disparador** que se
activa por separado desde Ajustes ([`src/lib/triggers.ts`](src/lib/triggers.ts)):

| Disparador | Abre el hueco | Lo cierra | Dónde |
| --- | --- | --- | --- |
| **Bloqueo del móvil** | pantalla apagada | desbloqueo real | APK |
| **Cargador** | lo enchufas | lo desenchufas | APK |
| **Apertura de la app** | última marca de actividad | vuelves a abrirla | siempre |
| **Horario objetivo** | — | — | siempre |

Los dos primeros los mide un servicio en primer plano
([`SleepMonitorService.java`](android/app/src/main/java/com/perfectrest/app/SleepMonitorService.java)).
Android sólo entrega `ACTION_SCREEN_OFF`, `ACTION_USER_PRESENT` y los eventos de
carga a receptores registrados en código y mientras un componente siga vivo, por
eso hace falta el servicio —y por eso Android obliga a mostrar una notificación
permanente mientras está activo. Se declara como
`foregroundServiceType="specialUse"`, se reanuda tras reiniciar el móvil y se
rearma con una **alarma exacta cada 15 minutos**: sin eso, deslizar la app fuera
de recientes o una limpieza de memoria de madrugada lo mataban en silencio y la
detección se quedaba reducida a las aperturas de la app. Por la misma razón
Ajustes ofrece **desactivar la optimización de batería**, que es la causa más
común de que el servicio no llegue vivo a la mañana.

El tercero es el respaldo: la app deja una marca temporal mientras está en
primer plano y mide el hueco desde la última
([`src/lib/activityMonitor.ts`](src/lib/activityMonitor.ts)). Es lo único que
funciona en el navegador, y depende de que mires el móvil poco antes de dormir y
poco después de despertar.

El cuarto no mide nada: cuando una noche no ha dejado **ninguna** otra señal,
propone la sesión que marca tu meta para que la corrijas a mano. Va siempre con
confianza baja y viene desactivado de fábrica.

Cuando dos disparadores caen sobre la misma noche no se proponen dos sesiones:
se fusionan quedándose con la **intersección** de ambos huecos, porque cada
señal acota el sueño por fuera —el cargador se enchufa antes de apagar la
pantalla y se desenchufa después de desbloquear—, y la coincidencia sube el
nivel de confianza. Toda sesión se puede confirmar, ajustar o descartar:

- **fiable** — empieza y termina dentro de la ventana nocturna y dura entre 4 y 11 h, o dos disparadores independientes coinciden.
- **estimada** — sólo uno de los dos extremos cae en la ventana nocturna.
- **dudosa** — demasiado corto, demasiado largo, fuera de horas, o deducido del horario.

**El aviso al despertar.** Una propuesta que espera a que abras la app es una
propuesta que no ves: al despertarse nadie abre PerfectRest, y la noche se
quedaba sin validar durante días, cuando ya no se recuerda si fue a las 23:40 o
a la una. Por eso, en cuanto se cierra el hueco, el servicio lanza una
notificación con la estimación —«Has dormido 7h 20m · De 23:40 a 07:00»— que
abre la app en la ficha de confirmación. Se activa y desactiva desde Ajustes
(«avisarme con la estimación al despertar») y viaja por un canal propio,
`perfectrest-summary`, separado del canal mudo del servicio para que se pueda
silenciar uno sin perder el otro.

Lo emite el servicio nativo y no la capa web a propósito: a las siete de la
mañana la app lleva horas cerrada y no hay ningún JavaScript vivo que pueda
avisar. El filtro del servicio es laxo —el umbral mínimo y un extremo dentro de
la ventana nocturna—; la evaluación fina (confianza, fusión de disparadores,
corrección de bordes) sigue estando sólo en la capa web, porque duplicarla en
Java sólo garantizaría que las dos acaben desincronizadas. La cifra del aviso
es el hueco bruto; la que se guarda, la refinada.

Los bordes se corrigen antes de proponerla: al inicio se suma la latencia (uno
suelta el móvil antes de dormirse) y al final se restan 5 minutos (nadie coge el
móvil al instante de despertar). La propuesta del horario se libra, porque ya
está expresada en tiempo de sueño.

Las estadísticas ([`src/lib/stats.ts`](src/lib/stats.ts)) cubren duración media,
metas cumplidas, hora media de acostarse y despertar (con media circular, para
que 23:50 y 00:10 no promedien a mediodía), **consistencia** de horarios, deuda
de sueño acumulada y racha de noches cumplidas.

Una sesión pertenece al día en que uno **se despierta**: dormir de lunes 23:40 a
martes 07:10 es «la noche del martes».

---

## Comprobaciones

`npm run check` ejecuta dos suites, sin dependencias de testing:

- **Dominio** ([`scripts/selfcheck.ts`](scripts/selfcheck.ts)) — cálculo de ciclos
  en ambos sentidos, propagación de metas entre modos, ventanas que cruzan
  medianoche, medias circulares, estadísticas y detección de huecos de
  inactividad, y el formato de las etiquetas de release.
- **Render** ([`scripts/rendercheck.tsx`](scripts/rendercheck.tsx)) — cada
  pantalla se renderiza fuera del navegador para detectar errores de render.

Además, con el servidor de desarrollo en marcha:

```bash
npm run layout        # auditoría de maquetación en un navegador real
npm run shots         # capturas de cada pantalla en screenshots/
```

[`scripts/layoutcheck.mjs`](scripts/layoutcheck.mjs) abre la app a 320, 360,
390, 430 y 520 px, recorre las cinco pantallas (arriba y con la página al
final) en tema claro, oscuro, onboarding y con una sesión pendiente, y falla si
encuentra scroll horizontal, cajas fuera del viewport, texto desbordado,
solapamientos, contenido tapado por la barra fija, zonas táctiles menores de
32 px o cualquier margen que no salga de la escala de espaciado del tema.

---

## Identidad visual

La marca es una **luna creciente dentro de un arco abierto**: el arco es el
mismo ciclo que dibuja la pantalla de Ciclos, y su hueco, arriba a la derecha,
coincide con el lado por el que la luna se abre. El degradado va del violeta
`#8E7BFF` al menta `#4FE0BE`, los dos acentos del tema.

El original es [`public/logo.svg`](public/logo.svg), un lienzo de 100×100 con
sólo dos trazados. De ahí salen los tres usos:

| Uso | Fichero | Notas |
| --- | --- | --- |
| Icono del lanzador | [`drawable/ic_launcher_foreground.xml`](android/app/src/main/res/drawable/ic_launcher_foreground.xml) | Adaptativo sobre fondo `#090D1A`, con capa `monochrome` para los iconos temáticos de Android 13+ |
| Icono heredado | `mipmap-*/ic_launcher*.png` | Sólo lo usan API 24 y 25; se generan con `npm run icons` |
| Pantalla de arranque nativa | [`drawable/splash.xml`](android/app/src/main/res/drawable/splash.xml) | Vectorial; en Android 12+ manda [`values-v31/styles.xml`](android/app/src/main/res/values-v31/styles.xml) |
| Pantalla de carga animada | [`index.html`](index.html) | 1,5 s: el arco se dibuja, la luna entra, aparece el nombre y todo se funde |
| Icono de notificación | [`drawable/ic_stat_icon.xml`](android/app/src/main/res/drawable/ic_stat_icon.xml) | Silueta blanca sobre transparente, como exige Android |
| Favicon | [`public/moon.svg`](public/moon.svg) | La marca sobre la baldosa oscura |

Casi todo es vectorial: un cambio en el dibujo se propaga editando los trazados.
Los únicos mapas de bits son los `mipmap-*` de respaldo, y se rasterizan con el
Chrome del sistema:

```bash
npm run icons                    # regenera los PNG
node scripts/icons.mjs --preview # además, una hoja de contacto en screenshots/
```

La animación de carga vive en el HTML y no en React a propósito: se pinta en el
primer fotograma, antes de que el bundle se descargue, así que releva a la
ventana de arranque nativa sin ningún parpadeo. Se quita del DOM a los 1500 ms
para no dejar una capa invisible interceptando toques, y con
`prefers-reduced-motion` la marca aparece ya montada y sólo se funde.

---

## El APK

El proyecto Android ya está generado en [`android/`](android/) y el APK
compilado está en la raíz como **`PerfectRest.apk`** (4,2 MB, depuración).

Para instalarlo en un móvil conectado por USB con depuración activada:

```bash
adb install -r PerfectRest.apk
```

O copia el archivo al teléfono y ábrelo, permitiendo la instalación de orígenes
desconocidos.

Para regenerarlo tras cambiar el código:

```bash
npm run android:apk     # build web + sync + gradle assembleDebug
```

Queda en `android/app/build/outputs/apk/debug/app-debug.apk`. Para abrir el
proyecto en Android Studio, `npm run android:open`.

`android/local.properties` apunta al SDK de esta máquina y no debe compartirse.

### Los permisos son el punto débil de todo esto

Ninguno de los permisos que necesita la detección falla con un error. Si falta
alguno, la app no se rompe: **simplemente deja de registrar noches**, que desde
fuera es indistinguible de una noche en la que no dejaste ninguna señal. Ése era
el fallo real —la detección parecía no funcionar sin que nada dijera por qué—, y
por eso Ajustes abre con una tarjeta de diagnóstico que los recorre uno a uno,
cada uno con su atajo directo a la pantalla del sistema que lo concede:

| Requisito | Qué pasa sin él | Cómo se concede |
| --- | --- | --- |
| **Notificaciones** | No hay recordatorios, ni aviso al despertar, ni notificación del servicio | Diálogo en el onboarding; después, ajustes del sistema |
| **Sin optimización de batería** | Android para el servicio de madrugada y se pierde la noche entera | Se pide en el onboarding y desde el diagnóstico |
| **Alarmas exactas** | El vigilante se degrada a alarma inexacta, Doze la agrupa y el servicio puede no rearmarse en toda la noche | Pantalla «alarmas y recordatorios» |
| **Servicio vivo** | No es un permiso: es el resultado de los tres anteriores | — |

Tres detalles que hacían que esto fallara en silencio y ya no:

- **Un permiso denegado dos veces no vuelve a preguntarse.** Android deja de
  mostrar el diálogo a la segunda negativa, así que el botón «conceder permiso»
  dejaba de hacer nada sin decirlo. Ahora, cuando ya no hay diálogo posible, el
  botón lleva a la ficha de la app en los ajustes del sistema.
- **Cada actualización apagaba la detección.** Instalar una versión nueva
  detiene la app por completo y cancela sus alarmas, la del vigilante incluida.
  Como PerfectRest se actualiza sola con cada push a `main`, el servicio se
  quedaba muerto hasta que alguien volviera a abrir la app —y como no hay nada
  visible que falle, podían pasar semanas. `BootReceiver` atiende ahora
  `MY_PACKAGE_REPLACED` además del arranque del dispositivo.
- **El estado del servicio mentía.** `start()` respondía «en marcha» sin
  comprobar nada, y `getRunningServices` informa del proceso, no de que el
  servicio siga escuchando. Ahora el servicio deja un latido en cada arranque y
  en cada evento recibido, y se le da por muerto si lleva más de 45 minutos sin
  tocarlo (el vigilante pasa cada 15). Todo lo que puede fallar por un permiso
  —entrar en primer plano, programar la alarma exacta, publicar el aviso— queda
  anotado y Ajustes lo muestra en vez de dejarlo morir en el log.

### Qué se ha comprobado en un dispositivo

Sobre un emulador Android 16 (API 36), con el APK instalado:

- La app arranca, carga y navega correctamente.
- El servicio de segundo plano arranca en primer plano
  (`isForeground=true`, tipo `specialUse`).
- Con la app **cerrada**, bloquear la pantalla y desbloquearla después registra
  el hueco de inactividad con su marca de inicio y fin.
- Al abrir la app, el hueco se lee, se evalúa, se vacía la cola nativa y
  aparece el aviso de sesión detectada con su nivel de confianza.

La detección se probó con un umbral reducido a 1 minuto para no esperar horas;
el umbral real por defecto son 3 horas.

---

## Autoactualización

Un `git push` a `main` acaba convertido en una actualización instalada en el
móvil, sin descargar ningún APK a mano ni entrar en ninguna web.

```
git push a main
      │
      ▼
GitHub Actions            compila y FIRMA la APK
      ▼
GitHub Release            tag: v<versionName>-b<versionCode>, con la APK adjunta
      ▼
La app, al arrancar       1. consulta api.github.com  (JavaScript, pasa por CORS)
                          2. compara versionCode
                          3. descarga la APK           (Java, sin CORS)
                          4. abre el instalador
      ▼
1 toque del usuario → instalada, datos intactos
```

**Lo que no puede hacer:** instalar en silencio. Eso exige ser *device owner* o
app de sistema. Todo lo demás —comprobar, descargar, preparar— es automático,
pero el último paso es siempre un diálogo del sistema.

### El reparto entre JavaScript y Java no es casual

La WebView corre en un origen `localhost`, así que sus peticiones pasan por
CORS:

| Petición | ¿Manda `Access-Control-Allow-Origin`? |
| --- | --- |
| `api.github.com/repos/.../releases/latest` | **sí**, `*` |
| La URL de descarga de un asset de release | **no** (redirige a otro host) |

Por eso el `versionCode` sale de la **etiqueta** de la release (`v0.1.0-b23` →
23), que ya viene en la respuesta de la API: publicar un `latest.json` como
asset y leerlo con `fetch` sería lo natural y no funcionaría nunca. La APK sí se
descarga del asset, pero eso lo hace
[`UpdaterPlugin.java`](android/app/src/main/java/com/perfectrest/app/UpdaterPlugin.java),
que además evita pasar varios megas en base64 por el puente de Capacitor.

### El versionado

`versionCode` = **número de commits** (`git rev-list --count HEAD`), calculado
en [`android/app/build.gradle`](android/app/build.gradle). Crece solo con cada
push y nadie tiene que acordarse de subirlo; Android sólo acepta actualizar a un
`versionCode` estrictamente mayor. `versionName` sale de `package.json`, que es
lo que ve el usuario.

**Contrapartida:** no se puede reescribir la historia de `main`. Un rebase o un
`push --force` que reduzca el número de commits dejaría las releases nuevas por
debajo de lo ya instalado y el canal se rompería en silencio. Por eso
`scripts/release-apk.mjs` aborta si el `versionCode` calculado no supera al de
la última APK publicada.

### Puesta en marcha (una sola vez)

1. **Repositorio público en GitHub.** La app consulta la API sin credenciales;
   en uno privado recibiría un 404 y no ofrecería nada nunca. Meter un token en
   el APK no es una opción. El slug `owner/repo` no se escribe a mano: sale del
   remoto de git en tiempo de compilación
   ([`vite.config.ts`](vite.config.ts)).

2. **Generar la clave de firma:**

   ```bash
   npm run keystore
   ```

   Crea `android/perfectrest-release.jks` y `android/keystore.properties` (los
   dos en `.gitignore`) e imprime lo que hay que pegar en los secrets. **Guarda
   una copia del `.jks` fuera del proyecto:** Android identifica una app por
   applicationId + firma, así que si se pierde la clave ningún dispositivo con
   PerfectRest instalada podrá volver a actualizarse —habría que desinstalar y
   reinstalar, perdiendo las noches registradas.

3. **Crear cuatro secrets** en *Settings → Secrets and variables → Actions*,
   pestaña **Secrets** (no *Variables*: ese error da un fallo mudo):
   `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`.

4. **Instalar a mano la primera APK firmada** con la clave nueva. La instalación
   actual va firmada con la clave de debug, así que hay que desinstalarla antes;
   a partir de ahí el canal se sostiene solo.

Para compilar una release en local: `npm run release` (deja el APK en
`release/`). Sin `keystore.properties` avisa y firma con la clave de debug: sirve
para probar, no para publicar.

### La comprobación manual no es un adorno

La comprobación del arranque **calla sus errores** a propósito: sin cobertura, o
con GitHub devolviendo 403 por límite de peticiones, la app tiene que seguir
funcionando sin molestar. El precio de ese diseño es que un fallo real se ve
exactamente igual que «no hay novedades».

Por eso Ajustes incluye una comprobación manual que sí cuenta lo que ocurre:
versión encontrada, ya al día, o el error exacto. Es la única forma de
distinguir «no hay nada» de «está roto».

### El permiso se concede fuera de la app

En Android 8+, «instalar apps desconocidas» se da por aplicación en una pantalla
de ajustes del sistema, y nada dentro de la app avisa de que ha cambiado. El
estado se relee al volver al primer plano
([`src/state/update.tsx`](src/state/update.tsx)); si no, el aviso seguiría
pidiendo un permiso ya concedido para siempre. Como la APK ya está descargada,
al recuperar el permiso el botón vuelve directo a «Instalar».

---

## Estructura

```
src/
  lib/
    types.ts             modelo de dominio
    time.ts              formato de horas, ventanas nocturnas, medias circulares
    cycles.ts            Módulo 2: cálculo de ciclos
    schedule.ts          Módulo 1: metas y modos de personalización
    notifications.ts     Módulo 1: avisos (nativos y de navegador)
    activityMonitor.ts   Módulo 3: detección por inactividad
    updater.ts           Autoactualización: API de GitHub y versiones
    triggers.ts          Módulo 3: catálogo de disparadores
    stats.ts             Módulo 3: estadísticas e interpretación
    storage.ts           persistencia (Preferences en el APK, localStorage en web)
  state/
    store.tsx            estado global, hidratación y efectos
    update.tsx           estado del canal de autoactualización
  components/            sistema de diseño y visualizaciones SVG
  screens/               una pantalla por módulo, más Inicio y Ajustes
  styles/theme.css       paleta y tokens de diseño

public/
  logo.svg               la marca, origen de todo el juego de iconos
  moon.svg               favicon: la marca sobre la baldosa oscura

scripts/
  release-apk.mjs        compila y firma la APK de release (local y en CI)
  keystore.mjs           genera la clave de firma, una sola vez
  icons.mjs              rasteriza los mipmap heredados desde logo.svg
.github/workflows/
  release.yml            publica la release en cada push a main
```

Todos los datos se guardan **solo en el dispositivo**. No hay cuenta, servidor
ni telemetría.

---

Las estimaciones de ciclos son orientativas y no sustituyen el criterio médico.
