import http from 'k6/http';
import { b64decode } from 'k6/encoding';

export interface Session {
  token: string;
  userId: string;
}

/**
 * Authenticates a user against the OpenCRVS gateway.
 *
 * Two-step flow:
 *   1. POST /auth/authenticate  → { nonce }
 *   2. POST /auth/verifyCode    → { token }
 *
 * In dev, 2FA is disabled so the code '000000' is always accepted.
 * The userId is decoded from the `sub` claim of the returned JWT.
 */
export function authenticate(gatewayUrl: string, username: string, password: string): Session {
  const authRes = http.post(
    `${gatewayUrl}/auth/authenticate`,
    JSON.stringify({ username, password }),
    { headers: { 'Content-Type': 'application/json' }, tags: { name: 'auth.authenticate' } }
  );

  if (authRes.status !== 200) {
    throw new Error(`auth.authenticate failed: ${authRes.status} ${authRes.body}`);
  }

  const { nonce } = authRes.json() as { nonce: string };

  const verifyRes = http.post(
    `${gatewayUrl}/auth/verifyCode`,
    JSON.stringify({ code: '000000', nonce }),
    { headers: { 'Content-Type': 'application/json' }, tags: { name: 'auth.verifyCode' } }
  );

  if (verifyRes.status !== 200) {
    throw new Error(`auth.verifyCode failed: ${verifyRes.status} ${verifyRes.body}`);
  }

  const { token } = verifyRes.json() as { token: string };
  const userId = decodeJwtSub(token);

  return { token, userId };
}

/** Extracts the `sub` claim from a JWT without verifying the signature. */
function decodeJwtSub(token: string): string {
  const payload = token.split('.')[1];
  const json = b64decode(payload, 'rawurl', 's') as string;
  return (JSON.parse(json) as { sub: string }).sub;
}
