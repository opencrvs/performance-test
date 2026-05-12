/**
 * Load test — open-workload ramp to answer:
 * "How many simultaneous real users can OpenCRVS handle?"
 *
 * ── Open workload model: ramping-arrival-rate ────────────────────────────────
 *
 * We control the rate at which new workflow cycles start (open model). k6's
 * ramping-arrival-rate executor allocates exactly the number of VUs needed to
 * sustain the target rate given the observed iteration duration.
 *
 * Because every iteration includes realistic think time, the VU count at any
 * instant equals the number of concurrent logged-in users (Little's Law).
 *
 * ── Background polling ───────────────────────────────────────────────────────
 *
 * The OpenCRVS client polls two endpoints every ~20 s while the user is on the
 * workqueue view:
 *
 *   1. workqueue.count  — badge counts for every workqueue tab
 *   2. event.search     — paginated list for the currently-visible tab
 *
 * These fire continuously while the user is *not* inside a record (creating,
 * viewing, or editing). Each persona models this differently:
 *
 *   registrar  Polls workqueue → picks a case → stops polling while inside
 *              the registration workflow → returns to workqueue → polls again.
 *
 *   searcher   Polls workqueue → performs searches → views record → polls again.
 *
 *   reader     Polls workqueue → searches "John" → views a record → polls again.
 *
 * ── Three user personas ──────────────────────────────────────────────────────
 *
 *   registrar  (50 % of arrivals)  Avg cycle: ~3.5 min
 *   searcher   (30 % of arrivals)  Avg cycle: ~2 min
 *   reader     (20 % of arrivals)  Avg cycle: ~6 min (mostly polling)
 *
 * ── Reading the result ───────────────────────────────────────────────────────
 *
 *   The peak VU count in the summary = peak concurrent real users.
 *
 * Run locally:
 *   yarn test:load
 */

import { check, sleep } from "k6";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.0.2/index.js";
import type { Options } from "k6/options";
import { getSession } from "../src/session";
import {
  assignEvent,
  createEvent,
  declareEvent,
  findUser,
  getEvent,
  registerEvent,
  searchByName,
  searchByTrackingId,
  workqueueCount,
  workqueueSearch,
} from "../src/client";
import { generateDeclaration } from "../src/data";
import { productionThresholds } from "../src/thresholds";

// ─── Configuration ────────────────────────────────────────────────────────────

const MAX_RATE = parseFloat(__ENV.MAX_RATE ?? "5");
const MAX_VUS = parseInt(__ENV.MAX_VUS ?? "1200", 10);

/** How often the client polls workqueue endpoints (seconds). */
const POLL_INTERVAL = 20;

// ─── Session bootstrap ───────────────────────────────────────────────────────

interface VUContext {
  token: string;
  userId: string;
  locationId: string;
}

/**
 * Authenticate and resolve the user's administrative location.
 * Called once at the start of every VU iteration.
 */
function getVUContext(): VUContext | null {
  const { token, userId } = getSession();
  const user = findUser(token, userId) as {
    administrativeAreaId?: string;
  } | null;

  if (!user?.administrativeAreaId) {
    console.error(`Could not resolve locationId for user ${userId}`);
    return null;
  }

  return { token, userId, locationId: user.administrativeAreaId };
}

// ─── Polling helpers ──────────────────────────────────────────────────────────

function pollWorkqueue(ctx: VUContext): void {
  workqueueCount(ctx.token, ctx.userId, ctx.locationId);
  workqueueSearch(ctx.token, ctx.locationId);
}

/**
 * Simulate a user sitting on the workqueue page for `durationS` seconds.
 * Fires both polling queries immediately, then every POLL_INTERVAL seconds.
 */
function stayOnWorkqueue(ctx: VUContext, durationS: number): void {
  const deadline = Date.now() + durationS * 1000;

  // Initial poll on page load
  pollWorkqueue(ctx);

  while (Date.now() < deadline) {
    const remaining = (deadline - Date.now()) / 1000;
    const waitTime = Math.min(POLL_INTERVAL, remaining);
    if (waitTime <= 0) break;
    sleep(waitTime);
    if (Date.now() < deadline) {
      pollWorkqueue(ctx);
    }
  }
}

// ─── Think time helper ────────────────────────────────────────────────────────

function think(minS: number, maxS: number): void {
  sleep(minS + Math.random() * (maxS - minS));
}

// ─── Arrival-rate stages ──────────────────────────────────────────────────────

const RATE_STAGES = [
  { duration: "3m", target: 0.05 },
  { duration: "5m", target: 0.1 },
  { duration: "5m", target: 0.2 },
  { duration: "5m", target: 0.4 },
  { duration: "5m", target: 0.6 },
  { duration: "5m", target: 0.8 },
  { duration: "10m", target: 1.0 },
];

function rateStages(weight: number) {
  return RATE_STAGES.map((s) => ({
    duration: s.duration,
    target: Math.max(1, Math.round(MAX_RATE * s.target * weight)),
  }));
}

// ─── Options ──────────────────────────────────────────────────────────────────

