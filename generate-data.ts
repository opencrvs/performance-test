/**
 * Tennis-club-membership event seeder.
 *
 * Inserts randomised events into app.events with varied action chains
 * into app.event_actions, directly via pg. Designed for local development only.
 *
 * Usage:
 *   yarn seed-events [--count <number>] [-n <number>]
 *
 * Options:
 *   --count, -n  Total number of events to generate (default: unlimited)
 *
 * Environment variables:
 *   EVENTS_POSTGRES_URL  – default: postgres://events_app:app_password@localhost:5432/events
 *   BATCH_SIZE           – events per batch (default 100)
 *   SLEEP_MS             – pause between batches in ms (default 0)
 */

import { faker } from "@faker-js/faker";
import { Pool } from "pg";
import { randomUUID } from "crypto";

// ─── Configuration ───────────────────────────────────────────────────────────

const EVENTS_POSTGRES_URL =
  process.env.EVENTS_POSTGRES_URL ??
  "postgres://events_app:app_password@localhost:5432/events";

const BATCH_SIZE = Number(process.env.BATCH_SIZE) || 100;
const SLEEP_MS = Number(process.env.SLEEP_MS) || 0;

/** Parse --count / -n from CLI args. Returns Infinity when not set. */
function parseMaxEvents(): number {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--count" || args[i] === "-n") && args[i + 1]) {
      const n = Number(args[i + 1]);
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
      console.error(`❌ Invalid value for ${args[i]}: "${args[i + 1]}"`);
      process.exit(1);
    }
  }
  return Infinity;
}

const MAX_EVENTS = parseMaxEvents();

const EVENT_TYPE = "tennis-club-membership";

// ─── Types ───────────────────────────────────────────────────────────────────

interface DbUser {
  id: string;
  role: string;
}

interface DbLocation {
  id: string;
}

