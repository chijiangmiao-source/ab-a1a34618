// 批次规则校验：稳定批次标识、至多 24 条、严格递增正整数序号、文本载荷。
// 所有违反规则的情况都以 ValidationError 给出「首个阻断证据」。

export const MAX_EVENTS = 24;

export class ValidationError extends Error {
  constructor(code, evidence, message) {
    super(message || code);
    this.name = 'ValidationError';
    this.code = code; // 机器可读的阻断代码
    this.evidence = evidence; // 首个阻断证据（人类可读）
  }
}

// 归一化：只做类型检查，不改动提交内容。
export function normalizeSubmission(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('BATCH_NOT_OBJECT', '提交体必须是对象', '提交体必须是对象');
  }
  const batchIdRaw = raw.batchId;
  const eventsRaw = raw.events;

  if (typeof batchIdRaw !== 'string') {
    throw new ValidationError('BATCH_ID_TYPE', `batchId 类型为 ${typeof batchIdRaw}`, 'batchId 必须是字符串');
  }
  const batchId = batchIdRaw;
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/.test(batchId)) {
    throw new ValidationError(
      'BATCH_ID_FORMAT',
      `batchId="${batchId.slice(0, 32)}" 不符合 1..64 位字母数字及 :_- 规则`,
      '批次标识格式不合法',
    );
  }

  if (!Array.isArray(eventsRaw)) {
    throw new ValidationError('EVENTS_NOT_ARRAY', `events 类型为 ${typeof eventsRaw}`, 'events 必须是数组');
  }
  if (eventsRaw.length === 0) {
    throw new ValidationError('EVENTS_EMPTY', 'events 长度为 0', '批次至少包含一条事件');
  }
  if (eventsRaw.length > MAX_EVENTS) {
    throw new ValidationError(
      'EVENTS_TOO_MANY',
      `events 长度 ${eventsRaw.length} 超过上限 ${MAX_EVENTS}`,
      `每批至多 ${MAX_EVENTS} 条事件`,
    );
  }

  const events = [];
  for (let i = 0; i < eventsRaw.length; i++) {
    const item = eventsRaw[i];
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      tornEvidence(i, 'EVENT_NOT_OBJECT', `第 ${i + 1} 条事件不是对象`);
    }
    const seq = item.seq;
    const text = item.text;
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq)) {
      tornEvidence(i, 'SEQ_TYPE', `第 ${i + 1} 条事件 seq=${safeShow(seq)} 不是安全整数`);
    }
    if (seq <= 0) {
      tornEvidence(i, 'SEQ_NON_POSITIVE', `第 ${i + 1} 条事件 seq=${seq} 必须为正整数`);
    }
    if (seq > Number.MAX_SAFE_INTEGER) {
      tornEvidence(i, 'SEQ_OUT_OF_RANGE', `第 ${i + 1} 条事件 seq=${seq} 超出安全整数范围`);
    }
    if (typeof text !== 'string') {
      tornEvidence(i, 'TEXT_TYPE', `第 ${i + 1} 条事件 text 类型为 ${typeof text}`);
    }
    events.push({ seq, text });
  }

  // 严格递增：逐对检查，报告第一个失序位置。
  let prev = 0;
  for (let i = 0; i < events.length; i++) {
    const seq = events[i].seq;
    if (seq <= prev) {
      throw new ValidationError(
        'SEQ_NOT_STRICTLY_INCREASING',
        `第 ${i + 1} 条事件 seq=${seq} 不大于前值 ${prev}（位置 ${i + 1} 处首次失序）`,
        '事件序号必须严格递增',
      );
    }
    prev = seq;
  }

  return { batchId, events };
}

function tornEvidence(index, code, msg) {
  throw new ValidationError(code, `[事件下标 ${index}] ${msg}`, msg);
}

function safeShow(v) {
  if (typeof v === 'string') return JSON.stringify(v.slice(0, 16));
  return String(v);
}
