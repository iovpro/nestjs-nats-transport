import { Controller } from '@nestjs/common';
import { StringCodec, connect } from 'nats';
import { ClientNats, NatsMessagePattern } from '../../src';
import { NATS_MAIN_URL } from './env';
import { sleep, startService } from './harness';

@Controller()
class FailingController {
  @NatsMessagePattern('e2e.log.fail')
  fail() {
    throw new Error('boom from handler');
  }
}

export const scenarios: Record<string, () => Promise<void>> = {
  async 'log-01-default-logger-stack'() {
    // logger=false keeps the default Nest ConsoleLogger
    await startService([FailingController], {}, undefined, false);
    const client = new ClientNats({ connection: { servers: NATS_MAIN_URL } });
    await client.request('e2e.log.fail', {}).catch(() => undefined);
    await sleep(300);
    await client.close();
  },

  async 'log-02-internal-error-stack'() {
    // logger=false keeps the default Nest ConsoleLogger; a request that is not JSON makes the library log an error
    await startService([FailingController], {}, undefined, false);
    const nc = await connect({ servers: NATS_MAIN_URL });
    await nc.request('e2e.log.fail', StringCodec().encode('not-json'), { timeout: 1000 }).catch(() => undefined);
    await sleep(300);
    await nc.close();
  },
};
