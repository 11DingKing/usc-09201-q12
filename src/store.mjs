// 追加式事件存储：事件以 JSONL 形式落盘，只增不改。
// filePath 为 null 时使用纯内存模式（测试与演示用）。

import { promises as fs } from 'node:fs';
import path from 'node:path';

export class EventStore {
  constructor(filePath = null) {
    this.filePath = filePath;
    this.events = [];
    this.keys = new Map(); // idempotencyKey -> eventId
    this._queue = Promise.resolve();
  }

  async load() {
    if (!this.filePath) return;
    let raw;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const event = JSON.parse(trimmed);
      this.events.push(event);
      if (event.idempotencyKey) this.keys.set(event.idempotencyKey, event.id);
    }
  }

  findByKey(key) {
    const id = this.keys.get(key);
    return id ? this.events.find((e) => e.id === id) : undefined;
  }

  append(event) {
    this.events.push(event);
    if (event.idempotencyKey) this.keys.set(event.idempotencyKey, event.id);
    if (!this.filePath) return Promise.resolve();
    const line = `${JSON.stringify(event)}\n`;
    // 串行化写入，避免并发追加交错
    this._queue = this._queue.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.appendFile(this.filePath, line, 'utf8');
    });
    return this._queue;
  }
}
