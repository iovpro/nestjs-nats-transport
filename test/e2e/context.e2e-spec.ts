import { HEALTHY, processOutcome, runScenario } from '../utils/run-scenario';

describe('Request context propagation', () => {
  it('CTX-01 traceId and requestId should propagate through RPC (including downstream), NATS and JetStream events', async () => {
    const run = await runScenario('ctx-01-cross-service-propagation');

    expect(processOutcome(run)).toEqual(HEALTHY);

    const expected = {
      ctxTraceId: 'trace-1',
      ctxRequestId: 'req-1',
      natsCtxTraceId: 'trace-1',
      natsCtxRequestId: 'req-1',
      decoratorRequestId: 'req-1',
    };

    expect(run.result.rpc).toEqual(expected);
    expect(run.result.downstream).toEqual(expected);
    expect(run.result.event).toEqual(expected);
    expect(run.result.jsEvent).toEqual(expected);
  });

  it('CTX-02 messages without headers should get generated traceId and undefined requestId', async () => {
    const run = await runScenario('ctx-02-message-without-headers');

    expect(processOutcome(run)).toEqual(HEALTHY);

    const rpc = run.result.rpcNoHeaders;
    expect(rpc.ctxTraceId).toMatch(/^gen-\d+$/);
    expect(rpc.ctxRequestId).toBeUndefined();
    expect(rpc.natsCtxTraceId).toBe(rpc.ctxTraceId);
    expect(rpc.decoratorRequestId).toBeUndefined();

    const js = run.result.jsNoHeaders;
    expect(js.ctxTraceId).toMatch(/^gen-\d+$/);
    expect(js.ctxRequestId).toBeUndefined();
    expect(js.natsCtxTraceId).toBe(js.ctxTraceId);
    expect(js.decoratorRequestId).toBeUndefined();
  });
});
