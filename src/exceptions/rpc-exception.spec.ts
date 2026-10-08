import { HttpStatus } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { NatsRpcException } from './rpc-exception';

const fields = (e: NatsRpcException) => ({
  message: e.message,
  statusCode: e.statusCode,
  errorCode: e.errorCode,
  errors: e.errors,
});

describe('NatsRpcException', () => {
  it('UT-05 should be created from a string', () => {
    expect(new NatsRpcException('User not found').message).toBe('User not found');
  });

  it('UT-06 should copy message, errorCode, statusCode and errors from an object', () => {
    const e = new NatsRpcException({
      message: 'Validation error',
      errorCode: 'VALIDATION_ERROR',
      statusCode: HttpStatus.BAD_REQUEST,
      errors: { email: ['email must be an email'] },
    });

    expect(fields(e)).toEqual({
      message: 'Validation error',
      errorCode: 'VALIDATION_ERROR',
      statusCode: HttpStatus.BAD_REQUEST,
      errors: { email: ['email must be an email'] },
    });
  });

  it('UT-07 should unwrap the nested error of a serialized RpcException', () => {
    const original = new NatsRpcException({
      message: 'User not found',
      statusCode: HttpStatus.NOT_FOUND,
      errorCode: 'USER_NOT_FOUND',
    });
    const wire = JSON.parse(JSON.stringify(new RpcException(original)));

    expect(fields(new NatsRpcException(wire))).toEqual({
      message: 'User not found',
      statusCode: HttpStatus.NOT_FOUND,
      errorCode: 'USER_NOT_FOUND',
      errors: undefined,
    });
  });

  it('UT-08 should take statusCode from an HttpException-like "status" field', () => {
    expect(new NatsRpcException({ message: 'Not Found', status: 404 } as any).statusCode).toBe(HttpStatus.NOT_FOUND);
  });

  it('UT-09 should not use the "error" status of a standard Nest RPC error packet as statusCode', () => {
    // BaseRpcExceptionFilter replies with { status: 'error', message } for unknown errors and guard rejections
    const e = new NatsRpcException({ status: 'error', message: 'Internal server error' } as any);

    expect([undefined, HttpStatus.INTERNAL_SERVER_ERROR]).toContain(e.statusCode);
  });
});
