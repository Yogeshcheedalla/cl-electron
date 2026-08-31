import { resolve, normalize, sep } from 'node:path'
import { settings } from './settings'

/** Locations Akansha refuses to touch regardless of the allow-list. */
const DENY = [
  'c:\\windows',
  'c:\\program files\\windowsapps',
  'c:\\$recycle.bin',
  'c:\\system volume information',
  'c:\\programdata\\microsoft\\windows\\start menu\\programs\\startup'
]

const SENSITIVE_FILES = [
  /\.env$/i,
  /id_rsa$/i,
  /\.pem$/i,
  /credentials(\.json)?$/i,
  /secrets\.bin$/i,
  /memkey\.bin$/i
]

export class PathDenied extends Error {}

const lower = (p: string) => p.toLowerCase().replace(/\//g, '\\')

/** Resolves and normalises a user/model supplied path, rejecting traversal escapes. */
export function safePath(input: string): string {
  if (!input || typeof input !== 'string') throw new PathDenied('A path is required.')
  const expanded = input.replace(/^~(?=$|[\\/])/, process.env.USERPROFILE ?? '')
  const abs = resolve(normalize(expanded))
  if (DENY.some((d) => lower(abs) === d || lower(abs).startsWith(d + sep))) {
    throw new PathDenied(`${abs} is a protected system location.`)
  }
  return abs
}

/** Read access: anywhere except protected system locations and secret-looking files. */
export function readablePath(input: string): string {
  const abs = safePath(input)
  if (SENSITIVE_FILES.some((r) => r.test(abs))) {
    throw new PathDenied(
      `${abs} looks like a credentials file, so Akansha will not read it. Open it yourself if you need its contents.`
    )
  }
  return abs
}

/** Write access: only inside the roots configured in Settings > Automation. */
export function writablePath(input: string): string {
  const abs = safePath(input)
  const roots = settings.get().automation.allowedRoots.map((r) => lower(resolve(r)))
  const target = lower(abs)
  const inside = roots.some((r) => target === r || target.startsWith(r.endsWith(sep) ? r : r + sep))
  if (!inside) {
    throw new PathDenied(
      `${abs} is outside the allowed write roots (${settings.get().automation.allowedRoots.join(', ')}). Add it in Settings > Automation to permit changes there.`
    )
  }
  return abs
}
