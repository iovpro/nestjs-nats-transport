import { ValidationPipe, HttpStatus, ValidationError } from '@nestjs/common';
import { NatsRpcException } from '../exceptions';

/**
 * Recursive type for validation errors
 * @publicApi
 */
export interface IValidationError {
  [key: string]: string[] | IValidationError;
}

const getErrors = (errors: ValidationError[]): IValidationError => {
  const messages: IValidationError = {};
  errors.forEach((e) => {
    if (e.constraints) {
      messages[e.property] = Object.values(e.constraints);
    } else if (e.children) {
      messages[e.property] = getErrors(e.children);
    }
  });
  return messages;
};

/**
 * Creates a ValidationPipe that throws NatsRpcException on validation errors
 * @publicApi
 */
export const RequestValidationPipe = () =>
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: false,
    exceptionFactory: (errors: ValidationError[]) => {
      return new NatsRpcException({
        errorCode: 'VALIDATION_ERROR',
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'Validation error',
        errors: getErrors(errors),
      });
    },
  });
