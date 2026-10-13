// Code examples copied from README.md; DOC-01 type-checks this file against the library sources.
import { DeliverPolicy, RetentionPolicy, StorageType } from 'nats';
import {
  NakStrategy,
  NatsContext,
  NatsEventPattern,
  NatsMessagePattern,
  RequestContext,
  RequestId,
  REQUEST_ID_HEADER,
  ServerNats,
  toNs,
} from '../../src';
import { randomUUID } from 'crypto';
// README, "Returning Headers in Response"
import { NatsRecord, Payload, Ctx } from '@nestjs/microservices';

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

  // README, "@RequestId": decorator example
  @NatsMessagePattern('orders.create')
  async createOrder(@Payload() data: any, @RequestId() requestId: string | undefined) {
    void requestId;
    return data;
  }

  // README, "NatsContext": getTraceId example
  @NatsMessagePattern('order.get')
  async getOrder(@Payload() data: any, @Ctx() ctx: NatsContext) {
    const message = ctx.getMessage();
    const subject = ctx.getSubject();
    const hdrs = ctx.getHeaders();
    const traceId = ctx.getTraceId();
    const userId = hdrs?.get('user-id');
    void message;
    return { subject, traceId, userId };
  }
}

// README, "Request Context (traceId and requestId)": HTTP middleware and logger
export function requestContextExample() {
  const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
  function sanitizeRequestId(value: unknown): string | undefined {
    return typeof value === 'string' && REQUEST_ID_RE.test(value) ? value : undefined;
  }

  // HTTP entry point
  function traceMiddleware(req: any, _res: any, next: () => void) {
    RequestContext.run(
      {
        traceId: randomUUID(),
        requestId: sanitizeRequestId(req.headers[REQUEST_ID_HEADER]),
      },
      next,
    );
  }

  // Logger: read the context
  const logEntry: Record<string, unknown> = {};
  const ctx = RequestContext.get();
  if (ctx) {
    logEntry.traceId = ctx.traceId;
    if (ctx.requestId) logEntry.requestId = ctx.requestId;
  }

  void traceMiddleware;
  void logEntry;
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
