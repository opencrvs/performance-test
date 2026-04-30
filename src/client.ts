import http from 'k6/http'
import { check } from 'k6'
import { config } from './config'
import type { TennisClubDeclaration } from './data'

// ─── tRPC helpers ─────────────────────────────────────────────────────────────

function headers(token: string) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`
  }
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
    JSON.stringify({ '0': { json: input } }),
    { headers: headers(token), tags: { name: procedure } }
  )
  const ok = check(res, { [`${procedure}: status 200`]: (r) => r.status === 200 })
  if (!ok) {
    console.error(`${procedure} ${res.status}: ${String(res.body).substring(0, 300)}`)
  }
  return res
}

/**
 * tRPC query (GET).
 * Wire format: GET {eventsUrl}/{procedure}?batch=1&input=<encoded>
 */
function query(token: string, procedure: string, input: object | string) {
  const encoded = encodeURIComponent(JSON.stringify({ '0': { json: input } }))
  const res = http.get(
    `${config.eventsUrl}/${procedure}?batch=1&input=${encoded}`,
    { headers: headers(token), tags: { name: procedure } }
  )
  const ok = check(res, { [`${procedure}: status 200`]: (r) => r.status === 200 })
  if (!ok) {
    console.error(`${procedure} ${res.status}: ${String(res.body).substring(0, 300)}`)
  }
  return res
}

/** Extracts the result payload from a tRPC batch+SuperJSON response. */
function unwrap<T>(res: ReturnType<typeof http.post>): T {
  const batch = res.json() as Array<{ result: { data: { json: T } } }>
  return batch[0]?.result?.data?.json
}

// ─── Event CRUD ───────────────────────────────────────────────────────────────

export interface EventRef {
  id: string
  trackingId: string
}

export function createEvent(token: string): EventRef {
  const res = call(token, 'event.create', {
    transactionId: crypto.randomUUID(),
    type: 'tennis-club-membership'
  })
  return unwrap<EventRef>(res)
}

export function getEvent(token: string, eventId: string): unknown {
  const res = query(token, 'event.get', { eventId })
  return unwrap<unknown>(res)
}

export function findUser(token: string, userId: string): unknown {
  const res = query(token, 'user.get', userId)
  return unwrap<unknown>(res)
}

// ─── Search operations ────────────────────────────────────────────────────────

export interface SearchResult {
  results: Array<{ id: string; trackingId: string }>
  total: number
}

const EVENT_TYPE = 'tennis-club-membership'

function search(token: string, clause: object): SearchResult {
  const res = call(token, 'event.search', {
    query: { type: 'and', clauses: [{ eventType: EVENT_TYPE, ...clause }] },
    limit: 10,
    offset: 0
  })
  return unwrap<SearchResult>(res)
}

export function searchByTrackingId(
  token: string,
  trackingId: string
): SearchResult {
  return search(token, { trackingId: { type: 'exact', term: trackingId } })
}

/** BRN = registration number assigned at the REGISTERED step. */
export function searchByBRN(token: string, brn: string): SearchResult {
  return search(token, {
    'legalStatuses.REGISTERED.registrationNumber': { type: 'exact', term: brn }
  })
}

/** Fuzzy match on applicant first/surname (tennis-club proxy for name search). */
export function searchByName(token: string, name: string): SearchResult {
  return search(token, {
    data: { 'applicant.name': { type: 'fuzzy', term: name } }
  })
}

/** Exact match on recommender.id (tennis-club proxy for NID). */
export function searchByNID(token: string, nid: string): SearchResult {
  return search(token, {
    data: { 'recommender.id': { type: 'exact', term: nid } }
  })
}

/** Exact DoB + fuzzy name (tennis-club proxy for DoB-and-name search). */
export function searchByDoBAndName(
  token: string,
  dob: string,
  name: string
): SearchResult {
  return search(token, {
    data: {
      'applicant.dob': { type: 'exact', term: dob },
      'applicant.name': { type: 'fuzzy', term: name }
    }
  })
}

export type EventStatus =
  | 'CREATED'
  | 'NOTIFIED'
  | 'DECLARED'
  | 'REGISTERED'
  | 'ARCHIVED'

export function searchByStatus(
  token: string,
  status: EventStatus
): SearchResult {
  return search(token, { status: { type: 'exact', term: status } })
}

/** flag — e.g. 'rejected', 'incomplete', 'correction-requested', 'potential-duplicate'. */
export function searchByFlag(token: string, flag: string): SearchResult {
  return search(token, { flags: { anyOf: [flag] } })
}

// ─── Actions ──────────────────────────────────────────────────────────────────

export function declareEvent(
  token: string,
  eventId: string,
  declaration: TennisClubDeclaration
): void {
  call(token, 'event.actions.declare.request', {
    eventId,
    transactionId: crypto.randomUUID(),
    declaration
  })
}

export function assignEvent(
  token: string,
  eventId: string,
  assignedTo: string
): void {
  call(token, 'event.actions.assignment.assign', {
    type: 'ASSIGN',
    eventId,
    transactionId: crypto.randomUUID(),
    assignedTo,
    declaration: {}
  })
}

export function registerEvent(
  token: string,
  eventId: string,
  declaration: TennisClubDeclaration
): void {
  call(token, 'event.actions.register.request', {
    type: 'REGISTER',
    eventId,
    transactionId: crypto.randomUUID(),
    declaration
  })
}
