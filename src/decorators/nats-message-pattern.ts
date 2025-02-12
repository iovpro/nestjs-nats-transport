import { applyDecorators, UseInterceptors, Type } from '@nestjs/common';
import { MessagePattern, Transport } from '@nestjs/microservices';
import { NatsRpcExceptionInterceptor } from '../exceptions';

export const NatsMessagePattern: {
  (metadata?: string | string[]): MethodDecorator;
  (metadata?: string | string[], extras?: Record<string, any>): MethodDecorator;
} = (metadata?: string | string[], extras?: Record<string, any>): MethodDecorator => {
  return applyDecorators(
    UseInterceptors(NatsRpcExceptionInterceptor),
    MessagePattern(Array.isArray(metadata) ? metadata.join('.') : metadata, Transport.NATS, extras),
  );
};
