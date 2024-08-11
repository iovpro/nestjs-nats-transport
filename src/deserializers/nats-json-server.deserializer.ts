import { NatsCodec } from '@nestjs/microservices/external/nats-client.interface';
import {
  IncomingEvent,
  IncomingRequest,
} from '@nestjs/microservices/interfaces';
import { IncomingRequestDeserializer } from '@nestjs/microservices/deserializers';
import { JSONCodec } from 'nats';

/**
 * @publicApi
 */
export class NatsJSONServerDeserializer extends IncomingRequestDeserializer {
  private readonly jsonCodec: NatsCodec<unknown>;

  constructor() {
    super();
    this.jsonCodec = JSONCodec();
  }

  deserialize(
    value: Uint8Array,
    options?: Record<string, any>,
  ): IncomingRequest | IncomingEvent {
    const decodedRequest = this.jsonCodec.decode(value);
    return super.deserialize(decodedRequest, options);
  }
}
