/**
 * The gate for the local sampling pilot.
 *
 * Sampling is being rebuilt against a database on this machine, and nothing
 * the pilot does may reach the shared one. Every pilot-only feature (the
 * sampling routes, and file storage on local disk) asks this one question, so
 * they all close together: the flag has to be on, the server must not be
 * running as production, and both database URLs have to point at the loopback
 * lderp_sampling database. A flag left switched on against the live
 * connection string therefore switches nothing on.
 *
 * Read on every call rather than once at start-up, so a check script can
 * change the environment and watch the gate close.
 */
export function samplingPilotEnabled(): boolean {
  if (process.env.SAMPLING_ENABLED !== 'true' || process.env.NODE_ENV === 'production') return false
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