export const options: Options = {
  scenarios: {
    registrar: {
      executor: "ramping-arrival-rate",
      timeUnit: "1s",
      stages: rateStages(0.5),
      preAllocatedVUs: Math.round(MAX_VUS * 0.45),
      maxVUs: Math.round(MAX_VUS * 0.5),
      exec: "registrarVU",
    },
    searcher: {
      executor: "ramping-arrival-rate",
      timeUnit: "1s",
      stages: rateStages(0.3),
      preAllocatedVUs: Math.round(MAX_VUS * 0.15),
      maxVUs: Math.round(MAX_VUS * 0.2),
      exec: "searcherVU",
    },
    reader: {
      executor: "ramping-arrival-rate",
      timeUnit: "1s",
      stages: rateStages(0.2),
      preAllocatedVUs: Math.round(MAX_VUS * 0.25),
      maxVUs: Math.round(MAX_VUS * 0.3),
      exec: "readerVU",
    },
  },

  thresholds: {
    ...productionThresholds,
    http_req_duration: [
      { threshold: "p(95)<2000", abortOnFail: true, delayAbortEval: "30s" },
    ],
    'http_req_duration{name:"workqueue.count"}': ["p(95)<3000"],
    'http_req_duration{name:"workqueue.search"}': ["p(95)<3000"],
  },
};

// ─── Persona workflows ───────────────────────────────────────────────────────

/**
 * Registrar: workqueue (polling) → registration workflow → workqueue (polling).
 *
 * Timeline:
 *   [workqueue 30-60s] → [create+declare 60-120s] → [search+assign+register 20-50s] → [workqueue 30-90s]
 */
export function registrarVU(): void {
  const ctx = getVUContext();
  if (!ctx) return;

  // Phase 1: Browsing the workqueue (30–60 s)
  stayOnWorkqueue(ctx, 30 + Math.random() * 30);

  // Phase 2: Inside the registration form — no polling

  // Step 1: Create event
  const event = createEvent(ctx.token);
  check(event, { "registrar: event created": (e) => Boolean(e?.id) });
  if (!event?.id) return;

  // Filling in the declaration (60–120 s)
  think(60, 120);

  // Step 2: Declare
  const declaration = generateDeclaration();
  declareEvent(ctx.token, event.id, declaration);
  think(5, 15);

  // Step 3: Search by tracking ID
  const result = searchByTrackingId(ctx.token, event.trackingId);
  check(result, { "registrar: search found": (r) => (r?.total ?? 0) > 0 });
  think(10, 30);

  // Step 4: Assign to self
  assignEvent(ctx.token, event.id, ctx.userId);
  think(5, 10);

  // Step 5: Register
  registerEvent(ctx.token, event.id, declaration);

  // Phase 3: Back on workqueue before next case (30–90 s)
  stayOnWorkqueue(ctx, 30 + Math.random() * 60);
}

/**
 * Searcher: workqueue (polling) → search + view record → workqueue (polling).
 *
 * Timeline:
 *   [workqueue 20-40s] → [search "John" + review 20-40s] → [view record 15-30s] → [workqueue 30-60s]
 */
export function searcherVU(): void {
  const ctx = getVUContext();
  if (!ctx) return;

  // Phase 1: Workqueue (20–40 s)
  stayOnWorkqueue(ctx, 20 + Math.random() * 20);

  // Phase 2: Performs a name search — leaves workqueue view
  const result = searchByName(ctx.token, "John");

  // User scans results (20–40 s)
  think(20, 40);

  // Opens a random record if any were found
  if (result && result.results.length > 0) {
    const randomRecord =
      result.results[Math.floor(Math.random() * result.results.length)];
    getEvent(ctx.token, randomRecord.id);
    // Reads the record (15–30 s)
    think(15, 30);
  }

  // Phase 3: Back to workqueue (30–60 s)
  stayOnWorkqueue(ctx, 30 + Math.random() * 30);
}

/**
 * Reader (supervisor): workqueue (polling) → searches "John" → views a random
 * record → back to workqueue (polling).
 *
 * Mostly idle. The bulk of the session is workqueue polling.
 *
 * Timeline:
 *   [workqueue 120-180s] → [search "John" + review 20-40s] → [view record 30-60s] → [workqueue 180-300s]
 */
export function readerVU(): void {
  const ctx = getVUContext();
  if (!ctx) return;

  // Phase 1: Sitting on workqueue (120–180 s)
  stayOnWorkqueue(ctx, 120 + Math.random() * 60);

  // Phase 2: Searches for "John"
  const result = searchByName(ctx.token, "John");

  // Scans results (20–40 s)
  think(20, 40);

  // Opens a random record
  if (result && result.results.length > 0) {
    const randomRecord =
      result.results[Math.floor(Math.random() * result.results.length)];
    getEvent(ctx.token, randomRecord.id);
    // Reads the record details (30–60 s)
    think(30, 60);
  }

  // Phase 3: Back to workqueue for a long idle stretch (180–300 s)
  stayOnWorkqueue(ctx, 180 + Math.random() * 120);
}

// ─── Summary ──────────────────────────────────────────────────────────────────

export function handleSummary(data: unknown) {
  return {
    stdout: textSummary(data, { indent: " ", enableColors: false }),
    "summary.json": JSON.stringify(data),
  };
}
