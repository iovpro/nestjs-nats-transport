import { Logger, OnModuleDestroy } from '@nestjs/common';
import { isObject } from '@nestjs/common/utils/shared.utils';
import {
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
} from 'nats';
import { SimpleMutex } from 'nats/lib/nats-base-client/util';
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
  AUTHORIZATION_VIOLATION_RETRY_DELAY,
  NATS_AUTHORIZATION_VIOLATION_ERROR_CODE,
} from '../constants';

/**
 * @publicApi
 */
export class ServerNats extends Server implements CustomTransportStrategy, OnModuleDestroy {
  public readonly transportId = Transport.NATS;
  protected readonly logger: Logger;

  private natsClient: NatsConnection;
  private jetstreamClient: JetStreamClient;
  private jetstreamManager: JetStreamManager;

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
      if (this.options.jetStream) {
        this.jetstreamClient = this.createJetStreamClient();
        this.jetstreamManager = await this.createJetStreamManager();
        if (this.streams) {
          await this.setupStreams();
        }
      }
      this.handleStatusUpdates(this.natsClient);
      await this.start(callback);

      this.logger.log(
        `Nats server connected to "${this.natsClient.getServer()}" server id "${this.natsClient.info.server_id}"`,
      );
    } catch (err) {
      if (err.code === NATS_AUTHORIZATION_VIOLATION_ERROR_CODE) {
        this.logger.error(err, 'Authorization violation, retrying in 5 seconds...');
        setTimeout(() => this.listen(callback), AUTHORIZATION_VIOLATION_RETRY_DELAY);
      } else {
        callback(err);
      }
    }
  }

  public createClient(): Promise<NatsConnection> {
    const options = this.options.connection || ({} as ConnectionOptions);
    return connect({
      servers: NATS_DEFAULT_URL,
      ...options,
    });
  }

  private createJetStreamClient(): JetStreamClient {
    return this.natsClient.jetstream();
  }

  private async createJetStreamManager(): Promise<JetStreamManager> {
    return await this.natsClient.jetstreamManager(this.options.jetStreamOptions);
  }

  public async close() {
    if (!this.natsClient) return;

    try {
      await this.natsClient.drain();
    } catch (error) {
      this.logger.error(
        error,
        `Failed to drain the NATS server due to an error, forcibly closing the connection: reason=${error.code}`,
      );

      await this.natsClient?.close();
    }

    this.natsClient = null;
    this.jetstreamClient = null;
    this.jetstreamManager = null;
    this.logger.log('Nats server disconnected');
  }

  public async start(callback: (err?: unknown, ...optionalParams: unknown[]) => void) {
    try {
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
      return undefined;
    }
  }

  private buildConsumerOptions({
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
      ...(this.options.globalEventOptions || {}),
      ...(description ? { description } : {}),
      ...(ack_wait ? { ack_wait } : {}),
      ...(max_deliver ? { max_deliver } : {}),
      ...(sample_freq ? { sample_freq } : {}),
      ...(max_ack_pending ? { max_ack_pending } : {}),
      ...(max_waiting ? { max_waiting } : {}),
      ...(headers_only ? { headers_only } : {}),
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

  private buildConsumerName(channel: string) {
    return [this.options.consumerName, channel.replace(/\s|\.|>|\*/g, '-')].join(':');
  }

  public bindEvents() {
    const eventHandlers = [...this.messageHandlers.entries()].filter(([, handler]) => handler.isEventHandler);

    const subscribe = (channel: string, handler: MessageHandler<any, any, any>) => {
      this.natsClient.subscribe(channel, {
        queue: this.options.consumerName,
        callback: this.getEventHandler(channel, handler).bind(this),
      });

      this.logger.log(`Subscribed to [${channel}] events`);
    };

    eventHandlers.forEach(([channel, handler]) => subscribe(channel, handler));
  }

  public bindRequests() {
    const requestHandlers = [...this.messageHandlers.entries()].filter(([, handler]) => !handler.isEventHandler);

    const subscribe = (channel: string, handler: MessageHandler<any, any, any>) => {
      this.natsClient.subscribe(channel, {
        queue: channel,
        callback: this.getRequestHandler(channel, handler).bind(this),
      });

      this.logger.log(`Subscribed to [${channel}] requests`);
    };

    requestHandlers.forEach(([channel, handler]) => subscribe(channel, handler));
  }

  public async bindJetStreamEvents() {
    const eventHandlers = [...this.messageHandlers.entries()].filter(([, handler]) => handler.isEventHandler);

    const subscribe = async (channel: string, handler: MessageHandler<any, any, any>) => {
      const consumerName = this.buildConsumerName(channel);
      const eventOptions: NatsEventHandlerOptions = handler.extras || {};
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
          filter_subject: channel,
          ack_policy: AckPolicy.Explicit,
          deliver_policy,
          replay_policy: ReplayPolicy.Instant,
          ...consumerOptions,
        });
        consumer = await this.getConsumer(stream, consumerName);
      }

      if (eventOptions.batch) {
        void this.runBatchSubscription(consumer, channel, handler, eventOptions);
        this.logger.log(`Subscribed to [${channel}] JetStream events batch`);
      } else {
        void this.runSubscription(consumer, channel, handler, eventOptions);
        this.logger.log(`Subscribed to [${channel}] JetStream events`);
      }
    };

    eventHandlers.forEach(async ([channel, handler]) => await subscribe(channel, handler));
  }

  private async runSubscription(
    consumer: Consumer,
    channel: string,
    handler: MessageHandler<any, any, any>,
    eventOptions: NatsEventHandlerOptions,
  ) {
    try {
      const iter = await consumer.consume(eventOptions.max_messages ? { max_messages: eventOptions.max_messages } : {});
      const mutex = new SimpleMutex(eventOptions.max_handlers || 1);

      for await (const message of iter) {
        await mutex.lock();
        void this.handleNatsJetStreamEvent(channel, message, handler, mutex);
      }
    } catch (err) {
      if (err instanceof NatsError && err.code === NATS_CONNECTION_DRAINING_ERROR_CODE) {
        this.logger.log(`Stopping messages consuming due server is draining: channel=${channel}`);
        return;
      }

      this.logger.error(err, `Consumer [${channel}] failed: reason=${err.code}`);
    }

    if (this.jetstreamClient) {
      void this.runSubscription(consumer, channel, handler, eventOptions);
    }
  }

  private async runBatchSubscription(
    consumer: Consumer,
    channel: string,
    handler: MessageHandler<any, any, any>,
    eventOptions: NatsEventHandlerOptions,
  ) {
    const mutex = new SimpleMutex(1);
    try {
      await mutex.lock();
      const expires = eventOptions.batch_expires || 1000;
      const iter = await consumer.fetch({
        expires,
        ...(eventOptions.max_messages ? { max_messages: eventOptions.max_messages } : {}),
      });

      const batch: any[] = [];
      for await (const message of iter) {
        batch.push(message);
      }
      await this.handleNatsJetStreamBatchEvents(channel, batch, handler, mutex);
      await mutex.lock();
    } catch (err) {
      if (err instanceof NatsError && err.code === NATS_CONNECTION_DRAINING_ERROR_CODE) {
        this.logger.log(`Stopping messages batch consuming due server is draining: channel=${channel}`);
        return;
      }

      this.logger.error(err, `Batch consumer [${channel}] failed`);
    }

    if (this.jetstreamClient) {
      void this.runBatchSubscription(consumer, channel, handler, eventOptions);
    }
  }

  private getEventHandler(channel: string, handler: MessageHandler<any, any, any>) {
    return async (error: object | undefined, message: Msg) => {
      if (error) {
        return this.logger.error(error);
      }
      return this.handleNatsEvent(channel, message, handler);
    };
  }

  private getRequestHandler(channel: string, handler: MessageHandler<any, any, any>) {
    return async (error: object | undefined, message: Msg) => {
      if (error) {
        return this.logger.error(error);
      }
      return this.handleRequest(channel, message, handler);
    };
  }

  public async handleNatsEvent(channel: string, natsMsg: Msg, handler: MessageHandler<any, any, any>) {
    try {
      const natsCtx = new NatsContext([natsMsg]);
      const message = await this.deserializer.deserialize(natsMsg.data, {
        channel,
        replyTo: natsMsg.reply,
        headers: natsMsg.headers,
      });

      const response$ = this.transformToObservable(await handler(message.data || message, natsCtx));

      const respond = async (response: WritePacket<any>) => {
        return;
      };

      this.send(response$, respond);
    } catch (err) {
      this.logger.error(err, 'Incorrect event data');
    }
  }

  public async handleNatsJetStreamEvent(
    channel: string,
    natsMsg: JsMsg,
    handler: MessageHandler<any, any, any>,
    mutex: SimpleMutex,
  ) {
    const eventOptions: NatsEventHandlerOptions = handler.extras || {};
    try {
      natsMsg.working();

      const natsCtx = new NatsContext([natsMsg]);
      const message = await this.deserializer.deserialize(natsMsg.data, {
        channel,
        headers: natsMsg.headers,
      });

      const response$ = this.transformToObservable(await handler(message.data || message, natsCtx));

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
          this.logger.error(e);
        } finally {
          mutex.unlock();
        }
      };

      this.send(response$, respond);
    } catch (err) {
      this.logger.error(err, 'Failed to process event data');
      try {
        natsMsg.term('Failed to process event data');
      } catch (e) {
        this.logger.error(e, 'Failed to term failed nats msg');
      }
      mutex.unlock();
    }
  }

  public async handleNatsJetStreamBatchEvents(
    channel: string,
    batchMsgs: JsMsg[],
    handler: MessageHandler<any, any, any>,
    mutex: SimpleMutex,
  ) {
    const eventOptions: NatsEventHandlerOptions = handler.extras || {};
    try {
      const validNatsMsgs: JsMsg[] = [];
      const messages: any[] = [];

      await Promise.all(
        batchMsgs.map(async natsMsg => {
          natsMsg.working();
          try {
            const message = await this.deserializer.deserialize(natsMsg.data, {
              channel,
              headers: natsMsg.headers,
            });
            if (!message) throw new Error('Empty message');

            validNatsMsgs.push(natsMsg);
            messages.push(message.data || message);
          } catch (e) {
            natsMsg.term(e.message);
          }
        }),
      );

      if (!messages.length) {
        mutex.unlock();
        return;
      }

      const natsCtx = new NatsContext([validNatsMsgs[0]]);
      const response$ = this.transformToObservable(await handler(messages, natsCtx));

      const respond = async (response: WritePacket<any>) => {
        try {
          if (response.err || response.response === NAK) {
            batchMsgs.forEach(natsMsg => natsMsg.nak(this.calculateNakDelay(natsMsg, eventOptions)));
          } else if (response.response === TERM) {
            batchMsgs.forEach(natsMsg => natsMsg.term());
          } else {
            batchMsgs.forEach(natsMsg => natsMsg.ack());
          }
        } catch (e) {
          this.logger.error(e);
        } finally {
          mutex.unlock();
        }
      };

      this.send(response$, respond);
    } catch (err) {
      this.logger.error(err, 'Failed to process batch event data');
      try {
        batchMsgs.forEach(async natsMsg => {
          natsMsg.nak(this.calculateNakDelay(natsMsg, eventOptions));
        });
      } catch (e) {
        this.logger.error(e);
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

  public async handleRequest(channel: string, natsMsg: Msg, handler: MessageHandler<any, any, any>) {
    const replyTo = natsMsg.reply;

    const natsCtx = new NatsContext([natsMsg]);
    const incomingMessage: IncomingRequest = (await this.deserializer.deserialize(natsMsg.data, {
      channel,
      replyTo,
      headers: natsMsg.headers,
    })) as IncomingRequest;

    const response$ = this.transformToObservable(await handler(incomingMessage.data || incomingMessage, natsCtx));
    const respond = async (response: WritePacket<any>) => {
      response = this.preparePacketHeaders(response);
      const message: NatsRecord = await this.serializer.serialize({ id: incomingMessage.id, ...response }, {});
      natsMsg.respond(message.data, {
        ...(message.headers ? { headers: message.headers } : {}),
      });
    };

    this.send(response$, respond);
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
