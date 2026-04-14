/**
 * Runtime configuration resolved from k6 environment variables.
 *
 * Local dev (defaults):
 *   k6 run dist/smoke.js
 *
 * Override any value:
 *   EVENTS_URL=http://... GATEWAY_URL=http://... k6 run dist/smoke.js
 *
 * Cloud reporting (Grafana Cloud):
 *   k6 run --out cloud dist/smoke.js   (requires K6_CLOUD_TOKEN env var)
 */
export const config = {
  /** Base URL for the events tRPC API, e.g. http://localhost:3000/api/events */
  eventsUrl: __ENV.EVENTS_URL ?? 'http://localhost:5555',

  /** Gateway base URL used for auth endpoints (/auth/authenticate, /auth/verifyCode). */
  gatewayUrl: __ENV.GATEWAY_URL ?? 'http://localhost:7070',

  username: __ENV.CRVS_USERNAME ?? 'k.mweene',
  password: __ENV.CRVS_PASSWORD ?? 'test',
};
