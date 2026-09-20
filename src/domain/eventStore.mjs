import fs from 'node:fs';
import path from 'node:path';
import { randomId, sha256Hex, stableStringify } from './ids.mjs';

/**
 * 只追加事件账本。
 *
 * - 事件按 seq 单调递增，一经写入不可修改、不可删除；
 * - 每条事件携带前一条事件的哈希，形成哈希链，任何改写都会在 verify() 暴露；
 * - 可选持久化到 JSONL 文件，每行一条事件，重启后完整重放；
 * - 同步内存实现 + 串行写入，足以支撑单节点独立运行。
 */
export class EventStore {
  constructor({ filePath } = {}) {
    this.filePath = filePath ?? null;
    this.events = [];
    this.listeners = new Set();
    if (this.filePath) this.#loadFromDisk();
  }

  #loadFromDisk() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      if (!raw.trim()) return;
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        this.events.push(event);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  #appendToDisk(event) {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.appendFileSync(this.filePath, `${JSON.stringify(event)}\n`);
  }

  all() {
    return this.events.slice();
  }

  get size() {
    return this.events.length;
  }

  /** 追加一条业务事件。payload 仅包含业务字段，账本字段在此统一补齐。 */
  append(type, payload, options = {}) {
    const { actor = null, occurredAt = new Date().toISOString() } = options;
    const seq = this.events.length + 1;
    const prevHash = this.events.length ? this.events[this.events.length - 1].hash : 'GENESIS';
    const body = { type, payload, actor: actor ?? null, occurredAt };
    const event = {
      id: randomId('evt'),
      seq,
      ...body,
      prevHash,
      hash: sha256Hex(`${prevHash}\n${stableStringify(body)}`),
    };
    this.events.push(event);
    this.#appendToDisk(event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* 投影异常不影响写入 */
      }
    }
    return event;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 校验哈希链完整性。任何对历史事件（含 payload、时间、操作人）的改写、
   * 删除或乱序都会返回失败位置。
   */
  verify() {
    let prevHash = 'GENESIS';
    for (const event of this.events) {
      const body = {
        type: event.type,
        payload: event.payload,
        actor: event.actor ?? null,
        occurredAt: event.occurredAt,
      };
      const expected = sha256Hex(`${prevHash}\n${stableStringify(body)}`);
      if (event.prevHash !== prevHash || event.hash !== expected) {
        return { ok: false, atSeq: event.seq };
      }
      prevHash = event.hash;
    }
    return { ok: true, count: this.events.length };
  }
}
