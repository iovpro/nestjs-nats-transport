import 'reflect-metadata';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { headers as natsMsgHeaders } from 'nats';
import { RequestContext } from '../context';
import { NatsContext } from '../ctx-host/nats.context';
import { RequestId } from './request-id.decorator';

class TestClass {
  handler(@RequestId() _requestId: string | undefined) {}
}

function getDecoratorFactory() {
  const metadata = Reflect.getMetadata(ROUTE_ARGS_METADATA, TestClass, 'handler');
  const key = Object.keys(metadata)[0];
  return metadata[key].factory;
}

function fakeExecutionContext(type: string, rpcContext?: any) {
  return {
    getType: () => type,
    switchToRpc: () => ({
      getContext: () => rpcContext,
    }),
    switchToHttp: () => ({
      getRequest: () => ({}),
    }),
  };
}

describe('@RequestId()', () => {
  const factory = getDecoratorFactory();

  it('UT-117 RPC with NatsContext and x-request-id header — returns header value', () => {
    const hdrs = natsMsgHeaders();
    hdrs.set('x-request-id', 'R');
    const ctx = new NatsContext([{ subject: 'test', headers: hdrs } as any]);
    const execCtx = fakeExecutionContext('rpc', ctx);

    expect(factory(undefined, execCtx)).toBe('R');
  });

  it('UT-117 RPC with context without getRequestId — returns undefined', () => {
    const execCtx = fakeExecutionContext('rpc', {});
    expect(factory(undefined, execCtx)).toBeUndefined();
  });

  it('UT-117 HTTP inside RequestContext — returns requestId from context', () => {
    const execCtx = fakeExecutionContext('http');
    RequestContext.run({ traceId: 'T', requestId: 'H' }, () => {
      expect(factory(undefined, execCtx)).toBe('H');
    });
  });

  it('UT-117 HTTP outside RequestContext — returns undefined', () => {
    const execCtx = fakeExecutionContext('http');
    expect(factory(undefined, execCtx)).toBeUndefined();
  });
});
