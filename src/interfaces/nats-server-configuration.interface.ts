import { Deserializer, Serializer } from '@nestjs/microservices';
import { ConnectionOptions, JetStreamOptions } from 'nats';
import { NatsEventHandlerOptions } from './nats-event-options.interface';

/**
 * @publicApi
 */
export interface NatsServerConnectionOptions {
  consumerName: string;
  connection: ConnectionOptions;
  serializer?: Serializer;
  deserializer?: Deserializer;
  jetStream?: boolean;
  jetStreamOptions?: JetStreamOptions;
  globalEventOptions?: Partial<NatsEventHandlerOptions>;
}
