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
      Object.assign(this, {
        message: error.message || 'Unknown error',
        ...(error.errorCode ? { errorCode: error.errorCode } : {}),
        ...(error.statusCode || error?.status ? { statusCode: error.statusCode || error?.status } : {}),
        ...(error.errors ? { errors: error.errors } : {}),
      });
    } else {
      Object.assign(this, { message: 'Unknown error' });
    }
  }
}
