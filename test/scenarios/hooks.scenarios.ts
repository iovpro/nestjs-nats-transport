import { Controller } from '@nestjs/common';
import { Ctx } from '@nestjs/microservices';
import { AsyncLocalStorage } from 'async_hooks';
import { ClientNats, NatsContext, NatsEventPattern, NatsMessagePattern, ServerNats } from '../../src';
import { NATS_MAIN_URL } from './env';
import { publishJs, report, resetStream, sleep, startStrategy, streams, waitFor } from './harness';

/** Context that the start hook opens for the processing, as tracing tools do */
const trace = new AsyncLocalStorage<string>();
/** Hook calls and handler runs per subject */
const calls: Record<string, string[]> = {};
const record = (subject: string, call: string) => (calls[subject] ??= []).push(call);

/** An async handler: the end hook has to wait for it */
async function handle(ctx: NatsContext) {
  await sleep(20);
  record(ctx.getSubject(), `handler in ${trace.getStore()}`);
  return trace.getStore();
}

@Controller()
class HookedController {
  @NatsMessagePattern('e2e.hooks.rpc')
  rpc(@Ctx() ctx: NatsContext) {
    return handle(ctx);
  }

  @NatsEventPattern('e2e.hooks.event')
  event(@Ctx() ctx: NatsContext) {
    return handle(ctx);
  }
}

@Controller()
class HookedJetStreamController {
  @NatsEventPattern('e2e.js.hooks.event')
  event(@Ctx() ctx: NatsContext) {
    return handle(ctx);
  }
}

function hooked(strategy: ServerNats) {
  strategy.setOnProcessingStartHook((transportId, ctx, done) => {
    const subject = (ctx as NatsContext).getSubject();
    record(subject, `start ${String(transportId)}`);
    return trace.run(subject, done);
  });
  strategy.setOnProcessingEndHook((transportId, ctx) =>
    record((ctx as NatsContext).getSubject(), `end ${String(transportId)}`),
  );
  return strategy;
}

export const scenarios: Record<string, () => Promise<void>> = {
  async 'hook-01-processing-hooks'() {
    await resetStream(NATS_MAIN_URL);
    const connection = { servers: NATS_MAIN_URL };
    const core = await startStrategy(hooked(new ServerNats({ consumerName: 'e2e', connection })), [HookedController]);
    const js = await startStrategy(
      hooked(new ServerNats({ consumerName: 'e2e', connection, jetStream: true }, streams())),
      [HookedJetStreamController],
    );
    await sleep(500);

    const client = new ClientNats({ connection });
    const rpc = await client.request('e2e.hooks.rpc', {});
    await client.event('e2e.hooks.event', {});
    await publishJs(NATS_MAIN_URL, 'e2e.js.hooks.event', [{ n: 1 }]);
    await waitFor(() => Object.values(calls).filter(list => list.includes('end 2')).length === 3, 5000);
    report({ rpc, calls });

    await client.close();
    await core.close();
    await js.close();
  },
};
