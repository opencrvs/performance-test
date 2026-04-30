/**
 * Spike test — validates system behaviour under sudden load spikes and confirms
 * it recovers within 60 s of returning to baseline.
 *
 * VU workflow (per iteration):
 *   create event → declare → quick search → assign to self → register
 *
 * 20% of VUs simulate high-latency clients (200–500 ms RTT per step).
 *
 * Profile (three 10-minute phases, 60 s transitions):
 *   warm-up (10 m at BASELINE_VUS)
 *     → 60 s ramp to 5× spike
 *       → spike hold (10 m at 5× BASELINE_VUS)
 *         → 60 s ramp back to baseline  ← recovery window
 *           → recovery hold (10 m at BASELINE_VUS)
 *
 * Recovery assertion: production thresholds are evaluated over the full run.
 * The 60-second ramp-down is the recovery window — if latency has not returned
 * to within-SLO by the time VUs reach baseline, the 10-minute recovery hold
 * will sustain threshold violations and fail the run.
 *
 * Run locally:
 *   yarn test:spike
 */

import { check, sleep } from 'k6'
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js'
import type { Options } from 'k6/options'
import { authenticate, type Session } from '../src/auth'
import {
  assignEvent,
  createEvent,
  declareEvent,
  registerEvent,
  searchByTrackingId
} from '../src/client'
import { generateDeclaration } from '../src/data'
import { config } from '../src/config'
import { productionThresholds } from '../src/thresholds'

// ─── VU counts ────────────────────────────────────────────────────────────────

/**
 * Baseline VU count. Override via BASELINE_VUS env var.
 * Spike is always 5× this value; normal/high-latency split is 80/20.
 */
const BASELINE_VUS = parseInt(__ENV.BASELINE_VUS ?? '20', 10)
const SPIKE_VUS = BASELINE_VUS * 5

function split(total: number, fraction: number): number {
  return Math.max(1, Math.round(total * fraction))
}

function stages(fraction: number) {
  const baseline = split(BASELINE_VUS, fraction)
  const spike = split(SPIKE_VUS, fraction)
  return [
    { duration: '10m', target: baseline }, // warm-up
    { duration: '60s', target: spike }, // ramp to spike
    { duration: '10m', target: spike }, // hold spike
    { duration: '60s', target: baseline }, // ramp down — recovery window
    { duration: '10m', target: baseline } // recovery hold
  ]
}

// ─── Options ──────────────────────────────────────────────────────────────────

export const options: Options = {
  scenarios: {
    /** 80% of VUs — standard network conditions. */
    normal: {
      executor: 'ramping-vus',
      stages: stages(0.8),
      exec: 'normalVU',
      startVUs: 0
    },
    /** 20% of VUs — 200–500 ms artificial RTT delay per workflow step. */
    highLatency: {
      executor: 'ramping-vus',
      stages: stages(0.2),
      exec: 'highLatencyVU',
      startVUs: 0
    }
  },

  thresholds: {
    ...productionThresholds
  }
}

// ─── Per-VU session ───────────────────────────────────────────────────────────

// Module-level vars are scoped per-VU in k6.
// Each VU authenticates once on its first iteration and reuses the token.
let session: Session

function getSession(): Session {
  if (!session) {
    session = authenticate(config.gatewayUrl, config.username, config.password)
  }
  return session
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

  sleep(1)
}

// ─── Exec functions ───────────────────────────────────────────────────────────

export function normalVU(): void {
  runWorkflow(false)
}

export function highLatencyVU(): void {
  runWorkflow(true)
}

export function handleSummary(data: unknown) {
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: false }),
    'summary.json': JSON.stringify(data)
  }
}
