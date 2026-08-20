import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Repositorio del canal de autoactualización, en formato "owner/repo".
 *
 * Se deduce del remoto de git en vez de escribirlo a mano: así un fork o un
 * cambio de nombre no dejan la app mirando al repositorio equivocado. En CI
 * llega directamente en GITHUB_REPOSITORY. Si no hay remoto, queda vacío y la
 * autoactualización se desactiva sola.
 */
function updateRepo(): string {
  const fromEnv = process.env.UPDATE_REPO ?? process.env.GITHUB_REPOSITORY
  if (fromEnv) return fromEnv

  try {
    const url = execSync('git remote get-url origin', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
    const match = url.match(/github\.com[:/]+([^/]+\/[^/]+?)(?:\.git)?$/i)
    return match ? match[1] : ''
  } catch {
    return ''
  }
}

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __UPDATE_REPO__: JSON.stringify(updateRepo()),
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
})
