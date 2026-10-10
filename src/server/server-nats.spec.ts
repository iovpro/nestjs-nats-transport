import { AsyncLocalStorage } from 'async_hooks';
import { DeliverPolicy, ErrorCode, JSONCodec, JsMsg, NatsError, connect } from 'nats';
import { QueuedIteratorImpl } from 'nats/lib/nats-base-client/queued_iterator';
import { SimpleMutex, deferred } from 'nats/lib/nats-base-client/util';
import { defer } from 'rxjs';
import { CONSUMER_RETRY_DELAY, GRACE_PERIOD, NAK, RECONNECT_DELAY } from '../constants';
import { NatsContext } from '../ctx-host/nats.context';
import { NakStrategy, NatsEventHandlerOptions } from '../interfaces';
import { ServerNats } from './server-nats';

// connect() is replaced to check the connection options passed to nats.js
jest.mock('nats', () => ({ ...jest.requireActual('nats'), connect: jest.fn() }));

// The helpers below are private; they are exercised directly to pin down their contract without a NATS server.
const createServer = (globalEventOptions?: Partial<NatsEventHandlerOptions>, options = {}): any =>
  Object.assign(
    new ServerNats({ consumerName: 'svc', connection: {}, jetStream: true, globalEventOptions, ...options }),
    {
      logger: { log: jest.fn(), error: jest.fn(), debug: jest.fn() },
    },
  );

