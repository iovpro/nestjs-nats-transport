import { Controller } from '@nestjs/common';
import { execFileSync } from 'child_process';
import { JSONCodec, NatsConnection, connect } from 'nats';
import { ClientNats, NatsEventPattern, ServerNats } from '../../src';
import { NATS_AUTH_URL, NATS_MAIN_URL, NATS_OUTAGE_CONTAINER, NATS_OUTAGE_URL } from './env';
import {
  CountingLogger,
  STREAM,
  consumerInfoFor,
  createService,
  log,
  marker,
  publishJs,
  report,
  resetStream,
  sleep,
  startService,
  startStrategy,
  streams,
  waitFor,
} from './harness';
import { waitUntilReachable } from './net';
import { RpcController } from './rpc.scenarios';

let received = 0;

@Controller()
class OutageRegularController {
  @NatsEventPattern('e2e.js.outage.regular')
  handle() {
    received++;
  }
}

// nats.js closes the connection for good after maxReconnectAttempts (default: 10 attempts 2 s apart);
// the budget is shortened to keep the scenarios fast, the behaviour is the same
const fragileConnection = { servers: NATS_OUTAGE_URL, maxReconnectAttempts: 2, reconnectTimeWait: 250 };

const docker = (...args: string[]) => execFileSync('docker', args, { stdio: 'ignore' });

// May not subscribe to the inboxes of pull requests (test/nats-auth.conf): every pull fails, the connection stays open
const pullDenied = { servers: NATS_AUTH_URL, user: 'restricted', pass: 'secret' };

/** Raw request to the echo handler of RpcController on the outage server: 'ok' or the error code */
async function echo() {
  const nc = await connect({ servers: NATS_OUTAGE_URL });
  try {
    await nc.request('e2e.rpc.echo', JSONCodec().encode({ pattern: 'e2e.rpc.echo', data: 'ping' }), { timeout: 2000 });
    return 'ok';
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  } finally {
    await nc.close();
  }
}

async function publishWithRetry(subject: string, payload: unknown) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await publishJs(NATS_OUTAGE_URL, subject, [payload]);
    } catch (error) {
      if (attempt === 10) throw error;
      await sleep(500);
    }
  }
}

