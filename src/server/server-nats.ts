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
  createInbox,
  ConsumerUpdateConfig,
} from 'nats';
import { NatsContext } from '../ctx-host/nats.context';
import { NatsJSONSerializer } from '../serializers/nats-json.serializer';
import { NatsJSONServerDeserializer } from '../deserializers/nats-json-server.deserializer';
import { createHash } from 'crypto';
import { NatsServerConnectionOptions } from '../interfaces/nats-server-configuration.interface';
import {
  NakStrategy,
  NatsEventOptions,
} from '../interfaces/nats-event-options.interface';
import {
  DEFAULT_MAX_NAK_DELAY,
  DEFAULT_NAK_DELAY,
  NAK,
  TERM,
} from '../constants';

/**
 * @publicApi
 */
export class ServerNats
  extends Server
  implements CustomTransportStrategy, OnModuleDestroy
{
  public readonly transportId = Transport.NATS;

  private natsClient: NatsConnection;
  private jetstreamClient: JetStreamClient;
  private jetstreamManager: JetStreamManager;

  protected readonly logger: Logger = new Logger(ServerNats.name);

  constructor(
    private readonly options: NatsServerConnectionOptions,
    private readonly streams?: Partial<StreamConfig>[],
  ) {
    super();

    this.initializeSerializer(options);
    this.initializeDeserializer(options);
  }

  public async listen(
    callback: (err?: unknown, ...optionalParams: unknown[]) => void,
  ) {
    try {
      this.natsClient = await this.createClient();
      if (this.options.useJetStream) {
        this.jetstreamClient = this.natsClient.jetstream();
        this.jetstreamManager = await this.natsClient.jetstreamManager(
          this.options.jetStreamOptions,
        );
        if (this.streams) {
          await this.setupStreams();
        }
      }
      this.handleStatusUpdates(this.natsClient);
      await this.start(callback);
    } catch (err) {
      callback(err);
    }
  }

  public createClient(): Promise<NatsConnection> {
    const options = this.options.connection || ({} as ConnectionOptions);
    return connect({
      servers: NATS_DEFAULT_URL,
      ...options,
    });
  }

  public async start(
    callback: (err?: unknown, ...optionalParams: unknown[]) => void,
  ) {
    if (this.options.useJetStream) {
      await this.bindJetStreamEvents();
    } else {
      this.bindEvents();
    }
    this.bindRequests();
    callback();
  }

  public async bindJetStreamEvents() {
    const eventHandlers = [...this.messageHandlers.entries()].filter(
      ([, handler]) => handler.isEventHandler,
    );

    const subscribe = async (
      channel: string,
      handler: MessageHandler<any, any, any>,
    ) => {
      const consumerName = this.buildConsumerName(channel);
      const eventOptions: NatsEventOptions = handler.extras || {};

      const consumerOptions = this.buildConsumerOptions(eventOptions);

      const stream = await this.getStream(channel);
      let consumer = await this.getConsumer(stream, consumerName);

      if (consumer) {
        await this.jetstreamManager.consumers.update(
          stream,
          consumerName,
          consumerOptions,
        );
      } else {
        await this.jetstreamManager.consumers.add(stream, {
          name: consumerName,
          durable_name: consumerName,
          deliver_group: this.options.consumerName,
          filter_subject: channel,
          ack_policy: AckPolicy.Explicit,
          deliver_policy: DeliverPolicy.New,
          replay_policy: ReplayPolicy.Instant,
          ...consumerOptions,
        });
        consumer = await this.getConsumer(stream, consumerName);
      }

      consumer.consume({
        callback: this.getJetStreamEventHandler(channel, handler).bind(this),
        ...(eventOptions.max_messages
          ? { max_messages: eventOptions.max_messages }
          : {}),
      });

      this.logger.log(`Subscribed to [${channel}] events`);
    };

    eventHandlers.forEach(
      async ([channel, handler]) => await subscribe(channel, handler),
    );
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
    return [
      this.options.consumerName,
      createHash('sha256').update(channel).digest('hex'),
    ].join('-');
  }

  public bindEvents() {
    const eventHandlers = [...this.messageHandlers.entries()].filter(
      ([, handler]) => handler.isEventHandler,
    );

    const subscribe = (
      channel: string,
      handler: MessageHandler<any, any, any>,
    ) => {
      this.natsClient.subscribe(channel, {
        queue: this.options.consumerName,
        callback: this.getEventHandler(channel, handler).bind(this),
      });

      this.logger.log(`Subscribed to [${channel}] events`);
    };

    eventHandlers.forEach(([channel, handler]) => subscribe(channel, handler));
  }

  public bindRequests() {
    const requestHandlers = [...this.messageHandlers.entries()].filter(
      ([, handler]) => !handler.isEventHandler,
    );

    const subscribe = (
      channel: string,
      handler: MessageHandler<any, any, any>,
    ) => {
      this.natsClient.subscribe(channel, {
        queue: channel,
        callback: this.getRequestHandler(channel, handler).bind(this),
      });

      this.logger.log(`Subscribed to [${channel}] requests`);
    };

    requestHandlers.forEach(([channel, handler]) =>
      subscribe(channel, handler),
    );
  }

  public async close() {
    await this.natsClient?.close();
    this.natsClient = null;
    this.jetstreamClient = null;
  }

  public async onModuleDestroy() {
    await this.close();
  }

  public getEventHandler(
    channel: string,
    handler: MessageHandler<any, any, any>,
  ): Function {
    return async (error: object | undefined, message: Msg) => {
      if (error) {
        return this.logger.error(error);
      }
      return this.handleNatsEvent(channel, message, handler);
    };
  }

  public getJetStreamEventHandler(
    channel: string,
    handler: MessageHandler<any, any, any>,
  ): Function {
    return async (message: JsMsg) => {
      return this.handleNatsJetStreamEvent(channel, message, handler);
    };
  }

  public getRequestHandler(
    channel: string,
    handler: MessageHandler<any, any, any>,
  ): Function {
    return async (error: object | undefined, message: Msg) => {
      if (error) {
        return this.logger.error(error);
      }
      return this.handleRequest(channel, message, handler);
    };
  }

  public async handleNatsEvent(
    channel: string,
    natsMsg: Msg,
    handler: MessageHandler<any, any, any>,
  ) {
    const callerSubject = natsMsg.subject;
    const rawMessage = natsMsg.data;
    const replyTo = natsMsg.reply;

    const natsCtx = new NatsContext([callerSubject, natsMsg.headers]);
    const message = await this.deserializer.deserialize(rawMessage, {
      channel,
      replyTo,
      headers: natsMsg.headers,
    });

    const response$ = this.transformToObservable(
      await handler(message.data, natsCtx),
    );

    const respond = async (response: WritePacket<any>) => {
      return;
    };

    this.send(response$, respond);
  }

  public async handleNatsJetStreamEvent(
    channel: string,
    natsMsg: JsMsg,
    handler: MessageHandler<any, any, any>,
  ) {
    try {
      natsMsg.working();

      const eventOptions: NatsEventOptions = handler.extras || {};

      const callerSubject = natsMsg.subject;
      const rawMessage = natsMsg.data;

      const natsCtx = new NatsContext([callerSubject, natsMsg.headers]);
      const message = await this.deserializer.deserialize(rawMessage, {
        channel,
        headers: natsMsg.headers,
      });

      const response$ = this.transformToObservable(
        await handler(message.data, natsCtx),
      );

      const respond = async (response: WritePacket<any>) => {
        const nak = () =>
          natsMsg.nak(this.calculateNakDelay(natsMsg, eventOptions));

        if (response.err) return nak();
        if (response.response === NAK) return nak();
        if (response.response === TERM) return natsMsg.term();

        return natsMsg.ack();
      };

      this.send(response$, respond);
    } catch (err) {
      this.logger.error(err, 'Incorrect event data');
      natsMsg.term('Incorrect event data');
    }
  }

  private calculateNakDelay(
    natsMsg: JsMsg,
    { nak_strategy, nak_delay, nak_delay_max }: NatsEventOptions,
  ) {
    const strategy: NakStrategy = nak_strategy || NakStrategy.regular;

    if (strategy == NakStrategy.regular) {
      return nak_delay || DEFAULT_NAK_DELAY;
    } else if (strategy == NakStrategy.increment) {
      const delay =
        natsMsg.info.redeliveryCount * (nak_delay || DEFAULT_NAK_DELAY);

      if (delay > nak_delay_max || DEFAULT_MAX_NAK_DELAY) {
        return nak_delay_max || DEFAULT_MAX_NAK_DELAY;
      } else {
        return delay;
      }
    }
  }

  public async handleRequest(
    channel: string,
    natsMsg: Msg,
    handler: MessageHandler<any, any, any>,
  ) {
    const callerSubject = natsMsg.subject;
    const rawMessage = natsMsg.data;
    const replyTo = natsMsg.reply;

    const natsCtx = new NatsContext([callerSubject, natsMsg.headers]);
    const incomingMessage: IncomingRequest =
      (await this.deserializer.deserialize(rawMessage, {
        channel,
        replyTo,
        headers: natsMsg.headers,
      })) as IncomingRequest;

    const response$ = this.transformToObservable(
      await handler(incomingMessage.data, natsCtx),
    );
    const respond = async (response: WritePacket<any>) => {
      const message: NatsRecord = await this.serializer.serialize(
        { id: incomingMessage.id, ...response },
        {},
      );
      natsMsg.respond(message.data, {
        ...(message.headers ? { headers: message.headers } : {}),
      });
    };

    this.send(response$, respond);
  }

  public async handleStatusUpdates(client: NatsConnection) {
    for await (const status of client.status()) {
      const data =
        status.data && isObject(status.data)
          ? JSON.stringify(status.data)
          : status.data;

      switch (status.type) {
        case 'error':
        case 'disconnect':
          this.logger.error(
            `NatsError: type: "${status.type}", data: "${data}".`,
          );
          break;

        case 'pingTimer':
          if (this.options.connection.debug) {
            this.logger.debug(
              `NatsStatus: type: "${status.type}", data: "${data}".`,
            );
          }
          break;

        default:
          this.logger.log(
            `NatsStatus: type: "${status.type}", data: "${data}".`,
          );
          break;
      }
    }
  }

  protected initializeSerializer(options: NatsServerConnectionOptions) {
    this.serializer = options?.serializer ?? new NatsJSONSerializer();
  }

  protected initializeDeserializer(options: NatsServerConnectionOptions) {
    this.deserializer =
      options?.deserializer ?? new NatsJSONServerDeserializer();
  }

  protected async setupStreams(): Promise<void> {
    const streams = await this.jetstreamManager.streams.list().next();
    const streamsConfig = this.streams;

    for (const streamConfig of streamsConfig) {
      const stream = streams.find(
        stream => stream.config.name === streamConfig.name,
      );

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