/** What close() completes a listen() with that it has stopped */
const CLOSED = 'ServerNats was closed before listen() completed';

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
      expect(await nakDelay({ nak_delay: undefined })).toBe(4_000);
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
    const jetStream = (failures: Record<string, Error> = {}, globalEventOptions?: Partial<NatsEventHandlerOptions>) => {
      const names = new Set<string>();
      const server = createServer(globalEventOptions);
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

    it('UT-70 an empty filter_subjects should create a consumer with filter_subject, not without a filter', async () => {
      const { jsm, bind } = jetStream();
      await bind({ 'orders.created': { filter_subjects: [] } });

      expect(jsm.consumers.add).toHaveBeenCalledWith(
        'ORDERS',
        expect.objectContaining({ filter_subject: 'orders.created' }),
      );
    });

    it('UT-54 a decorator option set to undefined or null should keep the global value, false should override it', async () => {
      const global = { ack_wait: 120e9, max_deliver: 5, deliver_policy: DeliverPolicy.All, headers_only: true };
      const { jsm, bind } = jetStream({}, global);
      // As values from a configuration that does not set them
      await bind({
        'orders.created': { ack_wait: undefined, max_deliver: null, deliver_policy: undefined, headers_only: false },
      });

      expect(jsm.consumers.add).toHaveBeenCalledWith(
        'ORDERS',
        expect.objectContaining({
          ack_wait: 120e9,
          max_deliver: 5,
          deliver_policy: DeliverPolicy.All,
          headers_only: false,
        }),
      );
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
      const eventOptions = server.buildEventOptions({ extras: {} });

      expect(Object.keys(server.pickConsumerOptions(eventOptions)).sort()).toEqual(['max_deliver']);
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
        isClosed: () => false,
        close: jest.fn(async () => resolveClosed()),
        drain: jest.fn(async () => resolveClosed()),
        jetstream: jest.fn(() => ({})),
        jetstreamManager: jest.fn(async () => ({})),
        subscribe: jest.fn(() => ({ unsubscribe: jest.fn(), drain: jest.fn(async () => undefined) })),
        status: async function* () {},
        getServer: () => 'nats://fake:4222',
        info: { server_id: 'fake' },
      };
    };

    /** Listening server with one RPC handler; createClient() gives out the connections (or errors) in turn */
    const listen = async (...connections: unknown[]) => {
      const server = createServer();
      server.addHandler('orders.get', jest.fn());
      const createClient = jest.spyOn(server, 'createClient');
      connections.forEach(connection =>
        createClient.mockImplementationOnce(() =>
          connection instanceof Error ? Promise.reject(connection) : Promise.resolve(connection),
        ),
      );
      const callback = jest.fn();
      await server.listen(callback);
      return { server, createClient, callback };
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

    it('UT-61 should schedule one attempt when the connection of an attempt closes during its setup', async () => {
      const [first, second, third] = [fakeConnection(), fakeConnection(), fakeConnection()];
      const request = deferred();
      second.jetstreamManager.mockReturnValue(request);
      const { server, createClient } = await listen(first, second, third, fakeConnection());

      first.fail();
      await settle();
      await jest.advanceTimersByTimeAsync(RECONNECT_DELAY);
      expect(createClient).toHaveBeenCalledTimes(2); // the attempt waits for the JetStream API

      // nats.js closes the connection for good and fails the pending request: closed() and listen() report it
      second.fail();
      request.reject(NatsError.errorForCode(ErrorCode.Timeout));
      await settle();
      expect(jest.getTimerCount()).toBe(1);
      expect(server.logger.error).toHaveBeenCalledTimes(2); // one line for each failure, not one for each report

      await jest.advanceTimersByTimeAsync(RECONNECT_DELAY);
      await settle();
      expect(createClient).toHaveBeenCalledTimes(3);
      expect(third.subscribe).toHaveBeenCalledWith('orders.get', expect.anything());
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

    it('UT-68 close() should call close() on the connection when drain() does not close it', async () => {
      const connection = fakeConnection();
      const { server } = await listen(connection);

      await server.close();
      expect(connection.drain).toHaveBeenCalled();
      expect(connection.close).toHaveBeenCalled();
      expect(connection.drain.mock.invocationCallOrder[0]).toBeLessThan(connection.close.mock.invocationCallOrder[0]);
    });

    it('UT-71 close() should drain core subscriptions and not fail on a dead one', async () => {
      const connection = fakeConnection();
      const { server } = await listen(connection);
      const subscription = (connection.subscribe as jest.Mock).mock.results[0].value;
      subscription.drain.mockRejectedValue(new Error('SUB_CLOSED'));

      await server.close();
      expect(subscription.drain).toHaveBeenCalled();
      expect(subscription.unsubscribe).not.toHaveBeenCalled();
    });

    it('UT-65 close() during the pause should not drain the connection that nats.js has closed', async () => {
      const [first, second] = [fakeConnection(), fakeConnection()];
      const { server } = await listen(first, second);
      first.fail();
      await settle();
      // As nats.js: the connection is closed for good, drain() fails with CONNECTION_CLOSED
      const closed = NatsError.errorForCode(ErrorCode.ConnectionClosed);
      Object.assign(first, { isClosed: () => true, drain: jest.fn().mockRejectedValue(closed) });

      await server.close();
      expect(first.drain).not.toHaveBeenCalled();
      expect(server.logger.error).toHaveBeenCalledTimes(1); // the reconnect only
    });

    it('UT-24 should close a connection that an attempt opens after close()', async () => {
      const [first, second] = [fakeConnection(), fakeConnection()];
      const attempt = deferred();
      const { server, createClient } = await listen(first, attempt);

      first.fail();
      await settle();
      await jest.advanceTimersByTimeAsync(RECONNECT_DELAY);
      expect(createClient).toHaveBeenCalledTimes(2); // the attempt is still connecting

      await server.close();
      attempt.resolve(second);
      await settle();
      expect(second.close).toHaveBeenCalled();
      expect(second.subscribe).not.toHaveBeenCalled();
    });

    it('UT-59 listen() should fail when close() is called while it connects', async () => {
      const server = createServer();
      server.addHandler('orders.get', jest.fn());
      const attempt = deferred();
      jest.spyOn(server, 'createClient').mockReturnValue(attempt);
      const callback = jest.fn();
      void server.listen(callback);

      await server.close();
      const connection = fakeConnection();
      attempt.resolve(connection);
      await settle();
      expect(connection.close).toHaveBeenCalled();
      expect(connection.subscribe).not.toHaveBeenCalled();
      expect(callback.mock.calls.map(([err]) => err?.message)).toEqual([CLOSED]); // app.listen() rejects
      expect(() => server.unwrap()).toThrow('Not initialized'); // the closed connection is not kept
    });

    it('UT-60 listen() after close() should connect anew and bind the handlers again', async () => {
      const [first, second] = [fakeConnection(), fakeConnection()];
      const { server, createClient, callback: started } = await listen(first, second);
      await server.close();
      expect(started.mock.calls).toEqual([[]]); // close() does not call back a listen() that has completed

      const callback = jest.fn();
      await server.listen(callback);
      expect(createClient).toHaveBeenCalledTimes(2);
      expect(second.close).not.toHaveBeenCalled();
      expect(second.subscribe).toHaveBeenCalledWith('orders.get', expect.anything());
      expect(callback.mock.calls).toEqual([[]]);
      expect(server.unwrap()).toBe(second);
    });

    it('UT-62 close() while listen() waits to retry rejected credentials should fail listen()', async () => {
      const { server, createClient, callback } = await listen(NatsError.errorForCode(ErrorCode.AuthorizationViolation));
      expect(callback).not.toHaveBeenCalled(); // the next attempt in 5 s

      await server.close();
      expect(callback.mock.calls.map(([err]) => err?.message)).toEqual([CLOSED]); // app.listen() rejects
      await jest.advanceTimersByTimeAsync(10_000);
      expect(createClient).toHaveBeenCalledTimes(1);
    });

    it.each(['connects', 'fails'])(
      'UT-63 a reconnect attempt that %s after close() and listen() should leave the new connection alone',
      async outcome => {
        const [first, second, third] = [fakeConnection(), fakeConnection(), fakeConnection()];
        const refused = NatsError.errorForCode(ErrorCode.ConnectionRefused);
        const attempt = deferred();
        const { server, createClient } = await listen(first, attempt, third);

        first.fail();
        await settle();
        await jest.advanceTimersByTimeAsync(RECONNECT_DELAY);
        expect(createClient).toHaveBeenCalledTimes(2); // the attempt is still connecting
        await server.close();
        await server.listen(jest.fn());
        expect(third.subscribe).toHaveBeenCalledWith('orders.get', expect.anything());

        if (outcome === 'connects') attempt.resolve(second);
        else attempt.reject(refused);
        await settle();
        expect(second.subscribe).not.toHaveBeenCalled();
        expect(third.close).not.toHaveBeenCalled();
        expect(server.unwrap()).toBe(third);
        expect(jest.getTimerCount()).toBe(0); // no reconnect scheduled
      },
    );

    it('UT-67 close() should stop the reconnects that go on after an authorization retry', async () => {
      const violation = NatsError.errorForCode(ErrorCode.AuthorizationViolation);
      const refused = NatsError.errorForCode(ErrorCode.ConnectionRefused);
      const attempt = deferred();
      const first = fakeConnection();
      const { server, createClient } = await listen(first, violation, refused, attempt);

      // closed for good → rejected credentials → refused → an attempt that fails after close()
      first.fail();
      for (let attempts = 2; attempts <= 4; attempts++) {
        await settle();
        await jest.advanceTimersByTimeAsync(RECONNECT_DELAY);
        expect(createClient).toHaveBeenCalledTimes(attempts);
      }
      await server.close();
      attempt.reject(refused);
      await settle();
      expect(jest.getTimerCount()).toBe(0); // no reconnect after close()
    });

    it('UT-64 a consumer bound before close() should not restart after listen() is called again', async () => {
      const { server } = await listen(fakeConnection(), fakeConnection());
      const consume = jest.fn().mockRejectedValue(new NatsError('no responders', '503'));
      void server.runSubscription({ consume }, 'orders', jest.fn(), {});
      await settle(); // the pull failed: the loop waits 1 s to restart
      await server.close();
      await server.listen(jest.fn());

      await jest.advanceTimersByTimeAsync(CONSUMER_RETRY_DELAY);
      await settle();
      expect(consume).toHaveBeenCalledTimes(1);
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
      expect(consume).toHaveBeenCalledTimes(1); // the loop left the stopped iterator, no restart on the closed connection
      expect(server.logger.error).toHaveBeenCalledTimes(1); // the reconnect only
    });

    it('UT-32 unwrap() should return the current connection and throw before listen(), while reconnecting and after close()', async () => {
      expect(() => createServer().unwrap()).toThrow('Not initialized');
      const [first, second] = [fakeConnection(), fakeConnection()];
      const { server } = await listen(first, second);
      expect(server.unwrap()).toBe(first);

      first.fail();
      await settle();
      expect(() => server.unwrap()).toThrow('Not initialized'); // the closed connection is not kept during the pause
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

    it('UT-58 status should be reconnecting while ServerNats connects anew, also after an attempt that connected fails', async () => {
      const [first, second, third] = [fakeConnection(), fakeConnection(), fakeConnection()];
      second.jetstreamManager.mockRejectedValue(new NatsError('JetStream not enabled', '503'));
      const { server } = await listen(first, second, third);
      const statuses: string[] = [];
      server.status.subscribe((status: string) => statuses.push(status));

      first.fail();
      await settle();
      expect(statuses).toEqual(['connected', 'reconnecting']);

      await jest.advanceTimersByTimeAsync(RECONNECT_DELAY);
      await settle();
      expect(statuses).toEqual(['connected', 'reconnecting', 'connected', 'reconnecting']); // connected, JetStream not ready

      await jest.advanceTimersByTimeAsync(RECONNECT_DELAY);
      await settle();
      expect(statuses).toEqual(['connected', 'reconnecting', 'connected', 'reconnecting', 'connected']);
    });

    it('UT-53 listen() should pass jetStreamOptions to the JetStream client, as to the JetStream manager', async () => {
      const connection = fakeConnection();
      const server = createServer(undefined, { jetStreamOptions: { domain: 'hub' } });
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
      const released = deferred<void>();
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
      return { server, connection, request, release: () => released.resolve() };
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
      const connection = fakeConnection();
      [server.natsClient, server.jetstreamClient] = [connection, {}];
      server._status$.next('connected'); // NATS answers
      const released = deferred<void>();
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
      return { server, connection, handler, consume, stop, release: () => released.resolve() };
    };

    it('UT-46 close() should stop taking requests and reply to the request in progress before draining', async () => {
      jest.useRealTimers(); // Nest sends the reply on process.nextTick
      const { server, connection, request, release } = await listenWithRequestInProgress();
      const closing = server.close();
      await settle();
      expect((connection.subscribe as jest.Mock).mock.results[0].value.drain).toHaveBeenCalled();
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

    it('UT-66 a message waiting for a handler at close() should not be handled after listen() is called again', async () => {
      const [first, second] = [jsMessage(1), jsMessage(2)];
      const { server, handler, release } = await consumeInProgress(first, second);
      const closing = server.close();
      await jest.advanceTimersByTimeAsync(GRACE_PERIOD); // the handler in progress outlasts close()
      await closing;
      jest.spyOn(server, 'createClient').mockResolvedValue(fakeConnection());
      await server.listen(jest.fn());

      jest.useRealTimers(); // Nest sends the reply on process.nextTick
      release();
      await settle();
      expect(first.ack).toHaveBeenCalled();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(second.ack).not.toHaveBeenCalled();
    });

    it('UT-79 listen() after a close() that came first should fail without connecting', async () => {
      const server = createServer();
      const createClient = jest.spyOn(server, 'createClient').mockResolvedValue(fakeConnection());
      await server.close(); // app.close() while NestJS runs the init hooks, before it calls listen()
      const callback = jest.fn();
      await server.listen(callback);

      expect(callback.mock.calls.map(([err]) => err?.message)).toEqual([CLOSED]);
      expect(createClient).not.toHaveBeenCalled();
    });

    it('UT-80 listen() again after a failed listen() should first close what the failed one runs', async () => {
      const [first, second] = [fakeConnection(), fakeConnection()];
      first.jetstreamManager.mockRejectedValue(new NatsError('JetStream not enabled', '503'));
      const { server, callback } = await listen(first, second);
      expect(callback.mock.calls[0][0]?.message).toBe('JetStream not enabled');
      const messages = new QueuedIteratorImpl();
      const stop = jest.spyOn(messages, 'stop');
      void server.runSubscription({ consume: jest.fn().mockResolvedValue(messages) }, 'orders', jest.fn(), {});
      await settle(); // a consumer bound before the failure

      await server.listen(jest.fn());
      expect(stop).toHaveBeenCalled();
      expect(first.drain).toHaveBeenCalled();
      expect(second.close).not.toHaveBeenCalled();
      expect(server.unwrap()).toBe(second);
    });

    it('UT-81 listen() while close() waits for a handler should wait for close() and keep its own connection', async () => {
      jest.useRealTimers(); // Nest sends the reply on process.nextTick
      const { server, connection, release } = await listenWithRequestInProgress();
      const second = fakeConnection();
      const createClient = jest.spyOn(server, 'createClient').mockResolvedValue(second);
      const closing = server.close();
      const listening = server.listen(jest.fn());
      await settle();
      expect(createClient).toHaveBeenCalledTimes(1); // the first listen() only

      release();
      await Promise.all([closing, listening]);
      expect(connection.drain).toHaveBeenCalled();
      expect(second.drain).not.toHaveBeenCalled();
      expect(server.unwrap()).toBe(second);
    });

    it('UT-82 an error that the listen() callback throws should complete listen() with that error', async () => {
      // NestJS logs "successfully started" in the callback: a logger that throws there
      const failure = new Error('logger broke');
      const callback = jest.fn((err?: Error) => {
        if (!err) throw failure;
      });
      const server = createServer();
      jest.spyOn(server, 'createClient').mockResolvedValue(fakeConnection());
      await server.listen(callback);

      expect(callback.mock.calls).toEqual([[], [failure]]);
    });

    it('UT-83 close() called again while it runs should wait for the same close', async () => {
      jest.useRealTimers(); // Nest sends the reply on process.nextTick
      const { server, connection, release } = await listenWithRequestInProgress();
      // As nats.js: a connection that drains already refuses another drain
      connection.drain.mockImplementation(async () => {
        if (connection.drain.mock.calls.length > 1) throw NatsError.errorForCode(ErrorCode.ConnectionDraining);
      });
      const [first, second] = [server.close(), server.close()];
      release();
      await Promise.all([first, second]);

      expect(connection.drain).toHaveBeenCalledTimes(1);
      expect(server.logger.error).not.toHaveBeenCalled();
    });

    it('UT-84 close() while NATS is unreachable should unsubscribe and close the connection without draining', async () => {
      const connection = fakeConnection();
      const feed = statusFeed(connection);
      const { server } = await listen(connection);
      feed.push({ type: 'disconnect', data: 'nats://fake:4222' });
      await settle();
      const subscription = (connection.subscribe as jest.Mock).mock.results[0].value;

      await server.close();
      expect(subscription.unsubscribe).toHaveBeenCalled();
      expect(subscription.drain).not.toHaveBeenCalled();
      expect(connection.drain).not.toHaveBeenCalled();
      expect(connection.close).toHaveBeenCalled();
    });

    it('UT-85 close() should stop waiting for the drains once nats.js closes the connection', async () => {
      const connection = fakeConnection();
      const { server } = await listen(connection);
      // NATS stops answering during close(): the drains wait for PONGs that do not come
      (connection.subscribe as jest.Mock).mock.results[0].value.drain.mockReturnValue(new Promise(() => undefined));
      connection.drain.mockReturnValue(new Promise(() => undefined));
      let closed = false;
      void server.close().then(() => (closed = true));
      await settle();

      // and nats.js runs out of reconnect attempts
      Object.assign(connection, { isClosed: () => true });
      connection.fail();
      await settle();
      expect(closed).toBe(true);
    });

    it('UT-86 close() should wait for the subscriptions to drain for at most 10 s', async () => {
      const connection = fakeConnection();
      const { server } = await listen(connection);
      (connection.subscribe as jest.Mock).mock.results[0].value.drain.mockReturnValue(new Promise(() => undefined));
      const closing = server.close();
      await jest.advanceTimersByTimeAsync(GRACE_PERIOD - 1);
      expect(connection.drain).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);
      await closing;
      expect(connection.drain).toHaveBeenCalled();
    });

    it('UT-87 close() should not keep the subscriptions of a connection closed before', async () => {
      const [first, second] = [fakeConnection(), fakeConnection()];
      const { server } = await listen(first, second);
      first.fail();
      await settle();
      await jest.advanceTimersByTimeAsync(RECONNECT_DELAY);
      await settle();

      await server.close();
      expect((first.subscribe as jest.Mock).mock.results[0].value.drain).not.toHaveBeenCalled();
      expect((second.subscribe as jest.Mock).mock.results[0].value.drain).toHaveBeenCalled();
      expect(server.subscriptions).toHaveLength(0);
    });

    it.each(['RPC request', 'core event', 'JetStream event'])(
      'UT-88 close() should wait for a %s that arrived before it, also while it is deserialized',
      async path => {
        jest.useRealTimers(); // Nest sends the reply on process.nextTick
        const connection = fakeConnection();
        const server = createServer(undefined, { jetStream: path !== 'core event' });
        const handler = jest.fn(async () => 'done');
        if (path !== 'JetStream event') server.addHandler('orders.get', handler, path === 'core event');
        // A custom deserializer that takes a while
        const { deserializer } = server;
        server.deserializer = {
          deserialize: (...args: unknown[]) =>
            new Promise(resolve => setTimeout(() => resolve(deserializer.deserialize(...args)), 20)),
        };
        jest.spyOn(server, 'createClient').mockResolvedValue(connection);
        await server.listen(jest.fn());
        const message = {
          subject: 'orders.get',
          data: JSONCodec().encode({ pattern: 'orders.get', data: 1, id: '1' }),
          respond: jest.fn(),
          info: { deliveryCount: 1 },
          working: jest.fn(),
          ack: jest.fn(),
        };
        if (path === 'JetStream event') {
          const messages = new QueuedIteratorImpl();
          messages.push(message);
          void server.runSubscription({ consume: async () => messages }, 'orders.get', handler, {});
          await settle();
        } else {
          (connection.subscribe as jest.Mock).mock.calls[0][1].callback(undefined, message);
        }

        await server.close();
        const outcome = { 'RPC request': message.respond, 'core event': handler, 'JetStream event': message.ack }[path];
        expect(outcome).toHaveBeenCalled();
        expect(outcome.mock.invocationCallOrder[0]).toBeLessThan(connection.drain.mock.invocationCallOrder[0]);
      },
    );

    it.each(['the JetStream manager', 'the consumers'])(
      'UT-89 close() while listen() sets up %s should keep the setup from taking messages',
      async stage => {
        const connection = fakeConnection();
        const consume = jest.fn();
        const step = deferred();
        const manager = { streams: { find: () => step }, consumers: { update: jest.fn() } };
        connection.jetstreamManager.mockReturnValue(stage === 'the consumers' ? Promise.resolve(manager) : step);
        connection.jetstream.mockReturnValue({ consumers: { get: async () => ({ consume }) } });
        const server = createServer();
        server.addHandler('orders.get', jest.fn());
        server.addHandler('orders.created', jest.fn(), true);
        jest.spyOn(server, 'createClient').mockResolvedValue(connection);
        const listening = server.listen(jest.fn());
        await settle(); // the setup waits for the JetStream API
        server.processing.add(new Promise(() => undefined)); // a handler in progress holds close() for 10 s
        const closing = server.close();

        step.resolve(stage === 'the consumers' ? 'ORDERS' : manager);
        await settle();
        expect(connection.subscribe).not.toHaveBeenCalled();
        expect(consume).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(GRACE_PERIOD);
        await Promise.all([listening, closing]);
      },
    );

    it('UT-90 listen() after a close() during the reconnect pause should reconnect when its connection is lost', async () => {
      const [first, second, third] = [fakeConnection(), fakeConnection(), fakeConnection()];
      const { server, createClient } = await listen(first, second, third);
      first.fail();
      await settle();
      await server.close(); // cancels the scheduled reconnect
      await server.listen(jest.fn());

      second.fail();
      await settle();
      await jest.advanceTimersByTimeAsync(RECONNECT_DELAY);
      await settle();
      expect(createClient).toHaveBeenCalledTimes(3);
      expect(third.subscribe).toHaveBeenCalledWith('orders.get', expect.anything());
    });

    it('UT-91 close() after listen() again should not wait for a handler that the close before has given up', async () => {
      const { server } = await listenWithRequestInProgress(); // the handler never finishes
      const closing = server.close();
      await jest.advanceTimersByTimeAsync(GRACE_PERIOD);
      await closing;
      jest.spyOn(server, 'createClient').mockResolvedValue(fakeConnection());
      await server.listen(jest.fn());

      let closed = false;
      void server.close().then(() => (closed = true));
      await settle();
      expect(closed).toBe(true);
    });
  });

  it('UT-96 the consume loop should hand its event options to each message instead of building them again', async () => {
    const server = createServer({ nak_delay: 2_000 });
    const build = jest.spyOn(server, 'buildEventOptions');
    const nak = jest.fn();
    const messages = new QueuedIteratorImpl();
    [1, 2].forEach(data =>
      messages.push({ data: JSONCodec().encode({ data }), info: { deliveryCount: 1 }, working: jest.fn(), nak }),
    );
    messages.stop();
    await server.runSubscription({ consume: async () => messages }, 'orders', async () => NAK, {
      nak_delay: 500,
      max_handlers: 2,
    });
    await settle();

    expect(nak.mock.calls).toEqual([[500], [500]]);
    expect(build).not.toHaveBeenCalled();
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
    const jsMessage = () => ({ ...jsMsg(), nak: jest.fn(), term: jest.fn() });
    const request = () => ({ subject: 'orders', data: encoded(), respond: jest.fn() });
    const paths: Record<
      string,
      (server: any, handler: unknown, message?: any, mutex?: SimpleMutex) => Promise<unknown>
    > = {
      'core event': (server, handler) =>
        server.handleNatsEvent('orders', { subject: 'orders', data: encoded() }, handler),
      'JetStream event': (server, handler, message = jsMessage(), mutex = new SimpleMutex(1)) =>
        server.handleNatsJetStreamEvent('orders', message, handler, mutex),
      'RPC request': (server, handler, message = request()) => server.handleNatsRequest('orders', message, handler),
    };

    /** Runs a JetStream message, an RPC request and a core event through the server and returns their outcome */
    const processAll = async (server: any, handler: unknown) => {
      const [message, rpc, mutex] = [jsMessage(), request(), new SimpleMutex(1)];
      await mutex.lock(); // taken by the consume loop before the message is handled
      void paths['JetStream event'](server, handler, message, mutex);
      void paths['RPC request'](server, handler, rpc);
      void paths['core event'](server, handler);
      await settle();
      const replies = () => rpc.respond.mock.calls.map(([data]) => JSONCodec().decode(data));
      return { jsMessage: message, mutex, replies };
    };

    /** The start hook runs the processing inside an AsyncLocalStorage context, as tracing tools do */
    const hookedServer = (calls: string[]) => {
      const server = createServer();
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

    /** Server with a failing start hook; runs a JetStream message, an RPC request and a core event through it */
    const processWithStartHook = async (
      hook: (transportId: unknown, ctx: unknown, done: () => Promise<unknown>) => unknown,
    ) => {
      const server = createServer();
      server.setOnProcessingStartHook(hook);
      const end = jest.fn();
      server.setOnProcessingEndHook(end);
      const handler = jest.fn(async () => 'done');
      return { server, handler, end, ...(await processAll(server, handler)) };
    };

    it.each([
      [
        'throws',
        () => {
          throw new Error('no traceparent');
        },
      ],
      [
        'rejects',
        async () => {
          throw new Error('no traceparent');
        },
      ],
    ])('UT-55 a start hook that %s before done should fail the message as a handler error', async (_, hook) => {
      const { server, handler, end, jsMessage, mutex, replies } = await processWithStartHook(hook);

      expect(handler).not.toHaveBeenCalled();
      expect(end).not.toHaveBeenCalled(); // the processing has not started, as in NestJS 12
      expect([jsMessage.nak.mock.calls.length, jsMessage.term.mock.calls.length, mutex.current]).toEqual([1, 0, 0]);
      expect(replies()).toEqual([
        { err: { message: 'Internal Server Error: no traceparent', statusCode: 500 }, isDisposed: true },
      ]);
      expect(server.processing.size).toBe(0);
      expect(server.logger.error).toHaveBeenCalledTimes(3);
    });

    it.each([
      [
        'throws',
        (transportId: unknown, ctx: unknown, done: () => Promise<unknown>) => {
          void done();
          throw new Error('span export failed');
        },
      ],
      [
        'rejects',
        async (transportId: unknown, ctx: unknown, done: () => Promise<unknown>) => {
          await done();
          throw new Error('span export failed');
        },
      ],
    ])('UT-56 a start hook that %s after done should only be logged', async (_, hook) => {
      const { server, handler, end, jsMessage, mutex, replies } = await processWithStartHook(hook);

      expect(handler).toHaveBeenCalledTimes(3);
      expect(end).toHaveBeenCalledTimes(3);
      expect([jsMessage.ack.mock.calls.length, jsMessage.nak.mock.calls.length, mutex.current]).toEqual([1, 0, 0]);
      expect(replies()).toEqual([{ response: 'done', isDisposed: true }]);
      expect(server.processing.size).toBe(0);
      expect(server.logger.error).toHaveBeenCalledTimes(3);
    });

    it('UT-92 a start hook that fails and calls done afterwards should not run the handler', async () => {
      const { handler, end, jsMessage, mutex, replies } = await processWithStartHook((transportId, ctx, done) => {
        setTimeout(done, 10); // a hook that reports the failure and goes on
        return Promise.reject(new Error('tracer not ready'));
      });
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(handler).not.toHaveBeenCalled();
      expect(end).not.toHaveBeenCalled();
      expect([jsMessage.nak.mock.calls.length, jsMessage.ack.mock.calls.length, mutex.current]).toEqual([1, 0, 0]);
      expect(replies()).toHaveLength(1); // the error reply only
    });

    it('UT-93 a start hook that rejects with something other than an Error should be logged with it', async () => {
      const { server } = await processWithStartHook(() => Promise.reject('tracer not ready'));

      expect(server.logger.error).toHaveBeenCalledWith('Processing start hook failed [orders]', "'tracer not ready'");
    });

    it('UT-94 a handler that rejects should fail the message as a handler error on every path', async () => {
      const server = createServer();
      // As a handler added with addHandler(), or a controller method whose exception filter throws
      const { jsMessage, mutex, replies } = await processAll(server, async () => {
        throw new Error('db down');
      });

      expect([jsMessage.nak.mock.calls.length, jsMessage.term.mock.calls.length, mutex.current]).toEqual([1, 0, 0]);
      expect(replies()).toEqual([
        { err: { message: 'Internal Server Error: db down', statusCode: 500 }, isDisposed: true },
      ]);
      expect(server.logger.error.mock.calls.map(([message]) => message)).toEqual(
        Array(3).fill('Processing failed [orders]'),
      );
      expect(server.processing.size).toBe(0);
    });

    it.each([
      ['fails', () => Promise.reject(new Error('db down')), [1, 0], 'Internal Server Error: db down'],
      ['succeeds', async () => 'done', [0, 1], undefined],
    ])('UT-95 an end hook that throws when the handler %s should be logged, the message processed', async (...args) => {
      const [, handler, [naks, acks], error] = args;
      const server = createServer();
      server.setOnProcessingEndHook(() => {
        throw new Error('span export failed');
      });
      const { jsMessage, mutex, replies } = await processAll(server, handler);

      expect([jsMessage.nak.mock.calls.length, jsMessage.ack.mock.calls.length, mutex.current]).toEqual([
        naks,
        acks,
        0,
      ]);
      expect(replies()).toEqual([
        error ? { err: { message: error, statusCode: 500 }, isDisposed: true } : { response: 'done', isDisposed: true },
      ]);
      expect(server.processing.size).toBe(0);
      expect(server.logger.error).toHaveBeenCalledWith(
        'Processing end hook failed [orders]',
        expect.stringContaining('span export failed'),
      );
    });
  });

  describe('RPC error replies', () => {
    it('UT-57 a request should get 400 only when it cannot be deserialized, 500 when its processing fails', async () => {
      const server = createServer();
      const reply = async (data: Uint8Array, handler: unknown) => {
        const respond = jest.fn();
        await server.getRequestHandler('orders', handler)(undefined, { subject: 'orders', data, respond });
        return JSONCodec().decode(respond.mock.calls[0][0]);
      };
      // A handler added with addHandler() runs without the interceptor and the filters that turn errors into replies
      const failing = async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.5:5432');
      };

      expect(await reply(Buffer.from('not-json'), failing)).toEqual({
        err: { message: 'Bad Request: Bad JSON', statusCode: 400 },
        isDisposed: true,
      });
      expect(await reply(JSONCodec().encode({ pattern: 'orders', data: 1 }), failing)).toEqual({
        err: { message: 'Internal Server Error: connect ECONNREFUSED 10.0.0.5:5432', statusCode: 500 },
        isDisposed: true,
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

  it('UT-72 the status updates should go on past pingTimer when the connection option is not set', async () => {
    const server = Object.assign(new ServerNats({ consumerName: 'svc' } as any), { logger: { log: jest.fn() } });
    const feed = new QueuedIteratorImpl<{ type: string; data?: unknown }>();
    const watching = server.handleStatusUpdates({ status: () => feed } as any);
    feed.push({ type: 'pingTimer', data: 1 });
    feed.stop();

    await expect(watching).resolves.toBeUndefined();
  });

  it('UT-74 propagatesEventHandlerErrors should be true, as NestJS 12 expects of a transport that reports handler errors', () => {
    expect(createServer().propagatesEventHandlerErrors).toBe(true);
  });
});
