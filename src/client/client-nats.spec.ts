import 'reflect-metadata';
import { JSONCodec, connect } from 'nats';
import { QueuedIteratorImpl } from 'nats/lib/nats-base-client/queued_iterator';
import { ClientNats } from './client-nats';

// connect() is replaced to observe the connections the client opens
jest.mock('nats', () => ({ ...jest.requireActual('nats'), connect: jest.fn() }));

describe('ClientNats connection', () => {
  const fakeConnection = () => ({
    closed: false,
    isClosed() {
      return this.closed;
    },
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
    first.closed = true; // nats.js gave up reconnecting
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

  it('UT-45 a failed connection attempt should not be reused by the next call', async () => {
    jest.mocked(connect).mockRejectedValueOnce(new Error('connection refused'));
    const client = createClient();

    await expect(client.connect()).rejects.toThrow('connection refused');
    await expect(client.connect()).resolves.toBeDefined();
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
