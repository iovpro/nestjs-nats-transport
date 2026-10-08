// Endpoints of test/docker-compose.yml; override with env variables when the servers run elsewhere.

/** NATS 2.15: strict JetStream API */
export const NATS_MAIN_URL = process.env.NATS_E2E_MAIN_URL ?? 'nats://127.0.0.1:14222';
export const NATS_MAIN_MONITOR_URL = process.env.NATS_E2E_MAIN_MONITOR_URL ?? 'http://127.0.0.1:18222';

/** NATS 2.10: JetStream API accepts unknown fields */
export const NATS_LEGACY_URL = process.env.NATS_E2E_LEGACY_URL ?? 'nats://127.0.0.1:14225';

/** NATS 2.15 that the connection-loss scenarios stop and start */
export const NATS_OUTAGE_URL = process.env.NATS_E2E_OUTAGE_URL ?? 'nats://127.0.0.1:14223';
export const NATS_OUTAGE_CONTAINER = process.env.NATS_E2E_OUTAGE_CONTAINER ?? 'nats-transport-test-outage';

/** NATS 2.15 with user "e2e" and password "secret" */
export const NATS_AUTH_URL = process.env.NATS_E2E_AUTH_URL ?? 'nats://127.0.0.1:14224';

export const ALL_NATS_URLS = [NATS_MAIN_URL, NATS_LEGACY_URL, NATS_OUTAGE_URL, NATS_AUTH_URL];
