// 超限处置：每一次超限的登记、回落跟踪与复核闭环
// 超限事件由水位记录按统一口径（water.levelCheck）自动判定，处置与复核登记在 data.exceedances 里，
// 以 levelId 关联；水位记录删除时由 records.removeLevel 一并清掉对应的处置登记。
const { AppError } = require('./errors');
const store = require('./store');
const water = require('./water');

// 处置状态流转：待处置 → 处置中 → 待复核 → 已闭环（已复核但还没回落时是「已复核待回落」）
const STATUSES = ['待处置', '处置中', '待复核', '已闭环', '已复核待回落'];

function keyOf(date, time) {
  return String(date || '') + ' ' + String(time || '00:00');
}

function handlingOf(data, levelId) {
  return (data.exceedances || []).find((x) => x.levelId === levelId) || null;
}

function handledOf(h) {
  return !!(h && h.cause && h.measures && h.handledAt && h.handler);
}

function reviewedOf(h) {
  return !!(h && h.reviewedBy && h.reviewedAt);
}

function statusOf(handled, recovered, reviewed) {
  if (!handled) return '待处置';
  if (recovered && reviewed) return '已闭环';
  if (recovered) return '待复核';
  if (reviewed) return '已复核待回落';
  return '处置中';
}

function decorateLevel(reservoir, record, settings) {
  const check = water.levelCheck(reservoir, record.level, record.date, settings);
  return {
    id: record.id,
    date: record.date,
    time: record.time,
    level: Number(record.level),
    limit: check.limit,
    over: check.over,
    exceeded: check.exceeded,
    floodSeason: check.floodSeason,
  };
}

// 同一水库、同一时刻之后的全部水位记录（按时刻升序）
function laterLevels(data, record) {
  const eventKey = keyOf(record.date, record.time);
  return data.levels
    .filter((l) => l.reservoirId === record.reservoirId && keyOf(l.date, l.time) > eventKey)
    .sort((a, b) => (keyOf(a.date, a.time) < keyOf(b.date, b.time) ? -1 : 1));
}

// 由一条超限的水位记录拼出处置行：超限情况、处置登记、回落与前后对照、闭环状态
function buildRow(data, record) {
  const reservoir = data.reservoirs.find((r) => r.id === record.reservoirId);
  const settings = data.settings;
  const check = water.levelCheck(reservoir, record.level, record.date, settings);
  const h = handlingOf(data, record.id);
  const handled = handledOf(h);
  const reviewed = reviewedOf(h);

  const after = laterLevels(data, record);

  // 回落：这次超限之后第一次出现不超限的水位记录
  let recovery = null;
  for (const l of after) {
    const c = water.levelCheck(reservoir, l.level, l.date, settings);
    if (!c.exceeded) {
      recovery = { id: l.id, date: l.date, time: l.time, level: Number(l.level), limit: c.limit };
      break;
    }
  }
  const recovered = !!recovery;

  // 处置后首次水位：处置时刻之后的第一条水位记录
  let afterHandling = null;
  if (handled) {
    const handledKey = String(h.handledAt).replace('T', ' ');
    const target = after.find((l) => keyOf(l.date, l.time) > handledKey);
    if (target) afterHandling = decorateLevel(reservoir, target, settings);
  }
  const latestAfter = after.length ? decorateLevel(reservoir, after[after.length - 1], settings) : null;

  return {
    levelId: record.id,
    reservoirId: record.reservoirId,
    reservoirName: reservoir ? reservoir.name : '',
    date: record.date,
    time: record.time,
    level: Number(record.level),
    limit: check.limit,
    over: check.over,
    floodSeason: check.floodSeason,
    basis: check.floodSeason ? '汛期·汛限水位' : '非汛期·正常蓄水位',
    handlingId: h ? h.id : '',
    cause: h ? h.cause || '' : '',
    measures: h ? h.measures || '' : '',
    handledAt: h ? h.handledAt || '' : '',
    handler: h ? h.handler || '' : '',
    reviewedBy: h ? h.reviewedBy || '' : '',
    reviewedAt: h ? h.reviewedAt || '' : '',
    reviewNote: h ? h.reviewNote || '' : '',
    handled,
    reviewed,
    recovered,
    recovery,
    recoveredAfterHandling: handled && recovery
      ? keyOf(recovery.date, recovery.time) > String(h.handledAt).replace('T', ' ')
      : null,
    afterHandling,
    latestAfter,
    status: statusOf(handled, recovered, reviewed),
  };
}

function exceededLevels(data) {
  return data.levels.filter((l) => {
    const reservoir = data.reservoirs.find((r) => r.id === l.reservoirId);
    return reservoir ? water.levelCheck(reservoir, l.level, l.date, data.settings).exceeded : false;
  });
}

