export const NAK = Symbol('nats:nak');
export const TERM = Symbol('nats:term');

export const TRACE_ID_HEADER = 'x-trace-id';
export const REQUEST_ID_HEADER = 'x-request-id';

export const DEFAULT_NAK_DELAY = 1000;
export const DEFAULT_MAX_NAK_DELAY = 60000;

export const NATS_CONNECTION_DRAINING_ERROR_CODE = 'CONNECTION_DRAINING';
export const NATS_CONNECTION_CLOSED_ERROR_CODE = 'CONNECTION_CLOSED';
export const NATS_AUTHORIZATION_VIOLATION_ERROR_CODE = 'AUTHORIZATION_VIOLATION';
/** `err_code` of the JetStream API error "consumer not found" */
export const NATS_CONSUMER_NOT_FOUND_ERROR_CODE = 10014;

export const AUTHORIZATION_VIOLATION_RETRY_DELAY = 5000;
export const CONSUMER_RETRY_DELAY = 1000;
export const RECONNECT_DELAY = 5000;
/** The longest close() waits for the handlers in progress, as NATS_DEFAULT_GRACE_PERIOD of NestJS 11+ */
export const GRACE_PERIOD = 10000;

/** `status` of ServerNats and ClientNats by NATS status type, as in the built-in NATS transport of NestJS 11+ */
export const NATS_STATUS_BY_TYPE: Record<string, string> = {
  disconnect: 'disconnected',
  reconnecting: 'reconnecting',
  reconnect: 'connected',
};
/** NATS status types passed to the listeners registered with `on()` */
export const NATS_STATUS_EVENTS = ['disconnect', 'reconnect', 'update'];
