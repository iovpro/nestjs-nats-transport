import { Logger } from '@nestjs/common/services/logger.service';
import { OnModuleDestroy } from '@nestjs/common';
import { isObject } from '@nestjs/common/utils/shared.utils';
import { NATS_DEFAULT_URL } from '@nestjs/microservices/constants';
import { ClientProxy, NatsRecord, NatsRecordBuilder, ReadPacket, WritePacket } from '@nestjs/microservices';
import {
  JetStreamClient,
  NatsConnection,
  connect,
  ConnectionOptions,
  MsgHdrs,
  headers as natsMsgHeaders,
  MsgHdrsImpl,
} from 'nats';
import { NatsClientConnectionOptions } from '../interfaces';
import { NatsRequestSerializer } from '../serializers';
import { NatsResponseJSONDeserializer } from '../deserializers';
import { Observable, ReplaySubject, distinctUntilChanged, firstValueFrom } from 'rxjs';
import { EventEmitter } from 'events';
import { NatsRpcException } from '../exceptions/rpc-exception';
import { addStatusListener, closeConnection, watchStatus } from '../connection/nats-connection';

/**
 * @publicApi
 */
export class ClientNats extends ClientProxy implements OnModuleDestroy {
  protected readonly logger;
  protected readonly timeout: number;

  protected natsClient: NatsConnection;
  protected jetstreamClient: JetStreamClient;
  private connectionPromise: Promise<NatsConnection>;
  private closePromise: Promise<void>;
  protected _status$ = new ReplaySubject<string>(1);
  private readonly statusEventEmitter = new EventEmitter();

  constructor(protected readonly options: NatsClientConnectionOptions) {
    super();
    this.logger = new Logger(this.constructor.name);
    this.timeout = options.requestTimeout || 30000;

    this.initializeSerializer(options);
    this.initializeDeserializer(options);
  }

  public close() {
    // close() called again while the close runs waits for the same close
    this.closePromise ??= this.disconnect().finally(() => (this.closePromise = undefined));
    return this.closePromise;
  }

  private async disconnect() {
    if (!this.natsClient) return;

    await closeConnection(this.natsClient, this.logger, 'client');
    this.natsClient = undefined;
    this.jetstreamClient = undefined;
    this.statusEventEmitter.removeAllListeners();
    this.logger.log('Nats client disconnected');
  }

  async onModuleDestroy() {
    await this.close();
  }

  public async connect(): Promise<any> {
    if (this.natsClient && !this.natsClient.isClosed()) {
      return this.natsClient;
    }
    this.connectionPromise ??= this.openConnection().finally(() => (this.connectionPromise = undefined));
    return this.connectionPromise;
  }

  private async openConnection(): Promise<NatsConnection> {
    this.natsClient = await this.createClient();
    this._status$.next('connected');
    if (this.options.jetStream) {
      this.jetstreamClient = this.createJetStreamClient();
    }
    this.handleStatusUpdates(this.natsClient);

    this.logger.log(
      `Nats client connected to "${this.natsClient.getServer()}" server id "${this.natsClient.info.server_id}"`,
    );

    return this.natsClient;
  }

  private createClient(): Promise<NatsConnection> {
    const options = this.options.connection || ({} as ConnectionOptions);
    return connect({
      servers: NATS_DEFAULT_URL,
      maxReconnectAttempts: -1,
      ...options,
    });
  }

  private createJetStreamClient(): JetStreamClient {
    return this.natsClient.jetstream();
  }

  public getClient(): NatsConnection | undefined {
    return this.natsClient;
  }

  public getJetStreamClient(): JetStreamClient | undefined {
    return this.jetstreamClient;
  }

  public unwrap<T>(): T {
    if (!this.natsClient) {
      throw new Error('Not initialized. Please call the "connect" method first.');
    }
    return this.natsClient as T;
  }

