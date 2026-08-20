/**
 * Genera la clave de firma de release y deja preparado lo que hay que copiar
 * a los secrets de GitHub.
 *
 *   node scripts/keystore.mjs
 *
 * Se ejecuta UNA sola vez en la vida del proyecto. Android identifica una app
 * por applicationId + firma: una APK firmada con otra clave no se considera una
 * actualización sino una app distinta, y la instalación falla con
 * INSTALL_FAILED_UPDATE_INCOMPATIBLE.
 *
 * Si esta clave se pierde, ningún dispositivo con PerfectRest instalada podrá
 * actualizarse nunca más: habría que desinstalar y reinstalar, perdiendo las
 * noches registradas. Guarda una copia FUERA del proyecto.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const jks = resolve(root, 'android/perfectrest-release.jks');
const props = resolve(root, 'android/keystore.properties');
const alias = 'perfectrest';

if (existsSync(jks)) {
  console.error(
    `Ya existe ${jks}.\n` +
      'Generar otra clave rompería el canal de actualización para quien ya tenga la app.\n' +
      'Si de verdad quieres empezar de cero, bórrala a mano primero.',
  );
  process.exit(1);
}

// Contraseña aleatoria: nadie la teclea nunca, vive en keystore.properties (que
// está en .gitignore) y en los secrets del repositorio.
const password = randomBytes(24).toString('base64url');

console.log('Generando la clave de firma…');
execFileSync(
  'keytool',
  [
    '-genkeypair',
    '-keystore', jks,
    '-alias', alias,
    '-keyalg', 'RSA',
    '-keysize', '2048',
    '-validity', '10950',
    '-storetype', 'PKCS12',
    '-storepass', password,
    '-keypass', password,
    '-dname', 'CN=PerfectRest, OU=PerfectRest, O=PerfectRest, C=ES',
  ],
  { stdio: 'inherit', shell: true },
);

writeFileSync(
  props,
  [
    '# Generado por scripts/keystore.mjs. NUNCA se sube a git.',
    'storeFile=perfectrest-release.jks',
    `storePassword=${password}`,
    `keyAlias=${alias}`,
    `keyPassword=${password}`,
    '',
  ].join('\n'),
);

const base64 = readFileSync(jks).toString('base64');

console.log(`
Clave creada:  android/perfectrest-release.jks
Config local:  android/keystore.properties   (ya en .gitignore)

──────────────────────────────────────────────────────────────────
Guarda AHORA una copia del .jks fuera del proyecto. Sin ella, la
app instalada en tu móvil no podrá volver a actualizarse jamás.
──────────────────────────────────────────────────────────────────

Crea estos cuatro secrets en el repositorio, en
Settings → Secrets and variables → Actions, pestaña **Secrets**
(no "Variables": ese error da un fallo mudo en el workflow):

  KEYSTORE_BASE64    (el bloque de abajo, entero y sin saltos añadidos)
  KEYSTORE_PASSWORD  ${password}
  KEY_ALIAS          ${alias}
  KEY_PASSWORD       ${password}

KEYSTORE_BASE64:
${base64}
`);
