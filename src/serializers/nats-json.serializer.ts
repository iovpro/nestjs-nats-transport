import { isObject } from '@nestjs/common/utils/shared.utils';
import { NatsCodec } from '@nestjs/microservices/external/nats-client.interface';
import { ReadPacket } from '@nestjs/microservices/interfaces';
import { Serializer } from '@nestjs/microservices/interfaces/serializer.interface';
import {
  NatsRecord,
  NatsRecordBuilder,
} from '@nestjs/microservices/record-builders';
import { JSONCodec } from 'nats';

export class NatsJSONSerializer implements Serializer<ReadPacket, NatsRecord> {
  private readonly jsonCodec: NatsCodec<unknown>;

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
      headers: natsMessage.headers,
    };
  }
}
