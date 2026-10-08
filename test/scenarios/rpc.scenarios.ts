import { Controller, HttpStatus, Type } from '@nestjs/common';
import { Ctx, MessagePattern, NatsRecord, Payload } from '@nestjs/microservices';
import { JSONCodec, StringCodec, connect } from 'nats';
import { firstValueFrom, timeout } from 'rxjs';
import { ClientNats, NatsContext, NatsEventPattern, NatsMessagePattern, NatsRpcException } from '../../src';
import { NATS_MAIN_URL } from './env';
import { CountingLogger, createService, log, report, sleep, startService } from './harness';

export const INTERNAL_ERROR_DETAILS = 'connect ECONNREFUSED 10.20.30.40:5432 (db user=billing_rw)';

@Controller()
export class RpcController {
  @NatsMessagePattern('e2e.rpc.echo')
  echo(@Payload() data: unknown) {
    return { received: data };
  }

  @NatsMessagePattern('e2e.rpc.oversized')
  oversized() {
    return 'x'.repeat(2 * 1024 * 1024);
  }

  @NatsMessagePattern('e2e.rpc.bigint')
  bigint() {
    return { id: BigInt(10) };
  }

  @MessagePattern('e2e.rpc.internal-error.plain')
  internalErrorPlain() {
    throw new Error(INTERNAL_ERROR_DETAILS);
  }

  @NatsMessagePattern('e2e.rpc.business-error')
  businessError() {
    throw new NatsRpcException({ message: 'User not found', statusCode: HttpStatus.NOT_FOUND, errorCode: 'USER_NOT_FOUND' });
  }

  @NatsMessagePattern('e2e.rpc.slow')
  async slow() {
    await sleep(1500);
    return 'done';
  }

  @NatsMessagePattern('e2e.rpc.headers')
  headers(@Ctx() ctx: NatsContext) {
    return new NatsRecord({ requestId: ctx.getHeaders()?.get('x-request-id') ?? null }, { 'x-served-by': 'e2e' });
  }
}

@Controller()
class SharedRpcController {
  @NatsMessagePattern('e2e.rpc.shared')
  handle() {}
}

@Controller()
class SecondSharedRpcController {
  @NatsMessagePattern('e2e.rpc.shared')
  handle() {}
}

@Controller()
class SharedEventController {
  @NatsEventPattern('e2e.rpc.shared')
  handle() {}
}

const createClient = (connection: Record<string, unknown> = {}) =>
  new ClientNats({ connection: { servers: NATS_MAIN_URL, ...connection } });

/** Request with an rxjs timeout, so the outcome does not depend on the library's own timeout handling */
async function requestWithin(client: ClientNats, pattern: string, ms: number): Promise<string> {
  try {
    const reply = await firstValueFrom(client.send(pattern, {}).pipe(timeout(ms)));
    return `reply: ${JSON.stringify(reply).slice(0, 80)}`;
  } catch (error) {
    const e = error as { name?: string; message?: string };
    return e.name === 'TimeoutError' ? 'no reply' : `error: ${e.message ?? JSON.stringify(error)}`;
  }
}

/** Sends raw bytes the way any NATS client (or `nats req`) can */
async function rawRequest(subject: string, payload: Uint8Array): Promise<string> {
  const nc = await connect({ servers: NATS_MAIN_URL });
  try {
    const reply = await nc.request(subject, payload, { timeout: 1500 });
    return `reply: ${reply.string().slice(0, 120)}`;
  } catch (error) {
    return `error: ${(error as { code?: string }).code ?? (error as Error).message}`;
  } finally {
    await nc.close();
  }
}

async function survivesRawPayload(payload: Uint8Array) {
  await startService([RpcController]);
  const rawOutcome = await rawRequest('e2e.rpc.echo', payload);
  log('raw requester outcome:', rawOutcome);
  await sleep(500);

  const client = createClient();
  const followUp = await requestWithin(client, 'e2e.rpc.echo', 3000);
  report({ rawOutcome, followUp });
  await client.close();
}

