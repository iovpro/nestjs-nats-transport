import { Controller } from '@nestjs/common';
import { Ctx, Payload } from '@nestjs/microservices';
import { JSONCodec, connect as rawConnect } from 'nats';
import {
  ClientNats,
  NatsContext,
  NatsEventPattern,
  NatsMessagePattern,
  RequestContext,
  RequestId,
  ServerNats,
} from '../../src';
import { NATS_MAIN_URL } from './env';
import { report, resetStream, startStrategy, streams, waitFor } from './harness';

interface Captured {
  ctxTraceId: string | undefined;
  ctxRequestId: string | undefined;
  natsCtxTraceId: string | undefined;
  natsCtxRequestId: string | undefined;
  decoratorRequestId: string | undefined;
}

const captured: Record<string, Captured> = {};

function capture(key: string, ctx: NatsContext, requestId: string | undefined): Captured {
  const c: Captured = {
    ctxTraceId: RequestContext.getTraceId(),
    ctxRequestId: RequestContext.getRequestId(),
    natsCtxTraceId: ctx.getTraceId(),
    natsCtxRequestId: ctx.getRequestId(),
    decoratorRequestId: requestId,
  };
  captured[key] = c;
  return c;
}

@Controller()
class ContextCoreController {
  @NatsMessagePattern('e2e.ctx.rpc')
  async rpc(
    @Payload() data: any,
    @Ctx() ctx: NatsContext,
    @RequestId() requestId: string | undefined,
  ) {
    capture('rpc', ctx, requestId);

    // Downstream RPC: tests two-hop propagation
    const client = new ClientNats({
      connection: { servers: NATS_MAIN_URL },
      requestContext: true,
    });
    await client.connect();
    const downstream = await client.request<Captured>(
      'e2e.ctx.rpc.downstream',
      { from: 'rpc' },
    );
    captured['downstream'] = downstream;
    await client.close();

    return captured['rpc'];
  }

  @NatsMessagePattern('e2e.ctx.rpc.downstream')
  downstream(
    @Payload() data: any,
    @Ctx() ctx: NatsContext,
    @RequestId() requestId: string | undefined,
  ) {
    return capture('downstream-handler', ctx, requestId);
  }

  @NatsEventPattern('e2e.ctx.event')
  event(@Payload() data: any, @Ctx() ctx: NatsContext, @RequestId() requestId: string | undefined) {
    capture('event', ctx, requestId);
  }
}

@Controller()
class ContextJsController {
  @NatsEventPattern('e2e.js.ctx.event')
  event(
    @Payload() data: any,
    @Ctx() ctx: NatsContext,
    @RequestId() requestId: string | undefined,
  ) {
    capture('js-event', ctx, requestId);
  }
}

let genCounter = 0;

export const scenarios: Record<string, () => Promise<void>> = {
  async 'ctx-01-cross-service-propagation'() {
    await resetStream(NATS_MAIN_URL);
    const connection = { servers: NATS_MAIN_URL };

    const core = await startStrategy(
      new ServerNats({ consumerName: 'e2e', connection, requestContext: true }),
      [ContextCoreController],
    );
    const js = await startStrategy(
      new ServerNats(
        { consumerName: 'e2e', connection, jetStream: true, requestContext: true },
        streams(),
      ),
      [ContextJsController],
    );

    const client = new ClientNats({ connection, requestContext: true });
    await client.connect();

    await RequestContext.run({ traceId: 'trace-1', requestId: 'req-1' }, async () => {
      await client.request('e2e.ctx.rpc', { test: true });
      await client.event('e2e.ctx.event', { test: true });
      await client.event('e2e.js.ctx.event', { test: true });
    });

    await waitFor(() => Boolean(captured['event'] && captured['js-event']), 5000);
    await client.close();

    report({
      rpc: captured['rpc'],
      downstream: captured['downstream'],
      event: captured['event'],
      jsEvent: captured['js-event'],
    });

    await core.close();
    await js.close();
  },

  async 'ctx-02-message-without-headers'() {
    await resetStream(NATS_MAIN_URL);
    genCounter = 0;
    const connection = { servers: NATS_MAIN_URL };

    const core = await startStrategy(
      new ServerNats({
        consumerName: 'e2e',
        connection,
        requestContext: true,
        generateTraceId: () => `gen-${++genCounter}`,
      }),
      [ContextCoreController],
    );
    const js = await startStrategy(
      new ServerNats(
        {
          consumerName: 'e2e',
          connection,
          jetStream: true,
          requestContext: true,
          generateTraceId: () => `gen-${++genCounter}`,
        },
        streams(),
      ),
      [ContextJsController],
    );

    // Send raw NATS messages without headers
    const nc = await rawConnect({ servers: NATS_MAIN_URL });
    const codec = JSONCodec<any>();

    // RPC without headers
    const rpcReply = await nc.request(
      'e2e.ctx.rpc.downstream',
      codec.encode({ pattern: 'e2e.ctx.rpc.downstream', data: { raw: true } }),
    );
    const rpcResult = codec.decode(rpcReply.data);

    // JetStream without headers
    const jsClient = nc.jetstream();
    await jsClient.publish(
      'e2e.js.ctx.event',
      codec.encode({ pattern: 'e2e.js.ctx.event', data: { raw: true } }),
    );

    await waitFor(() => Boolean(captured['js-event']), 5000);
    await nc.close();

    report({
      rpcNoHeaders: rpcResult.response ?? rpcResult,
      jsNoHeaders: captured['js-event'],
    });

    await core.close();
    await js.close();
  },
};
