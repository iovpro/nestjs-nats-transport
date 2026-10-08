import { AsyncLocalStorage } from 'async_hooks';
import { ErrorCode, JSONCodec, JsMsg, NatsError, connect } from 'nats';
import { QueuedIteratorImpl } from 'nats/lib/nats-base-client/queued_iterator';
import { SimpleMutex } from 'nats/lib/nats-base-client/util';
import { defer } from 'rxjs';
import { CONSUMER_RETRY_DELAY, GRACE_PERIOD, NAK, RECONNECT_DELAY } from '../constants';
import { NatsContext } from '../ctx-host/nats.context';
import { NakStrategy, NatsEventHandlerOptions } from '../interfaces';
import { ServerNats } from './server-nats';

// connect() is replaced to check the connection options passed to nats.js
jest.mock('nats', () => ({ ...jest.requireActual('nats'), connect: jest.fn() }));

// The helpers below are private; they are exercised directly to pin down their contract without a NATS server.
const createServer = (globalEventOptions?: Partial<NatsEventHandlerOptions>): any =>
  new ServerNats({ consumerName: 'svc', connection: {}, jetStream: true, globalEventOptions });

const delivery = (deliveryCount: number) => ({ info: { deliveryCount } }) as unknown as JsMsg;

// Real setImmediate: pending promise callbacks run while the fake clock stands still
const settle = () => new Promise(resolve => jest.requireActual('timers').setImmediate(resolve));

