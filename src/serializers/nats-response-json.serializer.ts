import { NatsCodec } from '@nestjs/microservices/external/nats-client.interface';
import { WritePacket } from '@nestjs/microservices/interfaces';
import { Serializer } from '@nestjs/microservices/interfaces/serializer.interface';
import { NatsRecord } from '@nestjs/microservices/record-builders';
import { JSONCodec } from 'nats';

export class NatsResponseSerializer implements Serializer<WritePacket, NatsRecord> {
  private readonly jsonCodec: NatsCodec<unknown>;

  constructor() {
    this.jsonCodec = JSONCodec();
  }

  serialize(packet: WritePacket): NatsRecord {
    return {
      data: this.jsonCodec.encode(packet),
      headers: undefined,
    };
  }
}
