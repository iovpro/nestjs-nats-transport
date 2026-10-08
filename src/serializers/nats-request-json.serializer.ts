import { isObject } from '@nestjs/common/utils/shared.utils';
import { NatsRecord, NatsRecordBuilder, ReadPacket } from '@nestjs/microservices';
import { Serializer } from '@nestjs/microservices/interfaces/serializer.interface';
import { Codec, JSONCodec } from 'nats';

export class NatsRequestSerializer implements Serializer<ReadPacket, NatsRecord> {
  private readonly jsonCodec: Codec<unknown>;

  constructor() {
    this.jsonCodec = JSONCodec();
  }

  serialize(packet: ReadPacket | any): NatsRecord {
    const natsMessage =
      packet?.data && isObject(packet.data) && packet.data instanceof NatsRecord
        ? (packet.data as NatsRecord)
        : new NatsRecordBuilder(packet?.data).build();

    return {
      data: this.jsonCodec.encode({ ...packet, data: natsMessage.data }),
      headers: natsMessage.headers || undefined,
    };
  }
}
