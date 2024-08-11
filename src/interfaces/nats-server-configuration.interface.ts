import { Deserializer, Serializer } from '@nestjs/microservices';
import { ConnectionOptions, JetStreamOptions } from 'nats';
import { NatsEventOptions } from './nats-event-options.interface';

/**
 * @publicApi
 */
export interface NatsServerConnectionOptions {
  consumerName: string;
  connection: ConnectionOptions;
  serializer?: Serializer;
  deserializer?: Deserializer;
  useJetStream?: boolean;
  jetStreamOptions?: JetStreamOptions;
  globalEventOptions?: Partial<NatsEventOptions>;
}
