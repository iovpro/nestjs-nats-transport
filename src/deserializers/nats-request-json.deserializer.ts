import { IncomingRequestDeserializer } from '@nestjs/microservices/deserializers/incoming-request.deserializer';
import { Codec, JSONCodec } from 'nats';

/**
 * @publicApi
 */
export class NatsRequestJSONDeserializer extends IncomingRequestDeserializer {
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
