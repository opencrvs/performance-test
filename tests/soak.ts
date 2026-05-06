/**
 * Soak test — validates system stability under sustained production-equivalent
 * load over a long-running session.
 *
 * VU workflow (per iteration):
 *   create event → declare → quick search → assign to self → register
 *
 * Load profile:
 *   50 constant VUs (40 normal + 10 high-latency) for 5 hours. The duration
 *   fits inside the 6-hour GitHub-hosted runner job ceiling with headroom for
 *   build, setup, and summary.
 *   Think time is randomised to 115–175 s per iteration so each VU completes
 *   one full workflow in 2–3 minutes, sustaining ~20 events/minute — matching
 *   the 1.5× production target (~21/min) from the README.
 *
 * Pass criteria:
 *   - All production response time thresholds hold for the full duration.
 *   - Error rate stays below 0.1%.
 *   - Memory consumption must plateau; a sustained upward trend fails the run
 *     (checked via infrastructure health monitoring — Section 2 of the test plan).
 *
 * Run locally:
 *   yarn test:soak
 */

import { check, sleep } from 'k6'
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js'
import type { Options } from 'k6/options'
import { getSession } from '../src/session'
import {
  assignEvent,
  createEvent,
  declareEvent,
  findUser,
  registerEvent,
  searchByTrackingId
} from '../src/client'
import { generateDeclaration } from '../src/data'
import { productionThresholds } from '../src/thresholds'

// ─── VU counts ────────────────────────────────────────────────────────────────

/**
 * Total concurrent VUs. Midpoint of the 40–60 range in the README.
 * Override via SOAK_VUS env var when running closer to the boundary.
 */
const TOTAL_VUS = parseInt(__ENV.SOAK_VUS ?? '50', 10)
const NORMAL_VUS = Math.round(TOTAL_VUS * 0.8)
const HIGH_LATENCY_VUS = Math.round(TOTAL_VUS * 0.2)
const USER_LOOKUP_VUS = Math.max(1, Math.round(TOTAL_VUS * 0.1))

// ─── Options ──────────────────────────────────────────────────────────────────

export const options: Options = {
  scenarios: {
    /** 80% of VUs — standard network conditions. */
    normal: {
      executor: 'constant-vus',
      vus: NORMAL_VUS,
      duration: '5h',
      exec: 'normalVU'
    },
    /** 20% of VUs — 200–500 ms artificial RTT delay per workflow step. */
    highLatency: {
      executor: 'constant-vus',
      vus: HIGH_LATENCY_VUS,
      duration: '5h',
      exec: 'highLatencyVU'
    },
    /** 10% of VUs — standalone user lookups to measure read-path SLO. */
    userLookup: {
      executor: 'constant-vus',
      vus: USER_LOOKUP_VUS,
      duration: '5h',
      exec: 'userLookupVU'
    }
  },

  thresholds: {
    ...productionThresholds
  }
}

// ─── Workflow ─────────────────────────────────────────────────────────────────

function runWorkflow(highLatency: boolean): void {
  const { token, userId } = getSession()

  const networkDelay = () => {
    if (highLatency) sleep(Math.random() * 0.3 + 0.2)
  }

  const event = createEvent(token)
  check(event, { 'event created: has id': (e) => Boolean(e?.id) })
  if (!event?.id) return
  networkDelay()

  const declaration = generateDeclaration()
  declareEvent(token, event.id, declaration)
  networkDelay()
  sleep(1.5)

  const result = searchByTrackingId(token, event.trackingId)
  check(result, { 'search: event found': (r) => r?.total > 0 })
  networkDelay()

  assignEvent(token, event.id, userId)
  networkDelay()

  registerEvent(token, event.id, declaration)

  // Think time: randomised 115–175 s so total iteration ≈ 2–3 min.
  // At 50 VUs × 1 iter per ~2.5 min → ~20 events/min ≈ the 21/min target.
  sleep(Math.random() * 60 + 115)
}

// ─── Exec functions ───────────────────────────────────────────────────────────

export function normalVU(): void {
  runWorkflow(false)
}

export function highLatencyVU(): void {
  runWorkflow(true)
}

export function userLookupVU(): void {
  const { token, userId } = getSession()
  findUser(token, userId)
  sleep(1)
}

export function handleSummary(data: unknown) {
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: false }),
    'summary.json': JSON.stringify(data)
  }
}
