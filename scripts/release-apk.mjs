/**
 * Compila la APK de release firmada y deja el fichero listo para publicar.
 *
 *   node scripts/release-apk.mjs
 *
 * Es el mismo script que ejecuta GitHub Actions, a propósito: la alternativa
 * era reescribir la lógica del build en el workflow y tener dos sitios que se
 * desincronizan. Aquí sólo se orquesta, todo lo específico de Android vive en
 * `android/app/build.gradle`.
 *
 * En CI, además, escribe versionName y versionCode en GITHUB_OUTPUT para que el
 * paso de la release pueda etiquetarla.
 */
import { execFileSync, execSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'release');
const isCI = process.env.CI === 'true';

/**
 * Suelo del versionCode. Las APK anteriores a este canal se publicaron con
 * `versionCode 1`; si el número de commits no lo superase, Android rechazaría
 * la actualización sin decir por qué. Es justo el tipo de fallo mudo que hay
 * que convertir en un error ruidoso.
 */
const MIN_VERSION_CODE = 1;

function run(command, args, options = {}) {
  console.log(`\n> ${command} ${args.join(' ')}`);
  execFileSync(command, args, { cwd: root, stdio: 'inherit', shell: true, ...options });
}

function versionCode() {
  try {
    const out = execSync('git rev-list --count HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
    return Number(out.toString().trim()) || 0;
  } catch {
    return 0;
  }
}

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const versionName = pkg.version;
const code = versionCode();

console.log(`PerfectRest ${versionName} (build ${code})`);

if (code <= MIN_VERSION_CODE) {
  console.error(
    `\nERROR: versionCode ${code} no supera al ya publicado (${MIN_VERSION_CODE}).\n` +
      'Android sólo acepta actualizar a un versionCode estrictamente mayor. ' +
      'Comprueba que el checkout trae la historia completa (fetch-depth: 0).',
  );
  process.exit(1);
}

// Sin clave propia la APK se firma con la de debug, que cambia de máquina a
// máquina: publicar eso rompería el canal para todo el que ya la tenga
// instalada, con INSTALL_FAILED_UPDATE_INCOMPATIBLE.
if (!existsSync(resolve(root, 'android/keystore.properties'))) {
  const message =
    'No hay android/keystore.properties: la APK se firmaría con la clave de debug.';
  if (isCI) {
    console.error(`::error::${message}`);
    process.exit(1);
  }
  console.warn(`\nAVISO: ${message}\nSirve para probar en local, no para publicar.\n`);
}

run('npm', ['run', 'build']);
run('npx', ['cap', 'sync', 'android']);

const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
run(gradlew, ['assembleRelease'], { cwd: resolve(root, 'android') });

const built = resolve(root, 'android/app/build/outputs/apk/release/app-release.apk');
if (!existsSync(built)) {
  console.error(`\nERROR: no se generó ${built}`);
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const tag = `v${versionName}-b${code}`;
const target = resolve(outDir, `PerfectRest-${tag}.apk`);
copyFileSync(built, target);

console.log(`\nAPK lista: release/PerfectRest-${tag}.apk`);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `versionName=${versionName}\nversionCode=${code}\ntag=${tag}\n`,
  );
  // Las anotaciones de un repositorio público se leen por la API sin
  // credenciales, al revés que los logs: son el mejor sitio para el
  // diagnóstico si algo falla en CI.
  console.log(`::notice::PerfectRest ${tag} compilada y firmada`);
}
