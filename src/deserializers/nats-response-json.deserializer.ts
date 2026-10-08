import { IncomingResponseDeserializer } from '@nestjs/microservices/deserializers/incoming-response.deserializer';
import { Codec, JSONCodec } from 'nats';

/**
 * @publicApi
 */
export class NatsResponseJSONDeserializer extends IncomingResponseDeserializer {
  private readonly jsonCodec: Codec<unknown>;

  constructor() {
    super();
    this.jsonCodec = JSONCodec();
  }

  deserialize(value: Uint8Array, options?: Record<string, any>) {
    const decodedRequest = this.jsonCodec.decode(value);
    return super.deserialize(decodedRequest, options);
  }
}
