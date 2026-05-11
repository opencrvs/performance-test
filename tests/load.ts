/**
 * Concurrent-user capacity test.
 *
 * Answers: "How many simultaneous real users can OpenCRVS handle?"
 *
 * ── Open workload model: ramping-arrival-rate ────────────────────────────────
 *
 * Instead of controlling the number of VUs directly (closed model), we control
 * the rate at which new workflow cycles start (open model). k6's
 * ramping-arrival-rate executor allocates exactly the number of VUs needed to
 * sustain the target rate given the observed iteration duration.
 *
 * Because every iteration includes realistic think time (the time the user
 * spends reading, typing, and idling), the VU count at any instant equals the
 * number of concurrent logged-in users. This follows directly from Little's Law:
 *
 *   N = λ × W
 *
 *   N  concurrent users (VUs at any moment)  ← the answer we want
 *   λ  arrival rate (new cycle starts per second)
 *   W  average time one complete user cycle takes, including think time (s)
 *
 * Example: λ = 1 workflow/s, W = 225 s  →  N = 225 concurrent registrars.
 *
 * The test ramps λ from near-zero to MAX_RATE/s in stages and aborts when p95
 * latency sustains above 2 s for 30 s. The peak VU count at that moment is the
 * answer.
 *
 * ── Three user personas ──────────────────────────────────────────────────────
 *
 *   registrar  (50 % of arrivals)
 *     Full create → declare → search → assign → register workflow.
 *     Think time: 60–120 s filling the form, 30–90 s between cases.
 *     Avg cycle: ~3.5 min. Drives the highest per-VU request rate.
 *
 *   searcher   (30 % of arrivals)
 *     Looks up existing records by status, opens one for detail.
 *     Avg cycle: ~2 min. Moderate request rate.
 *
 *   reader     (20 % of arrivals)
 *     Supervisor / admin who glances at the workqueue then does other work.
 *     Avg cycle: ~6 min (mostly idle). Low request rate but HIGH VU count
 *     because the long idle inflates W in Little's Law. This persona dominates
 *     the "logged-in but not actively processing" population.
 *
 * ── Reading the result ───────────────────────────────────────────────────────
 *
 *   The summary prints the peak VU count = peak concurrent real users.
 *
 */

import { check, sleep } from "k6";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.0.2/index.js";
import type { Options } from "k6/options";
import { getSession } from "../src/session";
import {
  assignEvent,
  createEvent,
  declareEvent,
  getEvent,
  findUser,
  registerEvent,
  searchByStatus,
  searchByTrackingId,
} from "../src/client";
import { generateDeclaration } from "../src/data";
import { productionThresholds } from "../src/thresholds";

// ─── Config ───────────────────────────────────────────────────────────────────

/**
 * Peak combined arrival rate across all three scenarios (workflows/second).
 * Each scenario gets a fraction: registrar 50 %, searcher 30 %, reader 20 %.
 *
 * Estimated concurrent users at MAX_RATE=2 (Little's Law, avg cycle times):
 *   registrar: 1.0/s × 225 s  = 225 concurrent
 *   searcher:  0.6/s × 120 s  =  72 concurrent
 *   reader:    0.4/s × 350 s  = 140 concurrent
 *   ─────────────────────────────────────────────
 *   Total ≈ 437 concurrent real users at peak
 */
const MAX_RATE = parseFloat(__ENV.MAX_RATE ?? "2");

// ─── Arrival rate ramp stages ─────────────────────────────────────────────────

/**
 * Combined target arrival rate per stage. Each scenario receives a scaled
 * fraction via split(). Stages ramp gradually so the system warms up properly
 * and the 30-second abort delay gives a clean signal before overshooting.
 *
 * Approximate combined concurrent users at each stage (avg W across personas):
 *   0.05/s  →  ~15 users   warm-up
 *   0.10/s  →  ~30 users
 *   0.30/s  →  ~90 users
 *   0.50/s  → ~150 users
 *   1.00/s  → ~300 users
 *   MAX_RATE →  peak
 */
const RATE_STAGES = [
  { duration: "2m", target: 0.05 },
  { duration: "3m", target: 0.1 },
  { duration: "5m", target: 0.3 },
  { duration: "5m", target: 0.5 },
  { duration: "5m", target: 1.0 },
  { duration: "5m", target: MAX_RATE },
  { duration: "5m", target: MAX_RATE }, // hold at peak to confirm stability
];

