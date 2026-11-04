import http from "k6/http";
import { check } from "k6";
import { randomBytes } from "k6/crypto";
import { config } from "./config";
import type { TennisClubDeclaration } from "./data";

function uuidv4(): string {
  const b = new Uint8Array(randomBytes(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(
    16,
    20
  )}-${h.slice(20)}`;
}

// ─── tRPC helpers ─────────────────────────────────────────────────────────────

function headers(token: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

/**
 * tRPC mutation (POST).
 * Wire format: POST {eventsUrl}/{procedure}?batch=1
 * Body: {"0": {"json": <input>}}
 * Response: [{"result": {"data": {"json": <output>}}}]
 */
function call(token: string, procedure: string, input: object) {
  const res = http.post(
    `${config.eventsUrl}/${procedure}?batch=1`,
    JSON.stringify({ "0": { json: input } }),
    { headers: headers(token), tags: { name: procedure } }
  );
  const ok = check(res, {
    [`${procedure}: status 200`]: (r) => r.status === 200,
  });
  if (!ok) {
    console.error(
      `${procedure} ${res.status}: ${String(res.body).substring(0, 300)}`
    );
  }
  return res;
}

/**
 * tRPC query (GET).
 * Wire format: GET {eventsUrl}/{procedure}?batch=1&input=<encoded>
 */
function query(token: string, procedure: string, input: object | string) {
  const encoded = encodeURIComponent(JSON.stringify({ "0": { json: input } }));
  const res = http.get(
    `${config.eventsUrl}/${procedure}?batch=1&input=${encoded}`,
    { headers: headers(token), tags: { name: procedure } }
  );
  const ok = check(res, {
    [`${procedure}: status 200`]: (r) => r.status === 200,
  });
  if (!ok) {
    console.error(
      `${procedure} ${res.status}: ${String(res.body).substring(0, 300)}`
    );
  }
  return res;
}

/** Extracts the result payload from a tRPC batch+SuperJSON response. Returns null on non-JSON or unexpected shape. */
function unwrap<T>(res: ReturnType<typeof http.post>): T | null {
  try {
    const batch = res.json() as Array<{ result: { data: { json: T } } }>;
    return batch[0]?.result?.data?.json ?? null;
  } catch {
    return null;
  }
}

// ─── Event CRUD ───────────────────────────────────────────────────────────────

export interface EventRef {
  id: string;
  trackingId: string;
}

export function createEvent(token: string): EventRef | null {
  const res = call(token, "event.create", {
    transactionId: uuidv4(),
    type: "tennis-club-membership",
  });
  return unwrap<EventRef>(res);
}

export function getEvent(token: string, eventId: string): unknown {
  const res = query(token, "event.get", { eventId });
  return unwrap<unknown>(res);
}

export function findUser(token: string, userId: string): unknown {
  const res = query(token, "user.get", userId);
  return unwrap<unknown>(res);
}

// ─── Search operations ────────────────────────────────────────────────────────

export interface SearchResult {
  results: Array<{ id: string; trackingId: string }>;
  total: number;
}

const EVENT_TYPE = "tennis-club-membership";

function search(token: string, clause: object): SearchResult | null {
  const res = call(token, "event.search", {
    query: { type: "and", clauses: [{ eventType: EVENT_TYPE, ...clause }] },
    limit: 10,
    offset: 0,
  });
  return unwrap<SearchResult>(res);
}

export function searchByTrackingId(
  token: string,
  trackingId: string
): SearchResult | null {
  return search(token, { trackingId: { type: "exact", term: trackingId } });
}

/** BRN = registration number assigned at the REGISTERED step. */
export function searchByBRN(token: string, brn: string): SearchResult | null {
  return search(token, {
    "legalStatuses.REGISTERED.registrationNumber": { type: "exact", term: brn },
  });
}

/** Fuzzy match on applicant first/surname (tennis-club proxy for name search). */
export function searchByName(token: string, name: string): SearchResult | null {
  return search(token, {
    data: { "applicant.name": { type: "fuzzy", term: name } },
  });
}

/** Exact match on recommender.id (tennis-club proxy for NID). */
export function searchByNID(token: string, nid: string): SearchResult | null {
  return search(token, {
    data: { "recommender.id": { type: "exact", term: nid } },
  });
}

/** Exact DoB + fuzzy name (tennis-club proxy for DoB-and-name search). */
export function searchByDoBAndName(
  token: string,
  dob: string,
  name: string
): SearchResult | null {
  return search(token, {
    data: {
      "applicant.dob": { type: "exact", term: dob },
      "applicant.name": { type: "fuzzy", term: name },
    },
  });
}

export type EventStatus =
  | "CREATED"
  | "NOTIFIED"
  | "DECLARED"
  | "REGISTERED"
  | "ARCHIVED";

export function searchByStatus(
  token: string,
  status: EventStatus
): SearchResult | null {
  return search(token, { status: { type: "exact", term: status } });
}

/** flag — e.g. 'rejected', 'incomplete', 'correction-requested', 'potential-duplicate'. */
export function searchByFlag(token: string, flag: string): SearchResult | null {
  return search(token, { flags: { anyOf: [flag] } });
}

// ─── Actions ──────────────────────────────────────────────────────────────────

export function declareEvent(
  token: string,
  eventId: string,
  declaration: TennisClubDeclaration
): void {
  call(token, "event.actions.declare.request", {
    eventId,
    transactionId: uuidv4(),
    declaration,
  });
}

export function assignEvent(
  token: string,
  eventId: string,
  assignedTo: string
): void {
  call(token, "event.actions.assignment.assign", {
    type: "ASSIGN",
    eventId,
    transactionId: uuidv4(),
    assignedTo,
    declaration: {},
  });
}

export function registerEvent(
  token: string,
  eventId: string,
  declaration: TennisClubDeclaration
): void {
  call(token, "event.actions.register.request", {
    type: "REGISTER",
    eventId,
    transactionId: uuidv4(),
    declaration,
  });
}

// ─── Workqueue polling ────────────────────────────────────────────────────────

export function workqueueCount(
  token: string,
  userId: string,
  locationId: string
): void {
  const slugs = [
    {
      slug: "assigned-to-you",
      query: {
        type: "and",
        clauses: [
          {
            assignedTo: { type: "exact", term: userId },
            createdBy: null,
            updatedBy: null,
            updatedByUserRole: null,
            createdAtLocation: null,
            updatedAtLocation: null,
            "legalStatuses.DECLARED.createdAtLocation": null,
            "legalStatuses.REGISTERED.createdAtLocation": null,
          },
        ],
      },
    },
    {
      slug: "recent",
      query: {
        type: "and",
        clauses: [
          {
            updatedAt: { type: "timePeriod", term: "last7Days" },
            updatedBy: { type: "exact", term: userId },
            assignedTo: null,
            createdBy: null,
            updatedByUserRole: null,
            createdAtLocation: null,
            updatedAtLocation: null,
            "legalStatuses.DECLARED.createdAtLocation": null,
            "legalStatuses.REGISTERED.createdAtLocation": null,
          },
        ],
      },
    },
    {
      slug: "requires-completion",
      query: {
        type: "and",
        clauses: [
          {
            updatedAtLocation: { type: "within", location: locationId },
            flags: { anyOf: ["incomplete"], noneOf: ["rejected"] },
            assignedTo: null,
            createdBy: null,
            updatedBy: null,
            updatedByUserRole: null,
            createdAtLocation: null,
            "legalStatuses.DECLARED.createdAtLocation": null,
            "legalStatuses.REGISTERED.createdAtLocation": null,
          },
        ],
      },
    },
    {
      slug: "potential-duplicate",
      query: {
        type: "and",
        clauses: [
          {
            "legalStatuses.DECLARED.createdAtLocation": {
              type: "within",
              location: locationId,
            },
            flags: { anyOf: ["potential-duplicate"] },
            assignedTo: null,
            createdBy: null,
            updatedBy: null,
            updatedByUserRole: null,
            createdAtLocation: null,
            updatedAtLocation: null,
            "legalStatuses.REGISTERED.createdAtLocation": null,
          },
        ],
      },
    },
    {
      slug: "pending-updates",
      query: {
        type: "and",
        clauses: [
          {
            createdAtLocation: { type: "within", location: locationId },
            flags: { anyOf: ["rejected"] },
            assignedTo: null,
            createdBy: null,
            updatedBy: null,
            updatedByUserRole: null,
            updatedAtLocation: null,
            "legalStatuses.DECLARED.createdAtLocation": null,
            "legalStatuses.REGISTERED.createdAtLocation": null,
          },
        ],
      },
    },
    {
      slug: "pending-approval",
      query: {
        type: "and",
        clauses: [
          {
            status: { type: "exact", term: "DECLARED" },
            "legalStatuses.DECLARED.createdAtLocation": {
              type: "within",
              location: locationId,
            },
            flags: {
              anyOf: ["approval-required-for-late-registration"],
              noneOf: ["potential-duplicate"],
            },
            assignedTo: null,
            createdBy: null,
            updatedBy: null,
            updatedByUserRole: null,
            createdAtLocation: null,
            updatedAtLocation: null,
            "legalStatuses.REGISTERED.createdAtLocation": null,
          },
        ],
      },
    },
    {
      slug: "pending-registration",
      query: {
        type: "and",
        clauses: [
          {
            status: { type: "exact", term: "DECLARED" },
            "legalStatuses.DECLARED.createdAtLocation": {
              type: "within",
              location: locationId,
            },
            flags: {
              anyOf: ["validated"],
              noneOf: [
                "approval-required-for-late-registration",
                "potential-duplicate",
              ],
            },
            assignedTo: null,
            createdBy: null,
            updatedBy: null,
            updatedByUserRole: null,
            createdAtLocation: null,
            updatedAtLocation: null,
            "legalStatuses.REGISTERED.createdAtLocation": null,
          },
        ],
      },
    },
    {
      slug: "escalated",
      query: {
        type: "and",
        clauses: [
          {
            createdAtLocation: { type: "within", location: locationId },
            flags: {
              anyOf: [
                "escalated-to-registrar-general",
                "escalated-to-provincial-registrar",
              ],
            },
            assignedTo: null,
            createdBy: null,
            updatedBy: null,
            updatedByUserRole: null,
            updatedAtLocation: null,
            "legalStatuses.DECLARED.createdAtLocation": null,
            "legalStatuses.REGISTERED.createdAtLocation": null,
          },
        ],
      },
    },
    {
      slug: "in-external-validation",
      query: {
        type: "and",
        clauses: [
          {
            updatedAtLocation: { type: "within", location: locationId },
            flags: { anyOf: ["register:requested"] },
            assignedTo: null,
            createdBy: null,
            updatedBy: null,
            updatedByUserRole: null,
            createdAtLocation: null,
            "legalStatuses.DECLARED.createdAtLocation": null,
            "legalStatuses.REGISTERED.createdAtLocation": null,
          },
        ],
      },
    },
    {
      slug: "pending-certification",
      query: {
        type: "and",
        clauses: [
          {
            "legalStatuses.REGISTERED.createdAtLocation": {
              type: "within",
              location: locationId,
            },
            flags: {
              anyOf: ["pending-first-certificate-issuance"],
              noneOf: ["revoked", "correction-requested"],
            },
            assignedTo: null,
            createdBy: null,
            updatedBy: null,
            updatedByUserRole: null,
            createdAtLocation: null,
            updatedAtLocation: null,
            "legalStatuses.DECLARED.createdAtLocation": null,
          },
        ],
      },
    },
    {
      slug: "pending-issuance",
      query: {
        type: "and",
        clauses: [
          {
            "legalStatuses.REGISTERED.createdAtLocation": {
              type: "within",
              location: locationId,
            },
            flags: {
              anyOf: ["certified-copy-printed-in-advance-of-issuance"],
              noneOf: ["revoked", "correction-requested"],
            },
            assignedTo: null,
            createdBy: null,
            updatedBy: null,
            updatedByUserRole: null,
            createdAtLocation: null,
            updatedAtLocation: null,
            "legalStatuses.DECLARED.createdAtLocation": null,
          },
        ],
      },
    },
    {
      slug: "correction-requested",
      query: {
        type: "and",
        clauses: [
          {
            "legalStatuses.REGISTERED.createdAtLocation": {
              type: "within",
              location: locationId,
            },
            flags: { anyOf: ["correction-requested"], noneOf: ["revoked"] },
            assignedTo: null,
            createdBy: null,
            updatedBy: null,
            updatedByUserRole: null,
            createdAtLocation: null,
            updatedAtLocation: null,
            "legalStatuses.DECLARED.createdAtLocation": null,
          },
        ],
      },
    },
  ];

  // Build SuperJSON meta.values — every null field needs an ["undefined"] entry
  const NULL_FIELDS = [
    "assignedTo",
    "createdBy",
    "updatedBy",
    "updatedByUserRole",
    "createdAtLocation",
    "updatedAtLocation",
    "legalStatuses.DECLARED.createdAtLocation",
    "legalStatuses.REGISTERED.createdAtLocation",
  ];

  const values: Record<string, string[]> = {};
  slugs.forEach((slug, i) => {
    const clause = slug.query.clauses[0];
    NULL_FIELDS.forEach((field) => {
      if (
        field in clause &&
        (clause as Record<string, unknown>)[field] === null
      ) {
        values[`${i}.query.clauses.0.${field}`] = ["undefined"];
      }
    });
  });

  const res = http.post(
    `${config.eventsUrl}/workqueue.count?batch=1`,
    JSON.stringify({ "0": { json: slugs, meta: { values } } }),
    { headers: headers(token), tags: { name: "workqueue.count" } }
  );
  check(res, { "workqueue.count: 200": (r) => r.status === 200 });
}

export function workqueueSearch(token: string, locationId: string): void {
  const res = http.post(
    `${config.eventsUrl}/event.search?batch=1`,
    JSON.stringify({
      "0": {
        json: {
          query: {
            type: "and",
            clauses: [
              {
                status: { type: "exact", term: "DECLARED" },
                "legalStatuses.DECLARED.createdAtLocation": {
                  type: "within",
                  location: locationId,
                },
                flags: {
                  anyOf: ["validated"],
                  noneOf: [
                    "approval-required-for-late-registration",
                    "potential-duplicate",
                  ],
                },
                assignedTo: null,
                createdBy: null,
                updatedBy: null,
                updatedByUserRole: null,
                createdAtLocation: null,
                updatedAtLocation: null,
                "legalStatuses.REGISTERED.createdAtLocation": null,
              },
            ],
          },
          offset: 0,
          limit: 10,
          sort: [{ field: "updatedAt", direction: "desc" }],
        },
        meta: {
          values: {
            "query.clauses.0.assignedTo": ["undefined"],
            "query.clauses.0.createdBy": ["undefined"],
            "query.clauses.0.updatedBy": ["undefined"],
            "query.clauses.0.updatedByUserRole": ["undefined"],
            "query.clauses.0.createdAtLocation": ["undefined"],
            "query.clauses.0.updatedAtLocation": ["undefined"],
            "query.clauses.0.legalStatuses.REGISTERED.createdAtLocation": [
              "undefined",
            ],
          },
        },
      },
    }),
    { headers: headers(token), tags: { name: "workqueue.search" } }
  );
  check(res, { "workqueue.search: 200": (r) => r.status === 200 });
}