export const scenarios: Record<string, () => Promise<void>> = {
  async 'con-01-outage-event-loop'() {
    await resetStream(NATS_OUTAGE_URL);
    const logger = new CountingLogger({ quiet: true, filter: /CONNECTION_CLOSED/ });
    await startService(
      [OutageRegularController],
      { jetStream: true, connection: fragileConnection },
      streams(),
      logger,
    );

    let ticks = 0;
    setInterval(() => console.log(`@@TICK ${++ticks} errors=${logger.counts.error ?? 0}`), 250);
    await sleep(1000);

    marker('OUTAGE');
    docker('stop', '-t', '0', NATS_OUTAGE_CONTAINER);
    await sleep(6000);
    report({ errorLogs: logger.counts.error ?? 0, closedErrors: logger.matched });
  },

  async 'con-02-outage-regular-consumer'() {
    await resetStream(NATS_OUTAGE_URL);
    await startService(
      [OutageRegularController, RpcController],
      { jetStream: true, connection: fragileConnection },
      streams(),
      new CountingLogger({ filter: /closed|CLOSED|Consumer|disconnect/ }),
    );
    await sleep(1000);

    marker('OUTAGE');
    docker('stop', '-t', '0', NATS_OUTAGE_CONTAINER);
    // Longer than the 5 s reconnect pause: the first attempt fails, the next one has to succeed
    await sleep(7000);
    docker('start', NATS_OUTAGE_CONTAINER);
    if (!(await waitUntilReachable(NATS_OUTAGE_URL, 15_000))) throw new Error('NATS did not come back after restart');
    marker('NATS_BACK');

    await publishWithRetry('e2e.js.outage.regular', { after: 'outage' });
    const recovered = await waitFor(() => received >= 1, 8000);
    log(`message published after the outage was ${recovered ? '' : 'NOT '}consumed`);
    report({ recovered, rpc: await echo() });
  },

  async 'con-03-auth-retry-after-close'() {
    const logger = new CountingLogger({ filter: /Authorization/ });
    const app = await createService(
      [RpcController],
      { connection: { servers: NATS_AUTH_URL, user: 'e2e', pass: 'wrong' } },
      undefined,
      logger,
    );
    let listenState = 'pending';
    app.listen().then(
      () => (listenState = 'resolved'),
      (e: Error) => (listenState = `rejected: ${e.message}`),
    );
    await sleep(6000);

    const attemptsBeforeClose = logger.counts.error ?? 0;
    log(`listen() is ${listenState}; calling app.close()`);
    await app.close();
    await sleep(11_000);
    report({ listenState, attemptsBeforeClose, attemptsAfterClose: (logger.counts.error ?? 0) - attemptsBeforeClose });
  },

  async 'con-05-pull-denied-regular-consumer'() {
    const logger = new CountingLogger({ quiet: true });
    await startService([OutageRegularController], { jetStream: true, connection: pullDenied }, streams(), logger);
    await sleep(6000);
    report({ errorLogs: logger.counts.error ?? 0 });
  },

  async 'con-07-close-during-retry-pause'() {
    const logger = new CountingLogger({ quiet: true });
    const app = await startService(
      [OutageRegularController],
      { jetStream: true, connection: pullDenied },
      streams(),
      logger,
    );
    // Pulls fail right after the start and then once a second: close in the middle of a pause
    await sleep(2500);

    const errorsBeforeClose = logger.counts.error ?? 0;
    await app.close();
    await sleep(2000);
    report({ errorsBeforeClose, errorsAfterClose: (logger.counts.error ?? 0) - errorsBeforeClose });
  },

  async 'con-08-close-during-reconnect-pause'() {
    const logger = new CountingLogger({ filter: /connected to|connection closed/ });
    const app = await startService([RpcController], { connection: fragileConnection }, undefined, logger);

    marker('OUTAGE');
    docker('stop', '-t', '0', NATS_OUTAGE_CONTAINER);
    // Reconnect attempts run out in ~0.5 s, then the service waits 5 s before connecting anew
    await sleep(1000);
    docker('start', NATS_OUTAGE_CONTAINER);
    if (!(await waitUntilReachable(NATS_OUTAGE_URL, 15_000))) throw new Error('NATS did not come back');

    const beforeClose = logger.matched;
    await app.close();
    await sleep(6000);
    report({ beforeClose, afterClose: logger.matched - beforeClose });
  },

  async 'con-09-outage-default-reconnect-budget'() {
    await resetStream(NATS_OUTAGE_URL);
    const logger = new CountingLogger({ filter: /connection closed/ });
    // nats.js gives up after 10 attempts by default; 100 ms apart that is under 2 s, shorter than the outage
    const connection = { servers: NATS_OUTAGE_URL, reconnectTimeWait: 100 };
    await startService([OutageRegularController], { jetStream: true, connection }, streams(), logger);
    await sleep(1000);

    marker('OUTAGE');
    docker('stop', '-t', '0', NATS_OUTAGE_CONTAINER);
    await sleep(3000);
    docker('start', NATS_OUTAGE_CONTAINER);
    if (!(await waitUntilReachable(NATS_OUTAGE_URL, 15_000))) throw new Error('NATS did not come back');
    marker('NATS_BACK');

    await publishWithRetry('e2e.js.outage.regular', { after: 'outage' });
    const consumed = await waitFor(() => received >= 1, 8000);
    report({ consumed, closedForGood: logger.matched });
  },

  async 'con-10-outage-client'() {
    // The responder keeps its connection through the outage
    const responder = { servers: NATS_OUTAGE_URL, maxReconnectAttempts: -1, reconnectTimeWait: 250 };
    await startService([RpcController], { connection: responder }, undefined, new CountingLogger({ quiet: true }));
    const client = new ClientNats({ connection: fragileConnection });
    const request = () => client.request('e2e.rpc.echo', 'ping').then(
      () => 'ok',
      (e: Error) => `error: ${e.message}`,
    );
    const before = await request();

    marker('OUTAGE');
    docker('stop', '-t', '0', NATS_OUTAGE_CONTAINER);
    await sleep(3000);
    docker('start', NATS_OUTAGE_CONTAINER);
    if (!(await waitUntilReachable(NATS_OUTAGE_URL, 15_000))) throw new Error('NATS did not come back');
    marker('NATS_BACK');

    // The responder needs a moment to subscribe again
    let after = await request();
    for (let attempt = 1; attempt < 20 && after !== 'ok'; attempt++) {
      await sleep(500);
      after = await request();
    }
    log(`after the outage: ${after}`);
    report({ before, after });
  },

  async 'con-11-status-and-events'() {
    // nats.js reconnects within the outage: it reports disconnect, reconnecting and reconnect
    const connection = { servers: NATS_OUTAGE_URL, reconnectTimeWait: 250 };
    const strategy = new ServerNats({ consumerName: 'e2e', connection });
    const client = new ClientNats({ connection });
    const statuses = { server: [] as string[], client: [] as string[] };
    const events = { server: [] as string[], client: [] as string[] };
    strategy.status.subscribe(status => statuses.server.push(status));
    client.status.subscribe(status => statuses.client.push(status));
    for (const event of ['disconnect', 'reconnect']) {
      strategy.on(event, (data: unknown) => events.server.push(`${event}: ${typeof data}`));
      client.on(event, (data: unknown) => events.client.push(`${event}: ${typeof data}`));
    }
    const app = await startStrategy(strategy, [RpcController]);
    await client.connect();

    marker('OUTAGE');
    docker('stop', '-t', '0', NATS_OUTAGE_CONTAINER);
    await sleep(2000);
    docker('start', NATS_OUTAGE_CONTAINER);
    if (!(await waitUntilReachable(NATS_OUTAGE_URL, 15_000))) throw new Error('NATS did not come back');
    marker('NATS_BACK');

    const last = (list: string[]) => list[list.length - 1];
    await waitFor(() => last(statuses.server) === 'connected' && last(statuses.client) === 'connected', 10_000);
    const rpc = await client.request('e2e.rpc.echo', 'ping').then(
      () => 'ok',
      (e: Error) => `error: ${e.message}`,
    );
    report({ statuses, events, rpc });
    await client.close();
    await app.close();
  },

  async 'con-12-consumer-deleted-storm'() {
    await resetStream(NATS_MAIN_URL);
    const logger = new CountingLogger({ quiet: true, filter: /Consumer.*failed/ });
    const app = await startService([OutageRegularController], { jetStream: true }, streams(), logger);
    await sleep(1000);

    const nc = await connect({ servers: NATS_MAIN_URL });
    const jsm = await nc.jetstreamManager();
    const consumer = await consumerInfoFor(jsm, 'e2e.js.outage.regular');
    await jsm.consumers.delete(STREAM, consumer!.name);
    await nc.close();
    log('consumer deleted');

    await sleep(3000);
    await app.close();
    report({ errorLogs: logger.matched });
  },

  async 'con-13-close-during-outage'() {
    const server = new ServerNats({ consumerName: 'e2e', connection: { servers: NATS_OUTAGE_URL } });
    const app = await startStrategy(server, [RpcController]);
    const nc = server.unwrap<NatsConnection>();
    await sleep(1000);

    docker('stop', '-t', '0', NATS_OUTAGE_CONTAINER);
    await sleep(2000);

    const startedAt = Date.now();
    await app.close();
    // main.ts ends the process after the scenario: the connection itself must be closed
    report({ closed: nc.isClosed(), closeMs: Date.now() - startedAt });
  },
};