  public get status(): Observable<string> {
    return this._status$.asObservable().pipe(distinctUntilChanged());
  }

  public on(event: string, callback: Function) {
    addStatusListener(this.statusEventEmitter, this.logger, event, callback);
  }

  public handleStatusUpdates(client: NatsConnection) {
    return watchStatus(client, this._status$, this.statusEventEmitter, this.logger, this.options.connection?.debug);
  }

  private prepareSubjectPattern(pattern: any) {
    if (Array.isArray(pattern)) {
      return pattern.join('.');
    } else return pattern;
  }

  protected publish(packet: ReadPacket, callback: (packet: WritePacket) => any): () => void {
    try {
      if (!this.natsClient) throw new Error('Nats client is not connected');
      packet = this.assignPacketId(packet);
      packet = this.preparePacketHeaders(packet);
      packet.pattern = this.prepareSubjectPattern(packet.pattern);

      const channel = this.normalizePattern(packet.pattern);
      const serializedPacket: NatsRecord<any, MsgHdrs> = this.serializer.serialize(packet);
      const headers = serializedPacket.headers || natsMsgHeaders();

      this.natsClient
        .request(channel, serializedPacket.data, {
          headers,
          timeout: this.timeout,
        })
        .then(
          async response$ =>
            (await this.deserializer.deserialize(response$.data, {
              channel,
            })) as WritePacket,
        )
        .then(packet => {
          callback(packet);
        })
        .catch(err => {
          callback({ err });
        });
    } catch (err) {
      callback({ err });
    }
    return;
  }

  protected async dispatchEvent(packet: ReadPacket): Promise<any> {
    if (!this.natsClient) throw new Error('Nats client is not connected');
    packet = this.preparePacketHeaders(packet);
    packet.pattern = this.prepareSubjectPattern(packet.pattern);

    const pattern = this.normalizePattern(packet.pattern);
    const serializedPacket: NatsRecord = this.serializer.serialize(packet);
    const headers = serializedPacket.headers || natsMsgHeaders();

    return new Promise<void>(async (resolve, reject) => {
      try {
        if (this.options.jetStream) {
          await this.jetstreamClient.publish(pattern, serializedPacket.data, {
            headers,
          });
        } else {
          this.natsClient.publish(pattern, serializedPacket.data, {
            headers,
          });
        }
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  }

  public async event<TInput = any>(
    pattern: string | string[],
    data: TInput,
    headers?: Record<string, any>,
  ): Promise<void> {
    const record = this.prepareRecord(data, headers);
    await firstValueFrom(super.emit<string | string[], TInput | NatsRecord>(pattern, record));
  }

  public async request<TResult = any, TInput = any>(
    pattern: string | string[],
    data: TInput,
    headers?: Record<string, any>,
  ): Promise<TResult> {
    const record = this.prepareRecord(data, headers);

    const plain = await firstValueFrom(this.send<TResult, TInput>(pattern, record)).catch(err => {
      throw new NatsRpcException(err);
    });
    return plain as TResult;
  }

  protected initializeSerializer(options: NatsClientConnectionOptions) {
    this.serializer = options?.serializer ?? new NatsRequestSerializer();
  }

  protected initializeDeserializer(options: NatsClientConnectionOptions) {
    this.deserializer = options?.deserializer ?? new NatsResponseJSONDeserializer();
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

  private preparePacketHeaders(packet: ReadPacket): ReadPacket {
    if (!packet?.data || !(packet.data instanceof NatsRecord)) return packet;
    const record =
      packet?.data && isObject(packet.data) && packet.data instanceof NatsRecord
        ? (packet.data as NatsRecord)
        : new NatsRecordBuilder(packet?.data).build();

    if (record.headers && record.headers instanceof MsgHdrsImpl) {
      return packet;
    } else if (record.headers) {
      return { ...packet, data: this.prepareRecord(record.data, record.headers) };
    } else {
      return packet;
    }
  }
}