/**
 * Scale each stage target by fraction, rounded to 3 decimal places, so that
 * each scenario maintains a proportional share of the total arrival rate.
 */
function split(fraction: number) {
  return RATE_STAGES.map((s) => ({
    duration: s.duration,
    target: parseFloat((s.target * fraction).toFixed(3)),
  }));
}

// ─── Options ──────────────────────────────────────────────────────────────────

export const options: Options = {
  scenarios: {
    /**
     * 50 % of arrivals — civil registration staff processing full workflows.
     *
     * maxVUs = MAX_RATE × fraction × max_cycle_s + headroom
     * At MAX_RATE=2: 2 × 0.5 × 300 + 50 = 350 VUs
     */
    registrar: {
      executor: "ramping-arrival-rate",
      startRate: 0,
      timeUnit: "1s",
      preAllocatedVUs: 20,
      maxVUs: Math.ceil(MAX_RATE * 0.5 * 300) + 50,
      stages: split(0.5),
      exec: "registrarVU",
    },

    /**
     * 30 % of arrivals — staff looking up and reading existing records.
     * Shorter cycles (~120 s avg) → fewer VUs needed per unit of arrival rate.
     *
     * At MAX_RATE=2: 2 × 0.3 × 180 + 30 = 138 VUs
     */
    searcher: {
      executor: "ramping-arrival-rate",
      startRate: 0,
      timeUnit: "1s",
      preAllocatedVUs: 10,
      maxVUs: Math.ceil(MAX_RATE * 0.3 * 180) + 30,
      stages: split(0.3),
      exec: "searcherVU",
    },

    /**
     * 20 % of arrivals — supervisors and admins monitoring the system.
     * Long cycles (~350 s avg) → HIGH VU count despite low request rate.
     * These represent the "logged in but mostly idle" population.
     *
     * At MAX_RATE=2: 2 × 0.2 × 520 + 30 = 238 VUs
     */
    reader: {
      executor: "ramping-arrival-rate",
      startRate: 0,
      timeUnit: "1s",
      preAllocatedVUs: 10,
      maxVUs: Math.ceil(MAX_RATE * 0.2 * 520) + 30,
      stages: split(0.2),
      exec: "readerVU",
    },
  },

  thresholds: {
    ...productionThresholds,
    // Abort early when the overall p95 sustains above 2 s for 30 s.
    // The VU count at abort is the concurrent-user capacity figure.
    http_req_duration: [
      { threshold: "p(95)<2000", abortOnFail: true, delayAbortEval: "30s" },
    ],
  },
};

// ─── Think-time helper ────────────────────────────────────────────────────────

/**
 * Pause for a random duration in [minS, maxS] seconds.
 *
 * This is the ingredient that makes each VU represent one real user rather than
 * one robot. Without realistic think time, VUs spin through requests at machine
 * speed and generate far more load per VU than a human ever would.
 */
function think(minS: number, maxS: number): void {
  sleep(minS + Math.random() * (maxS - minS));
}

// ─── Registrar VU ─────────────────────────────────────────────────────────────

/**
 * Full civil registration workflow with realistic think times.
 *
 * Approximate time budget per cycle:
 *   Navigate to / read the blank form           5–15 s
 *   Type applicant details                     30–60 s  ← largest chunk
 *   Type recommender details                   20–40 s
 *   Review form before submitting              10–20 s
 *   declareEvent (server)                        ~1 s
 *   Read "submitted" confirmation               5–10 s
 *   ES refresh pause (server-side)              1.5 s
 *   searchByTrackingId (server)                ~0.5 s
 *   Read results / note tracking ID           10–20 s
 *   assignEvent + confirm                       5–10 s
 *   registerEvent (server)                       ~1 s
 *   Read registration confirmation             15–30 s
 *   Between-case idle (inbox / next file)      30–90 s
 *   ──────────────────────────────────────────────────
 *   Total cycle                               ~135–300 s  (avg ≈ 220 s)
 */
