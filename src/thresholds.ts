/**
 * Threshold definitions derived from the README baseline policy.
 *
 * k6 threshold keys use the format: http_req_duration{name:"<procedure>"}
 * which matches the `tags: { name }` set on each HTTP call in client.ts.
 */

// ─── Per-operation SLOs (from README) ─────────────────────────────────────────

/** Read operations: search, lookup, auth */
const READ_SLO = { p50: 50, p95: 150, p99: 300 };

/** Write operations: declare, register */
const WRITE_SLO = { p50: 100, p95: 300, p99: 500 };

function slo(op: typeof READ_SLO) {
  return [
    `p(50)<${op.p50}`,
    `p(95)<${op.p95}`,
    `p(99)<${op.p99}`,
  ];
}

// ─── Production thresholds ────────────────────────────────────────────────────

export const productionThresholds = {
  // Auth
  'http_req_duration{name:"auth.authenticate"}': slo(READ_SLO),
  'http_req_duration{name:"auth.verifyCode"}': slo(READ_SLO),

  // Reads
  'http_req_duration{name:"event.search"}': slo(READ_SLO),
  'http_req_duration{name:"event.get"}': slo(READ_SLO),

  // Writes
  'http_req_duration{name:"event.create"}': slo(WRITE_SLO),
  'http_req_duration{name:"event.actions.declare.request"}': slo(WRITE_SLO),
  'http_req_duration{name:"event.actions.assign.request"}': slo(WRITE_SLO),
  'http_req_duration{name:"event.actions.register.request"}': slo(WRITE_SLO),

  // Overall error rate
  http_req_failed: ['rate<0.001'], // < 0.1%
};

// ─── Smoke thresholds (relaxed — validates connectivity, not perf) ─────────────

export const smokeThresholds = {
  http_req_duration: ['p(95)<5000'],
  http_req_failed: ['rate<0.01'],
};
