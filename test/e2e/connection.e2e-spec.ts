import { NATS_OUTAGE_CONTAINER, NATS_OUTAGE_URL } from '../scenarios/env';
import { HEALTHY, ensureContainerRunning, markersAfter, processOutcome, runScenario } from '../utils/run-scenario';

describe('Connection lifecycle', () => {
  // Outage scenarios stop the NATS container; a hung scenario cannot restart it itself
  afterEach(() => ensureContainerRunning(NATS_OUTAGE_CONTAINER, NATS_OUTAGE_URL));

  it('CON-01 event loop should stay responsive after the connection is closed for good', async () => {
    const run = await runScenario('con-01-outage-event-loop', 20_000);

    expect(processOutcome(run)).toEqual(HEALTHY);
    // 6 s after the outage with a 250 ms heartbeat
    expect(markersAfter(run, 'TICK', 'OUTAGE')).toBeGreaterThanOrEqual(20);
    // restarts without a real pause flood the log even when the event loop survives (setImmediate: ~450k lines)
    expect(run.result.errorLogs).toBeLessThanOrEqual(10);
    // the consumer stops on the closed connection instead of retrying on it once a second
    expect(run.result.closedErrors).toBeLessThanOrEqual(1);
  });

  it('CON-02 service should recover when the connection is closed for good', async () => {
    const run = await runScenario('con-02-outage-regular-consumer', 45_000);

    expect(processOutcome(run)).toEqual(HEALTHY);
    // a new connection: the JetStream consumer gets the message published after the outage, the RPC handler replies
    expect(run.result).toEqual({ recovered: true, rpc: 'ok' });
  });

  it('CON-03 rejected credentials: reconnect attempts should stop after app.close()', async () => {
    const run = await runScenario('con-03-auth-retry-after-close', 30_000);

    expect(processOutcome(run)).toEqual(HEALTHY);
    expect(run.result.attemptsAfterClose).toBe(0);
  });

  it('CON-05 regular consumer should pause between retries when every pull is rejected', async () => {
    const run = await runScenario('con-05-pull-denied-regular-consumer', 20_000);

    expect(processOutcome(run)).toEqual(HEALTHY);
    // a rejected pull logs the consumer error and the "error" status: 12 lines in 6 s with a 1 s pause, ~44k without
    expect(run.result.errorLogs).toBeGreaterThanOrEqual(4); // keeps retrying
    expect(run.result.errorLogs).toBeLessThanOrEqual(20);
  });

  it('CON-07 consumers waiting for a retry should not restart after app.close()', async () => {
    const run = await runScenario('con-07-close-during-retry-pause', 20_000);

    expect(processOutcome(run)).toEqual(HEALTHY);
    expect(run.result.errorsBeforeClose).toBeGreaterThan(0);
    expect(run.result.errorsAfterClose).toBe(0);
  });

  it('CON-08 a reconnect pending when app.close() is called should not happen', async () => {
    const run = await runScenario('con-08-close-during-reconnect-pause', 20_000);

    expect(processOutcome(run)).toEqual(HEALTHY);
    // before close(): "connected to" at the start and "connection closed, reconnecting in 5 seconds"
    expect(run.result).toEqual({ beforeClose: 2, afterClose: 0 });
  });

  it('CON-09 by default the connection should outlast an outage longer than the nats.js reconnect budget', async () => {
    const run = await runScenario('con-09-outage-default-reconnect-budget', 45_000);

    expect(processOutcome(run)).toEqual(HEALTHY);
    // nats.js reconnects by itself: the connection is never closed for good, the service does not have to reconnect
    expect(run.result).toEqual({ consumed: true, closedForGood: 0 });
  });

  it('CON-10 ClientNats should send requests again after its connection is closed for good', async () => {
    const run = await runScenario('con-10-outage-client', 45_000);

    expect(processOutcome(run)).toEqual(HEALTHY);
    expect(run.result).toEqual({ before: 'ok', after: 'ok' });
  });

  it('CON-11 status and on() should report the outage and the recovery (server and client)', async () => {
    const run = await runScenario('con-11-status-and-events', 40_000);

    expect(processOutcome(run)).toEqual(HEALTHY);
    const statuses = ['connected', 'disconnected', 'reconnecting', 'connected'];
    const events = ['disconnect: string', 'reconnect: string'];
    expect(run.result).toEqual({
      statuses: { server: statuses, client: statuses },
      events: { server: events, client: events },
      rpc: 'ok',
    });
  });
});