interface ActionRow {
  id: string;
  action_type: string;
  status: "Requested" | "Accepted" | "Rejected";
  event_id: string;
  created_by: string;
  created_by_role: string;
  created_by_user_type: "user" | "system";
  created_at_location: string;
  created_at: Date;
  assigned_to: string | null;
  registration_number: string | null;
  request_id: string | null;
  transaction_id: string;
  custom_action_type: string | null;
  content: object | null;
  annotation: object | null;
  declaration: object;
  original_action_id: string | null;
  created_by_signature: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Generate a short alphanumeric tracking ID (8 chars, uppercase). */
function generateTrackingId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

/** Generate a 12-char alphanumeric registration number like 47WDGH7FYFF3. */
function generateRegistrationNumber(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let num = "";
  for (let i = 0; i < 12; i++) {
    num += chars[Math.floor(Math.random() * chars.length)];
  }
  return num;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Generate a random date within the last 3 years. */
function randomBaseDate(): Date {
  const now = Date.now();
  const threeYearsMs = 3 * 365.25 * 24 * 60 * 60 * 1000;
  return new Date(now - Math.random() * threeYearsMs);
}

/** Advance a date by 1–48 hours (random). */
function advanceDate(d: Date): Date {
  const hoursMs = (1 + Math.random() * 47) * 60 * 60 * 1000;
  return new Date(d.getTime() + hoursMs);
}

/** Advance a date by 1–5 seconds (for Requested→Accepted pairs). */
function advanceDateBySeconds(d: Date): Date {
  const secondsMs = (1 + Math.random() * 4) * 1000;
  return new Date(d.getTime() + secondsMs);
}

// ─── Declaration generator ───────────────────────────────────────────────────

function generateDeclaration(): object {
  const firstName = faker.person.firstName();
  const middleName = faker.helpers.maybe(() => faker.person.middleName(), {
    probability: 0.3,
  });
  const surname = faker.person.lastName();

  const recFirstName = faker.person.firstName();
  const recMiddleName = faker.helpers.maybe(() => faker.person.middleName(), {
    probability: 0.3,
  });
  const recSurname = faker.person.lastName();
  const recRole = pick([
    "Registrar",
    "Coach",
    "Club President",
    "Secretary",
    "Treasurer",
  ]);

  return {
    "applicant.name": {
      firstname: firstName,
      middlename: middleName ?? "",
      surname,
    },
    "applicant.dob": faker.date
      .birthdate({ min: 5, max: 90, mode: "age" })
      .toISOString()
      .slice(0, 10),
    "applicant.tob": `${String(faker.number.int({ min: 0, max: 23 })).padStart(
      2,
      "0"
    )}:${String(faker.number.int({ min: 0, max: 59 })).padStart(2, "0")}`,
    "applicant.registrationDuration": {
      unit: pick(["Hours", "Days", "Minutes"]),
      numericValue: faker.number.int({ min: 1, max: 72 }),
    },
    "recommender.name": {
      firstname: recFirstName,
      middlename: recMiddleName ?? "",
      surname: recSurname,
    },
    "recommender.id": String(
      faker.number.int({ min: 1000000000, max: 9999999999 })
    ),
    "recommender.none": false,
    "recommender.role": recRole,
    "recommender.device": pick(["Mobile phone", "Tablet", "Desktop computer"]),
    "recommender.fullHonorificName": `${pick([
      "Mr.",
      "Mrs.",
      "Ms.",
      "Dr.",
    ])} ${recFirstName} ${recSurname}`,
    "recommender2.id": String(
      faker.number.int({ min: 1000000000, max: 9999999999 })
    ),
  };
}

// ─── Action chain templates ──────────────────────────────────────────────────

type ActionSpec = {
  actionType: string;
  status: "Requested" | "Accepted" | "Rejected";
  /** Which transaction-id group this action belongs to: 'init' or 'main'. */
  txGroup: "init" | "main";
  /** If true, the declaration JSONB is populated. */
  hasDeclaration?: boolean;
  /** If true, annotation is populated. */
  hasAnnotation?: boolean;
  /** Extra fields to set. */
  extras?: Partial<
    Pick<
      ActionRow,
      | "assigned_to"
      | "registration_number"
      | "request_id"
      | "content"
      | "custom_action_type"
    >
  >;
};

type ChainTemplate = {
  /** Human-readable name for logging/debugging. */
  name: string;
  weight: number;
  /** Build the action specs (may depend on runtime-random values). */
  build: (ctx: { userId: string; registrationNumber: string }) => ActionSpec[];
};

const CHAIN_TEMPLATES: ChainTemplate[] = [
  // ── Draft only ──
  {
    name: "draft",
    weight: 5,
    build: () => [
      { actionType: "CREATE", status: "Requested", txGroup: "init" },
      { actionType: "CREATE", status: "Accepted", txGroup: "init" },
    ],
  },

  // ── Declared (pending review) ──
  {
    name: "declared",
    weight: 15,
    build: ({ userId }) => [
      { actionType: "CREATE", status: "Requested", txGroup: "init" },
      { actionType: "CREATE", status: "Accepted", txGroup: "init" },
      {
        actionType: "ASSIGN",
        status: "Requested",
        txGroup: "init",
        extras: { assigned_to: userId },
      },
      {
        actionType: "ASSIGN",
        status: "Accepted",
        txGroup: "init",
        extras: { assigned_to: userId },
      },
      {
        actionType: "DECLARE",
        status: "Requested",
        txGroup: "main",
        hasDeclaration: true,
        hasAnnotation: true,
      },
      { actionType: "DECLARE", status: "Accepted", txGroup: "main" },
    ],
  },

  // ── Declared then unassigned ──
  {
    name: "declared-unassigned",
    weight: 8,
    build: ({ userId }) => [
      { actionType: "CREATE", status: "Requested", txGroup: "init" },
      { actionType: "CREATE", status: "Accepted", txGroup: "init" },
      {
        actionType: "ASSIGN",
        status: "Requested",
        txGroup: "init",
        extras: { assigned_to: userId },
      },
      {
        actionType: "ASSIGN",
        status: "Accepted",
        txGroup: "init",
        extras: { assigned_to: userId },
      },
      {
        actionType: "DECLARE",
        status: "Requested",
        txGroup: "main",
        hasDeclaration: true,
        hasAnnotation: true,
      },
      { actionType: "DECLARE", status: "Accepted", txGroup: "main" },
      { actionType: "UNASSIGN", status: "Requested", txGroup: "main" },
      { actionType: "UNASSIGN", status: "Accepted", txGroup: "main" },
    ],
  },

  // ── Fully registered ──
  {
    name: "registered",
    weight: 25,
    build: ({ userId, registrationNumber }) => [
      { actionType: "CREATE", status: "Requested", txGroup: "init" },
      { actionType: "CREATE", status: "Accepted", txGroup: "init" },
      {
        actionType: "ASSIGN",
        status: "Requested",
        txGroup: "init",
        extras: { assigned_to: userId },
      },
      {
        actionType: "ASSIGN",
        status: "Accepted",
        txGroup: "init",
        extras: { assigned_to: userId },
      },
      {
        actionType: "DECLARE",
        status: "Requested",
        txGroup: "main",
        hasDeclaration: true,
        hasAnnotation: true,
      },
      { actionType: "DECLARE", status: "Accepted", txGroup: "main" },
      {
        actionType: "REGISTER",
        status: "Requested",
        txGroup: "main",
        hasAnnotation: true,
      },
      {
        actionType: "REGISTER",
        status: "Accepted",
        txGroup: "main",
        extras: { registration_number: registrationNumber },
      },
      { actionType: "UNASSIGN", status: "Requested", txGroup: "main" },
      { actionType: "UNASSIGN", status: "Accepted", txGroup: "main" },
    ],
  },

  // ── Registered + certificate printed ──
  {
    name: "registered-printed",
    weight: 15,
    build: ({ userId, registrationNumber }) => [
      { actionType: "CREATE", status: "Requested", txGroup: "init" },
      { actionType: "CREATE", status: "Accepted", txGroup: "init" },
      {
        actionType: "ASSIGN",
        status: "Requested",
        txGroup: "init",
        extras: { assigned_to: userId },
      },
      {
        actionType: "ASSIGN",
        status: "Accepted",
        txGroup: "init",
        extras: { assigned_to: userId },
      },
      {
        actionType: "DECLARE",
        status: "Requested",
        txGroup: "main",
        hasDeclaration: true,
        hasAnnotation: true,
      },
      { actionType: "DECLARE", status: "Accepted", txGroup: "main" },
      {
        actionType: "REGISTER",
        status: "Requested",
        txGroup: "main",
        hasAnnotation: true,
      },
      {
        actionType: "REGISTER",
        status: "Accepted",
        txGroup: "main",
        extras: { registration_number: registrationNumber },
      },
      { actionType: "UNASSIGN", status: "Requested", txGroup: "main" },
      { actionType: "UNASSIGN", status: "Accepted", txGroup: "main" },
      { actionType: "PRINT_CERTIFICATE", status: "Requested", txGroup: "main" },
      { actionType: "PRINT_CERTIFICATE", status: "Accepted", txGroup: "main" },
    ],
  },
];

// Build a weighted picker from the templates.
const TOTAL_WEIGHT = CHAIN_TEMPLATES.reduce((s, t) => s + t.weight, 0);

function pickChainTemplate(): ChainTemplate {
  let r = Math.random() * TOTAL_WEIGHT;
  for (const t of CHAIN_TEMPLATES) {
    r -= t.weight;
    if (r <= 0) return t;
  }
  return CHAIN_TEMPLATES[CHAIN_TEMPLATES.length - 1];
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const pool = new Pool({ connectionString: EVENTS_POSTGRES_URL });

  // Graceful shutdown
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    console.log("\n⏳ Finishing current batch then shutting down…");
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // ── Bootstrap: load locations & users from DB ──
  const { rows: locationRows } = await pool.query<DbLocation>(
    "SELECT id FROM app.locations"
  );
  if (locationRows.length === 0) {
    console.error(
      "❌ No locations found in app.locations — seed locations first."
    );
    await pool.end();
    process.exit(1);
  }
  const locationIds = locationRows.map((r) => r.id);
  console.log(`📍 Loaded ${locationIds.length} locations`);

  const { rows: userRows } = await pool.query<DbUser>(
    "SELECT id, role FROM app.users WHERE status = $1",
    ["active"]
  );
  if (userRows.length === 0) {
    console.error("❌ No active users found in app.users — seed users first.");
    await pool.end();
    process.exit(1);
  }
  console.log(`👤 Loaded ${userRows.length} users`);

  // ── Infinite loop ──
  let totalEvents = 0;
  let totalActions = 0;
  let batchNum = 0;

  const limitLabel = Number.isFinite(MAX_EVENTS)
    ? `${MAX_EVENTS} events`
    : "∞ (unlimited)";
  console.log(
    `\n🚀 Starting seeder: ${BATCH_SIZE} events/batch, ${SLEEP_MS}ms pause, target: ${limitLabel}\n` +
      `   Press Ctrl+C to stop gracefully.\n`
  );

  while (!stopping && totalEvents < MAX_EVENTS) {
    // If we're near the limit, shrink the batch so we don't overshoot
    const eventsThisBatch = Math.min(BATCH_SIZE, MAX_EVENTS - totalEvents);
    batchNum++;
    const client = await pool.connect();

    try {
      const start = Date.now();
      await client.query("BEGIN");

      const eventValues: string[] = [];
      const eventParams: unknown[] = [];
      const actionRows: unknown[][] = [];

      let paramIdx = 1;

      for (let i = 0; i < eventsThisBatch; i++) {
        const eventId = randomUUID();
        const trackingId = generateTrackingId();
        const txIdInit = `tmp-${randomUUID()}`;
        const txIdMain = randomUUID();
        const registrationNumber = generateRegistrationNumber();

        const baseDate = randomBaseDate();

        // Insert event
        eventValues.push(
          `($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`
        );
        eventParams.push(
          eventId,
          EVENT_TYPE,
          txIdInit,
          trackingId,
          baseDate,
          baseDate
        );

        // Pick a chain
        const user = pick(userRows);
        const template = pickChainTemplate();
        const specs = template.build({
          userId: user.id,
          registrationNumber,
        });

        // Generate the declaration once for this event
        const declaration = generateDeclaration();

        let ts = baseDate;
        let lastRequestedRow: unknown[] | null = null;
        for (let si = 0; si < specs.length; si++) {
          const spec = specs[si];
          const prevSpec = si > 0 ? specs[si - 1] : null;

          // Is this the Accepted half of a Requested→Accepted pair?
          const isAcceptedHalf =
            prevSpec &&
            prevSpec.actionType === spec.actionType &&
            prevSpec.status === "Requested" &&
            spec.status === "Accepted";

          // Use a small seconds delay for the Accepted half of a Requested→Accepted pair,
          // otherwise advance by 1–48 hours between different actions.
          if (isAcceptedHalf) {
            ts = advanceDateBySeconds(ts);
          } else {
            ts = advanceDate(ts);
          }

          if (isAcceptedHalf && lastRequestedRow) {
            // Clone the Requested row — identical except for id, status,
            // created_at, and any status-dependent extras (e.g. registration_number).
            const row = [...lastRequestedRow];
            row[0] = randomUUID(); // id
            row[2] = spec.status; // status → "Accepted"
            row[8] = ts; // created_at
            // Apply status-dependent extras on top of the clone
            if (spec.extras?.assigned_to !== undefined)
              row[9] = spec.extras.assigned_to;
            if (spec.extras?.registration_number !== undefined)
              row[10] = spec.extras.registration_number;
            if (spec.extras?.request_id !== undefined)
              row[11] = spec.extras.request_id;
            if (spec.extras?.custom_action_type !== undefined)
              row[13] = spec.extras.custom_action_type;
            if (spec.extras?.content)
              row[14] = JSON.stringify(spec.extras.content);
            actionRows.push(row);
            lastRequestedRow = null;
          } else {
            const actionId = randomUUID();
            const txId = spec.txGroup === "init" ? txIdInit : txIdMain;
            const actionUser = pick(userRows);
            const locationId = pick(locationIds);

            const row = [
              actionId,
              spec.actionType,
              spec.status,
              eventId,
              actionUser.id,
              actionUser.role,
              "user",
              locationId,
              ts,
              spec.extras?.assigned_to ?? null,
              spec.extras?.registration_number ?? null,
              spec.extras?.request_id ?? null,
              txId,
              spec.extras?.custom_action_type ?? null,
              spec.extras?.content ? JSON.stringify(spec.extras.content) : "{}",
              spec.hasAnnotation
                ? JSON.stringify({
                    "review.comment": faker.lorem.sentence(),
                    "review.signature": null,
                  })
                : null,
              spec.hasDeclaration
                ? JSON.stringify(declaration)
                : JSON.stringify({}),
              null, // original_action_id
              null, // created_by_signature
            ];
            actionRows.push(row);

            // Remember Requested rows so the next Accepted can clone them
            lastRequestedRow = spec.status === "Requested" ? row : null;
          }
        }

        totalActions += specs.length;
      }

      // Bulk-insert events
      await client.query(
        `INSERT INTO app.events (id, event_type, transaction_id, tracking_id, created_at, updated_at)
         VALUES ${eventValues.join(", ")}`,
        eventParams
      );

      // Bulk-insert actions (parameterised per row to stay safe with types)
      for (const row of actionRows) {
        await client.query(
          `INSERT INTO app.event_actions
            (id, action_type, status, event_id, created_by, created_by_role,
             created_by_user_type, created_at_location, created_at,
             assigned_to, registration_number, request_id, transaction_id,
             custom_action_type, content, annotation, declaration,
             original_action_id, created_by_signature)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
          row
        );
      }

      await client.query("COMMIT");
      totalEvents += eventsThisBatch;
      const total = Date.now() - start;
      console.log(
        `✅ Batch ${batchNum}: +${eventsThisBatch} events | Total: ${totalEvents} events, ${totalActions} actions, took ${total}ms so ${Math.round(
          total / eventsThisBatch
        )}ms per event`
      );
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`❌ Batch ${batchNum} failed, rolled back:`, err);
    } finally {
      client.release();
    }

    if (!stopping) {
      await sleep(SLEEP_MS);
    }
  }

  console.log(
    `\n🏁 Stopped. Inserted ${totalEvents} events and ${totalActions} actions total.\n`
  );
  await pool.end();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
