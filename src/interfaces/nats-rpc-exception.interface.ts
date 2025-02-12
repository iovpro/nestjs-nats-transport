import { HttpStatus } from '@nestjs/common';

/**
 * @publicApi
 */
export interface NatsRpcExceptionInterface {
  message: string;
  errorCode?: string;
  statusCode?: HttpStatus;
  errors?: any;
}
