import { RequestContext, runOutsideRequestContext } from './request-context';

describe('RequestContext', () => {
  it('UT-102 run/get should store and retrieve context, survive await, and restore outer context', async () => {
    expect(RequestContext.get()).toBeUndefined();
    expect(RequestContext.getTraceId()).toBeUndefined();
    expect(RequestContext.getRequestId()).toBeUndefined();

    await RequestContext.run({ traceId: 'outer', requestId: 'R-outer' }, async () => {
      expect(RequestContext.get()).toEqual({ traceId: 'outer', requestId: 'R-outer' });
      expect(RequestContext.getTraceId()).toBe('outer');
      expect(RequestContext.getRequestId()).toBe('R-outer');

      await new Promise(resolve => setImmediate(resolve));
      expect(RequestContext.getTraceId()).toBe('outer');

      await RequestContext.run({ traceId: 'inner' }, async () => {
        expect(RequestContext.getTraceId()).toBe('inner');
        expect(RequestContext.getRequestId()).toBeUndefined();
      });

      expect(RequestContext.getTraceId()).toBe('outer');
      expect(RequestContext.getRequestId()).toBe('R-outer');
    });

    expect(RequestContext.get()).toBeUndefined();
  });

  it('UT-103 shared storage: a second copy of the module sees the same store', async () => {
    let secondRequestContext: typeof RequestContext;

    jest.isolateModules(() => {
      secondRequestContext = require('./request-context').RequestContext;
    });

    await RequestContext.run({ traceId: 'A' }, async () => {
      expect(secondRequestContext!.getTraceId()).toBe('A');
    });

    await secondRequestContext!.run({ traceId: 'B' }, async () => {
      expect(RequestContext.getTraceId()).toBe('B');
    });
  });

  it('UT-104 runOutsideRequestContext should exit context and restore it after', async () => {
    await RequestContext.run({ traceId: 'A' }, async () => {
      const result = await runOutsideRequestContext(async () => {
        expect(RequestContext.get()).toBeUndefined();
        await new Promise(resolve => setImmediate(resolve));
        expect(RequestContext.get()).toBeUndefined();
        return 'done';
      });
      expect(result).toBe('done');

      expect(RequestContext.getTraceId()).toBe('A');
      await new Promise(resolve => setImmediate(resolve));
      expect(RequestContext.getTraceId()).toBe('A');
    });
  });
});
