import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { RequestContext } from '../context';
import { NatsContext } from '../ctx-host/nats.context';

/**
 * Parameter decorator that extracts the request ID.
 * - HTTP: reads from RequestContext (set by middleware)
 * - RPC: reads from NatsContext headers
 */
export const RequestId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string | undefined => {
  if (ctx.getType() === 'rpc') {
    const rpcCtx = ctx.switchToRpc().getContext<NatsContext>();
    return rpcCtx?.getRequestId?.();
  }
  return RequestContext.getRequestId();
});
