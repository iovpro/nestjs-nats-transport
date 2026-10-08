import { HttpStatus, Logger, OnModuleDestroy } from '@nestjs/common';
import { isObject } from '@nestjs/common/utils/shared.utils';
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
} from 'nats';
import { SimpleMutex } from 'nats/lib/nats-base-client/util';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import { Observable, ReplaySubject, distinctUntilChanged, finalize } from 'rxjs';
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
  NATS_STATUS_BY_TYPE,
  NATS_STATUS_EVENTS,
  GRACE_PERIOD,
} from '../constants';

type ProcessingStartHook = (transportId: Transport | symbol, context: BaseRpcContext, done: () => Promise<any>) => void;
type ProcessingEndHook = (transportId: Transport | symbol, context: BaseRpcContext) => void;

/**
 * @publicApi
 */
export class ServerNats extends Server implements CustomTransportStrategy, OnModuleDestroy {
  public readonly transportId = Transport.NATS;
  protected readonly logger: Logger;

  private natsClient: NatsConnection;
  private jetstreamClient: JetStreamClient;
  private jetstreamManager: JetStreamManager;
  private readonly consumerMessages = new Map<string, ConsumerMessages>();
  private readonly subscriptions: Subscription[] = [];
  private readonly processing = new Set<Promise<unknown>>();
  private readonly sharedRpcPatterns = new Set<string>();
  private reconnectTimer: NodeJS.Timeout;
  private closing = false;
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
  }

  public async onModuleDestroy() {
    await this.close();
  }

  public async listen(callback: (err?: unknown, ...optionalParams: unknown[]) => void) {
    try {
      this.natsClient = await this.createClient();
      if (this.closing) return void this.natsClient.close();
      this._status$.next('connected');
      void this.natsClient.closed().then(err => err && this.reconnect(err));
      if (this.options.jetStream) {
        this.jetstreamClient = this.createJetStreamClient();
        this.jetstreamManager = await this.createJetStreamManager();
        if (this.streams) {
          await this.setupStreams();
        }
      }
      this.handleStatusUpdates(this.natsClient);
      this.logger.log(
        `Nats server connected to "${this.natsClient.getServer()}" server id "${this.natsClient.info.server_id}"`,
      );
      await this.start(callback);
    } catch (err) {
      if (err.code === NATS_AUTHORIZATION_VIOLATION_ERROR_CODE && !this.closing) {
        this.logger.error('Authorization violation, retrying in 5 seconds...', err?.stack);
        this.reconnectTimer = setTimeout(() => this.listen(callback), AUTHORIZATION_VIOLATION_RETRY_DELAY);
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

  private reconnect(err: unknown) {
    if (this.closing) return;
    this.logger.error('Nats connection closed, reconnecting in 5 seconds...', (err as Error)?.stack);
    this.consumerMessages.forEach(messages => messages.stop());
    void this.natsClient.close();
    this.reconnectTimer = setTimeout(() => this.listen(e => e && this.reconnect(e)), RECONNECT_DELAY);
  }

  private createJetStreamClient(): JetStreamClient {
    return this.natsClient.jetstream(this.options.jetStreamOptions);
  }

  private async createJetStreamManager(): Promise<JetStreamManager> {
    return await this.natsClient.jetstreamManager(this.options.jetStreamOptions);
  }

  public async close() {
    this.closing = true;
    clearTimeout(this.reconnectTimer);
    if (!this.natsClient) return;

    // Stops taking messages and lets the handlers in progress reply and ack
    this.subscriptions.forEach(subscription => subscription.unsubscribe());
    this.consumerMessages.forEach(messages => messages.stop());
    let gracePeriod: NodeJS.Timeout;
    await Promise.race([
      Promise.all(this.processing),
      new Promise(resolve => (gracePeriod = setTimeout(resolve, GRACE_PERIOD))),
    ]);
    clearTimeout(gracePeriod);

    try {
      await this.natsClient.drain();
      if (!this.natsClient.isClosed()) await this.natsClient.close();
    } catch (error) {
      this.logger.error(
        `Failed to drain the NATS server due to an error, forcibly closing the connection: reason=${error.code}`,
        error?.stack,
      );

      await this.natsClient?.close();
    }

    this.natsClient = null;
    this.jetstreamClient = null;
    this.jetstreamManager = null;
    this.statusEventEmitter.removeAllListeners();
    this.logger.log('Nats server disconnected');
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
    this.statusEventEmitter.on(event, callback as (...args: unknown[]) => void);
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
      this.bindRequests();
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

  private buildConsumerOptions(options: ConsumerUpdateConfig) {
    return this.pickConsumerOptions({ ...this.options.globalEventOptions, ...options });
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
      const eventOptions: NatsEventHandlerOptions = { ...this.options.globalEventOptions, ...handler.extras };
      const deliver_policy = eventOptions.deliver_policy || DeliverPolicy.New;

      const consumerOptions = this.buildConsumerOptions(eventOptions);

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
        if (this.closing) return;
        void this.handleNatsJetStreamEvent(channel, message, handler, mutex);
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

    if (this.jetstreamClient && !this.closing) {
      void this.runSubscription(consumer, channel, handler, eventOptions);
    }
  }

  private getEventHandler(channel: string, handler: MessageHandler<any, any, any>) {
    return async (error: NatsError | undefined, message: Msg) => {
      if (error) {
        return this.logger.error(error.message, error.stack);
      }
      return this.handleNatsEvent(channel, message, handler);
    };
  }

  private getRequestHandler(channel: string, handler: MessageHandler<any, any, any>) {
    return async (error: NatsError | undefined, message: Msg) => {
      if (error) {
        return this.logger.error(error.message, error.stack);
      }
      return this.handleNatsRequest(channel, message, handler).catch(err => {
        this.logger.error(`Failed to process request [${channel}]`, err?.stack);
        return this.respondWithError(message, {
          message: `Bad Request: ${err?.message}`,
          statusCode: HttpStatus.BAD_REQUEST,
        });
      });
    };
  }

  /** Runs the handler and subscribes to its result inside the processing hooks, as the base Server of NestJS 12 */
  private sendWithHooks(
    context: NatsContext,
    produce: () => Promise<Observable<any>>,
    respond: (response: WritePacket<any>) => Promise<unknown>,
  ): Promise<void> {
    const end = () => this.onProcessingEndHook?.(this.transportId, context);
    let processed: () => void;
    const processing = new Promise<void>(resolve => (processed = resolve)).then(() =>
      this.processing.delete(processing),
    );
    this.processing.add(processing);
    return new Promise((resolve, reject) =>
      this.onProcessingStartHook(this.transportId, context, async () => {
        try {
          this.send((await produce()).pipe(finalize(end)), packet =>
            respond(packet).finally(() => packet.isDisposed && processed()),
          );
          resolve();
        } catch (err) {
          end();
          processed();
          reject(err);
        }
      }),
    );
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
  ) {
    const eventOptions: NatsEventHandlerOptions = { ...this.options.globalEventOptions, ...handler.extras };
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
        return this.respondWithError(natsMsg, {
          message: `Internal Server Error: ${err?.message}`,
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        });
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

  public async handleStatusUpdates(client: NatsConnection) {
    for await (const status of client.status()) {
      const data = status.data && isObject(status.data) ? JSON.stringify(status.data) : status.data;
      if (NATS_STATUS_BY_TYPE[status.type]) this._status$.next(NATS_STATUS_BY_TYPE[status.type]);
      if (NATS_STATUS_EVENTS.includes(status.type)) this.statusEventEmitter.emit(status.type, status.data);

      switch (status.type) {
        case 'error':
        case 'disconnect':
          this.logger.error(`NatsError: type: "${status.type}", data: "${data}".`);
          break;

        case 'pingTimer':
          if (this.options.connection.debug) {
            this.logger.debug(`NatsStatus: type: "${status.type}", data: "${data}".`);
          }
          break;

        default:
          this.logger.log(`NatsStatus: type: "${status.type}", data: "${data}".`);
          break;
      }
    }
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
