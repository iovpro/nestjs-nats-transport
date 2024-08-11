import { Logger } from '@nestjs/common/services/logger.service';
import { isObject } from '@nestjs/common/utils/shared.utils';
import { OnModuleDestroy } from '@nestjs/common/interfaces/hooks';
import { NATS_DEFAULT_URL } from '@nestjs/microservices/constants';
import {
  ClientProxy,
  NatsRecord,
  ReadPacket,
  WritePacket,
} from '@nestjs/microservices';
import {
  JetStreamClient,
  NatsConnection,
  connect,
  ConnectionOptions,
} from 'nats';
import { NatsClientConnectionOptions } from '../interfaces/nats-client-configuration.interface';
import { NatsJSONSerializer } from '../serializers/nats-json.serializer';
import { NatsJSONClientDeserializer } from '../deserializers/nats-json-client.deserializer';
import { firstValueFrom } from 'rxjs';
import { NatsRpcException } from '../exceptions/rpc-exception';

/**
 * @publicApi
 */
export class ClientNats extends ClientProxy implements OnModuleDestroy {
  protected readonly logger = new Logger(ClientNats.name);

  protected natsClient: NatsConnection;
  protected jetstreamClient: JetStreamClient;

  constructor(protected readonly options: NatsClientConnectionOptions) {
    super();

    this.initializeSerializer(options);
    this.initializeDeserializer(options);
  }

  public async close() {
    await this.natsClient?.close();
    this.natsClient = undefined;
    this.jetstreamClient = undefined;
  }

  async onModuleDestroy() {
    await this.close();
  }

  public async connect(): Promise<any> {
    if (this.natsClient) {
      return this.natsClient;
    }
    this.natsClient = await this.createClient();
    if (this.options.useJetStream) {
      this.jetstreamClient = this.natsClient.jetstream();
    }
    this.handleStatusUpdates(this.natsClient);
    return this.natsClient;
  }

  public createClient(): Promise<NatsConnection> {
    const options = this.options.connection || ({} as ConnectionOptions);
    return connect({
      servers: NATS_DEFAULT_URL,
      ...options,
    });
  }

  getClient(): NatsConnection | undefined {
    return this.natsClient;
  }

  getJetStreamClient(): JetStreamClient | undefined {
    return this.jetstreamClient;
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

  private preparePattern(pattern: any) {
    if (Array.isArray(pattern)) {
      return pattern.join('.');
    } else return pattern;
  }

  protected publish(
    partialPacket: ReadPacket,
    callback: (packet: WritePacket) => any,
  ): () => void {
    try {
      const packet = this.assignPacketId(partialPacket);
      const channel = this.normalizePattern(
        this.preparePattern(partialPacket.pattern),
      );
      const serializedPacket: NatsRecord = this.serializer.serialize(packet);

      const headers = this.mergeHeaders(serializedPacket.headers);
      this.natsClient
        .request(channel, serializedPacket.data, {
          headers,
          timeout: 30000,
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
    const pattern = this.normalizePattern(packet.pattern);
    const serializedPacket: NatsRecord = this.serializer.serialize(packet);
    const headers = this.mergeHeaders(serializedPacket.headers);

    return new Promise<void>(async (resolve, reject) => {
      try {
        if (this.options.useJetStream) {
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

  public async event<TInput = any>(pattern: any, data: TInput): Promise<void> {
    await firstValueFrom(super.emit<any, TInput>(pattern, data));
  }

  public async request<TResult = any, TInput = any>(
    pattern: any,
    data: any,
  ): Promise<TResult> {
    const plain = await firstValueFrom(
      this.send<TResult, TInput>(pattern, data),
    ).catch(err => {
      if (err.code === '503') {
        throw new NatsRpcException({
          statusCode: Number(err.code),
          code: 'SERVICE_UNAVAILABLE',
          message: 'Service unavailable',
        });
      }
      throw new NatsRpcException(err);
    });
    return plain as TResult;
  }

  protected initializeSerializer(options: NatsClientConnectionOptions) {
    this.serializer = options?.serializer ?? new NatsJSONSerializer();
  }

  protected initializeDeserializer(options: NatsClientConnectionOptions) {
    this.deserializer =
      options?.deserializer ?? new NatsJSONClientDeserializer();
  }

  protected mergeHeaders<THeaders = any>(requestHeaders?: THeaders) {
    return requestHeaders;
  }
}
