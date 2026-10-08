/**
 * AutoDL API 错误基类
 */
export class AutoDLError extends Error {
  public readonly code?: string;
  public readonly statusCode?: number;
  public readonly isRetryable: boolean;

  constructor(message: string, options?: { code?: string; statusCode?: number; isRetryable?: boolean; cause?: unknown }) {
    super(message);
    this.name = 'AutoDLError';
    this.code = options?.code;
    this.statusCode = options?.statusCode;
    this.isRetryable = options?.isRetryable ?? false;
    if (options?.cause) {
      this.cause = options.cause;
    }
  }
}

/**
 * 可重试错误（例如 GPU 资源不足、网络暂时超时、限流、服务短时不可用）
 */
export class AutoDLRetryableError extends AutoDLError {
  constructor(message: string, options?: { code?: string; statusCode?: number; cause?: unknown }) {
    super(message, { ...options, isRetryable: true });
    this.name = 'AutoDLRetryableError';
  }
}

/**
 * 不可重试错误（例如鉴权失败、实例不存在、账户欠费、参数非法）
 */
export class AutoDLNonRetryableError extends AutoDLError {
  constructor(message: string, options?: { code?: string; statusCode?: number; cause?: unknown }) {
    super(message, { ...options, isRetryable: false });
    this.name = 'AutoDLNonRetryableError';
  }
}

/**
 * 对未知的网络或 API 错误进行智能分类
 */
export function classifyAutoDLError(error: unknown): {
  isRetryable: boolean;
  classifiedError: AutoDLError;
  reason: string;
} {
  if (error instanceof AutoDLError) {
    return {
      isRetryable: error.isRetryable,
      classifiedError: error,
      reason: error.message,
    };
  }

  const rawMessage = error instanceof Error ? error.message : String(error);
  const msgLower = rawMessage.toLowerCase();

  // 1. 不可重试场景检测
  const nonRetryablePatterns = [
    { pattern: /(token|auth|unauthorized|forbidden|未授权|认证失败|登录失效|无权限)/i, reason: '鉴权或Token失效' },
    { pattern: /(not found|不存在|invalid uuid|未找到实例)/i, reason: '实例不存在或UUID无效' },
    { pattern: /(balance|arrears|欠费|余额不足|需充值)/i, reason: '账户余额不足或已欠费' },
    { pattern: /(param|invalid argument|参数错误|非法请求)/i, reason: '请求参数非法' },
  ];

  for (const item of nonRetryablePatterns) {
    if (item.pattern.test(rawMessage)) {
      const classified = new AutoDLNonRetryableError(`[不可重试: ${item.reason}] ${rawMessage}`, {
        cause: error,
      });
      return { isRetryable: false, classifiedError: classified, reason: item.reason };
    }
  }

  // 2. 判定是否为明确的可重试场景（GPU资源不足、网络超时等）
  const retryablePatterns = [
    { pattern: /(资源不足|无可用|排队|gpu|busy|stock|机器忙|容量不足|暂无可用|调度失败)/i, reason: 'GPU资源不足或机器暂不可用' },
    { pattern: /(timeout|etimedout|econnreset|fetch failed|network|socket|eai_again|reset)/i, reason: '网络连接异常或请求超时' },
    { pattern: /(rate limit|too many requests|429)/i, reason: '请求被频率限制' },
    { pattern: /(500|502|503|504|server error|bad gateway|internal)/i, reason: 'AutoDL服务端临时故障' },
  ];

  for (const item of retryablePatterns) {
    if (item.pattern.test(rawMessage)) {
      const classified = new AutoDLRetryableError(`[可重试: ${item.reason}] ${rawMessage}`, {
        cause: error,
      });
      return { isRetryable: true, classifiedError: classified, reason: item.reason };
    }
  }

  // 默认策略：如果是未知错误，开机阶段保守判定为可重试（以防是 AutoDL 临时未说明的文案）
  const classified = new AutoDLRetryableError(`[可能可重试] ${rawMessage}`, { cause: error });
  return { isRetryable: true, classifiedError: classified, reason: '未知暂时性错误' };
}
