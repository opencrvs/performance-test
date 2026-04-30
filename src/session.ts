import { sleep } from 'k6'
import { authenticate, type Session } from './auth'
import { config } from './config'

// Module-level var is scoped per-VU in k6 — each VU gets its own session.
let session: Session

export function getSession(): Session {
  const nowSec = Date.now() / 1000
  const needsAuth = !session || session.expiresAt - nowSec < 60

  if (needsAuth) {
    // Spread initial auth bursts across 2 s to avoid a thundering herd at
    // stage transitions when many VUs start simultaneously.
    if (!session) sleep(Math.random() * 2)
    session = authenticate(config.gatewayUrl, config.username, config.password)
  }

  return session
}
