import type { FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { CoreHttpError } from '../http-error.js';

/**
 * Request validation + the structured error envelope (CORE-1, §1):
 * every route schema is a Zod schema (type-provider compilers); a
 * schema-invalid request returns 400 with the Zod issue list; service
 * errors keep their own status; anything else is an opaque 500 (internals
 * never leak into the envelope).
 */
export const registerValidation = (app: FastifyInstance): void => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler((error, _req, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'request does not match schema',
          issues: error.validation.map((failure) => failure.params['issue']),
        },
      });
    }
    if (error instanceof CoreHttpError) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.reasonCode ? { reason_code: error.reasonCode } : {}),
        },
      });
    }
    _req.log.error(error);
    return reply.code(500).send({
      error: { code: 'INTERNAL', message: 'internal error' },
    });
  });
};
