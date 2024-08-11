import { applyDecorators, UseInterceptors } from '@nestjs/common';
import { EventPattern, Transport } from '@nestjs/microservices';
import { NatsEventOptions } from '../interfaces/nats-event-options.interface';
import { NatsRpcExceptionInterceptor } from '../exceptions/rpc-exception.interceptor';

export const NatsEventPattern: {
  (metadata?: string | string[]): MethodDecorator;
  (metadata?: string | string[], extras?: NatsEventOptions): MethodDecorator;
} = (
  metadata?: string | string[],
  extras?: Record<string, any>,
): MethodDecorator => {
  return applyDecorators(
    UseInterceptors(NatsRpcExceptionInterceptor),
    EventPattern(
      Array.isArray(metadata) ? metadata.join('.') : metadata,
      Transport.NATS,
      extras,
    ),
  );
};
