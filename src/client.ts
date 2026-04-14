import http from 'k6/http';
import { check } from 'k6';
import { config } from './config';
import type { TennisClubDeclaration } from './data';

// ─── tRPC helpers ─────────────────────────────────────────────────────────────

function headers(token: string) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

/**
 * Makes a tRPC mutation call to the events service.
 *
 * The server uses SuperJSON transformer + httpBatchLink, so requests must use
 * the batch wire format:
 *   URL:  POST {eventsUrl}/{procedure}?batch=1
 *   Body: {"0": {"json": <input>}}
 *   Response: [{"result": {"data": {"json": <output>}}}]
 */
function call(token: string, procedure: string, input: object) {
  const res = http.post(
    `${config.eventsUrl}/${procedure}?batch=1`,
    JSON.stringify({ '0': { json: input } }),
    { headers: headers(token), tags: { name: procedure } }
  );

  check(res, { [`${procedure}: status 200`]: (r) => r.status === 200 });
  return res;
}

/** Extracts the result payload from a tRPC batch+SuperJSON response. */
function unwrap<T>(res: ReturnType<typeof http.post>): T {
  const batch = res.json() as Array<{ result: { data: { json: T } } }>;
  return batch[0]?.result?.data?.json;
}

// ─── Event operations ─────────────────────────────────────────────────────────

export interface EventRef {
  id: string;
  trackingId: string;
}

export function createEvent(token: string): EventRef {
  const res = call(token, 'event.create', {
    transactionId: crypto.randomUUID(),
    type: 'tennis-club-membership',
  });
  return unwrap<EventRef>(res);
}

export interface SearchResult {
  results: Array<{ id: string; trackingId: string }>;
  total: number;
}

export function searchByTrackingId(token: string, trackingId: string): SearchResult {
  const res = call(token, 'event.search', {
    query: {
      type: 'and',
      clauses: [
        {
          eventType: 'tennis-club-membership',
          trackingId: { type: 'exact', term: trackingId },
        },
      ],
    },
    limit: 10,
    offset: 0,
  });
  return unwrap<SearchResult>(res);
}

export function declareEvent(
  token: string,
  eventId: string,
  declaration: TennisClubDeclaration
): void {
  call(token, 'event.actions.declare.request', {
    eventId,
    transactionId: crypto.randomUUID(),
    declaration,
  });
}

export function assignEvent(token: string, eventId: string, assignedTo: string): void {
  call(token, 'event.actions.assignment.assign', {
    type: 'ASSIGN',
    eventId,
    transactionId: crypto.randomUUID(),
    assignedTo,
    declaration: {},
  });
}

export function registerEvent(token: string, eventId: string): void {
  call(token, 'event.actions.register.request', {
    type: 'REGISTER',
    eventId,
    transactionId: crypto.randomUUID(),
    declaration: {},
  });
}
