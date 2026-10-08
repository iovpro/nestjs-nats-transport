import { Controller } from '@nestjs/common';
import { Ctx, Payload } from '@nestjs/microservices';
import { DeliverPolicy, JsMsg, StringCodec, connect } from 'nats';
import { ClientNats, NAK, NatsContext, NatsEventPattern, toNs } from '../../src';
import { NATS_LEGACY_URL, NATS_MAIN_URL } from './env';
import {
  CountingLogger,
  ParallelismMeter,
  STREAM,
  consumerInfoFor,
  createService,
  createStream,
  log,
  publishJs,
  report,
  resetStream,
  sleep,
  startService,
  streams,
  waitFor,
} from './harness';

const state = {
  received: [] as unknown[],
  subjects: [] as string[],
  routes: [] as string[],
  perMessage: new Map<number, number>(),
  invocations: 0,
  maxRedeliveryCount: 0,
  singleNak: [] as number[],
  multiNak: [] as number[],
  inProgress: { started: 0, done: 0 },
};

const deliveryCount = (ctx: NatsContext) => (ctx.getMessage() as JsMsg).info.deliveryCount;

@Controller()
class SmokeController {
  @NatsEventPattern('e2e.js.smoke')
  handle(@Payload() data: unknown) {
    state.received.push(data);
  }
}

@Controller()
class PoisonController {
  @NatsEventPattern('e2e.js.poison')
  handle(@Payload() data: unknown) {
    state.received.push(data);
  }
}

const globalMeter = new ParallelismMeter();
const localMeter = new ParallelismMeter();

@Controller()
class GlobalConcurrencyController {
  @NatsEventPattern('e2e.js.concurrency.global')
  handle() {
    return globalMeter.run(500);
  }
}

@Controller()
class LocalConcurrencyController {
  @NatsEventPattern('e2e.js.concurrency.local', { max_handlers: 5 })
  handle() {
    return localMeter.run(500);
  }
}

@Controller()
class NoStreamController {
  @NatsEventPattern('e2e.nostream.created')
  handle() {}
}

@Controller()
class FilterSubjectsController {
  @NatsEventPattern('e2e.js.multi', { filter_subjects: ['e2e.js.multi.a', 'e2e.js.multi.b'] })
  handle(@Ctx() ctx: NatsContext) {
    state.subjects.push(ctx.getSubject());
  }
}

@Controller()
class StartSequenceController {
  // README, "Processing from specific sequence"
  @NatsEventPattern('e2e.js.replay', { deliver_policy: DeliverPolicy.StartSequence, opt_start_seq: 2 })
  handle(@Payload() data: unknown) {
    state.received.push(data);
  }
}

@Controller()
class NameCollisionController {
  @NatsEventPattern('e2e.js.orders.created.v1')
  dotted(@Ctx() ctx: NatsContext) {
    state.routes.push(`dotted <- ${ctx.getSubject()}`);
  }

  @NatsEventPattern('e2e.js.orders.created-v1')
  dashed(@Ctx() ctx: NatsContext) {
    state.routes.push(`dashed <- ${ctx.getSubject()}`);
  }
}

@Controller()
class PrefetchController {
  @NatsEventPattern('e2e.js.prefetch', { max_handlers: 1, ack_wait: toNs(2, 's') })
  async handle(@Payload() data: { i: number }, @Ctx() ctx: NatsContext) {
    state.invocations++;
    state.perMessage.set(data.i, (state.perMessage.get(data.i) ?? 0) + 1);
    state.maxRedeliveryCount = Math.max(state.maxRedeliveryCount, deliveryCount(ctx) - 1);
    await sleep(400);
  }
}

@Controller()
class PrefetchBufferController {
  @NatsEventPattern('e2e.js.buffer.default', { max_handlers: 3 })
  byDefault() {
    return sleep(1000);
  }

  @NatsEventPattern('e2e.js.buffer.explicit', { max_handlers: 1, max_messages: 10 })
  explicit() {
    return sleep(1000);
  }
}

@Controller()
class SingleNakController {
  @NatsEventPattern('e2e.js.nak.single', { nak_delay: 300 })
  handle(@Ctx() ctx: NatsContext) {
    state.singleNak.push(deliveryCount(ctx));
    return deliveryCount(ctx) === 1 ? NAK : undefined;
  }
}

@Controller()
class FirstOfTwoNakController {
  @NatsEventPattern('e2e.js.nak.multi', { nak_delay: 300 })
  handle(@Ctx() ctx: NatsContext) {
    state.multiNak.push(deliveryCount(ctx));
    return deliveryCount(ctx) === 1 ? NAK : undefined;
  }
}