async function survivesUnsendableResponse(pattern: string) {
  await startService([RpcController]);
  const client = createClient();
  const outcome = await requestWithin(client, pattern, 5000);
  log('caller outcome:', outcome);
  const rawOutcome = await rawRequest(pattern, JSONCodec().encode({ pattern, data: {}, id: 'raw-1' }));
  log('raw requester outcome:', rawOutcome);
  await sleep(300);
  report({ outcome, rawOutcome });
}

export const scenarios: Record<string, () => Promise<void>> = {
  'rpc-01-malformed-payload': () => survivesRawPayload(StringCodec().encode('definitely-not-json')),

  'rpc-02-empty-payload': () => survivesRawPayload(new Uint8Array(0)),

  'rpc-03-oversized-response': () => survivesUnsendableResponse('e2e.rpc.oversized'),

  'rpc-04-bigint-response': () => survivesUnsendableResponse('e2e.rpc.bigint'),

  async 'rpc-05-falsy-payloads'() {
    await startService([RpcController]);
    const client = createClient();
    const received: unknown[] = [];
    for (const value of [0, false, '', 42, 'text', { a: 1 }]) {
      received.push((await client.request<{ received: unknown }>('e2e.rpc.echo', value)).received);
    }
    report({ received });
    await client.close();
  },

  async 'rpc-06-error-propagation'() {
    await startService([RpcController], {}, undefined, new CountingLogger({ quiet: true }));
    const client = createClient();
    const outcome = (pattern: string) =>
      client.request(pattern, {}).then(
        () => ({ replied: true }),
        (e: NatsRpcException) => ({
          name: e.name,
          message: e.message,
          statusCode: e.statusCode ?? null,
          errorCode: e.errorCode ?? null,
        }),
      );

    report({
      internalPlain: await outcome('e2e.rpc.internal-error.plain'),
      business: await outcome('e2e.rpc.business-error'),
    });
    await client.close();
  },

  async 'rpc-08-request-timeout'() {
    await startService([RpcController]);
    // connection.timeout is the nats.js connect timeout and must not limit how long an RPC may take
    const client = createClient({ timeout: 1000 });
    const outcome = await client.request('e2e.rpc.slow', {}).then(
      reply => `reply: ${reply}`,
      (e: Error) => `error: ${e.message}`,
    );
    report({ outcome });
    await client.close();
  },

  async 'rpc-09-shutdown-inflight'() {
    const app = await startService([RpcController]);
    const client = createClient();
    let outcome = 'no reply';
    client.request('e2e.rpc.slow', {}).then(
      reply => (outcome = `reply: ${reply}`),
      (e: Error) => (outcome = `error: ${e.message}`),
    );
    await sleep(200);
    log('app.close() while e2e.rpc.slow is in flight');
    await app.close();
    await sleep(2500);
    report({ outcome });
  },

  async 'rpc-10-headers'() {
    await startService([RpcController]);
    const client = createClient();
    const reply = await client.request<{ requestId: string | null }>('e2e.rpc.headers', {}, { 'x-request-id': 'req-42' });

    // ClientNats returns only the payload, so response headers are read with a raw request
    const nc = await connect({ servers: NATS_MAIN_URL });
    const raw = await nc.request('e2e.rpc.headers', JSONCodec().encode({ pattern: 'e2e.rpc.headers', data: {}, id: 'raw-1' }));
    report({ requestIdSeenByHandler: reply.requestId, responseHeader: raw.headers?.get('x-served-by') ?? null });
    await nc.close();
    await client.close();
  },

  async 'rpc-11-shared-rpc-pattern'() {
    const pairs: Record<string, Type[]> = {
      rpcThenEvent: [SharedRpcController, SharedEventController],
      eventThenRpc: [SharedEventController, SharedRpcController],
      rpcThenRpc: [SharedRpcController, SecondSharedRpcController],
    };
    const outcomes: Record<string, Record<string, string | null>> = { jetStream: {}, core: {} };
    for (const mode of Object.keys(outcomes)) {
      for (const [pair, controllers] of Object.entries(pairs)) {
        const app = await createService(controllers, { jetStream: mode === 'jetStream' });
        outcomes[mode][pair] = await app.listen().then(
          () => null,
          (e: Error) => e.message,
        );
      }
    }
    log('listen() outcomes:', JSON.stringify(outcomes));
    report(outcomes);
  },
};
