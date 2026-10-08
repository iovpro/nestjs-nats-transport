import { HEALTHY, ScenarioRun, processOutcome, runScenario } from '../utils/run-scenario';

describe('RPC (core NATS request-reply)', () => {
  describe('robustness', () => {
    const BAD_REQUEST_REPLY = 'reply: {"err":{"message":"Bad Request: Bad JSON","statusCode":400},"isDisposed":true}';
    const internalErrorReply = (reason: string) =>
      `reply: {"err":{"message":"Internal Server Error: ${reason}","statusCode":500},"isDisposed":true}`;

    it('RPC-01 service should survive a non-JSON request payload and report an error to the caller', async () => {
      const run = await runScenario('rpc-01-malformed-payload');

      expect(processOutcome(run)).toEqual(HEALTHY);
      expect(run.result.rawOutcome).toBe(BAD_REQUEST_REPLY);
      expect(run.result.followUp).toMatch(/^reply/);
    });

    it('RPC-02 service should survive an empty request payload and report an error to the caller', async () => {
      const run = await runScenario('rpc-02-empty-payload');

      expect(processOutcome(run)).toEqual(HEALTHY);
      expect(run.result.rawOutcome).toBe(BAD_REQUEST_REPLY);
      expect(run.result.followUp).toMatch(/^reply/);
    });

    it('RPC-03 service should survive a response larger than max_payload and report an error to the caller', async () => {
      const run = await runScenario('rpc-03-oversized-response');

      expect(processOutcome(run)).toEqual(HEALTHY);
      expect(run.result.outcome).toBe('error: Internal Server Error: MAX_PAYLOAD_EXCEEDED');
      expect(run.result.rawOutcome).toBe(internalErrorReply('MAX_PAYLOAD_EXCEEDED'));
    });

    it('RPC-04 service should survive a non-serializable (BigInt) response and report an error to the caller', async () => {
      const run = await runScenario('rpc-04-bigint-response');

      expect(processOutcome(run)).toEqual(HEALTHY);
      expect(run.result.outcome).toBe('error: Internal Server Error: Bad JSON');
      expect(run.result.rawOutcome).toBe(internalErrorReply('Bad JSON'));
    });
  });

  it('RPC-05 handler should receive falsy payloads as is', async () => {
    const run = await runScenario('rpc-05-falsy-payloads');

    expect(processOutcome(run)).toEqual(HEALTHY);
    expect(run.result.received).toEqual([0, false, '', 42, 'text', { a: 1 }]);
  });

  describe('error propagation', () => {
    let run: ScenarioRun;

    beforeAll(async () => {
      run = await runScenario('rpc-06-error-propagation');
    });

    it('RPC-06a business NatsRpcException should reach the caller intact (control)', () => {
      expect(run.result.business).toEqual({
        name: 'NatsRpcException',
        message: 'User not found',
        statusCode: 404,
        errorCode: 'USER_NOT_FOUND',
      });
    });

    it('RPC-06c plain @MessagePattern masks unexpected errors (control, standard NestJS behaviour)', () => {
      expect(run.result.internalPlain?.message).toBe('Internal server error');
    });

    it('RPC-07 statusCode of a standard NestJS RPC error should be numeric or absent', () => {
      expect([null, 500]).toContain(run.result.internalPlain?.statusCode);
    });
  });

  it('RPC-08 connection.timeout should not limit the duration of an RPC', async () => {
    const run = await runScenario('rpc-08-request-timeout');

    expect(processOutcome(run)).toEqual(HEALTHY);
    expect(run.result.outcome).toBe('reply: done');
  });

  it('RPC-09 graceful shutdown should deliver the reply of an in-flight request', async () => {
    const run = await runScenario('rpc-09-shutdown-inflight');

    expect(processOutcome(run)).toEqual(HEALTHY);
    expect(run.result.outcome).toBe('reply: done');
  });

  it('RPC-10 headers should travel in both directions (control)', async () => {
    const run = await runScenario('rpc-10-headers');

    expect(processOutcome(run)).toEqual(HEALTHY);
    expect(run.result).toEqual({ requestIdSeenByHandler: 'req-42', responseHeader: 'e2e' });
  });

  it('RPC-11 a second handler on the pattern of an RPC handler should be reported by listen()', async () => {
    const run = await runScenario('rpc-11-shared-rpc-pattern');
    const error = 'Several handlers for the RPC pattern [e2e.rpc.shared]: one handler per pattern';
    const rejected = { rpcThenEvent: error, eventThenRpc: error, rpcThenRpc: error };

    expect(processOutcome(run)).toEqual(HEALTHY);
    expect(run.result).toEqual({ jetStream: rejected, core: rejected });
  });
});
