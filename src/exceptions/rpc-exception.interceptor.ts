import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger, HttpStatus } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { RpcException } from '@nestjs/microservices';
import { NatsRpcException } from './rpc-exception';

/**
 * @publicApi
 */
@Injectable()
export class NatsRpcExceptionInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      catchError(err => {
        if (context.getType() !== 'rpc') return throwError(() => err);
        this.logException(context, err);
        const natsException = err instanceof NatsRpcException ? err : new NatsRpcException(err);
        return throwError(() => new RpcException(natsException));
      }),
    );
  }

  logException(context: ExecutionContext, err: any) {
    const controller = context.getClass();
    const handler = context.getHandler();
    const logger = new Logger(controller?.name ? controller?.name + '.' + handler?.name : 'NatsRpcExceptionsHandler');

    const statusCode: HttpStatus = err?.statusCode || err?.status;

    if (!statusCode || (statusCode >= 500 && statusCode < 600)) {
      logger.error(err);
    } else {
      logger.debug(err);
    }
  }
}
