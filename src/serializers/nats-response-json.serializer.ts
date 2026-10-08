import { isObject } from '@nestjs/common/utils/shared.utils';
import { NatsRecord, NatsRecordBuilder, WritePacket } from '@nestjs/microservices';
import { Serializer } from '@nestjs/microservices/interfaces/serializer.interface';
import { Codec, JSONCodec } from 'nats';

export class NatsResponseSerializer implements Serializer<WritePacket, NatsRecord> {
  private readonly jsonCodec: Codec<unknown>;

  constructor() {
    this.jsonCodec = JSONCodec();
  }

  serialize(packet: WritePacket): NatsRecord {
    const natsMessage =
      packet?.response && isObject(packet.response) && packet.response instanceof NatsRecord
        ? (packet.response as NatsRecord)
        : new NatsRecordBuilder(packet?.response).build();

    return {
      data: this.jsonCodec.encode({ ...packet, response: natsMessage.data }),
      headers: natsMessage.headers || undefined,
    };
  }
}
