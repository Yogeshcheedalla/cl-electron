import type { AkanshaApi } from '../../shared/api'

/**
 * The only global the renderer may touch. Everything else about the machine --
 * files, processes, shells, secrets -- is reachable exclusively through these
 * whitelisted channels.
 */
declare global {
  interface Window {
    akansha: AkanshaApi
  }
}

export { }
