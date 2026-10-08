import { execFileSync } from 'child_process';
import { join } from 'path';
import { ALL_NATS_URLS, NATS_OUTAGE_CONTAINER, NATS_OUTAGE_URL } from '../scenarios/env';
import { isReachable, waitUntilReachable } from '../scenarios/net';

const ROOT = join(__dirname, '..', '..');

export default async function globalSetup() {
  // An interrupted run may leave the outage server stopped
  if (!(await isReachable(NATS_OUTAGE_URL))) {
    try {
      execFileSync('docker', ['start', NATS_OUTAGE_CONTAINER], { stdio: 'ignore' });
    } catch {
      // reported below
    }
  }

  for (const url of ALL_NATS_URLS) {
    if (!(await waitUntilReachable(url, 15_000))) {
      throw new Error(`NATS is not reachable at ${url}. Start the e2e infrastructure first: yarn test:e2e:infra:up`);
    }
  }

  // Scenarios run in child processes (a crash or a blocked event loop must not take Jest down), so they are compiled once
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', join(ROOT, 'test', 'tsconfig.scenarios.json')], {
    stdio: 'inherit',
  });
}
