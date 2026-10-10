import 'reflect-metadata';
import { ErrorCode, JSONCodec, NatsError, connect } from 'nats';
import { QueuedIteratorImpl } from 'nats/lib/nats-base-client/queued_iterator';
import { deferred } from 'nats/lib/nats-base-client/util';
import { ClientNats } from './client-nats';

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
