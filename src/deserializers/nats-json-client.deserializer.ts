import { NatsCodec } from '@nestjs/microservices/external/nats-client.interface';
import { IncomingResponse } from '@nestjs/microservices/interfaces';
import { IncomingResponseDeserializer } from '@nestjs/microservices/deserializers';
import { JSONCodec } from 'nats';

/**
 * @publicApi
 */
export class NatsJSONClientDeserializer extends IncomingResponseDeserializer {
  private readonly jsonCodec: NatsCodec<unknown>;

  constructor() {
    super();
    this.jsonCodec = JSONCodec();
  }

  deserialize(
    value: Uint8Array,
    options?: Record<string, any>,
  ): IncomingResponse {
    const decodedRequest = this.jsonCodec.decode(value);
    return super.deserialize(decodedRequest, options);
  }
}
