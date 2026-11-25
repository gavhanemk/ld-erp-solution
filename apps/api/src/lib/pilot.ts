/**
 * Whether this server runs Sampling: SAMPLING_ENABLED=true. The module's
 * routes, sample stores, sample needs in Purchase and its number series in
 * Settings all ask this one question, so they switch on and off together.
 * Off unless set: a server that has not chosen to run Sampling behaves as it
 * did before the module came. The screens ask NEXT_PUBLIC_SAMPLING_ENABLED,
 * which is set beside it.
 *
 * Read on every call rather than once at start-up, so a check script can
 * change the environment and watch it close.
 */
export function samplingEnabled(): boolean {
  return process.env.SAMPLING_ENABLED === 'true'
}

/**
 * The gate for the local sampling pilot's own conveniences — files kept on
 * this machine's disk instead of the storage bucket. Nothing the pilot keeps
 * locally may stand in for the shared server's storage, so this is strict:
 * Sampling has to be on, the server must not be running as production, and
 * both database URLs have to point at the loopback lderp_sampling database.
 * A flag left switched on against the live connection string therefore turns
 * none of this on.
 */
export function samplingPilotEnabled(): boolean {
  if (!samplingEnabled() || process.env.NODE_ENV === 'production') return false
  return ['DATABASE_URL', 'DIRECT_URL'].every((k) => {
    try {
      const u = new URL(process.env[k] ?? '')
      // Postgres drivers let a ?host= or ?hostaddr= parameter override the host
      // written before the path, so a loopback-looking URL could still connect
      // elsewhere. The pilot's own URLs never carry either; refuse them outright.
      const hostOverride = [...u.searchParams.keys()].some((p) =>
        ['host', 'hostaddr'].includes(p.toLowerCase())
      )
      return (
        ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) &&
        u.pathname === '/lderp_sampling' &&
        !hostOverride
      )
    } catch {
      return false
    }
  })
}

/**
 * The address the API listens on. The local pilot answers only this machine,
 * so its fictional data is never open to the office network. Every other
 * server listens on all addresses, the live one included with Sampling
 * switched on: Render reaches the API from outside the machine, and a live
 * API listening on loopback would answer no one.
 */
export function apiListenHost(): string {
  return samplingPilotEnabled() ? '127.0.0.1' : '0.0.0.0'
}
