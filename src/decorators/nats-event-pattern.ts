import { applyDecorators, UseInterceptors } from '@nestjs/common';
import { EventPattern, Transport } from '@nestjs/microservices';
import { NatsEventHandlerOptions } from '../interfaces';
import { NatsRpcExceptionInterceptor } from '../exceptions';

export const NatsEventPattern: {
  (metadata?: string | string[]): MethodDecorator;
  (metadata?: string | string[], extras?: NatsEventHandlerOptions): MethodDecorator;
} = (metadata?: string | string[], extras?: Record<string, any>): MethodDecorator => {
  return applyDecorators(
    UseInterceptors(NatsRpcExceptionInterceptor),
    EventPattern(Array.isArray(metadata) ? metadata.join('.') : metadata, Transport.NATS, extras),
  );
};
