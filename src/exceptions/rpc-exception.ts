import { HttpStatus } from '@nestjs/common';
import { NatsRpcExceptionInterface } from '../interfaces';

/**
 * @publicApi
 */
export class NatsRpcException extends Error {
  name = 'NatsRpcException';
  message: string;
  errorCode?: string;
  statusCode?: HttpStatus;
  errors?: any;

  constructor(error: NatsRpcExceptionInterface | string | any) {
    super();
    if (error instanceof NatsRpcException) {
      Object.assign(this, error);
    } else if (typeof error === 'string') {
      this.message = error;
    } else if (error && typeof error === 'object') {
      // Unwrap nested error from RpcException serialization
      const source = error.error && typeof error.error === 'object' ? error.error : error;

      Object.assign(this, {
        message: source.message || 'Unknown error',
        ...(source.errorCode ? { errorCode: source.errorCode } : {}),
        ...(source.statusCode || source?.status ? { statusCode: source.statusCode || source?.status } : {}),
        ...(source.errors ? { errors: source.errors } : {}),
      });
    } else {
      Object.assign(this, { message: 'Unknown error' });
    }
  }
}
