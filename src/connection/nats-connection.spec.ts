import { EventEmitter } from 'events';
import { ErrorCode, NatsError } from 'nats';
import { QueuedIteratorImpl } from 'nats/lib/nats-base-client/queued_iterator';
import { ReplaySubject } from 'rxjs';
import { addStatusListener, closeConnection, watchStatus } from './nats-connection';

describe('NATS connection handling of ServerNats and ClientNats', () => {
  const logger = () => ({ log: jest.fn(), error: jest.fn(), debug: jest.fn() });

  /** Watches a feed of status updates that the test pushes to, as nats.js reports them */
  const watchFeed = (log: ReturnType<typeof logger>, emitter = new EventEmitter()) => {
    const feed = new QueuedIteratorImpl<Record<string, unknown>>();
    const watching = watchStatus({ status: () => feed } as any, new ReplaySubject<string>(1), emitter, log);
    return { feed, watching };
  };

  it('UT-77 a listener of on() that throws or rejects should be logged, and the other listeners should still be called', async () => {
    const log = logger();
    const emitter = new EventEmitter();
    const later = jest.fn();
    addStatusListener(emitter, log, 'disconnect', () => {
      throw new Error('listener boom');
    });
    addStatusListener(emitter, log, 'disconnect', async () => {
      throw new Error('async listener boom'); // an alert sent over the network that fails in the same outage
    });
    addStatusListener(emitter, log, 'disconnect', later);
    const { feed, watching } = watchFeed(log, emitter);
    feed.push({ type: 'disconnect', data: 'nats://fake:4222' });
    feed.push({ type: 'reconnect', data: 'nats://fake:4222' });
    feed.stop();
    await watching;
    await new Promise(resolve => setImmediate(resolve)); // the rejection of the async listener

    expect(later).toHaveBeenCalledWith('nats://fake:4222');
    const failures = log.error.mock.calls.filter(([message]) => message.startsWith('Status listener'));
    expect(failures).toEqual([
      ['Status listener for "disconnect" failed', expect.stringContaining('Error: listener boom')],
      ['Status listener for "disconnect" failed', expect.stringContaining('Error: async listener boom')],
    ]);
    expect(log.log).toHaveBeenCalledWith('NatsStatus: type: "reconnect", data: "nats://fake:4222".');
  });

  it('UT-100 the error status of a permissions violation should be logged with the operation and the subject', async () => {
    const log = logger();
    const { feed, watching } = watchFeed(log);
    // As nats.js reports it (ProtocolHandler.processError): the error code and what NATS has denied
    feed.push({
      type: 'error',
      data: 'PERMISSIONS_VIOLATION',
      permissionContext: { operation: 'subscription', subject: 'orders.get' },
    });
    feed.push({ type: 'disconnect', data: 'nats://fake:4222' });
    feed.stop();
    await watching;

    expect(log.error.mock.calls).toEqual([
      [
        'NatsError: type: "error", data: "PERMISSIONS_VIOLATION", permissionContext: {"operation":"subscription","subject":"orders.get"}.',
      ],
      ['NatsError: type: "disconnect", data: "nats://fake:4222".'],
    ]);
  });

  it('UT-101 closeConnection should log a failed drain and close the connection anyway', async () => {
    const log = logger();
    const connection = {
      isClosed: () => false,
      drain: jest.fn().mockRejectedValue(NatsError.errorForCode(ErrorCode.ConnectionDraining)),
      closed: () => new Promise(() => undefined),
      close: jest.fn(),
    };
    await closeConnection(connection as any, log, 'server');

    expect(log.error).toHaveBeenCalledWith(
      'Failed to drain the NATS server due to an error, forcibly closing the connection: reason=CONNECTION_DRAINING',
      expect.stringContaining('CONNECTION_DRAINING'),
    );
    expect(connection.close).toHaveBeenCalled();
  });
});
