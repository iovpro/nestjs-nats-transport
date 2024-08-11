import { Deserializer, Serializer } from '@nestjs/microservices';
import { ConnectionOptions } from 'nats';

/**
 * @publicApi
 */
export interface NatsClientConnectionOptions {
  connection: ConnectionOptions;
  serializer?: Serializer;
  deserializer?: Deserializer;
  useJetStream?: boolean;
}
