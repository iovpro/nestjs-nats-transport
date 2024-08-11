import { throwError } from 'rxjs';
import { ArgumentsHost } from '@nestjs/common/interfaces/features/arguments-host.interface';
import { Catch } from '@nestjs/common';
import { BaseRpcExceptionFilter, RpcException } from '@nestjs/microservices';

/**
 * @publicApi
 */
@Catch(RpcException)
export class NatsRpcExceptionFilter extends BaseRpcExceptionFilter {
  catch(exception: RpcException, host: ArgumentsHost) {
    return throwError(() => exception);
  }
}
