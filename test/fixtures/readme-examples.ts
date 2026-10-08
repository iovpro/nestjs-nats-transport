// Code examples copied from README.md; DOC-01 type-checks this file against the library sources.
import { DeliverPolicy, RetentionPolicy, StorageType } from 'nats';
import { NakStrategy, NatsEventPattern, ServerNats, toNs } from '../../src';
// README, "Returning Headers in Response"
import { NatsRecord } from '@nestjs/microservices';

export class ReadmeExamples {
  // README, "Durable consumer for scaling"
  @NatsEventPattern('orders.processing', { deliver_policy: DeliverPolicy.All, max_handlers: 10 })
  durable() {}

  // README, "Processing from specific sequence"
  @NatsEventPattern('orders.replay', { deliver_policy: DeliverPolicy.StartSequence, opt_start_seq: 1000 })
  replay() {}

  // README, "Deliver Policies": from specific timestamp
  @NatsEventPattern('orders.since-timestamp', {
    deliver_policy: DeliverPolicy.StartTime,
    opt_start_time: '2024-01-01T00:00:00Z',
  })
  sinceTimestamp() {}

  // README, "NAK Strategies": enum value
  @NatsEventPattern('orders.process', { nak_strategy: NakStrategy.increment, nak_delay: 1000 })
  withEnum() {}

  // README, "toNs": usage examples
  @NatsEventPattern('orders.process', { ack_wait: toNs(30, 's'), inactive_threshold: toNs(1, 'h') })
  withNanoseconds() {}

  headers(order: { id: string }) {
    return new NatsRecord(order, { 'cache-control': 'max-age=3600' });
  }
}

export async function setupStreamsExample() {
  // README, "Setting up JetStream Streams"
  const streams = [
    { name: 'ORDERS', subjects: ['orders.*'], retention: RetentionPolicy.Limits, storage: StorageType.File },
    { name: 'USERS', subjects: ['users.*'], retention: RetentionPolicy.Interest, max_age: 3600_000_000_000 },
  ];

  const serverNats = new ServerNats(
    {
      consumerName: 'order-service',
      connection: { servers: ['nats://localhost:4222'] },
      jetStream: true,
    },
    streams,
  );
}
