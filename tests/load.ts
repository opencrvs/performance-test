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
 *
 * Run with Grafana Cloud reporting:
 *   yarn test:load:cloud   (requires K6_CLOUD_TOKEN env var)
 */

import { check, sleep } from 'k6';
import type { Options } from 'k6/options';
import { authenticate, type Session } from '../src/auth';
import {
  assignEvent,
  createEvent,
  declareEvent,
  registerEvent,
  searchByTrackingId,
} from '../src/client';
import { generateDeclaration } from '../src/data';
import { config } from '../src/config';
import { productionThresholds } from '../src/thresholds';

// ─── Ramp stages ──────────────────────────────────────────────────────────────

/**
 * Hard ceiling on VU count. Override via MAX_VUS env var to stay within
 * Grafana Cloud project limits when running locally (free tier = 100 VUs).
 * k8s runs leave this unset and get the full 300.
 *
 *   MAX_VUS=100 yarn test:load:cloud   # local cloud run
 *   yarn test:load                      # local run, uncapped
 */
const MAX_VUS = parseInt(__ENV.MAX_VUS ?? '300', 10);

/**
 * Total VU targets per stage. Normal and high-latency scenarios are derived
 * from these by splitting 80% / 20% respectively. Each target is capped at
 * MAX_VUS so the ramp still makes sense at lower ceilings.
 */
const TOTAL_STAGES = [
  { duration: '2m', target: 25 },
  { duration: '5m', target: 25 },
  { duration: '3m', target: 50 },
  { duration: '5m', target: 50 },
  { duration: '3m', target: 100 },
  { duration: '5m', target: 100 },
  { duration: '5m', target: 200 },
  { duration: '5m', target: 200 },
  { duration: '5m', target: 300 },
  { duration: '10m', target: 300 },
];

function split(fraction: number) {
  return TOTAL_STAGES.map((s) => ({
    duration: s.duration,
    target: Math.min(Math.round(s.target * fraction), Math.round(MAX_VUS * fraction)),
  }));
}

// ─── Options ──────────────────────────────────────────────────────────────────

export const options: Options = {
  scenarios: {
    /** 80% of VUs — standard network conditions. */
    normal: {
      executor: 'ramping-vus',
      stages: split(0.8),
      exec: 'normalVU',
      startVUs: 0,
    },
    /** 20% of VUs — 200–500 ms artificial RTT delay per workflow step. */
    highLatency: {
      executor: 'ramping-vus',
      stages: split(0.2),
      exec: 'highLatencyVU',
      startVUs: 0,
    },
  },

  thresholds: {
    ...productionThresholds,
    // Abort early if the overall p95 sustains above 2 s for 30 s.
    // k6 re-evaluates the threshold after delayAbortEval; abort fires only if
    // it is still failing at that point, making this a sustained-violation check.
    'http_req_duration': [
      { threshold: 'p(95)<2000', abortOnFail: true, delayAbortEval: '30s' },
    ],
  },

  // Only include cloud metadata when the token is present.
  // k6 auto-enables cloud output when both K6_CLOUD_TOKEN and a cloud block
  // exist — without this guard a local run would stream to Grafana Cloud.
  ...(__ENV.K6_CLOUD_TOKEN ? { cloud: { name: 'OpenCRVS Load — tennis-club-membership' } } : {}),
};

// ─── Per-VU session ───────────────────────────────────────────────────────────

// Module-level vars are scoped per-VU in k6.
// Each VU authenticates once on its first iteration and reuses the token.
let session: Session;

function getSession(): Session {
  if (!session) {
    session = authenticate(config.gatewayUrl, config.username, config.password);
  }
  return session;
}

// ─── Workflow ─────────────────────────────────────────────────────────────────

function runWorkflow(highLatency: boolean): void {
  const { token, userId } = getSession();

  // High-latency VUs pause between steps to simulate a slow-network client.
  // The delay is randomised per step (200–500 ms) to avoid lock-step patterns.
  const networkDelay = () => {
    if (highLatency) sleep(Math.random() * 0.3 + 0.2);
  };

  // Step 1: Create event
  const event = createEvent(token);
  check(event, { 'event created: has id': (e) => Boolean(e?.id) });
  if (!event?.id) return;
  networkDelay();

  // Step 2: Declare
  declareEvent(token, event.id, generateDeclaration());
  networkDelay();

  // Step 3: Quick search by tracking ID
  const result = searchByTrackingId(token, event.trackingId);
  check(result, { 'search: event found': (r) => r?.total > 0 });
  networkDelay();

  // Step 4: Assign to self
  assignEvent(token, event.id, userId);
  networkDelay();

  // Step 5: Register
  registerEvent(token, event.id);

  // Think time between iterations — simulates a registrar moving to the next case.
  sleep(1);
}

// ─── Exec functions ───────────────────────────────────────────────────────────

export function normalVU(): void {
  runWorkflow(false);
}

export function highLatencyVU(): void {
  runWorkflow(true);
}
