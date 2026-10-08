import { HEALTHY, processOutcome, runScenario } from '../utils/run-scenario';

describe('Logging', () => {
  it('LOG-01 default NestJS logger should print the stack trace of a handler error', async () => {
    const run = await runScenario('log-01-default-logger-stack');

    expect(processOutcome(run)).toEqual(HEALTHY);
    expect(run.stdout + run.stderr).toMatch(/at FailingController\.fail/);
  });

  it('LOG-02 default NestJS logger should print the stack trace of an internal library error', async () => {
    const run = await runScenario('log-02-internal-error-stack');

    expect(processOutcome(run)).toEqual(HEALTHY);
    // the text of the log, then the stack of the error: "NatsError: Bad JSON" and its frames
    expect(run.stdout + run.stderr).toMatch(/Failed to process request \[e2e\.log\.fail\].*\n.*Bad JSON\n\s+at /);
  });
});
