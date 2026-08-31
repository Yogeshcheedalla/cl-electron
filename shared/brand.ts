/**
 * The product word and its motto, in one place so the wordmark cannot drift
 * between the titlebar, the dashboard, the tray tooltip and anything added
 * later. It lives in `shared/` because both processes need it.
 *
 * The motto is a claim the app actually keeps: every tool call goes through
 * `electron/services/guard.ts`, and a CONFIRM or PRIVILEGED tool prompts before
 * it touches the machine.
 */
export const PRODUCT = 'Akansha'

export const MOTTO = 'Real tools on this machine — and it asks first.'
