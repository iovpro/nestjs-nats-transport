import 'reflect-metadata';
import { ErrorCode, JSONCodec, Match, MsgHdrs, NatsError, connect, headers as natsMsgHeaders } from 'nats';
import { NatsRecordBuilder } from '@nestjs/microservices';
import { QueuedIteratorImpl } from 'nats/lib/nats-base-client/queued_iterator';
import { deferred } from 'nats/lib/nats-base-client/util';
import { firstValueFrom, lastValueFrom } from 'rxjs';
import { ClientNats } from './client-nats';
import { RequestContext } from '../context';
import { TRACE_ID_HEADER, REQUEST_ID_HEADER } from '../constants';

// connect() is replaced to observe the connections the client opens
jest.mock('nats', () => ({ ...jest.requireActual('nats'), connect: jest.fn() }));

describe('ClientNats connection', () => {
  const fakeConnection = () => ({
    gone: false, // nats.js has closed the connection for good
    isClosed() {
      return this.gone;
    },
    closed: () => new Promise(() => undefined),
    close: jest.fn(),
    status: async function* () {},
    getServer: () => 'nats://fake:4222',
    info: { server_id: 'fake' },
  });

  const createClient = (connection = {}, options = {}): any => {
    const client: any = new ClientNats({ connection, ...options });
    client.logger = { log: jest.fn(), error: jest.fn() };
    return client;
  };

  beforeEach(() =>
    jest
      .mocked(connect)
      .mockReset()
      .mockImplementation(async () => fakeConnection() as any),
  );

  it('UT-27 should open a new connection once the current one is closed for good', async () => {
    const client = createClient();
    const first = await client.connect();

    expect(await client.connect()).toBe(first);
    first.gone = true; // nats.js gave up reconnecting
    expect(await client.connect()).not.toBe(first);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('UT-28 should not limit reconnect attempts unless the connection options set a limit', async () => {
    await createClient().connect();
    await createClient({ maxReconnectAttempts: 3 }).connect();

    expect(connect).toHaveBeenNthCalledWith(1, expect.objectContaining({ maxReconnectAttempts: -1 }));
    expect(connect).toHaveBeenNthCalledWith(2, expect.objectContaining({ maxReconnectAttempts: 3 }));
  });

  it('UT-34 unwrap() should return the current connection and throw before connect()', async () => {
    const client = createClient();
    expect(() => client.unwrap()).toThrow('Not initialized');

    const connection = await client.connect();
    expect(client.unwrap()).toBe(connection);
  });

  it('UT-36 status and on() should follow the connection until close()', async () => {
    const feed = new QueuedIteratorImpl<{ type: string; data?: unknown }>();
    const connection = Object.assign(fakeConnection(), { status: () => feed, drain: jest.fn() });
    jest.mocked(connect).mockImplementation(async () => connection as any);
    const client = createClient();
    const statuses: string[] = [];
    const events: unknown[] = [];
    client.status.subscribe((status: string) => statuses.push(status));
    ['disconnect', 'reconnect', 'update', 'error'].forEach(event =>
      client.on(event, (data: unknown) => events.push([event, data])),
    );
    await client.connect();

    ['disconnect', 'reconnecting', 'reconnecting', 'error', 'reconnect', 'update'].forEach(type =>
      feed.push({ type, data: type }),
    );
    await new Promise(resolve => setImmediate(resolve));
    expect(statuses).toEqual(['connected', 'disconnected', 'reconnecting', 'connected']);
    expect(events).toEqual([
      ['disconnect', 'disconnect'],
      ['reconnect', 'reconnect'],
      ['update', 'update'],
    ]);

    await client.close();
    feed.push({ type: 'disconnect', data: 'disconnect' });
    await new Promise(resolve => setImmediate(resolve));
    expect(events).toHaveLength(3); // close() removes the listeners
  });

  it('UT-44 request() should wait for requestTimeout, 30 s by default, whatever connection.timeout is', async () => {
    const reply = { data: JSONCodec().encode({ response: 'ok', isDisposed: true }) };
    const request = jest.fn(async (subject: string, data: Uint8Array, options: { timeout: number }) => reply);
    jest.mocked(connect).mockImplementation(async () => Object.assign(fakeConnection(), { request }) as any);

    await createClient({ timeout: 1_000 }).request('orders', 1);
    await createClient({}, { requestTimeout: 5_000 }).request('orders', 1);

    expect(request.mock.calls.map(([, , options]) => options.timeout)).toEqual([30_000, 5_000]);
  });

  it('UT-69 close() should call close() on the connection when drain() does not close it', async () => {
    const connection = Object.assign(fakeConnection(), { drain: jest.fn() });
    jest.mocked(connect).mockImplementation(async () => connection as any);
    const client = createClient();
    await client.connect();

    await client.close();
    expect(connection.drain).toHaveBeenCalled();
    expect(connection.close).toHaveBeenCalled();
    expect(connection.drain.mock.invocationCallOrder[0]).toBeLessThan(connection.close.mock.invocationCallOrder[0]);
  });

  it('UT-45 a failed connection attempt should not be reused by the next call', async () => {
    jest.mocked(connect).mockRejectedValueOnce(new Error('connection refused'));
    const client = createClient();

    await expect(client.connect()).rejects.toThrow('connection refused');
    await expect(client.connect()).resolves.toBeDefined();
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('UT-75 the status updates should go on past pingTimer when the connection option is not set', async () => {
    const client = Object.assign(new ClientNats({} as any), { logger: { log: jest.fn() } });
    const feed = new QueuedIteratorImpl<{ type: string; data?: unknown }>();
    const watching = client.handleStatusUpdates({ status: () => feed } as any);
    feed.push({ type: 'pingTimer', data: 1 });
    feed.stop();

    await expect(watching).resolves.toBeUndefined();
  });

  /** A connected client whose connection drains with `drain` */
  const connectedClient = async (drain: () => Promise<unknown>) => {
    const connection = Object.assign(fakeConnection(), { drain: jest.fn(drain) });
    jest.mocked(connect).mockImplementation(async () => connection as any);
    const client = createClient();
    await client.connect();
    return { client, connection };
  };

  it('UT-97 close() should not drain a connection that nats.js has closed', async () => {
    const { client, connection } = await connectedClient(async () => {
      throw NatsError.errorForCode(ErrorCode.ConnectionClosed);
    });
    connection.gone = true; // nats.js gave up reconnecting, no request came since

    await client.close();
    expect(connection.drain).not.toHaveBeenCalled();
    expect(client.logger.error).not.toHaveBeenCalled();
  });

  it('UT-98 close() should stop waiting for the drain once nats.js closes the connection', async () => {
    // NATS stops answering during close(): the drain waits for a PONG that does not come
    const { client, connection } = await connectedClient(() => new Promise(() => undefined));
    const gone = deferred<void>();
    connection.closed = () => gone;
    const closing = client.close();

    // and nats.js runs out of reconnect attempts
    connection.gone = true;
    gone.resolve();
    await closing;
    expect(client.logger.log).toHaveBeenCalledWith('Nats client disconnected');
  });

  it('UT-99 close() called again while it runs should wait for the same close', async () => {
    // As nats.js: a connection that drains already refuses another drain
    const { client, connection } = await connectedClient(async () => {
      if (connection.drain.mock.calls.length > 1) throw NatsError.errorForCode(ErrorCode.ConnectionDraining);
    });

    await Promise.all([client.close(), client.close()]);
    expect(connection.drain).toHaveBeenCalledTimes(1);
    expect(client.logger.error).not.toHaveBeenCalled();
  });
});

describe('ClientNats request context', () => {
  /** Captures headers sent by the nats.js request/publish calls */
  const sentHeaders: MsgHdrs[] = [];
  const reply = { data: JSONCodec().encode({ response: 'ok', isDisposed: true }) };
  const natsRequest = jest.fn(async (_s: string, _d: any, opts: { headers: MsgHdrs }) => {
    sentHeaders.push(opts.headers);
    return reply;
  });
  const natsPublish = jest.fn((_s: string, _d: any, opts: { headers: MsgHdrs }) => {
    sentHeaders.push(opts.headers);
  });
  const jsPublish = jest.fn(async (_s: string, _d: any, opts: { headers: MsgHdrs }) => {
    sentHeaders.push(opts.headers);
  });

  const fakeConn = () =>
    ({
      isClosed: () => false,
      closed: () => new Promise(() => undefined),
      close: jest.fn(),
      status: async function* () {},
      getServer: () => 'nats://fake:4222',
      info: { server_id: 'fake' },
      request: natsRequest,
      publish: natsPublish,
      jetstream: () => ({ publish: jsPublish }),
    }) as any;

  const createCtxClient = (opts = {}): any => {
    const client: any = new ClientNats({ connection: {}, requestContext: true, ...opts });
    client.logger = { log: jest.fn(), error: jest.fn() };
    return client;
  };

  beforeEach(() => {
    sentHeaders.length = 0;
    natsRequest.mockClear();
    natsPublish.mockClear();
    jsPublish.mockClear();
    jest
      .mocked(connect)
      .mockReset()
      .mockImplementation(async () => fakeConn());
  });

  it('UT-105 context headers on all four paths (request, event, send, emit)', async () => {
    const store = { traceId: 'T', requestId: 'R' };

    await RequestContext.run(store, async () => {
      // request()
      const client1 = createCtxClient();
      await client1.request('orders', 1);

      // event() with jetStream: true
      const client2 = createCtxClient({ jetStream: true });
      await client2.connect();
      await client2.event('orders', 2);

      // event() without jetStream
      const client3 = createCtxClient({ jetStream: false });
      await client3.connect();
      await client3.event('orders', 3);

      // send() (RPC via ClientProxy)
      const client4 = createCtxClient();
      await client4.connect();
      await firstValueFrom(client4.send('orders', 4));

      // emit()
      const client5 = createCtxClient({ jetStream: true });
      await client5.connect();
      await lastValueFrom(client5.emit('orders', 5));
    });

    expect(sentHeaders.length).toBeGreaterThanOrEqual(5);
    for (const hdrs of sentHeaders) {
      expect(hdrs.get(TRACE_ID_HEADER)).toBe('T');
      expect(hdrs.get(REQUEST_ID_HEADER)).toBe('R');
    }
  });

  it('UT-106 explicit header in different case wins over context', async () => {
    await RequestContext.run({ traceId: 'CTX', requestId: 'CTX-R' }, async () => {
      const client = createCtxClient();
      await client.request('orders', 1, { 'X-Trace-Id': 'mine', 'X-Request-Id': 'my-r' });

      const hdrs = sentHeaders[0];
      // Only the explicit values: the lowercase context headers are not added
      expect(hdrs.values(TRACE_ID_HEADER)).toHaveLength(0);
      expect(hdrs.get('X-Trace-Id')).toBe('mine');
      expect(hdrs.values(REQUEST_ID_HEADER)).toHaveLength(0);
      expect(hdrs.get('X-Request-Id')).toBe('my-r');
    });
  });

  it('UT-107 NatsRecord of the caller is not mutated; different context per send', async () => {
    const recordHdrs = natsMsgHeaders();
    recordHdrs.set('user-id', 'U1');
    const record = new NatsRecordBuilder().setData({ item: 1 }).setHeaders(recordHdrs).build();

    await RequestContext.run({ traceId: 'T1' }, async () => {
      const client = createCtxClient();
      await client.request('orders', record);

      expect(sentHeaders[0].get(TRACE_ID_HEADER)).toBe('T1');
      expect(sentHeaders[0].get('user-id')).toBe('U1');
      // Original record headers not mutated
      expect(recordHdrs.has(TRACE_ID_HEADER)).toBe(false);
    });

    sentHeaders.length = 0;

    await RequestContext.run({ traceId: 'T2' }, async () => {
      const client = createCtxClient();
      await client.request('orders', record);

      expect(sentHeaders[0].get(TRACE_ID_HEADER)).toBe('T2');
    });
  });

  it.each([
    { name: 'requestContext: false', opts: { requestContext: false }, ctx: { traceId: 'T' }, requestId: undefined },
    { name: 'no context', opts: {}, ctx: undefined, requestId: undefined },
    { name: 'empty traceId', opts: {}, ctx: { requestId: 'R' } as any, requestId: 'R' },
  ])('UT-108 no x-trace-id header when: $name', async ({ opts, ctx, requestId }) => {
    const run = async () => {
      const client = createCtxClient(opts);
      await client.request('orders', 1);
      const hdrs = sentHeaders[0];
      expect(hdrs.has(TRACE_ID_HEADER)).toBe(false);
      // nats.js returns '' for a missing header
      expect(hdrs.get(REQUEST_ID_HEADER) || undefined).toBe(requestId);
    };

    if (ctx) {
      await RequestContext.run(ctx, run);
    } else {
      await run();
    }
  });

  it('UT-108 context without requestId — no x-request-id header', async () => {
    await RequestContext.run({ traceId: 'T' }, async () => {
      const client = createCtxClient();
      await client.request('orders', 1);
      expect(sentHeaders[0].get(TRACE_ID_HEADER)).toBe('T');
      expect(sentHeaders[0].has(REQUEST_ID_HEADER)).toBe(false);
    });
  });

  it('UT-109 connection opens outside request context', async () => {
    const feed = new QueuedIteratorImpl<{ type: string; data?: unknown }>();
    const conn = Object.assign(fakeConn(), { status: () => feed });
    jest.mocked(connect).mockImplementation(async () => conn);

    const client = createCtxClient();
    const onDisconnect = jest.fn(() => RequestContext.get());

    client.on('disconnect', onDisconnect);

    await RequestContext.run({ traceId: 'A' }, async () => {
      await client.request('orders', 1);
    });

    // The request was sent with traceId A
    expect(sentHeaders[0].get(TRACE_ID_HEADER)).toBe('A');

    // Status update outside context
    feed.push({ type: 'disconnect', data: 'gone' });
    await new Promise(resolve => setImmediate(resolve));

    expect(onDisconnect).toHaveBeenCalled();
    expect(onDisconnect.mock.results[0].value).toBeUndefined();
  });
});
