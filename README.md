# OpenCRVS 2.0 Performance Test Pattern

## Setup

- [Production-like](https://documentation.opencrvs.org/setup/3.-installation/3.3-set-up-a-server-hosted-environment#minimum-server-specifications) hardware configuration
- OpenCRVS 2.x
- Database with 1,000,000 records (~10 actions each)
- 1,000 users
- 30,000 administrative areas
- 40,000 locations

All tests are written in [k6](https://k6.io/) with TypeScript. Test scripts, seed data generators, and threshold configurations live in this repository. Each test run produces a k6 summary JSON that is compared against the baseline thresholds defined below.

## Response time percentiles

All response time thresholds are defined at p50, p95, and p99. Thresholds measure server-side time only (request received to response sent), excluding network latency.

### Read operations

Searches, lookups, and queries backed by Elasticsearch or PostgreSQL indexes.

| Operation                  | p50   | p95    | p99    |
| -------------------------- | ----- | ------ | ------ |
| Search event by ID         | 50ms  | 150ms  | 300ms  |
| Quick search (any UI query)| 50ms  | 150ms  | 300ms  |
| Advanced search (complex)  | 50ms  | 150ms  | 300ms  |
| Find user by ID            | 50ms  | 150ms  | 300ms  |

> The advanced search query to be used as benchmark is to be defined.

### Write operations

Includes the database write and synchronous event handling. Country config is configured to acknowledge without intercepting.

| Operation              | p50    | p95    | p99    |
| ---------------------- | ------ | ------ | ------ |
| Create declare action  | 100ms  | 300ms  | 500ms  |
| Register event         | 100ms  | 300ms  | 500ms  |

### Reindexing

- Wall-clock time ≤ 10 minutes for 1M records
- Track throughput as records/second for scalability projections
- Country config acknowledges events without maintaining an analytics database (analytics writes are a variable core cannot control)

## Infrastructure health conditions

The following conditions are checked after every test run. A violation of any condition fails the test regardless of response time results.

| Metric                              | Threshold                                                  |
| ----------------------------------- | ---------------------------------------------------------- |
| Pod memory utilisation              | Must not exceed 85% at any point                           |
| Pod CPU utilisation                 | Must not sustain >80% for more than 60 seconds             |
| PostgreSQL connection pool          | Must not exceed 80% of configured maximum                  |
| PostgreSQL query duration (p99)     | ≤ 200ms (excluding reindex operations)                     |
| Elasticsearch JVM heap              | Must not exceed 75% of configured heap                     |
| Elasticsearch indexing latency (p95)| ≤ 100ms                                                    |
| OOM kills / pod restarts            | Zero                                                       |
| Disk I/O wait                       | Must not exceed 10% on any node                            |
| Error rate (5xx)                    | < 0.1%                                                     |

## Load test

### Virtual user scenario

Each virtual user follows this workflow:

1. Declares a birth event
2. Searches for the event using quick search
3. Assigns the event to themselves
4. Registers the event

### Ramp-up

Load is increased incrementally. 20% of virtual users simulate high-latency clients (200–500ms RTT, randomised per request) to validate that slow clients do not exhaust server-side connection pools.

### Metrics tracked during ramp-up

- **Response time**: Time taken to load a page, time from start to completed registration
- **Error rate**: Percentage of failed transactions
- **Virtual user count**: Number of concurrent simulated users

### Termination condition

Test ends when p95 response time exceeds 2 seconds sustained over 30 seconds.

## Soak test

The soak test validates system stability under sustained production-equivalent load over a full working day.

### Load profile

The load is derived from the following civil registration volumes:

| Event type | Annual volume | Daily volume |
| ---------- | ------------- | ------------ |
| Births     | 1,358,989     | ~3,724       |
| Deaths     | 701,884       | ~1,923       |
| Marriages  | 371,825       | ~1,019       |
| **Total**  | **2,432,698** | **~6,666**   |

All 6,666 daily events are registered within an **8-hour working day**. With a **1.5× safety margin**, the target is **~10,000 events in 8 hours** (~1,250/hour, ~21/minute).

Assuming each virtual user workflow takes 2–3 minutes, the test sustains **40–60 concurrent virtual users** for the full 8 hours.

### Pass criteria

- All response time percentile thresholds hold for the entire 8-hour duration
- All infrastructure health conditions hold for the entire 8-hour duration
- Memory consumption must plateau — any sustained upward trend indicates a leak and fails the test

## Spike test

The spike test validates system behaviour and recovery under a sudden 5× load increase.

### Load profile

| Phase         | Duration   | Concurrent users | Equivalent daily load |
| ------------- | ---------- | ---------------- | --------------------- |
| Warm-up       | 10 minutes | ~50              | ~10,000 events/day    |
| Spike         | 10 minutes | ~250             | ~50,000 events/day    |
| Recovery      | 10 minutes | ~50              | ~10,000 events/day    |

### Pass criteria

- No OOM kills or pod restarts during the spike
- Error rate remains below 1% during the spike window
- **Recovery time**: p95 response time returns to within 20% of pre-spike levels within 60 seconds of load dropping back to baseline
- Brief CPU spikes above 80% are expected and acceptable during the spike window

## Baseline policy

The thresholds defined in this document form the absolute baseline for OpenCRVS 2.0. All future versions must meet or exceed these thresholds. CI can run a smoke variant (reduced dataset, shorter duration) on pull requests to catch regressions before merge.
