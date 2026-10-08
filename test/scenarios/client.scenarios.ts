import { ClientNats } from '../../src';
import { NATS_MAIN_URL } from './env';
import { CountingLogger, connectionsCount, report, sleep, startService } from './harness';
import { RpcController } from './rpc.scenarios';

export const scenarios: Record<string, () => Promise<void>> = {
  async 'cli-01-connect-race'() {
    await startService([RpcController], {}, undefined, new CountingLogger({ quiet: true }));
    await sleep(300);
    const before = await connectionsCount();

    const client = new ClientNats({ connection: { servers: NATS_MAIN_URL } });
    await Promise.all(Array.from({ length: 20 }, (_, i) => client.request('e2e.rpc.echo', { i })));
    await sleep(300);
    const opened = (await connectionsCount()) - before;

    await client.close();
    await sleep(500);
    report({ opened, leakedAfterClose: (await connectionsCount()) - before });
  },
};
