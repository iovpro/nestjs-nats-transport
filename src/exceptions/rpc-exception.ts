import { HttpStatus } from '@nestjs/common';
import { NatsRpcExceptionInterface } from '../interfaces';
import { RpcException } from '@nestjs/microservices';

export type NatsRpcExceptionInput = Partial<NatsRpcExceptionInterface> | RpcException | Error | string;

/**
 * @publicApi
 */
export class NatsRpcException extends Error {
  name = 'NatsRpcException';
  message: string;
  errorCode?: string;
  statusCode?: HttpStatus;
  errors?: any;

  constructor(error: NatsRpcExceptionInput) {
    super();
    if (error instanceof NatsRpcException) {
      Object.assign(this, error);
    } else if (typeof error === 'string') {
      this.message = error;
    } else if (error && typeof error === 'object') {
      this.assignFromObject(error as unknown as Record<string, unknown>);
    } else {
      Object.assign(this, { message: 'Unknown error' });
    }
  }

  private assignFromObject(obj: Record<string, unknown>): void {
    // Unwrap nested error from RpcException serialization
    const source = (obj.error && typeof obj.error === 'object' ? obj.error : obj) as Record<string, unknown>;

    this.message = String(source.message || 'Unknown error');
    if (source.errorCode) this.errorCode = source.errorCode as string;
    if (source.statusCode || source.status) this.statusCode = (source.statusCode || source.status) as HttpStatus;
    if (source.errors) this.errors = source.errors;
  }
}