function list(data, query) {
  const q = query || {};
  let rows = exceededLevels(data).map((l) => buildRow(data, l));
  if (q.reservoirId) rows = rows.filter((r) => r.reservoirId === q.reservoirId);
  if (q.status === '未闭环') rows = rows.filter((r) => r.status !== '已闭环');
  else if (q.status) rows = rows.filter((r) => r.status === q.status);
  if (q.from) rows = rows.filter((r) => r.date >= q.from);
  if (q.to) rows = rows.filter((r) => r.date <= q.to);
  return rows.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    if (a.time !== b.time) return a.time < b.time ? 1 : -1;
    return a.reservoirId < b.reservoirId ? -1 : 1;
  });
}

function findExceededLevel(data, levelId) {
  const record = data.levels.find((l) => l.id === levelId);
  if (!record) throw new AppError(404, 'LEVEL_NOT_FOUND', '这条水位记录不存在');
  const reservoir = data.reservoirs.find((r) => r.id === record.reservoirId);
  if (!reservoir) throw new AppError(404, 'RESERVOIR_NOT_FOUND', '这条水位记录对应的水库不存在');
  const check = water.levelCheck(reservoir, record.level, record.date, data.settings);
  if (!check.exceeded) throw new AppError(409, 'NOT_EXCEEDED', '这条水位记录当前没有超限，不需要处置');
  return record;
}

function detail(data, levelId) {
  const record = findExceededLevel(data, levelId);
  const reservoir = data.reservoirs.find((r) => r.id === record.reservoirId);
  const row = buildRow(data, record);
  // 回落过程：事件之后的水位记录，到回落为止（最多 40 条）
  const trace = [];
  for (const l of laterLevels(data, record)) {
    trace.push(decorateLevel(reservoir, l, data.settings));
    if (!trace[trace.length - 1].exceeded || trace.length >= 40) break;
  }
  return Object.assign({}, row, { trace });
}

const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/;

// 登记或修改处置：原因、措施、处置时刻、处置人
function saveHandling(data, levelId, payload) {
  const record = findExceededLevel(data, levelId);
  const errors = {};
  const cause = String(payload.cause || '').trim();
  const measures = String(payload.measures || '').trim();
  const handledAt = String(payload.handledAt || '').trim().replace('T', ' ');
  const handler = String(payload.handler || '').trim();
  if (!cause) errors.cause = '请登记超限原因';
  if (!measures) errors.measures = '请登记处置措施';
  if (!DATETIME_RE.test(handledAt)) errors.handledAt = '处置时刻要按 年-月-日 时:分 填';
  if (!handler) errors.handler = '请登记处置人';
  if (Object.keys(errors).length) {
    throw new AppError(400, 'VALIDATION_FAILED', '处置登记没通过校验，请按提示补齐', errors);
  }
  let h = handlingOf(data, record.id);
  if (!h) {
    h = {
      id: store.nextId('exc', data.exceedances),
      levelId: record.id,
      reservoirId: record.reservoirId,
      cause: '',
      measures: '',
      handledAt: '',
      handler: '',
      reviewedBy: '',
      reviewedAt: '',
      reviewNote: '',
    };
    data.exceedances.push(h);
  }
  Object.assign(h, { cause, measures, handledAt, handler });
  return buildRow(data, record);
}

// 登记或修改复核：复核人、复核时刻、复核结论；要先登记处置
function saveReview(data, levelId, payload) {
  const record = findExceededLevel(data, levelId);
  const h = handlingOf(data, record.id);
  if (!handledOf(h)) throw new AppError(409, 'HANDLING_REQUIRED', '先登记处置，再登记复核');
  const errors = {};
  const reviewedBy = String(payload.reviewedBy || '').trim();
  const reviewedAt = String(payload.reviewedAt || '').trim().replace('T', ' ');
  const reviewNote = String(payload.reviewNote || '').trim();
  if (!reviewedBy) errors.reviewedBy = '请登记复核人';
  if (!DATETIME_RE.test(reviewedAt)) errors.reviewedAt = '复核时刻要按 年-月-日 时:分 填';
  if (Object.keys(errors).length) {
    throw new AppError(400, 'VALIDATION_FAILED', '复核登记没通过校验，请按提示补齐', errors);
  }
  Object.assign(h, { reviewedBy, reviewedAt, reviewNote });
  return buildRow(data, record);
}

// 概览用：按闭环状态统计超限事件
function stats(data) {
  const rows = exceededLevels(data).map((l) => buildRow(data, l));
  return {
    total: rows.length,
    pending: rows.filter((r) => r.status === '待处置').length,
    open: rows.filter((r) => r.status !== '已闭环').length,
    closed: rows.filter((r) => r.status === '已闭环').length,
  };
}

module.exports = { list, detail, saveHandling, saveReview, stats, STATUSES };
