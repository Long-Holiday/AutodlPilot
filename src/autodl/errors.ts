export type AutoDLErrorKind =
  | 'gpu_unavailable'
  | 'transient'
  | 'permanent'
  | 'unknown'
  | 'invalid_response'
  | 'cancelled';

interface ErrorOptions {
  code?: string;
  statusCode?: number;
  requestId?: string;
  kind?: AutoDLErrorKind;
  isRetryable?: boolean;
  uncertain?: boolean;
  cause?: unknown;
}

export class AutoDLError extends Error {
  readonly code?: string;
  readonly statusCode?: number;
  readonly requestId?: string;
  readonly kind: AutoDLErrorKind;
  readonly isRetryable: boolean;
  readonly uncertain: boolean;

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'AutoDLError';
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.requestId = options.requestId;
    this.kind = options.kind ?? 'unknown';
    this.isRetryable = options.isRetryable ?? false;
    this.uncertain = options.uncertain ?? false;
  }
}

export class AutoDLRetryableError extends AutoDLError {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, { kind: 'transient', ...options, isRetryable: true });
    this.name = 'AutoDLRetryableError';
  }
}

export class AutoDLNonRetryableError extends AutoDLError {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, { kind: 'permanent', ...options, isRetryable: false });
    this.name = 'AutoDLNonRetryableError';
  }
}

// 官方未公布业务错误码表；这些是保守的文案兼容规则，不是官方枚举。
const permanentMessage = /认证失败|鉴权失败|无权限|未授权|token\s*(?:无效|失效)|实例不存在|余额不足|欠费|参数错误|非法参数|unauthorized|forbidden|invalid token|instance not found|insufficient balance|invalid (?:argument|parameter)/i;
const resourceMessage = /(?:资源|库存|容量)(?:不足|已满)|(?:暂无|没有|无)(?:空闲|可用)(?:的)?\s*(?:GPU|显卡|机器|资源)|no (?:available|free) (?:gpus?|resources?)|no gpu available|(?:gpu|resource|capacity).{0,30}(?:unavailable|insufficient|exhausted)|insufficient.{0,20}(?:gpu|resources?)/i;

export function businessError(code: string, message: string, requestId?: string): AutoDLError {
  const options = { code, requestId };
  if (permanentMessage.test(message)) {
    return new AutoDLNonRetryableError(message, options);
  }
  if (resourceMessage.test(message)) {
    return new AutoDLRetryableError(message, { ...options, kind: 'gpu_unavailable' });
  }
  return new AutoDLNonRetryableError(message || `AutoDL API: ${code}`, {
    ...options,
    kind: 'unknown',
  });
}

export function classifyAutoDLError(error: unknown): {
  isRetryable: boolean;
  classifiedError: AutoDLError;
  reason: string;
} {
  const classifiedError = error instanceof AutoDLError
    ? error
    : new AutoDLNonRetryableError(error instanceof Error ? error.message : String(error), {
        kind: 'unknown',
      });
  return {
    isRetryable: classifiedError.isRetryable,
    classifiedError,
    reason: classifiedError.kind,
  };
}

export function errorDetails(error: unknown) {
  const { classifiedError: err } = classifyAutoDLError(error);
  return {
    kind: err.kind,
    code: err.code,
    message: err.message,
    request_id: err.requestId,
    http_status: err.statusCode,
    retryable: err.isRetryable,
    outcome_uncertain: err.uncertain,
  };
}
