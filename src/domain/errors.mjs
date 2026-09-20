/**
 * 领域错误：携带稳定的错误代码，HTTP 层据此映射状态码。
 */
export class DomainError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function fail(code, message, details) {
  throw new DomainError(code, message, details);
}