export function registrarVU(): void {
  const { token, userId } = getSession();

  // Open a new registration
  const event = createEvent(token);
  check(event, { "event created": (e) => Boolean(e?.id) });
  if (!event?.id) return;
  think(5, 15); // user navigates and reads the blank form

  // The bulk of a registrar's time: reading field labels, typing names and
  // dates, cross-checking source documents, correcting typos.
  const declaration = generateDeclaration();
  think(60, 120);

  // Submit the declaration
  declareEvent(token, event.id, declaration);
  think(5, 10); // reads the submission confirmation

  // Wait for Elasticsearch to index the newly declared record
  sleep(1.5);

  // Search to verify the record is findable by tracking ID
  const result = searchByTrackingId(token, event.trackingId);
  check(result, { "search: event found": (r) => (r?.total ?? 0) > 0 });
  think(10, 20); // reads tracking ID, notes it on the physical file

  // Assign to self, then register
  assignEvent(token, event.id, userId);
  think(5, 10);

  registerEvent(token, event.id, declaration);
  think(15, 30); // reviews the registration confirmation, notes the registration number

  // Idle before the next case: checking inbox, fetching the next file, brief rest
  think(30, 90);
}

// ─── Searcher VU ──────────────────────────────────────────────────────────────

/**
 * Search-and-read workflow. Simulates staff answering a family member's query
 * or verifying a record without processing it.
 *
 * Approximate time budget per cycle:
 *   Decide what to search / type query         10–30 s
 *   Review results list                        20–60 s
 *   Open and read selected event               30–90 s  (skipped if no results)
 *   ──────────────────────────────────────────────────
 *   Total cycle                                60–180 s  (avg ≈ 120 s)
 */
export function searcherVU(): void {
  const { token } = getSession();

  think(10, 30); // user decides what to look for, types the search query

  const results = searchByStatus(token, "DECLARED");
  check(results, { "search returned results": (r) => r !== null });
  think(20, 60); // scans through the results list

  // Open the first result for detail if any records came back
  if ((results?.results?.length ?? 0) > 0) {
    getEvent(token, results!.results[0].id);
    think(30, 90); // reads the full event detail page
  }
}

// ─── Reader VU ────────────────────────────────────────────────────────────────

/**
 * Supervisor / admin monitoring pattern.
 *
 * These users stay logged in all day but interact with the system only a few
 * times per hour. They represent the "long tail" of concurrent sessions: the
 * long idle period (180–480 s) pushes W high in Little's Law, which means even
 * a modest arrival rate keeps many VUs alive. In real deployments these users
 * can easily outnumber active registrars.
 *
 * Approximate time budget per cycle:
 *   Refresh workqueue (searchByStatus)           < 1 s
 *   Glance through the list                    10–30 s
 *   Check own user profile (findUser)            < 1 s
 *   Other work: email, phone calls, meetings  180–480 s
 *   ──────────────────────────────────────────────────
 *   Total cycle                               190–510 s  (avg ≈ 350 s)
 */
export function readerVU(): void {
  const { token, userId } = getSession();

  // Refresh the workqueue — a supervisor checking for pending declarations
  searchByStatus(token, "DECLARED");
  think(10, 30); // scans the list, maybe spots something to follow up on later

  // Quick profile check (verify own permissions, confirm office assignment)
  findUser(token, userId);

  // Long idle — user turns to email, handles a phone call, attends a meeting
  think(180, 480);
}

// ─── Summary ──────────────────────────────────────────────────────────────────

export function handleSummary(data: unknown) {
  const d = data as {
    metrics?: { vus?: { values?: { max?: number } } };
    state?: { isAborted?: boolean };
  };

  const peakVUs = d?.metrics?.vus?.values?.max ?? 0;
  const aborted = d?.state?.isAborted ?? false;

  const sep = "═".repeat(62);
  const verdict = aborted
    ? "EARLY — p95 > 2 s sustained for 30 s (system limit reached)"
    : "NORMALLY — all stages completed within SLO";

  const box = [
    "",
    sep,
    "  CONCURRENT USER CAPACITY RESULT",
    sep,
    `  Peak concurrent real users : ${peakVUs}`,
    `  Test ended                 : ${verdict}`,
    "",
    "  How to read this:",
    "    Each VU = one logged-in user with realistic think time.",
    "    VU count at any moment = arrival_rate × avg_cycle_time",
    "    (Little's Law: N = λ × W)",
    "    Peak VUs before degradation = max concurrent real users.",
    "",
    "  Personas modelled:",
    "    registrar (50 %) — full workflow,         avg cycle ~3.5 min",
    "    searcher  (30 %) — search + read,         avg cycle ~2 min",
    "    reader    (20 %) — workqueue + long idle,  avg cycle ~6 min",
    sep,
    "",
  ].join("\n");

  return {
    stdout: box + textSummary(data, { indent: " ", enableColors: false }),
    "summary.json": JSON.stringify(data),
  };
}
