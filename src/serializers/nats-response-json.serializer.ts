import { isObject } from '@nestjs/common/utils/shared.utils';
import { NatsCodec } from '@nestjs/microservices/external/nats-client.interface';
import { WritePacket } from '@nestjs/microservices/interfaces';
import { Serializer } from '@nestjs/microservices/interfaces/serializer.interface';
import { NatsRecord, NatsRecordBuilder } from '@nestjs/microservices/record-builders';
import { JSONCodec } from 'nats';

export class NatsResponseSerializer implements Serializer<WritePacket, NatsRecord> {
  private readonly jsonCodec: NatsCodec<unknown>;

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
