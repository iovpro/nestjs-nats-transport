import { HEALTHY, processOutcome, runScenario } from '../utils/run-scenario';

describe('Processing hooks', () => {
  it('HOOK-01 handlers should run inside the processing hooks: RPC, events, JetStream', async () => {
    const run = await runScenario('hook-01-processing-hooks');

    expect(processOutcome(run)).toEqual(HEALTHY);
    // the start hook opens a context for the handler; the end hook waits for the async handler
    const handled = (subject: string) => ['start 2', `handler in ${subject}`, 'end 2'];
    expect(run.result).toEqual({
      rpc: 'e2e.hooks.rpc',
      calls: {
        'e2e.hooks.rpc': handled('e2e.hooks.rpc'),
        'e2e.hooks.event': handled('e2e.hooks.event'),
        'e2e.js.hooks.event': handled('e2e.js.hooks.event'),
      },
    });
  });
});
