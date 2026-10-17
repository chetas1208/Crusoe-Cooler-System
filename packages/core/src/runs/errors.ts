import type { ApiProblem, ApiProblemCode } from './types';

export class ApiError extends Error implements ApiProblem {
  constructor(
    readonly code: ApiProblemCode,
    message: string,
    readonly status = 400,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}
