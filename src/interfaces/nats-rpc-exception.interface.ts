import { HttpStatus } from '@nestjs/common';

/**
 * @publicApi
 */
export interface NatsRpcExceptionInterface {
  code?: string;
  message: string;
  statusCode?: HttpStatus;
  errors?: any;
}