@Controller()
class SecondOfTwoNakController {
  @NatsEventPattern('e2e.js.nak.multi')
  handle() {}
}

@Controller()
class InProgressController {
  @NatsEventPattern('e2e.js.in-progress')
  async handle() {
    state.inProgress.started++;
    await sleep(1000);
    state.inProgress.done++;
  }
}

const jetStreamOptions = (url = NATS_MAIN_URL) => ({ jetStream: true, connection: { servers: url } });

export const scenarios: Record<string, () => Promise<void>> = {
  async 'js-01-smoke'() {
    await resetStream(NATS_MAIN_URL);
    await startService([SmokeController], jetStreamOptions(), streams());
    const client = new ClientNats({ connection: { servers: NATS_MAIN_URL }, jetStream: true });
    await client.event('e2e.js.smoke', { hello: 'world' });
    await waitFor(() => state.received.length >= 1, 3000);
    report({ received: state.received });
    await client.close();
  },

  async 'js-02-poison-message'() {
    await resetStream(NATS_MAIN_URL);
    await startService([PoisonController], jetStreamOptions(), streams(), new CountingLogger({ quiet: true }));
    const nc = await connect({ servers: NATS_MAIN_URL });
    await nc.jetstream().publish('e2e.js.poison', StringCodec().encode('definitely-not-json'));
    await publishJs(NATS_MAIN_URL, 'e2e.js.poison', [{ ok: true }]);
    await waitFor(() => state.received.length >= 1, 3000);
    await sleep(2500); // a NAK-ed poison message would be redelivered within this window

    const info = await consumerInfoFor(await nc.jetstreamManager(), 'e2e.js.poison');
    report({ received: state.received, ackPending: info.num_ack_pending, redelivered: info.num_redelivered });
    await nc.close();
  },

  async 'js-03-global-options-strict-server'() {
    await resetStream(NATS_MAIN_URL);
    // README, "Global Event Settings"
    await startService(
      [SmokeController],
      { ...jetStreamOptions(), globalEventOptions: { nak_delay: 2000, max_handlers: 5 } },
      streams(),
    );
    await sleep(500);
    await publishJs(NATS_MAIN_URL, 'e2e.js.smoke', [{ n: 1 }]);
    await waitFor(() => state.received.length >= 1, 3000);
    report({ received: state.received.length });
  },

  async 'js-04-global-runtime-options'() {
    await resetStream(NATS_LEGACY_URL);
    await startService(
      [GlobalConcurrencyController, LocalConcurrencyController],
      { ...jetStreamOptions(NATS_LEGACY_URL), globalEventOptions: { max_handlers: 5 } },
      streams(),
      new CountingLogger({ quiet: true }),
    );
    await sleep(500);
    await publishJs(NATS_LEGACY_URL, 'e2e.js.concurrency.global', Array.from({ length: 10 }, (_, i) => ({ i })));
    await waitFor(() => globalMeter.calls >= 10 && globalMeter.active === 0, 10_000);
    await publishJs(NATS_LEGACY_URL, 'e2e.js.concurrency.local', Array.from({ length: 10 }, (_, i) => ({ i })));
    await waitFor(() => localMeter.calls >= 10 && localMeter.active === 0, 10_000);
    report({ globalMaxParallel: globalMeter.max, localMaxParallel: localMeter.max });
  },

  async 'js-05-no-stream-for-subject'() {
    await resetStream(NATS_MAIN_URL);
    const app = await createService([NoStreamController], jetStreamOptions(), streams());
    const listenError = await app.listen().then(
      () => null,
      (e: Error) => e.message,
    );
    log('listen() outcome:', listenError ?? 'resolved');
    report({ listenError });
    await sleep(1500);
  },

  async 'js-06-filter-subjects'() {
    await resetStream(NATS_MAIN_URL);
    await startService([FilterSubjectsController], jetStreamOptions(), streams());
    await sleep(500);
    await publishJs(NATS_MAIN_URL, 'e2e.js.multi.a', [{ n: 1 }]);
    await publishJs(NATS_MAIN_URL, 'e2e.js.multi.b', [{ n: 2 }]);
    await waitFor(() => state.subjects.length >= 2, 3000);
    report({ subjects: state.subjects.sort() });
  },

  async 'js-07-start-sequence'() {
    await resetStream(NATS_MAIN_URL);
    await createStream(NATS_MAIN_URL);
    await publishJs(NATS_MAIN_URL, 'e2e.js.replay', [{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
    await startService([StartSequenceController], jetStreamOptions(), streams());
    await waitFor(() => state.received.length >= 2, 3000);
    await sleep(300);
    report({ received: state.received });
  },

  async 'js-08-consumer-name-collision'() {
    await resetStream(NATS_MAIN_URL);
    await startService([NameCollisionController], jetStreamOptions(), streams());
    await sleep(500);
    await publishJs(NATS_MAIN_URL, 'e2e.js.orders.created.v1', [{ n: 1 }]);
    await publishJs(NATS_MAIN_URL, 'e2e.js.orders.created-v1', [{ n: 2 }]);
    await waitFor(() => state.routes.length >= 2, 3000);
    report({ routes: state.routes.sort() });
  },

  async 'js-09-prefetch-redelivery'() {
    await resetStream(NATS_MAIN_URL);
    await startService([PrefetchController], jetStreamOptions(), streams(), new CountingLogger({ quiet: true }));
    await sleep(500);
    await publishJs(NATS_MAIN_URL, 'e2e.js.prefetch', Array.from({ length: 20 }, (_, i) => ({ i })));
    log('published 20 messages: handler takes 400 ms, max_handlers=1, ack_wait=2 s');
    await sleep(16_000);
    report({
      unique: state.perMessage.size,
      invocations: state.invocations,
      processedMoreThanOnce: [...state.perMessage.values()].filter(count => count > 1).length,
      maxRedeliveryCount: state.maxRedeliveryCount,
    });
  },

  async 'js-11-nak-redelivery'() {
    await resetStream(NATS_MAIN_URL);
    await startService([SingleNakController], jetStreamOptions(), streams(), new CountingLogger({ quiet: true }));
    await sleep(500);
    await publishJs(NATS_MAIN_URL, 'e2e.js.nak.single', [{ n: 1 }]);
    await sleep(2500);
    report({ deliveries: state.singleNak });
  },

  async 'js-12-prefetch-buffer-size'() {
    await resetStream(NATS_MAIN_URL);
    await startService([PrefetchBufferController], jetStreamOptions(), streams(), new CountingLogger({ quiet: true }));
    await sleep(500);
    await publishJs(NATS_MAIN_URL, 'e2e.js.buffer.default', Array.from({ length: 20 }, (_, i) => ({ i })));
    await publishJs(NATS_MAIN_URL, 'e2e.js.buffer.explicit', Array.from({ length: 20 }, (_, i) => ({ i })));

    // num_ack_pending: messages in the handlers plus messages waiting in the client buffer
    const nc = await connect({ servers: NATS_MAIN_URL });
    const jsm = await nc.jetstreamManager();
    const maxAckPending = { default: 0, explicit: 0 };
    for (let sample = 0; sample < 25; sample++) {
      for (const key of ['default', 'explicit'] as const) {
        const info = await consumerInfoFor(jsm, `e2e.js.buffer.${key}`);
        maxAckPending[key] = Math.max(maxAckPending[key], info.num_ack_pending);
      }
      await sleep(100);
    }
    report({ maxAckPending });
    await nc.close();
  },

  async 'js-14-two-handlers-one-pattern'() {
    await resetStream(NATS_MAIN_URL);
    const app = await createService([FirstOfTwoNakController, SecondOfTwoNakController], jetStreamOptions(), streams());
    const listenError = await app.listen().then(
      () => null,
      (e: Error) => e.message,
    );
    log('listen() outcome:', listenError ?? 'resolved');
    report({ listenError });
    await sleep(1500);
  },

  async 'js-13-ack-on-close'() {
    await resetStream(NATS_MAIN_URL);
    const app = await startService(
      [InProgressController],
      jetStreamOptions(),
      streams(),
      new CountingLogger({ quiet: true }),
    );
    await sleep(500);
    await publishJs(NATS_MAIN_URL, 'e2e.js.in-progress', [{ n: 1 }]);
    await waitFor(() => state.inProgress.started === 1, 3000);
    log('app.close() while the message is being processed');
    await app.close();
    await sleep(300);

    const nc = await connect({ servers: NATS_MAIN_URL });
    const info = await consumerInfoFor(await nc.jetstreamManager(), 'e2e.js.in-progress');
    report({ handled: state.inProgress.done, ackPending: info.num_ack_pending, redelivered: info.num_redelivered });
    await nc.close();
  },
};
