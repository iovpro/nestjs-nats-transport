import { HEALTHY, processOutcome, runScenario } from '../utils/run-scenario';

describe('JetStream events', () => {
  it('JS-01 event published with ClientNats should reach the handler (control)', async () => {
    const run = await runScenario('js-01-smoke');

    expect(processOutcome(run)).toEqual(HEALTHY);
    expect(run.result.received).toEqual([{ hello: 'world' }]);
  });

  it('JS-02 non-JSON message should be terminated without crashing the service (control)', async () => {
    const run = await runScenario('js-02-poison-message');

    expect(processOutcome(run)).toEqual(HEALTHY);
    expect(run.result).toEqual({ received: [{ ok: true }], ackPending: 0, redelivered: 0 });
  });

  it('JS-03 globalEventOptions from the README should work on a NATS server with the strict JetStream API', async () => {
    const run = await runScenario('js-03-global-options-strict-server');

    expect(processOutcome(run)).toEqual(HEALTHY);
    expect(run.result.received).toBe(1);
  });

  it('JS-04 runtime options from globalEventOptions should apply to handlers (max_handlers)', async () => {
    const run = await runScenario('js-04-global-runtime-options');

    expect(processOutcome(run)).toEqual(HEALTHY);
    expect(run.result).toEqual({ globalMaxParallel: 5, localMaxParallel: 5 });
  });

  it('JS-05 missing stream should be reported by listen() instead of crashing the process', async () => {
    const run = await runScenario('js-05-no-stream-for-subject');

    expect(processOutcome(run)).toEqual(HEALTHY);
    expect(run.result.listenError).toMatch(/stream/i);
  });

  it('JS-06 filter_subjects option should create a multi-filter consumer', async () => {
    const run = await runScenario('js-06-filter-subjects');

    expect(processOutcome(run)).toEqual(HEALTHY);
    expect(run.result.subjects).toEqual(['e2e.js.multi.a', 'e2e.js.multi.b']);
  });

  it('JS-07 README example with DeliverPolicy.StartSequence should start from the given sequence', async () => {
    const run = await runScenario('js-07-start-sequence');

    expect(processOutcome(run)).toEqual(HEALTHY);
    expect(run.result.received).toEqual([{ seq: 2 }, { seq: 3 }]);
  });

  it('JS-08 subjects that differ only by "." and "-" should get separate consumers', async () => {
    const run = await runScenario('js-08-consumer-name-collision');

    expect(processOutcome(run)).toEqual(HEALTHY);
    expect(run.result.routes).toEqual(['dashed <- e2e.js.orders.created-v1', 'dotted <- e2e.js.orders.created.v1']);
  });

  it('JS-09 messages waiting in the client buffer should not be redelivered while the handler keeps up with ack_wait', async () => {
    const run = await runScenario('js-09-prefetch-redelivery');

    expect(processOutcome(run)).toEqual(HEALTHY);
    expect(run.result).toEqual({ unique: 20, invocations: 20, processedMoreThanOnce: 0, maxRedeliveryCount: 0 });
  });

  it('JS-11 NAK returned by the handler should redeliver the message (control)', async () => {
    const run = await runScenario('js-11-nak-redelivery');

    expect(processOutcome(run)).toEqual(HEALTHY);
    expect(run.result).toEqual({ deliveries: [1, 2] });
  });

  it('JS-12 consume() should buffer max_handlers messages by default and max_messages when it is set', async () => {
    const run = await runScenario('js-12-prefetch-buffer-size');

    expect(processOutcome(run)).toEqual(HEALTHY);
    // Delivered but not acked: 3 handlers + 3 buffered by default; 1 handler + 10 buffered with max_messages: 10
    expect(run.result.maxAckPending).toEqual({ default: 6, explicit: 11 });
  });

  it('JS-13 a message processed during app.close() should be acked before the connection closes', async () => {
    const run = await runScenario('js-13-ack-on-close');

    expect(processOutcome(run)).toEqual(HEALTHY);
    expect(run.result).toEqual({ handled: 1, ackPending: 0, redelivered: 0 });
  });

  it('JS-14 several handlers of one JetStream pattern should be reported by listen()', async () => {
    const run = await runScenario('js-14-two-handlers-one-pattern');

    expect(processOutcome(run)).toEqual(HEALTHY);
    expect(run.result.listenError).toBe(
      'Several handlers for the JetStream pattern [e2e.js.nak.multi]: one handler per pattern',
    );
  });
});