describe('ServerNats internals', () => {
  describe('NAK delay strategies', () => {
    const server = createServer();
    const delays = (options: NatsEventHandlerOptions, attempts: number[]) =>
      attempts.map(attempt => server.calculateNakDelay(delivery(attempt), options));

    it('UT-10 regular strategy should always return nak_delay', () => {
      expect(delays({ nak_strategy: NakStrategy.regular, nak_delay: 1_500 }, [1, 2, 7])).toEqual([1_500, 1_500, 1_500]);
    });

    it('UT-11 increment strategy should grow linearly up to nak_delay_max', () => {
      const options = { nak_strategy: NakStrategy.increment, nak_delay: 1_000, nak_delay_max: 3_500 };

      expect(delays(options, [1, 2, 3, 4])).toEqual([1_000, 2_000, 3_000, 3_500]);
    });

    it('UT-12 fibonacci strategy should follow the Fibonacci sequence up to nak_delay_max', () => {
      const options = { nak_strategy: NakStrategy.fibonacci, nak_delay: 1_000, nak_delay_max: 60_000 };

      expect(delays(options, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])).toEqual([
        1_000, 1_000, 2_000, 3_000, 5_000, 8_000, 13_000, 21_000, 34_000, 55_000, 60_000,
      ]);
    });

    it('UT-42 NAK options from globalEventOptions should apply unless the decorator sets them', async () => {
      const server = createServer({ nak_delay: 2_000, nak_strategy: NakStrategy.increment });
      /** NAK delay for the second delivery of a message whose handler returns NAK */
      const nakDelay = async (extras: NatsEventHandlerOptions) => {
        const nak = jest.fn();
        const msg = { data: JSONCodec().encode({ data: 1 }), info: { deliveryCount: 2 }, working: jest.fn(), nak };
        const handler = Object.assign(async () => NAK, { extras });
        await server.handleNatsJetStreamEvent('orders', msg, handler, new SimpleMutex(1));
        await settle();
        return nak.mock.calls[0]?.[0];
      };

      expect(await nakDelay({})).toBe(4_000);
      expect(await nakDelay({ nak_delay: 500 })).toBe(1_000);
    });
  });

  describe('consumer naming', () => {
    it('UT-13 should produce distinct consumer names for distinct subjects', () => {
      const server = createServer();

      expect(server.buildConsumerName('orders.created.v1')).not.toBe(server.buildConsumerName('orders.created-v1'));
    });

    it('UT-39 should name a consumer after the subject and the first 8 hex digits of its SHA-256', () => {
      expect(createServer().buildConsumerName('orders.created')).toBe('svc:orders-created~18d455b7');
    });
  });

  describe('consumer binding', () => {
    const notFound = () =>
      Object.assign(new NatsError('consumer not found', '404'), {
        api_error: { code: 404, err_code: 10014, description: 'consumer not found' },
      });

    /** ServerNats on a JetStream stand-in with no consumers; looking up a name in `failures` rejects with its error */
    const jetStream = (failures: Record<string, Error> = {}) => {
      const names = new Set<string>();
      const server = createServer();
      server.logger = { log: jest.fn(), error: jest.fn() };
      server.jetstreamManager = {
        streams: { find: async () => 'ORDERS' },
        consumers: {
          add: jest.fn(async (stream: string, config: { name: string }) => names.add(config.name)),
          update: jest.fn(),
        },
      };
      server.jetstreamClient = {
        consumers: {
          get: async (stream: string, name: string) => {
            if (failures[name]) throw failures[name];
            if (!names.has(name)) throw notFound();
            return { name };
          },
        },
      };
      // The consumer each subject gets is what matters, not the consume loop
      const runSubscription = (server.runSubscription = jest.fn());
      /** Binds event handlers (subject → options) and returns the name of the consumer each subject consumes from */
      const bind = async (handlers: Record<string, NatsEventHandlerOptions>) => {
        Object.entries(handlers).forEach(([subject, extras]) => server.addHandler(subject, jest.fn(), true, extras));
        await server.bindJetStreamEvents();
        return Object.fromEntries(runSubscription.mock.calls.map(([consumer, subject]) => [subject, consumer.name]));
      };
      return { jsm: server.jetstreamManager, bind, server };
    };

    it('UT-40 should create a consumer with the hashed name for a new subject', async () => {
      const { jsm, bind } = jetStream();

      expect(await bind({ 'orders.created-v1': {} })).toEqual({
        'orders.created-v1': 'svc:orders-created-v1~9da9e633',
      });
      expect(jsm.consumers.add).toHaveBeenCalledWith(
        'ORDERS',
        expect.objectContaining({
          name: 'svc:orders-created-v1~9da9e633',
          durable_name: 'svc:orders-created-v1~9da9e633',
          filter_subject: 'orders.created-v1',
        }),
      );
    });

    it('UT-41 should reject instead of creating a consumer when a lookup fails with another error', async () => {
      const timeout = NatsError.errorForCode(ErrorCode.Timeout);
      const { jsm, bind } = jetStream({ 'svc:orders-created-v1~9da9e633': timeout });

      await expect(bind({ 'orders.created-v1': {} })).rejects.toBe(timeout);
      expect(jsm.consumers.add).not.toHaveBeenCalled();
    });

    it('UT-50 should reject before creating a consumer when several handlers share a JetStream pattern', async () => {
      const { jsm, bind, server } = jetStream();
      server.addHandler('orders.created', jest.fn(), true); // bind() adds a second one: NestJS links it with `next`

      await expect(bind({ 'orders.created': {} })).rejects.toThrow(
        'Several handlers for the JetStream pattern [orders.created]: one handler per pattern',
      );
      expect(jsm.consumers.add).not.toHaveBeenCalled();
    });
  });

  describe.each([true, false])('handler registration, jetStream: %s', jetStream => {
    it.each([
      ['RPC, then event', false, true],
      ['event, then RPC', true, false],
      ['RPC, then RPC', false, false],
    ])('UT-51 start() should fail when an RPC handler shares its pattern: %s', async (_, first, second) => {
      const server: any = new ServerNats({ consumerName: 'svc', connection: {}, jetStream });
      server.addHandler('orders.get', jest.fn(), first);
      server.addHandler('orders.get', jest.fn(), second);
      const callback = jest.fn();
      await server.start(callback);

      expect(callback.mock.calls[0][0]?.message).toBe(
        'Several handlers for the RPC pattern [orders.get]: one handler per pattern',
      );
    });

    it('UT-52 start() should match object patterns the way NestJS normalizes them', async () => {
      const server: any = new ServerNats({ consumerName: 'svc', connection: {}, jetStream });
      server.addHandler({ cmd: 'get', v: 1 }, jest.fn());
      server.addHandler({ v: 1, cmd: 'get' }, jest.fn());
      const callback = jest.fn();
      await server.start(callback);

      expect(callback.mock.calls[0][0]?.message).toBe(
        'Several handlers for the RPC pattern [{"cmd":"get","v":1}]: one handler per pattern',
      );
    });
  });

  describe('consumer options', () => {
    it('UT-14 should not send library-only globalEventOptions to the NATS server', () => {
      const server = createServer({
        max_deliver: 5,
        nak_delay: 2_000,
        nak_delay_max: 30_000,
        nak_strategy: NakStrategy.increment,
        max_handlers: 5,
        max_messages: 10,
      });

      expect(Object.keys(server.buildConsumerOptions({})).sort()).toEqual(['max_deliver']);
    });

    it('UT-15 should let a decorator option override a global option with a falsy value', () => {
      const server = createServer({ headers_only: true });

      expect(server.buildConsumerOptions({ headers_only: false }).headers_only).toBe(false);
    });
  });

  describe('consumer restart', () => {
    // nats.js throws synchronously when consume() is called on a closed or draining connection
    const throwing = (code: string) => () => {
      throw NatsError.errorForCode(code);
    };
    const rejected = () => Promise.reject(new NatsError('no responders', '503'));

    /** Runs a consume loop on a fake consumer and cuts it after `maxPulls` pulls: restart storms must end */
    const startLoop = (loop: string, pull: () => unknown, maxPulls = 50) => {
      const server = createServer();
      server.logger = { log: jest.fn(), error: jest.fn() };
      server.jetstreamClient = {};
      let count = 0;
      const pulls = jest.fn(() => {
        if (++count >= maxPulls) server.jetstreamClient = null;
        return pull();
      });
      server[loop]({ consume: pulls }, 'orders', jest.fn(), {});
      return { server, pulls };
    };

    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    describe.each(['runSubscription'])('%s', loop => {
      it('UT-16 should log a closed connection once and stop', async () => {
        const { server, pulls } = startLoop(loop, throwing(ErrorCode.ConnectionClosed));
        await settle();
        await jest.advanceTimersByTimeAsync(10_000);

        expect(pulls).toHaveBeenCalledTimes(1);
        expect(server.logger.error).toHaveBeenCalledTimes(1);
      });

      it('UT-17 should retry a failed pull in exactly 1 s', async () => {
        const { pulls } = startLoop(loop, rejected);
        await settle();
        await jest.advanceTimersByTimeAsync(CONSUMER_RETRY_DELAY - 1);
        await settle();
        expect(pulls).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(1);
        await settle();
        expect(pulls).toHaveBeenCalledTimes(2);
      });

      it('UT-18 should not restart when the server is closed during the pause', async () => {
        const { server, pulls } = startLoop(loop, rejected);
        await settle();
        server.jetstreamClient = null; // what close() does
        await jest.advanceTimersByTimeAsync(10_000);
        await settle();

        expect(pulls).toHaveBeenCalledTimes(1);
      });

      it('UT-19 should stop without an error while the connection is draining', async () => {
        const { server, pulls } = startLoop(loop, throwing(ErrorCode.ConnectionDraining));
        await settle();
        await jest.advanceTimersByTimeAsync(10_000);

        expect(pulls).toHaveBeenCalledTimes(1);
        expect(server.logger.error).not.toHaveBeenCalled();
      });
    });
  });

  describe('connection recovery', () => {
    /** NatsConnection stand-in; fail() closes it for good, as nats.js does when reconnect attempts run out */
    const fakeConnection = () => {
      let resolveClosed: (err?: Error) => void;
      const closed = new Promise<void | Error>(resolve => (resolveClosed = resolve));
      return {
        fail: (err: Error = NatsError.errorForCode(ErrorCode.ConnectionRefused)) => resolveClosed(err),
        closed: () => closed,
        close: jest.fn(async () => resolveClosed()),
        drain: jest.fn(async () => resolveClosed()),
        jetstream: jest.fn(() => ({})),
        jetstreamManager: jest.fn(async () => ({})),
        subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })),
        status: async function* () {},
        getServer: () => 'nats://fake:4222',
        info: { server_id: 'fake' },
      };
    };

    /** Listening server with one RPC handler; createClient() gives out the connections (or errors) in turn */
    const listen = async (...connections: unknown[]) => {
      const server = createServer();
      server.logger = { log: jest.fn(), error: jest.fn() };
      server.addHandler('orders.get', jest.fn());
      const createClient = jest.spyOn(server, 'createClient');
      connections.forEach(connection =>
        createClient.mockImplementationOnce(() =>
          connection instanceof Error ? Promise.reject(connection) : Promise.resolve(connection),
        ),
      );
      await server.listen(jest.fn());
      return { server, createClient };
    };

    /** Replaces the status updates of a fake connection with a feed the test pushes to */
    const statusFeed = (connection: ReturnType<typeof fakeConnection>) => {
      const feed = new QueuedIteratorImpl<{ type: string; data?: unknown }>();
      Object.assign(connection, { status: () => feed });
      return feed;
    };

    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('UT-21 should reconnect 5 s after the connection is closed for good and bind the handlers again', async () => {
      const [first, second] = [fakeConnection(), fakeConnection()];
      const { server, createClient } = await listen(first, second);

      first.fail();
      await settle();
      await jest.advanceTimersByTimeAsync(RECONNECT_DELAY - 1);
      expect(createClient).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(1);
      await settle();
      expect(createClient).toHaveBeenCalledTimes(2);
      expect(second.subscribe).toHaveBeenCalledWith('orders.get', expect.anything());
      expect(server.logger.error).toHaveBeenCalledTimes(1);
    });

    it('UT-22 should retry every 5 s and close the connection of a failed attempt', async () => {
      const [first, third, fourth] = [fakeConnection(), fakeConnection(), fakeConnection()];
      third.jetstreamManager.mockRejectedValue(new NatsError('JetStream not enabled', '503'));
      const refused = NatsError.errorForCode(ErrorCode.ConnectionRefused);
      const { server, createClient } = await listen(first, refused, third, fourth);

      first.fail();
      for (let attempt = 2; attempt <= 4; attempt++) {
        await settle();
        await jest.advanceTimersByTimeAsync(RECONNECT_DELAY);
        await settle();
        expect(createClient).toHaveBeenCalledTimes(attempt);
      }
      expect(third.close).toHaveBeenCalled(); // connected, but JetStream was not ready
      expect(fourth.subscribe).toHaveBeenCalledWith('orders.get', expect.anything());
      expect(server.logger.error).toHaveBeenCalledTimes(3);

      await jest.advanceTimersByTimeAsync(30_000);
      expect(createClient).toHaveBeenCalledTimes(4);
    });

    it('UT-23 should not reconnect when close() is called during the pause', async () => {
      const [first, second] = [fakeConnection(), fakeConnection()];
      const { server, createClient } = await listen(first, second);

      first.fail();
      await settle();
      expect(jest.getTimerCount()).toBe(1); // the reconnect is scheduled
      await server.close();
      expect(jest.getTimerCount()).toBe(0); // and cancelled, not left to keep the process alive

      await jest.advanceTimersByTimeAsync(10_000);
      await settle();
      expect(createClient).toHaveBeenCalledTimes(1);
    });

    it('UT-24 should close a connection that an attempt opens after close()', async () => {
      const [first, second] = [fakeConnection(), fakeConnection()];
      let connectSecond: (connection: unknown) => void;
      const { server, createClient } = await listen(first, new Promise(resolve => (connectSecond = resolve)));

      first.fail();
      await settle();
      await jest.advanceTimersByTimeAsync(RECONNECT_DELAY);
      expect(createClient).toHaveBeenCalledTimes(2); // the attempt is still connecting

      await server.close();
      connectSecond(second);
      await settle();
      expect(second.close).toHaveBeenCalled();
      expect(second.subscribe).not.toHaveBeenCalled();
    });

    it('UT-25 should stop a consumer that waits for messages on the closed connection', async () => {
      const first = fakeConnection();
      const { server } = await listen(first, fakeConnection());
      // consume() keeps waiting after nats.js closed the connection; the next call throws
      const messages = new QueuedIteratorImpl();
      const stop = jest.spyOn(messages, 'stop');
      const consume = jest
        .fn()
        .mockResolvedValueOnce(messages)
        .mockImplementation(() => {
          throw NatsError.errorForCode(ErrorCode.ConnectionClosed);
        });
      void server.runSubscription({ consume }, 'orders', jest.fn(), {});
      await settle();

      first.fail();
      await settle();
      expect(stop).toHaveBeenCalled();
      expect(consume).toHaveBeenCalledTimes(2); // the loop left the stopped iterator and ended on the closed connection
    });

    it('UT-32 unwrap() should return the current connection and throw before listen() and after close()', async () => {
      expect(() => createServer().unwrap()).toThrow('Not initialized');
      const [first, second] = [fakeConnection(), fakeConnection()];
      const { server } = await listen(first, second);
      expect(server.unwrap()).toBe(first);

      first.fail();
      await settle();
      await jest.advanceTimersByTimeAsync(RECONNECT_DELAY);
      await settle();
      expect(server.unwrap()).toBe(second);

      await server.close();
      expect(() => server.unwrap()).toThrow('Not initialized');
    });

    it('UT-33 on() should pass disconnect, reconnect and update to the listeners until close()', async () => {
      const connection = fakeConnection();
      const feed = statusFeed(connection);
      const { server } = await listen(connection);
      const events: unknown[] = [];
      ['disconnect', 'reconnect', 'update', 'error', 'pingTimer'].forEach(event =>
        server.on(event, (data: unknown) => events.push([event, data])),
      );

      feed.push({ type: 'disconnect', data: 'nats://fake:4222' });
      feed.push({ type: 'error', data: 'boom' }); // an "error" event would throw without listeners
      feed.push({ type: 'pingTimer', data: 1 });
      feed.push({ type: 'reconnect', data: 'nats://fake:4222' });
      feed.push({ type: 'update', data: { added: ['nats://other:4222'], deleted: [] } });
      await settle();
      expect(events).toEqual([
        ['disconnect', 'nats://fake:4222'],
        ['reconnect', 'nats://fake:4222'],
        ['update', { added: ['nats://other:4222'], deleted: [] }],
      ]);

      await server.close();
      feed.push({ type: 'disconnect', data: 'nats://fake:4222' });
      await settle();
      expect(events).toHaveLength(3); // close() removes the listeners
    });

    it('UT-35 status should be connected after listen() and follow the connection', async () => {
      const connection = fakeConnection();
      const feed = statusFeed(connection);
      const { server } = await listen(connection);
      const statuses: string[] = [];
      server.status.subscribe((status: string) => statuses.push(status));

      ['disconnect', 'reconnecting', 'reconnecting', 'pingTimer', 'update', 'error', 'reconnect'].forEach(type =>
        feed.push({ type }),
      );
      await settle();
      expect(statuses).toEqual(['connected', 'disconnected', 'reconnecting', 'connected']);
    });

    it('UT-53 listen() should pass jetStreamOptions to the JetStream client, as to the JetStream manager', async () => {
      const connection = fakeConnection();
      const server: any = new ServerNats({
        consumerName: 'svc',
        connection: {},
        jetStream: true,
        jetStreamOptions: { domain: 'hub' },
      });
      server.logger = { log: jest.fn(), error: jest.fn() };
      jest.spyOn(server, 'createClient').mockResolvedValue(connection);
      await server.listen(jest.fn());

      expect(connection.jetstream).toHaveBeenCalledWith({ domain: 'hub' });
      expect(connection.jetstreamManager).toHaveBeenCalledWith({ domain: 'hub' });
    });

    it('UT-26 should not limit reconnect attempts unless the connection options set a limit', async () => {
      jest.mocked(connect).mockClear();
      await createServer().createClient();
      await new ServerNats({ consumerName: 'svc', connection: { maxReconnectAttempts: 3 } }).createClient();

      expect(connect).toHaveBeenNthCalledWith(1, expect.objectContaining({ maxReconnectAttempts: -1 }));
      expect(connect).toHaveBeenNthCalledWith(2, expect.objectContaining({ maxReconnectAttempts: 3 }));
    });

    /** Listening server with an RPC request in progress: like a Nest handler, it replies once release() is called */
    const listenWithRequestInProgress = async () => {
      const connection = fakeConnection();
      const server = createServer();
      server.logger = { log: jest.fn(), error: jest.fn() };
      let release: () => void;
      const released = new Promise<void>(resolve => (release = resolve));
      server.addHandler('orders.get', async () => defer(() => released.then(() => 'done')));
      jest.spyOn(server, 'createClient').mockResolvedValue(connection);
      await server.listen(jest.fn());

      const request = {
        subject: 'orders.get',
        data: JSONCodec().encode({ pattern: 'orders.get', data: 1, id: '1' }),
        respond: jest.fn(),
      };
      (connection.subscribe as jest.Mock).mock.calls[0][1].callback(undefined, request);
      await settle();
      return { server, connection, request, release };
    };

    const jsMessage = (data: unknown) => ({
      subject: 'orders',
      data: JSONCodec().encode({ pattern: 'orders', data }),
      info: { deliveryCount: 1 },
      working: jest.fn(),
      ack: jest.fn(),
    });

    /** Server with an open connection that consumes `messages` one at a time; the handler finishes on release() */
    const consumeInProgress = async (...messages: ReturnType<typeof jsMessage>[]) => {
      const server = createServer();
      server.logger = { log: jest.fn(), error: jest.fn() };
      const connection = fakeConnection();
      [server.natsClient, server.jetstreamClient] = [connection, {}];
      let release: () => void;
      const released = new Promise<void>(resolve => (release = resolve));
      const handler = jest.fn(async () => defer(() => released));
      const iterator = new QueuedIteratorImpl();
      messages.forEach(message => iterator.push(message));
      const stop = jest.spyOn(iterator, 'stop');
      // A restart would wait for messages forever instead of looping over the stopped iterator
      const consume = jest
        .fn()
        .mockResolvedValueOnce(iterator)
        .mockReturnValue(new Promise(() => undefined));
      void server.runSubscription({ consume }, 'orders', handler, { max_handlers: 1 });
      await settle();
      return { server, connection, handler, consume, stop, release };
    };

    it('UT-46 close() should stop taking requests and reply to the request in progress before draining', async () => {
      jest.useRealTimers(); // Nest sends the reply on process.nextTick
      const { server, connection, request, release } = await listenWithRequestInProgress();
      const closing = server.close();
      await settle();
      expect((connection.subscribe as jest.Mock).mock.results[0].value.unsubscribe).toHaveBeenCalled();
      expect(connection.drain).not.toHaveBeenCalled();

      release();
      await closing;
      expect(request.respond).toHaveBeenCalled();
      expect(request.respond.mock.invocationCallOrder[0]).toBeLessThan(connection.drain.mock.invocationCallOrder[0]);
    });

    it('UT-47 close() should drain after 10 s when the request in progress does not finish', async () => {
      const { server, connection } = await listenWithRequestInProgress();
      const closing = server.close();
      await jest.advanceTimersByTimeAsync(GRACE_PERIOD - 1);
      expect(connection.drain).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);
      await closing;
      expect(connection.drain).toHaveBeenCalled();
    });

    it('UT-48 close() should stop the consumers and not restart them while a message is in progress', async () => {
      jest.useRealTimers();
      const { server, consume, stop, release } = await consumeInProgress(jsMessage(1));
      const closing = server.close();
      await settle();
      expect(stop).toHaveBeenCalled();

      release();
      await closing;
      expect(consume).toHaveBeenCalledTimes(1);
    });

    it('UT-49 close() should ack the message in progress before draining and leave a message waiting for a handler', async () => {
      jest.useRealTimers();
      const [first, second] = [jsMessage(1), jsMessage(2)];
      const { server, connection, handler, release } = await consumeInProgress(first, second);
      expect(handler).toHaveBeenCalledTimes(1); // the second message waits for the handler

      const closing = server.close();
      await settle();
      release();
      await closing;
      expect(first.ack.mock.invocationCallOrder[0]).toBeLessThan(connection.drain.mock.invocationCallOrder[0]);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(second.ack).not.toHaveBeenCalled();
    });
  });

  describe('consumer buffer', () => {
    /** Starts a loop on a fake consumer whose pull never resolves; the pull options are all that matters */
    const startPull = async (loop: string, eventOptions: NatsEventHandlerOptions) => {
      const pull = jest.fn(() => new Promise(() => undefined));
      void createServer()[loop]({ consume: pull }, 'orders', jest.fn(), eventOptions);
      await settle();
      return pull;
    };

    it('UT-29 consume() should buffer max_handlers messages when max_messages is not set', async () => {
      expect(await startPull('runSubscription', {})).toHaveBeenCalledWith({
        max_messages: 1,
        abort_on_missing_resource: true,
      });
      expect(await startPull('runSubscription', { max_handlers: 5 })).toHaveBeenCalledWith({
        max_messages: 5,
        abort_on_missing_resource: true,
      });
    });

    it('UT-30 consume() should buffer max_messages messages when it is set (control)', async () => {
      const pull = await startPull('runSubscription', { max_messages: 10, max_handlers: 5 });

      expect(pull).toHaveBeenCalledWith({ max_messages: 10, abort_on_missing_resource: true });
    });
  });

  describe('processing hooks', () => {
    const trace = new AsyncLocalStorage<string>();
    const encoded = () => JSONCodec().encode({ pattern: 'orders', data: 1 });
    const jsMsg = () => ({
      subject: 'orders',
      data: encoded(),
      info: { deliveryCount: 1 },
      working: jest.fn(),
      ack: jest.fn(),
    });
    const paths: Record<string, (server: any, handler: unknown) => Promise<unknown>> = {
      'core event': (server, handler) =>
        server.handleNatsEvent('orders', { subject: 'orders', data: encoded() }, handler),
      'JetStream event': (server, handler) =>
        server.handleNatsJetStreamEvent('orders', { ...jsMsg(), term: jest.fn() }, handler, new SimpleMutex(1)),
      'RPC request': (server, handler) =>
        server.handleNatsRequest('orders', { subject: 'orders', data: encoded(), respond: jest.fn() }, handler),
    };

    /** The start hook runs the processing inside an AsyncLocalStorage context, as tracing tools do */
    const hookedServer = (calls: string[]) => {
      const server = createServer();
      server.logger = { log: jest.fn(), error: jest.fn() };
      server.setOnProcessingStartHook((transportId: number, ctx: NatsContext, done: () => Promise<unknown>) => {
        calls.push(`start ${transportId} ${ctx.getSubject()}`);
        return trace.run('traced', done);
      });
      server.setOnProcessingEndHook((transportId: number, ctx: NatsContext) =>
        calls.push(`end ${transportId} ${ctx.getSubject()}`),
      );
      return server;
    };

    describe.each(Object.keys(paths))('%s', path => {
      it('UT-37 the handler should run inside the processing hooks', async () => {
        const calls: string[] = [];
        // Nest handlers return lazy streams: the controller method runs on subscription and may be async
        const handler = async () =>
          defer(async () => {
            await Promise.resolve();
            return calls.push(`handler ${trace.getStore()}`);
          });
        await paths[path](hookedServer(calls), handler);
        await settle();

        expect(calls).toEqual(['start 2 orders', 'handler traced', 'end 2 orders']);
      });

      it('UT-38 the end hook should run when the handler fails', async () => {
        const calls: string[] = [];
        const handler = async () => {
          throw new Error('boom');
        };
        await paths[path](hookedServer(calls), handler).catch(() => undefined);
        await settle();

        expect(calls).toEqual(['start 2 orders', 'end 2 orders']);
      });
    });
  });

  describe('handler payload', () => {
    const natsMsg = (data: unknown) => ({
      subject: 'orders',
      data: JSONCodec().encode({ pattern: 'orders', data }),
      info: { deliveryCount: 1 },
      working: jest.fn(),
      ack: jest.fn(),
    });
    const paths: Record<string, (server: any, msg: unknown, handler: unknown) => Promise<unknown>> = {
      'core event': (server, msg, handler) => server.handleNatsEvent('orders', msg, handler),
      'JetStream event': (server, msg, handler) =>
        server.handleNatsJetStreamEvent('orders', msg, handler, new SimpleMutex(1)),
    };

    it.each(Object.keys(paths))('UT-43 %s handler should receive 0, false and an empty string as is', async path => {
      const received: unknown[] = [];
      const handler = async (data: unknown) => received.push(data);
      for (const value of [0, false, '']) {
        await paths[path](createServer(), natsMsg(value), handler);
      }

      expect(received).toEqual([0, false, '']);
    });
  });
});
