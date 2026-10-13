import { headers as natsMsgHeaders } from 'nats';
import { RequestContext } from '../context';
import { NatsContext } from './nats.context';

const fakeMsg = (hdrs?: ReturnType<typeof natsMsgHeaders>) => ({ subject: 'test', headers: hdrs }) as any;

describe('NatsContext tracing methods', () => {
  it.each([
    {
      name: 'context present — value from context, even if header differs',
      ctx: { traceId: 'CTX-T', requestId: 'CTX-R' },
      headerTrace: 'HDR-T',
      headerRequest: 'HDR-R',
      expectedTrace: 'CTX-T',
      expectedRequest: 'CTX-R',
    },
    {
      name: 'no context, header present (different case) — value from header',
      ctx: undefined,
      headerTrace: 'HDR-T',
      headerRequest: 'HDR-R',
      expectedTrace: 'HDR-T',
      expectedRequest: 'HDR-R',
    },
    {
      name: 'headers exist but trace/request not set — undefined (not empty string)',
      ctx: undefined,
      headerTrace: undefined,
      headerRequest: undefined,
      expectedTrace: undefined,
      expectedRequest: undefined,
    },
    {
      name: 'no headers at all — undefined',
      ctx: undefined,
      headerTrace: null, // signals: no headers object
      headerRequest: null,
      expectedTrace: undefined,
      expectedRequest: undefined,
    },
  ])(
    'UT-116 getTraceId/getRequestId: $name',
    async ({ ctx, headerTrace, headerRequest, expectedTrace, expectedRequest }) => {
      let hdrs: ReturnType<typeof natsMsgHeaders> | undefined;
      if (headerTrace !== null) {
        hdrs = natsMsgHeaders();
        if (headerTrace) hdrs.set('X-Trace-Id', headerTrace);
        if (headerRequest) hdrs.set('X-Request-Id', headerRequest);
      }
      const natsCtx = new NatsContext([fakeMsg(hdrs)]);

      const run = () => {
        expect(natsCtx.getTraceId()).toBe(expectedTrace);
        expect(natsCtx.getRequestId()).toBe(expectedRequest);
      };

      if (ctx) {
        await RequestContext.run(ctx, run);
      } else {
        run();
      }
    },
  );
});
