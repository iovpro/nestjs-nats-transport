import { HttpStatus } from '@nestjs/common';
import { NatsRpcExceptionInterface } from 'src/interfaces/nats-rpc-exception.interface';

/**
 * @publicApi
 */
export class NatsRpcException extends Error {
  name = 'NatsRpcException';
  code?: string;
  message: string;
  statusCode?: HttpStatus;
  errors?: any;

  constructor(errOrMessage: NatsRpcExceptionInterface | string | any) {
    super();
    if (errOrMessage instanceof NatsRpcException) {
      Object.assign(this, errOrMessage);
    } else if (typeof errOrMessage === 'string') {
      this.message = errOrMessage;
    } else {
      const err = errOrMessage.error || errOrMessage.err || errOrMessage;

      let error: Partial<NatsRpcExceptionInterface> = {};

      error.code = err?.code || undefined;
      error.statusCode = err?.statusCode || err?.status || undefined;
      error.message = err?.message || err?.err || 'Undefined error';
      error.errors = err?.errors || undefined;

      Object.assign(this, {
        message: error.message,
        ...(error.code ? { code: error.code } : {}),
        ...(error.statusCode ? { statusCode: error.statusCode } : {}),
        ...(error.errors ? { errors: error.errors } : {}),
      });
    }
  }
}
