import { api, tokens } from './api'

/**
 * Signs this browser out and goes to the sign-in page. Shared by the sidebar's
 * button and the menu under the initials in the top bar, so both do the same.
 */
export async function signOut(go: (href: string) => void): Promise<void> {
  try {
    await api.post('/auth/logout', {})
  } catch {
    // Signing out must work even when the server cannot be reached: the
    // tokens live in this browser and clearing them is what actually matters.
  }
  tokens.clear()
  go('/login')
}
