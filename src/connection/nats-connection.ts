import { Logger } from '@nestjs/common';
import { isObject } from '@nestjs/common/utils/shared.utils';
import { EventEmitter } from 'events';
import { NatsConnection } from 'nats';
import { Subject } from 'rxjs';
import { inspect } from 'util';
import { NATS_STATUS_BY_TYPE, NATS_STATUS_EVENTS } from '../constants';

// The connection handling that ServerNats and ClientNats share; the package does not export this module

type Log = Pick<Logger, 'log' | 'error' | 'debug'>;

/** What to log as the stack of a failure: a rejection reason that is not an Error has no stack and is logged as is */
export const stackOf = (err: unknown) => (err as Error)?.stack ?? inspect(err);

/** Registers a listener of on(): an error it throws or rejects with is logged instead of ending the process */
export function addStatusListener(emitter: EventEmitter, logger: Log, event: string, callback: Function) {
  emitter.on(event, (...args: unknown[]) =>
    new Promise(resolve => resolve(callback(...args))).catch(err =>
      logger.error(`Status listener for "${event}" failed`, stackOf(err)),
    ),
  );
}

/** Passes the status updates of a connection to the status, the listeners of on() and the log */
export async function watchStatus(
  client: NatsConnection,
  status$: Subject<string>,
  emitter: EventEmitter,
  logger: Log,
  debug?: boolean,
) {
  for await (const status of client.status()) {
    const data = isObject(status.data) ? JSON.stringify(status.data) : status.data;
    // A permissions violation names the operation and the subject that NATS has denied
    const context = status.permissionContext ? `, permissionContext: ${JSON.stringify(status.permissionContext)}` : '';
    if (NATS_STATUS_BY_TYPE[status.type]) status$.next(NATS_STATUS_BY_TYPE[status.type]);
    if (NATS_STATUS_EVENTS.includes(status.type)) emitter.emit(status.type, status.data);

    switch (status.type) {
      case 'error':
      case 'disconnect':
        logger.error(`NatsError: type: "${status.type}", data: "${data}"${context}.`);
        break;

      case 'pingTimer':
        if (debug) {
          logger.debug(`NatsStatus: type: "${status.type}", data: "${data}".`);
        }
        break;

      default:
        logger.log(`NatsStatus: type: "${status.type}", data: "${data}".`);
        break;
    }
  }
}

/**
 * Drains the connection and closes it: nats.js leaves the connection open when its drain fails during an outage.
 * Stops waiting once nats.js closes the connection, as when the reconnect attempts run out. Without `drain` the
 * connection is closed at once.
 */
export async function closeConnection(client: NatsConnection, logger: Log, owner: string, drain = true) {
  try {
    if (drain && !client.isClosed()) await Promise.race([client.drain(), client.closed()]);
    if (!client.isClosed()) await client.close();
  } catch (error) {
    logger.error(
      `Failed to drain the NATS ${owner} due to an error, forcibly closing the connection: reason=${error.code}`,
      error?.stack,
    );

    await client.close();
  }
}
