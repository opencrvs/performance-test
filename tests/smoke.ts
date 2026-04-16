/**
 * Smoke test — validates the full VU workflow end-to-end.
 *
 * Intentionally small: 1 VU, 5 iterations, relaxed thresholds.
 * Purpose: catch broken endpoints before running a full load test.
 *
 * Run locally:
 *   yarn test:smoke
 *
 * Run with Grafana Cloud reporting:
 *   yarn test:smoke:cloud        (requires K6_CLOUD_TOKEN env var)
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
import { smokeThresholds } from '../src/thresholds';

export const options: Options = {
  vus: 1,
  iterations: 5,
  thresholds: smokeThresholds,
  // Only include cloud metadata when the token is present.
  // k6 auto-enables cloud output when both K6_CLOUD_TOKEN and a cloud block
  // exist — without this guard a local run would stream to Grafana Cloud.
  ...(__ENV.K6_CLOUD_TOKEN ? { cloud: { name: 'OpenCRVS Smoke — tennis-club-membership' } } : {}),
};

// Per-VU session — initialised on first iteration, reused for the rest.
let session: Session;

export default function () {
  // ── Auth (once per VU) ────────────────────────────────────────────────────
  if (!session) {
    session = authenticate(config.gatewayUrl, config.username, config.password);
  }
  const { token, userId } = session;

  // ── Step 1: Create event ──────────────────────────────────────────────────
  const event = createEvent(token);

  check(event, {
    'event created: has id': (e) => Boolean(e?.id),
    'event created: has trackingId': (e) => Boolean(e?.trackingId),
  });

  if (!event?.id) {
    console.error('createEvent returned no id — skipping iteration');
    return;
  }

  // ── Step 2: Declare ───────────────────────────────────────────────────────
  declareEvent(token, event.id, generateDeclaration());

  // ── Step 3: Search for the event ──────────────────────────────────────────
  const searchResult = searchByTrackingId(token, event.trackingId);

  check(searchResult, {
    'search: event found': (r) => r?.total > 0,
  });

  // ── Step 4: Assign to self ────────────────────────────────────────────────
  assignEvent(token, event.id, userId);

  // ── Step 5: Register ──────────────────────────────────────────────────────
  registerEvent(token, event.id);

  sleep(1);
}
