import crypto from 'node:crypto';

/** 生成不可猜测的内部标识（批次、事件等）。 */
export function randomId(prefix = 'ID') {
  return `${prefix}-${crypto.randomBytes(6).toString('hex')}`;
}

/** 生成一次性 API 密钥，仅在用户注册时返回明文。 */
export function generateApiKey(role) {
  return `key-${role}-${crypto.randomBytes(8).toString('hex')}`;
}

export function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 以稳定排序序列化对象，保证哈希链在不同进程间可复算。
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? 'null' : stableStringify(item))).join(',')}]`;
  const text = Object.keys(value)
    .sort()
    .filter((key) => value[key] !== undefined) // 与 JSON.stringify 语义一致：undefined 字段不入链
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',');
  return `{${text}}`;
}

/**
 * 人类可读批次号生成器：按类型单调递增，永不复用。
 * 重编号会分配新号但旧号保留为别名（见 aliases 投影）。
 */
const PREFIX_BY_TYPE = {
  harvest: 'RC', // 采收批
  merged: 'HB', // 合批批
  split: 'CB', // 拆包批
};

export class BatchNumberGenerator {
  constructor() {
    this.counters = new Map();
  }

  next(type) {
    const prefix = PREFIX_BY_TYPE[type] || 'PC';
    const seq = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, seq);
    return `${prefix}${String(seq).padStart(6, '0')}`;
  }

  /** 重启重放账本后，用既有批次号回填计数器，保证号码永不复用。 */
  seed(batchNo) {
    const match = /^([A-Z]+)(\d+)$/.exec(batchNo);
    if (!match) return;
    const [, prefix, digits] = match;
    const seq = Number(digits);
    this.counters.set(prefix, Math.max(this.counters.get(prefix) ?? 0, seq));
  }
}

/** 内部标识与对外批次号分离，重编号不改变标识，链路不断。 */
export function newBatchIdentity(type, generator) {
  return { batchId: randomId('bat'), batchNo: generator.next(type) };
}
