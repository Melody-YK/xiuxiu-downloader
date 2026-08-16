// native messaging 消息帧：4 字节小端长度 + UTF-8 JSON（Chrome 官方协议）
const MAX_FRAME = 1024 * 1024; // 单帧上限 1MB，防御异常输入

export function serializeMessage(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(json.length, 0);
  return Buffer.concat([head, json]);
}

export class FrameParser {
  constructor(onMessage, onError) {
    this.buf = Buffer.alloc(0);
    this.onMessage = onMessage;
    this.onError = onError ?? (() => {});
  }

  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (len > MAX_FRAME) {
        this.onError(new Error('frame too large: ' + len));
        this.buf = Buffer.alloc(0);
        return;
      }
      if (this.buf.length < 4 + len) return; // 半帧，等待更多数据
      const payload = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      try {
        this.onMessage(JSON.parse(payload.toString('utf8')));
      } catch (err) {
        this.onError(new Error('invalid JSON: ' + (err instanceof Error ? err.message : String(err))));
      }
    }
  }
}

export function handleMessage(msg) {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
    return [{ type: 'error', message: 'invalid message' }];
  }
  switch (msg.type) {
    case 'ping':
      return [{ type: 'pong' }];
    case 'capture':
      return [{ type: 'ack', ok: true, count: Array.isArray(msg.entries) ? msg.entries.length : 0 }];
    default:
      return [{ type: 'error', message: 'unknown type: ' + String(msg.type) }];
  }
}
