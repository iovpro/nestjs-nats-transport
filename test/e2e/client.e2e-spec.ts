import { HEALTHY, processOutcome, runScenario } from '../utils/run-scenario';

describe('ClientNats', () => {
  it('CLI-01 concurrent first requests should share a single connection', async () => {
    const run = await runScenario('cli-01-connect-race');

    expect(processOutcome(run)).toEqual(HEALTHY);
    expect(run.result).toEqual({ opened: 1, leakedAfterClose: 0 });
  });
});
