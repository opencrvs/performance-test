/**
 * Smoke test — validates the full VU workflow end-to-end.
 *
 * Intentionally small: 1 VU, 5 iterations, relaxed thresholds.
 * Purpose: catch broken endpoints before running a full load test.
 *
 * Run locally:
 *   yarn test:smoke
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
import { smokeThresholds } from '../src/thresholds'

export const options: Options = {
  vus: 1,
  iterations: 5,
  thresholds: smokeThresholds
}

export default function () {
  const { token, userId } = getSession()

  // ── Step 1: Create event ──────────────────────────────────────────────────
  const event = createEvent(token)

  check(event, {
    'event created: has id': (e) => Boolean(e?.id),
    'event created: has trackingId': (e) => Boolean(e?.trackingId)
  })

  if (!event?.id) {
    console.error('createEvent returned no id — skipping iteration')
    return
  }

  // ── Step 2: Declare ───────────────────────────────────────────────────────
  const declaration = generateDeclaration()
  declareEvent(token, event.id, declaration)

  // ── Step 3: Search for the event ──────────────────────────────────────────
  sleep(1.5)
  const searchResult = searchByTrackingId(token, event.trackingId)

  check(searchResult, {
    'search: event found': (r) => r?.total > 0
  })

  // ── Step 4: Assign to self ────────────────────────────────────────────────
  assignEvent(token, event.id, userId)

  // ── Step 5: Register ──────────────────────────────────────────────────────
  registerEvent(token, event.id, declaration)

  // ── Step 6: Find user ─────────────────────────────────────────────────────
  findUser(token, userId)

  sleep(1)
}

export function handleSummary(data: unknown) {
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: false }),
    'summary.json': JSON.stringify(data)
  }
}
