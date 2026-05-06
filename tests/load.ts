/**
 * Load test — staged ramp-up to find the system's breaking point.
 *
 * VU workflow (per iteration):
 *   create event → declare → quick search → assign to self → register
 *
 * 20% of VUs simulate high-latency clients (200–500 ms RTT per workflow step).
 *
 * Termination:
 *   - Normal: all stages complete.
 *   - Early: overall p95 latency exceeds 2 s. delayAbortEval: '30s' means the
 *     test won't abort until the threshold has been continuously failing for
 *     30 s, so brief spikes during stage transitions do not trigger early exit.
 *
 * Run locally:
 *   yarn test:load
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

// ─── Ramp stages ──────────────────────────────────────────────────────────────

/**
 *   MAX_VUS=100 yarn test:load:cloud   # local cloud run
 *   yarn test:load                      # local run, uncapped
 */
const MAX_VUS = parseInt(__ENV.MAX_VUS ?? '300', 10)

/**
 * Total VU targets per stage. Normal and high-latency scenarios are derived
 * from these by splitting 80% / 20% respectively. Each target is capped at
 * MAX_VUS so the ramp still makes sense at lower ceilings.
 */
const TOTAL_STAGES = [
  { duration: '2m', target: 5 },
  { duration: '5m', target: 10 },
  { duration: '3m', target: 15 },
  { duration: '5m', target: 20 },
  { duration: '3m', target: 25 },
  { duration: '5m', target: 30 },
  { duration: '5m', target: 35 },
  { duration: '5m', target: 40 },
  { duration: '5m', target: 45 },
  { duration: '10m', target: 50 }
]

function split(fraction: number) {
  return TOTAL_STAGES.map((s) => ({
    duration: s.duration,
    target: Math.min(
      Math.round(s.target * fraction),
      Math.round(MAX_VUS * fraction)
    )
  }))
}

// ─── Options ──────────────────────────────────────────────────────────────────

export const options: Options = {
  scenarios: {
    /** 80% of VUs — standard network conditions. */
    normal: {
      executor: 'ramping-vus',
      stages: split(0.8),
      exec: 'normalVU',
      startVUs: 0
    },
    /** 20% of VUs — 200–500 ms artificial RTT delay per workflow step. */
    highLatency: {
      executor: 'ramping-vus',
      stages: split(0.2),
      exec: 'highLatencyVU',
      startVUs: 0
    },
    /** 10% of VUs — standalone user lookups to measure read-path SLO. */
    userLookup: {
      executor: 'ramping-vus',
      stages: split(0.1),
      exec: 'userLookupVU',
      startVUs: 0
    }
  },

  thresholds: {
    ...productionThresholds,
    // Abort early if the overall p95 sustains above 2 s for 30 s.
    // k6 re-evaluates the threshold after delayAbortEval; abort fires only if
    // it is still failing at that point, making this a sustained-violation check.
    http_req_duration: [
      { threshold: 'p(95)<2000', abortOnFail: true, delayAbortEval: '30s' }
    ]
  }
}

// ─── Workflow ─────────────────────────────────────────────────────────────────

function runWorkflow(highLatency: boolean): void {
  const { token, userId } = getSession()

  // High-latency VUs pause between steps to simulate a slow-network client.
  // The delay is randomised per step (200–500 ms) to avoid lock-step patterns.
  const networkDelay = () => {
    if (highLatency) sleep(Math.random() * 0.3 + 0.2)
  }

  // Step 1: Create event
  const event = createEvent(token)
  check(event, { 'event created: has id': (e) => Boolean(e?.id) })
  if (!event?.id) return
  networkDelay()

  // Step 2: Declare
  const declaration = generateDeclaration()
  declareEvent(token, event.id, declaration)
  networkDelay()

  // Wait for Elasticsearch to refresh before searching.
  sleep(1.5)

  // Step 3: Quick search by tracking ID
  const result = searchByTrackingId(token, event.trackingId)
  check(result, { 'search: event found': (r) => (r?.total ?? 0) > 0 })
  networkDelay()

  // Step 4: Assign to self
  assignEvent(token, event.id, userId)
  networkDelay()

  // Step 5: Register
  registerEvent(token, event.id, declaration)

  // Think time between iterations — simulates a registrar moving to the next case.
  sleep(1)
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
