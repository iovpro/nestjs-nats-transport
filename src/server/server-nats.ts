import { HttpStatus, Logger, OnModuleDestroy } from '@nestjs/common';
import { isNil } from '@nestjs/common/utils/shared.utils';
import {
  BaseRpcContext,
  CustomTransportStrategy,
  IncomingRequest,
  MessageHandler,
  NatsRecord,
  Server,
  Transport,
  WritePacket,
  NatsRecordBuilder,
} from '@nestjs/microservices';
import { NATS_DEFAULT_URL } from '@nestjs/microservices/constants';
import {
  AckPolicy,
  JetStreamClient,
  JetStreamManager,
  JsMsg,
  Msg,
  NatsConnection,
  connect,
  StreamConfig,
  DeliverPolicy,
  ReplayPolicy,
  ConnectionOptions,
  ConsumerUpdateConfig,
  headers as natsMsgHeaders,
  Consumer,
  MsgHdrs,
  MsgHdrsImpl,
  NatsError,
  ConsumerMessages,
  Subscription,
  Match,
} from 'nats';
import { SimpleMutex } from 'nats/lib/nats-base-client/util';
import { createHash, randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { STATUS_CODES } from 'http';
import { Observable, ReplaySubject, distinctUntilChanged, finalize } from 'rxjs';
import { addStatusListener, closeConnection, stackOf, watchStatus } from '../connection/nats-connection';
import { NatsContext } from '../ctx-host/nats.context';
import { NatsResponseSerializer } from '../serializers';
import { NatsRequestJSONDeserializer } from '../deserializers';
import { NatsServerConnectionOptions, NakStrategy, NatsEventHandlerOptions } from '../interfaces';
import {
  DEFAULT_MAX_NAK_DELAY,
  DEFAULT_NAK_DELAY,
  NAK,
  TERM,
  NATS_CONNECTION_DRAINING_ERROR_CODE,
  NATS_CONNECTION_CLOSED_ERROR_CODE,
  NATS_CONSUMER_NOT_FOUND_ERROR_CODE,
  AUTHORIZATION_VIOLATION_RETRY_DELAY,
  CONSUMER_RETRY_DELAY,
  NATS_AUTHORIZATION_VIOLATION_ERROR_CODE,
  RECONNECT_DELAY,
  GRACE_PERIOD,
  TRACE_ID_HEADER,
  REQUEST_ID_HEADER,
} from '../constants';
import { RequestContext } from '../context';

type ProcessingStartHook = (transportId: Transport | symbol, context: BaseRpcContext, done: () => Promise<any>) => void;
type ProcessingEndHook = (transportId: Transport | symbol, context: BaseRpcContext) => void;
/**
 * A listen() with its retries and reconnects until close(): what a closed session still runs leaves the next alone.
 * `complete` calls the listen() back, `closed` is the close of the session.
 */
type Session = { closing: boolean; complete?: (err?: unknown) => void; closed?: Promise<void> };

/** The error of a listen() that close() has stopped, also of a listen() after a close() that came first */
const closedBeforeListen = () => new Error('ServerNats was closed before listen() completed');

/** An error reply of the library: the reason phrase of the status code and the message of the error */
const errorReply = (statusCode: HttpStatus, err: Error) => ({
  message: `${STATUS_CODES[statusCode]}: ${err?.message}`,
  statusCode,
});

/**
 * @publicApi
 */
export class ServerNats extends Server implements CustomTransportStrategy, OnModuleDestroy {
  public readonly transportId = Transport.NATS;
  public readonly propagatesEventHandlerErrors = true;
  protected readonly logger: Logger;

  private natsClient: NatsConnection;
  private jetstreamClient: JetStreamClient;
  private jetstreamManager: JetStreamManager;
  private readonly consumerMessages = new Map<string, ConsumerMessages>();
  private readonly subscriptions: Subscription[] = [];
  private readonly processing = new Set<Promise<unknown>>();
  private readonly sharedRpcPatterns = new Set<string>();
  private reconnectTimer: NodeJS.Timeout;
  private session: Session = { closing: false };
  /** NATS answers: the last status is `connected` */
  private reachable = false;
  protected _status$ = new ReplaySubject<string>(1);
  protected onProcessingStartHook: ProcessingStartHook = (transportId, context, done) => done();
  protected onProcessingEndHook: ProcessingEndHook;
  private readonly statusEventEmitter = new EventEmitter();

  constructor(
    private readonly options: NatsServerConnectionOptions,
    private readonly streams?: Partial<StreamConfig>[],
  ) {
    super();
    this.logger = new Logger(ServerNats.name);

    this.initializeSerializer(options);
    this.initializeDeserializer(options);
    this._status$.subscribe(status => (this.reachable = status === 'connected'));
  }

  public async onModuleDestroy() {
    await this.close();
  }

  public async listen(callback: (err?: unknown, ...optionalParams: unknown[]) => void) {
    // NestJS calls listen() after the init hooks of the application: app.close() during them has closed the server
    if (this.session.closing && !this.session.complete) return callback(closedBeforeListen());
    // Another listen() first closes what the previous one runs, also when the previous one has failed
    if (this.session.complete) await this.stop(this.session);
    let completed = false;
    const complete: typeof callback = (...args) => {
      if (completed) return;
      callback(...args);
      completed = true; // not before: an error the callback throws completes listen() with that error
    };
    this.session = { closing: false, complete };
    await this.connect(this.session, complete);
  }

  /** Connects and starts the handlers of the session; the authorization retries and the reconnects call it again */
  private async connect(session: Session, callback: (err?: unknown) => void) {
    try {
      const natsClient = await this.createClient();
      if (session.closing) return void natsClient.close(); // close() has completed listen()
      this.natsClient = natsClient;
      this._status$.next('connected');
      void natsClient.closed().then(err => err && this.reconnect(session, err));
      if (this.options.jetStream) {
        this.jetstreamClient = this.createJetStreamClient();
        this.jetstreamManager = await this.createJetStreamManager();
        if (this.streams) {
          await this.setupStreams();
        }
      }
      this.handleStatusUpdates(natsClient);
      this.logger.log(`Nats server connected to "${natsClient.getServer()}" server id "${natsClient.info.server_id}"`);
      await this.start(callback);
    } catch (err) {
      if (err.code === NATS_AUTHORIZATION_VIOLATION_ERROR_CODE && !session.closing) {
        this.logger.error('Authorization violation, retrying in 5 seconds...', err?.stack);
        this.schedule(() => this.connect(session, callback), AUTHORIZATION_VIOLATION_RETRY_DELAY);
      } else {
        callback(err);
      }
    }
  }

  public createClient(): Promise<NatsConnection> {
    const options = this.options.connection || ({} as ConnectionOptions);
    return connect({
      servers: NATS_DEFAULT_URL,
      maxReconnectAttempts: -1,
      ...options,
    });
  }

  private reconnect(session: Session, err: unknown) {
    // A failure that a scheduled attempt already replaces is reported twice: by closed() and by the setup
    if (session.closing || this.reconnectTimer) return;
    this._status$.next('reconnecting');
    this.logger.error('Nats connection closed, reconnecting in 5 seconds...', (err as Error)?.stack);
    this.consumerMessages.forEach(messages => messages.stop());
    void this.natsClient?.close();
    this.release();
    this.schedule(() => this.connect(session, e => e && this.reconnect(session, e)), RECONNECT_DELAY);
  }

  /** Schedules the next attempt to connect; close() cancels it */
  private schedule(attempt: () => void, delay: number) {
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      attempt();
    }, delay);
  }

  /** Forgets the connection and what is bound to it */
  private release() {
    this.natsClient = null;
    this.jetstreamClient = null;
    this.jetstreamManager = null;
    this.subscriptions.length = 0;
    this.consumerMessages.clear();
  }

  private createJetStreamClient(): JetStreamClient {
    return this.natsClient.jetstream(this.options.jetStreamOptions);
  }

  private async createJetStreamManager(): Promise<JetStreamManager> {
    return await this.natsClient.jetstreamManager(this.options.jetStreamOptions);
  }

  public async close() {
    await this.stop(this.session);
    this.statusEventEmitter.removeAllListeners();
  }

  /** Closes what a listen() runs; close() called again, also while the close runs, waits for the same close */
  private stop(session: Session) {
    return (session.closed ??= this.shutdown(session));
  }

  private async shutdown(session: Session) {
    session.closing = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    session.complete?.(closedBeforeListen()); // a listen() that has completed is not called back again
    if (!this.natsClient) return;

    // Stops taking messages: a subscription drains the messages that NATS has routed to it. While NATS is
    // unreachable nothing arrives, and a drain would wait for the next reconnect attempt.
    const reachable = this.reachable;
    const stopped = this.subscriptions.map(s => (reachable ? s.drain().catch(() => undefined) : s.unsubscribe()));
    this.consumerMessages.forEach(messages => messages.stop());
    // Lets the handlers in progress reply and ack, for at most GRACE_PERIOD
    let gracePeriod: NodeJS.Timeout;
    await Promise.race([
      Promise.all(stopped).then(() => this.idle()),
      new Promise(resolve => (gracePeriod = setTimeout(resolve, GRACE_PERIOD))),
      this.natsClient.closed(), // nats.js has closed the connection: no reply can be sent any more
    ]);
    clearTimeout(gracePeriod);
    this.processing.clear(); // what has not finished by now is abandoned with the connection

    await closeConnection(this.natsClient, this.logger, 'server', this.reachable);
    this.release();
    this.logger.log('Nats server disconnected');
  }

  /** Resolves once no message is in processing, also the messages that arrive meanwhile */
  private async idle() {
    while (this.processing.size) await Promise.all(this.processing);
  }

  public unwrap<T>(): T {
    if (!this.natsClient) {
      throw new Error(
        'Not initialized. Please call the "listen"/"startAllMicroservices" method before accessing the server.',
      );
    }
    return this.natsClient as T;
  }

  public get status(): Observable<string> {
    return this._status$.asObservable().pipe(distinctUntilChanged());
  }

  public on(event: string, callback: Function) {
    addStatusListener(this.statusEventEmitter, this.logger, event, callback);
  }

  public setOnProcessingStartHook(hook: ProcessingStartHook) {
    this.onProcessingStartHook = hook;
  }

  public setOnProcessingEndHook(hook: ProcessingEndHook) {
    this.onProcessingEndHook = hook;
  }

  public async start(callback: (err?: unknown, ...optionalParams: unknown[]) => void) {
    try {
      const [shared] = this.sharedRpcPatterns;
      if (shared) throw new Error(`Several handlers for the RPC pattern [${shared}]: one handler per pattern`);
      if (this.options.jetStream) {
        await this.bindJetStreamEvents();
      } else {
        this.bindEvents();
      }
      if (!this.session.closing) this.bindRequests(); // close() has come during the JetStream setup
      callback();
    } catch (err) {
      callback(err);
    }
  }

  private async getStream(channel: string) {
    try {
      return await this.jetstreamManager.streams.find(channel);
    } catch (error) {
      throw new Error(`Can't find stream: ${channel}`);
    }
  }

  private async getConsumer(stream: string, consumerName: string) {
    try {
      return await this.jetstreamClient.consumers.get(stream, consumerName);
    } catch (e) {
      if (e.api_error?.err_code !== NATS_CONSUMER_NOT_FOUND_ERROR_CODE) throw e;
      return undefined;
    }
  }

  /** The decorator options over globalEventOptions; a decorator option set to undefined or null keeps the global value */
  private buildEventOptions({ extras }: MessageHandler): NatsEventHandlerOptions {
    const defined = Object.entries(extras ?? {}).filter(([, value]) => !isNil(value));
    return { ...this.options.globalEventOptions, ...Object.fromEntries(defined) };
  }

  private pickConsumerOptions({
    description,
    ack_wait,
    max_deliver,
    sample_freq,
    max_ack_pending,
    max_waiting,
    headers_only,
    max_batch,
    max_expires,
    inactive_threshold,
    backoff,
    max_bytes,
    num_replicas,
    mem_storage,
    filter_subject,
    filter_subjects,
    metadata,
  }: ConsumerUpdateConfig) {
    return {
      ...(description ? { description } : {}),
      ...(ack_wait ? { ack_wait } : {}),
      ...(max_deliver ? { max_deliver } : {}),
      ...(sample_freq ? { sample_freq } : {}),
      ...(max_ack_pending ? { max_ack_pending } : {}),
      ...(max_waiting ? { max_waiting } : {}),
      ...(headers_only !== undefined ? { headers_only } : {}),
      ...(max_batch ? { max_batch } : {}),
      ...(max_expires ? { max_expires } : {}),
      ...(inactive_threshold ? { inactive_threshold } : {}),
      ...(backoff ? { backoff } : {}),
      ...(max_bytes ? { max_bytes } : {}),
      ...(num_replicas ? { num_replicas } : {}),
      ...(mem_storage ? { mem_storage } : {}),
      ...(filter_subject ? { filter_subject } : {}),
      ...(filter_subjects ? { filter_subjects } : {}),
      ...(metadata ? { metadata } : {}),
    };
  }

  /** The hash tells apart subjects that differ only by ".", "-", "*", ">" or whitespace */
  private buildConsumerName(channel: string) {
    const hash = createHash('sha256').update(channel).digest('hex').slice(0, 8);
    return [this.options.consumerName, `${channel.replace(/\s|\.|>|\*/g, '-')}~${hash}`].join(':');
  }

  public bindEvents() {
    const eventHandlers = [...this.messageHandlers.entries()].filter(([, handler]) => handler.isEventHandler);

    const subscribe = (channel: string, handler: MessageHandler<any, any, any>) => {
      const subscription = this.natsClient.subscribe(channel, {
        queue: this.options.consumerName,
        callback: this.getEventHandler(channel, handler).bind(this),
      });
      this.subscriptions.push(subscription);

      this.logger.log(`Subscribed to [${channel}] events`);
    };

    eventHandlers.forEach(([channel, handler]) => subscribe(channel, handler));
  }

  public bindRequests() {
    const requestHandlers = [...this.messageHandlers.entries()].filter(([, handler]) => !handler.isEventHandler);

    const subscribe = (channel: string, handler: MessageHandler<any, any, any>) => {
      const subscription = this.natsClient.subscribe(channel, {
        queue: channel,
        callback: this.getRequestHandler(channel, handler).bind(this),
      });
      this.subscriptions.push(subscription);

      this.logger.log(`Subscribed to [${channel}] requests`);
    };

    requestHandlers.forEach(([channel, handler]) => subscribe(channel, handler));
  }

  /** NestJS calls one handler of a pattern that has an RPC handler: the others are replaced or never run */
  public addHandler(pattern: any, callback: MessageHandler, isEventHandler = false, extras: Record<string, any> = {}) {
    const route = this.normalizePattern(pattern);
    const head = this.messageHandlers.get(route);
    if (head && !(isEventHandler && head.isEventHandler)) this.sharedRpcPatterns.add(route);
    super.addHandler(pattern, callback, isEventHandler, extras);
  }

  public async bindJetStreamEvents() {
    const eventHandlers = [...this.messageHandlers.entries()].filter(([, handler]) => handler.isEventHandler);
    // NestJS links the handlers of one pattern with `next`, and a JetStream message has one acknowledgement
    const [shared] = eventHandlers.find(([, handler]) => handler.next) ?? [];
    if (shared) throw new Error(`Several handlers for the JetStream pattern [${shared}]: one handler per pattern`);

    const subscribe = async (channel: string, handler: MessageHandler<any, any, any>) => {
      const consumerName = this.buildConsumerName(channel);
      const eventOptions = this.buildEventOptions(handler);
      const deliver_policy = eventOptions.deliver_policy || DeliverPolicy.New;

      const consumerOptions = this.pickConsumerOptions(eventOptions);

      const stream = await this.getStream(channel);
      let consumer = await this.getConsumer(stream, consumerName);

      if (consumer) {
        await this.jetstreamManager.consumers.update(stream, consumerName, consumerOptions);
      } else {
        await this.jetstreamManager.consumers.add(stream, {
          name: consumerName,
          durable_name: consumerName,
          deliver_group: this.options.consumerName,
          filter_subject: eventOptions.filter_subjects?.length ? undefined : channel,
          ack_policy: AckPolicy.Explicit,
          deliver_policy,
          opt_start_seq: eventOptions.opt_start_seq,
          opt_start_time: eventOptions.opt_start_time,
          replay_policy: ReplayPolicy.Instant,
          ...consumerOptions,
        });
        consumer = await this.getConsumer(stream, consumerName);
      }

      if (this.session.closing) return; // close() has come while the consumer was set up
      void this.runSubscription(consumer, channel, handler, eventOptions);
      this.logger.log(`Subscribed to [${channel}] JetStream events`);
    };

    await Promise.all(eventHandlers.map(([channel, handler]) => subscribe(channel, handler)));
  }

  private async runSubscription(
    consumer: Consumer,
    channel: string,
    handler: MessageHandler<any, any, any>,
    eventOptions: NatsEventHandlerOptions,
    session = this.session,
  ) {
    try {
      const iter = await consumer.consume({
        max_messages: eventOptions.max_messages || eventOptions.max_handlers || 1,
        abort_on_missing_resource: true,
      });
      this.consumerMessages.set(channel, iter);
      const mutex = new SimpleMutex(eventOptions.max_handlers || 1);

      for await (const message of iter) {
        await mutex.lock();
        if (session.closing) return;
        void this.track(
          this.withRequestContext(message, () =>
            this.handleNatsJetStreamEvent(channel, message, handler, mutex, eventOptions),
          ),
        );
      }
    } catch (err) {
      if (err instanceof NatsError && err.code === NATS_CONNECTION_DRAINING_ERROR_CODE) {
        this.logger.log(`Stopping messages consuming due server is draining: channel=${channel}`);
        return;
      }

      this.logger.error(`Consumer [${channel}] failed: reason=${err.code}`, err?.stack);
      if (err instanceof NatsError && err.code === NATS_CONNECTION_CLOSED_ERROR_CODE) return;
      await new Promise(resolve => setTimeout(resolve, CONSUMER_RETRY_DELAY));
    }

    if (this.jetstreamClient && !session.closing) {
      void this.runSubscription(consumer, channel, handler, eventOptions, session);
    }
  }

  private getEventHandler(channel: string, handler: MessageHandler<any, any, any>) {
    return async (error: NatsError | undefined, message: Msg) => {
      if (error) {
        return this.logger.error(error.message, error.stack);
      }
      return this.track(this.withRequestContext(message, () => this.handleNatsEvent(channel, message, handler)));
    };
  }

  private getRequestHandler(channel: string, handler: MessageHandler<any, any, any>) {
    return async (error: NatsError | undefined, message: Msg) => {
      if (error) {
        return this.logger.error(error.message, error.stack);
      }
      // Only a request that cannot be deserialized gets here: sendWithHooks() replies to the other failures
      return this.track(
        this.withRequestContext(message, () =>
          this.handleNatsRequest(channel, message, handler).catch(err => {
            this.logger.error(`Failed to process request [${channel}]`, err?.stack);
            return this.respondWithError(message, errorReply(HttpStatus.BAD_REQUEST, err));
          }),
        ),
      );
    };
  }

  /** Counts a message as in processing from its arrival, before its deserialization, for close() to wait for it */
  private track<T>(work: Promise<T>) {
    const tracked: Promise<unknown> = work.catch(() => undefined).then(() => this.processing.delete(tracked));
    this.processing.add(tracked);
    return work;
  }

  /** Wraps `fn` in RequestContext.run() when the option is enabled, extracting trace from message headers */
  private withRequestContext<T>(msg: Msg | JsMsg, fn: () => T): T {
    if (!this.options.requestContext) return fn();
    let hdrs: MsgHdrs | undefined;
    try {
      hdrs = msg.headers;
    } catch {
      // nats.js throws on headers it cannot decode: the handler reads them again and fails the message as before
    }
    const store = {
      traceId: hdrs?.get(TRACE_ID_HEADER, Match.IgnoreCase) || (this.options.generateTraceId ?? randomUUID)(),
      requestId: hdrs?.get(REQUEST_ID_HEADER, Match.IgnoreCase) || undefined,
    };
    return RequestContext.run(store, fn);
  }

  /** Runs the handler and subscribes to its result inside the processing hooks, as the base Server of NestJS 12 */
  private sendWithHooks(
    context: NatsContext,
    produce: () => Promise<Observable<any>>,
    respond: (response: WritePacket<any>) => Promise<unknown>,
  ): Promise<void> {
    const subject = context.getSubject();
    const end = () => {
      try {
        this.onProcessingEndHook?.(this.transportId, context);
      } catch (err) {
        this.logger.error(`Processing end hook failed [${subject}]`, stackOf(err));
      }
    };
    let processed: () => void;
    const processing = new Promise<void>(resolve => (processed = resolve)).then(() =>
      this.processing.delete(processing),
    );
    this.processing.add(processing);
    // As a handler error: a JetStream message is NAKed, an RPC request gets an error reply
    const fail = (err: Error) =>
      respond({ err: errorReply(HttpStatus.INTERNAL_SERVER_ERROR, err), isDisposed: true }).finally(processed);
    let started = false;
    return new Promise(resolve =>
      this.startProcessing(context, async () => {
        if (started) return; // the start hook has failed before, and the message with it
        started = true;
        try {
          this.send((await produce()).pipe(finalize(end)), packet =>
            respond(packet).finally(() => packet.isDisposed && processed()),
          );
        } catch (err) {
          this.logger.error(`Processing failed [${subject}]`, stackOf(err));
          end();
          void fail(err);
        }
        resolve();
      }).catch(err => {
        this.logger.error(`Processing start hook failed [${subject}]`, stackOf(err));
        if (started) return;
        started = true;
        void fail(err);
        resolve();
      }),
    );
  }

  /** The start hook as a promise, rejected when the hook throws or rejects */
  private async startProcessing(context: NatsContext, done: () => Promise<void>) {
    return this.onProcessingStartHook(this.transportId, context, done);
  }

  public async handleNatsEvent(channel: string, natsMsg: Msg, handler: MessageHandler<any, any, any>) {
    try {
      const natsCtx = new NatsContext([natsMsg]);
      const message = await this.deserializer.deserialize(natsMsg.data, {
        channel,
        replyTo: natsMsg.reply,
        headers: natsMsg.headers,
      });

      const produce = async () => this.transformToObservable(await handler(message.data, natsCtx));

      const respond = async (response: WritePacket<any>) => {
        return;
      };

      await this.sendWithHooks(natsCtx, produce, respond);
    } catch (err) {
      this.logger.error('Incorrect event data', err?.stack);
    }
  }

  public async handleNatsJetStreamEvent(
    channel: string,
    natsMsg: JsMsg,
    handler: MessageHandler<any, any, any>,
    mutex: SimpleMutex,
    eventOptions = this.buildEventOptions(handler),
  ) {
    try {
      natsMsg.working();

      const natsCtx = new NatsContext([natsMsg]);
      const message = await this.deserializer.deserialize(natsMsg.data, {
        channel,
        headers: natsMsg.headers,
      });

      const produce = async () => this.transformToObservable(await handler(message.data, natsCtx));

      const respond = async (response: WritePacket<any>) => {
        try {
          if (response.err || response.response === NAK) {
            natsMsg.nak(this.calculateNakDelay(natsMsg, eventOptions));
          } else if (response.response === TERM) {
            natsMsg.term();
          } else {
            natsMsg.ack();
          }
        } catch (e) {
          this.logger.error(e?.message, e?.stack);
        } finally {
          mutex.unlock();
        }
      };

      await this.sendWithHooks(natsCtx, produce, respond);
    } catch (err) {
      this.logger.error('Failed to process event data', err?.stack);
      try {
        natsMsg.term('Failed to process event data');
      } catch (e) {
        this.logger.error('Failed to term failed nats msg', e?.stack);
      }
      mutex.unlock();
    }
  }

  private fibonacciApproximation(n: number): number {
    const phi = (1 + Math.sqrt(5)) / 2;
    return Math.round(Math.pow(phi, n) / Math.sqrt(5));
  }

  private calculateNakDelay(natsMsg: JsMsg, { nak_strategy, nak_delay, nak_delay_max }: NatsEventHandlerOptions) {
    const strategy: NakStrategy = nak_strategy || NakStrategy.regular;
    nak_delay = nak_delay || DEFAULT_NAK_DELAY;
    nak_delay_max = nak_delay_max || DEFAULT_MAX_NAK_DELAY;

    if (strategy === NakStrategy.regular) {
      return nak_delay;
    } else if (strategy === NakStrategy.increment) {
      const delay = natsMsg.info.deliveryCount * nak_delay;
      return delay > nak_delay_max ? nak_delay_max : delay;
    } else if (strategy === NakStrategy.fibonacci) {
      const delay = this.fibonacciApproximation(natsMsg.info.deliveryCount) * nak_delay;
      return delay > nak_delay_max ? nak_delay_max : delay;
    }
  }

  public async handleNatsRequest(channel: string, natsMsg: Msg, handler: MessageHandler<any, any, any>) {
    const replyTo = natsMsg.reply;

    const natsCtx = new NatsContext([natsMsg]);
    const incomingMessage: IncomingRequest = (await this.deserializer.deserialize(natsMsg.data, {
      channel,
      replyTo,
      headers: natsMsg.headers,
    })) as IncomingRequest;

    const produce = async () => this.transformToObservable(await handler(incomingMessage.data, natsCtx));
    const respond = async (response: WritePacket<any>) => {
      response = this.preparePacketHeaders(response);
      const message: NatsRecord = await this.serializer.serialize({ id: incomingMessage.id, ...response }, {});
      natsMsg.respond(message.data, {
        ...(message.headers ? { headers: message.headers } : {}),
      });
    };

    await this.sendWithHooks(natsCtx, produce, response =>
      respond(response).catch(err => {
        this.logger.error(`Failed to send response [${channel}]`, err?.stack);
        return this.respondWithError(natsMsg, errorReply(HttpStatus.INTERNAL_SERVER_ERROR, err));
      }),
    );
  }

  private async respondWithError(natsMsg: Msg, err: { message: string; statusCode: HttpStatus }) {
    try {
      const message: NatsRecord = await this.serializer.serialize({ id: undefined, err, isDisposed: true }, {});
      natsMsg.respond(message.data);
    } catch (e) {
      this.logger.error(`Failed to send error response [${natsMsg.subject}]`, e?.stack);
    }
  }

  private preparePacketHeaders(packet: WritePacket<any>): WritePacket {
    if (!packet?.response || !(packet.response instanceof NatsRecord)) return packet;
    const record = packet.response as NatsRecord;

    if (record.headers && record.headers instanceof MsgHdrsImpl) {
      return packet;
    } else if (record.headers) {
      return { ...packet, response: this.prepareRecord(record.data, record.headers) };
    } else {
      return packet;
    }
  }

  private prepareRecord(data: any, headers?: Record<string, any>) {
    if (headers) {
      const msgHeaders = natsMsgHeaders();
      this.recordToHeaders(msgHeaders, headers);
      const recordBuilder = new NatsRecordBuilder();
      recordBuilder.setData(data);
      recordBuilder.setHeaders(msgHeaders);
      return recordBuilder.build();
    } else {
      return data;
    }
  }

  private recordToHeaders(headers: MsgHdrs, records: Record<string, any>) {
    for (const [key, value] of Object.entries(records)) {
      if (!headers.has(key)) {
        headers.set(key, typeof value === 'string' ? value : JSON.stringify(value));
      }
    }
  }

  public handleStatusUpdates(client: NatsConnection) {
    return watchStatus(client, this._status$, this.statusEventEmitter, this.logger, this.options.connection?.debug);
  }

  protected initializeSerializer(options: NatsServerConnectionOptions) {
    this.serializer = options?.serializer ?? new NatsResponseSerializer();
  }

  protected initializeDeserializer(options: NatsServerConnectionOptions) {
    this.deserializer = options?.deserializer ?? new NatsRequestJSONDeserializer();
  }

  protected async setupStreams(): Promise<void> {
    const streams = await this.jetstreamManager.streams.list().next();
    const streamsConfig = this.streams;

    for (const streamConfig of streamsConfig) {
      const stream = streams.find(stream => stream.config.name === streamConfig.name);

      if (!stream) {
        await this.jetstreamManager.streams.add(streamConfig);
        this.logger.log(`Stream ${streamConfig.name} created`);
      } else {
        await this.jetstreamManager.streams.update(streamConfig.name, {
          ...stream.config,
          ...streamConfig,
        });
        this.logger.log(`Stream ${streamConfig.name} updated`);
      }
    }
  }
}
