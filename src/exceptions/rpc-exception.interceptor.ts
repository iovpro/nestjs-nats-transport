import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
  HttpStatus,
} from '@nestjs/common';
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
        return throwError(() => new RpcException(new NatsRpcException(err)));
      }),
    );
  }

  logException(context: ExecutionContext, err: any) {
    const controller = context.getClass();
    const handler = context.getHandler();
    const logger = new Logger(
      controller?.name
        ? controller?.name + '.' + handler?.name
        : 'NatsRpcExceptionsHandler',
    );

    const statusCode: HttpStatus =
      (err.error || err.err || err)?.statusCode ||
      (err.error || err.err || err)?.status;

    if (!statusCode || statusCode >= 500) {
      logger.error(err);
    } else if (statusCode < 500) {
      logger.debug(err);
    }
  }
}
