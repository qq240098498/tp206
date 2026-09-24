// 超限处置：把连续超限的水位测报归并成一次「超限事件」，登记处置并复核闭环。
// 事件本身不落库——每次都按 data.levels 现算，限水位改了、测报补录了都能自动跟着变；
// 落库的只有人工填写的处置单 data.exceedanceHandlings，按 eventKey 对到事件上。
const { AppError } = require('./errors');
const store = require('./store');
const water = require('./water');

const REVIEW_RESULTS = ['通过', '不通过'];

function tsOf(level) {
  return String(level.date) + ' ' + String(level.time || '08:00');
}

// 接受 "2026-06-05 14:30" 或 "2026-06-05T14:30"，统一成 "YYYY-MM-DD HH:mm"
function parseDateTime(value, field) {
  const text = String(value || '').trim().replace('T', ' ');
  if (!/^\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}$/.test(text)) {
    throw new AppError(400, 'VALIDATION_FAILED', '处置时刻要按 年-月-日 时:分 填', { [field]: '时刻格式不对，例如 2026-06-05 14:30' });
  }
  const parts = text.split(' ');
  const hm = parts[1].split(':');
  return parts[0] + ' ' + String(hm[0]).padStart(2, '0') + ':' + String(hm[1]).padStart(2, '0');
}

// 两个 "YYYY-MM-DD HH:mm" 相差的小时数（b - a），分钟以下忽略（测报最小粒度到小时）
function hoursBetween(a, b) {
  const pa = String(a).split(/[- :]/).map(Number);
  const pb = String(b).split(/[- :]/).map(Number);
  if (pa.length < 4 || pb.length < 4) return 0;
  const ta = Date.UTC(pa[0], pa[1] - 1, pa[2], pa[3]);
  const tb = Date.UTC(pb[0], pb[1] - 1, pb[2], pb[3]);
  return (tb - ta) / 3600000;
}

// 判定依据：同一次超限里各测报可能跨汛期/非汛期（限水位口径会换），都摊开写清楚
function basisOf(points) {
  const flood = points.filter((p) => p.chk.floodSeason);
  const nonFlood = points.filter((p) => !p.chk.floodSeason);
  const reservoir = points[0].reservoir;
  if (flood.length && nonFlood.length) {
    return {
      basis: '跨汛期与非汛期',
      floodSeason: null,
      mixed: true,
      detail: '本次超限从汛期持续到非汛期：汛期按汛限水位 ' + reservoir.floodLimitLevel
        + ' m 判定，非汛期按正常蓄水位 ' + reservoir.normalLevel + ' m 判定',
    };
  }
  if (flood.length) {
    return { basis: '汛期', floodSeason: true, mixed: false, detail: '汛期，按汛限水位 ' + reservoir.floodLimitLevel + ' m 判定' };
  }
  return { basis: '非汛期', floodSeason: false, mixed: false, detail: '非汛期，按正常蓄水位 ' + reservoir.normalLevel + ' m 判定' };
}

// 一个连续超限段收口成事件。
// recoverKind：measured=后面有不超限测报（测到回落）；gap=后面记录中断超过阈值（缺测收口）；none=到数据末尾仍超限
function finalizeEvent(reservoir, points, recoverKind, boundaryRow, gapHours, boundaryChk) {
  const first = points[0];
  const peak = points.reduce((a, b) => (Number(b.row.level) > Number(a.row.level) ? b : a), points[0]);
  const last = points[points.length - 1];
  const basis = basisOf(points.map((p) => Object.assign({ reservoir }, p)));
  const startDate = first.row.date;
  const startTime = String(first.row.time || '08:00');
  const measured = recoverKind === 'measured';
  const gapped = recoverKind === 'gap';
  return {
    eventKey: 'ex@' + reservoir.id + '@' + startDate + ' ' + startTime,
    reservoirId: reservoir.id,
    reservoirCode: reservoir.code,
    reservoirName: reservoir.name,
    pointCount: points.length,
    levelIds: points.map((p) => p.row.id),
    points: points.map((p) => ({
      id: p.row.id,
      date: p.row.date,
      time: String(p.row.time || '08:00'),
      at: tsOf(p.row),
      level: Number(p.row.level),
      limit: p.chk.limit,
      over: p.chk.over,
      floodSeason: p.chk.floodSeason,
      source: p.row.source || '',
      recorder: p.row.recorder || '',
    })),
    // 起报
    startAt: tsOf(first.row),
    startDate,
    startTime,
    startLevel: Number(first.row.level),
    startLimit: first.chk.limit,
    startOver: first.chk.over,
    // 峰值
    peakAt: tsOf(peak.row),
    peakDate: peak.row.date,
    peakTime: String(peak.row.time || '08:00'),
    peakLevel: Number(peak.row.level),
    peakLimit: peak.chk.limit,
    peakOver: peak.chk.over,
    floodSeason: basis.floodSeason,
    basis: basis.basis,
    basisMixed: basis.mixed,
    basisDetail: basis.detail,
    floodLimitLevel: Number(reservoir.floodLimitLevel),
    normalLevel: Number(reservoir.normalLevel),
    // 超限段最后一个测点
    lastAt: tsOf(last.row),
    lastLevel: Number(last.row.level),
    lastLimit: last.chk.limit,
    // 回落：只有「测到不超限测报」才算数；缺测中断要如实标出来，不能假装回落了
    recoverKind,
    recovered: measured,
    recoveredAt: measured && boundaryRow ? tsOf(boundaryRow) : '',
    recoveredDate: measured && boundaryRow ? boundaryRow.date : '',
    recoveredTime: measured && boundaryRow ? String(boundaryRow.time || '08:00') : '',
    recoveredLevel: measured && boundaryRow ? Number(boundaryRow.level) : null,
    recoveredLimit: measured && boundaryChk ? boundaryChk.limit : null,
    recoveredOver: measured && boundaryChk ? boundaryChk.over : null,
    recoveredFloodSeason: measured && boundaryChk ? boundaryChk.floodSeason : null,
    gapToAt: gapped && boundaryRow ? tsOf(boundaryRow) : '',
    gapHours: gapped ? store.round(gapHours, 1) : null,
    gapNote: gapped ? '末点 ' + tsOf(last.row) + ' 之后 ' + store.round(gapHours, 1) + ' 小时无测报，按缺测中断收口，未测到回落过程' : '',
  };
}

// 按水库时序归并：连续超限的测点归为一次；遇到不超限测报收口，相邻超限测点间隔超过阈值也按缺测收口
function deriveEvents(data) {
  const gapLimit = Number(data.settings.exceedanceGapHours) > 0 ? Number(data.settings.exceedanceGapHours) : 48;
  const events = [];
  data.reservoirs.forEach((reservoir) => {
    const rows = data.levels
      .filter((l) => l.reservoirId === reservoir.id)
      .slice()
      .sort((a, b) => (tsOf(a) < tsOf(b) ? -1 : tsOf(a) > tsOf(b) ? 1 : 0));
    let points = [];
    for (let i = 0; i < rows.length; i += 1) {
      const chk = water.levelCheck(reservoir, rows[i].level, rows[i].date, data.settings);
      if (chk.exceeded) {
        if (points.length) {
          const gap = hoursBetween(tsOf(points[points.length - 1].row), tsOf(rows[i]));
          if (gap > gapLimit) {
            events.push(finalizeEvent(reservoir, points, 'gap', rows[i], gap, chk));
            points = [];
          }
        }
        points.push({ row: rows[i], chk });
      } else if (points.length) {
        events.push(finalizeEvent(reservoir, points, 'measured', rows[i], 0, chk));
        points = [];
      }
    }
    if (points.length) events.push(finalizeEvent(reservoir, points, 'none', null, 0, null));
  });
  return events.sort((a, b) => (a.startAt === b.startAt ? (a.reservoirId < b.reservoirId ? -1 : 1) : a.startAt < b.startAt ? 1 : -1));
}

function handlingMap(data) {
  const map = {};
  (data.exceedanceHandlings || []).forEach((h) => { map[h.eventKey] = h; });
  return map;
}

// 处置前水位：取处置时刻之前最近一条测报（没有就退到峰值），处置后取回落测报
function decorateWithHandling(event, handling) {
  // 处置前水位默认取峰值；decorate 会在有处置单时改取处置时刻之前最近一条测报
  const beforeLevel = event.peakLevel;
  const beforeAt = event.peakAt;
  let status = 'open';
  let statusText = '未处置';
  const pendingText = event.recoverKind === 'gap' ? '已处置·缺测未测到回落'
    : event.recoverKind === 'none' ? '已处置·水位仍超限' : '已处置·待复核';
  if (handling) {
    if (!handling.review) {
      if (event.recovered) { status = 'pending_review'; statusText = '已处置·待复核'; }
      else { status = 'handling'; statusText = pendingText; }
    } else if (handling.review.result === '不通过') {
      status = 'review_rejected';
      statusText = '复核未通过·需重新处置';
    } else if (event.recovered) {
      status = 'closed';
      statusText = '已闭环';
    } else {
      status = 'reviewed_pending';
      statusText = event.recoverKind === 'gap' ? '复核通过·缺测未见回落' : '复核通过·水位待回落';
    }
  }
  const afterLevel = event.recovered ? event.recoveredLevel : null;
  const drawdown = event.recovered ? store.round(beforeLevel - event.recoveredLevel, 2) : null;
  return Object.assign({}, event, {
    handling: handling || null,
    beforeLevel,
    beforeAt,
    afterLevel,
    afterAt: event.recovered ? event.recoveredAt : '',
    drawdown,
    closed: status === 'closed',
    status,
    statusText,
  });
}

// 处置时刻之前该水库最近一条测报（在 decorate 时带上该库全部测报来查）
function levelBeforeAt(data, reservoirId, dateTime) {
  return data.levels
    .filter((l) => l.reservoirId === reservoirId && tsOf(l) <= dateTime)
    .sort((a, b) => (tsOf(a) < tsOf(b) ? 1 : -1))[0] || null;
}

function decorate(data, event, handling) {
  const out = decorateWithHandling(event, handling);
  if (handling && handling.handledAt) {
    const before = levelBeforeAt(data, event.reservoirId, handling.handledAt);
    if (before) {
      out.beforeLevel = Number(before.level);
      out.beforeAt = tsOf(before);
      out.drawdown = out.recovered ? store.round(Number(before.level) - out.recoveredLevel, 2) : null;
    }
  }
  return out;
}

function list(data, query) {
  const q = query || {};
  const map = handlingMap(data);
  let events = deriveEvents(data);
  if (q.reservoirId) events = events.filter((e) => e.reservoirId === q.reservoirId);
  if (q.from) events = events.filter((e) => e.startDate >= q.from);
  if (q.to) events = events.filter((e) => e.startDate <= q.to);
  let rows = events.map((e) => decorate(data, e, map[e.eventKey] || null));
  if (q.status) rows = rows.filter((r) => r.status === q.status);
  if (q.closed === 'true') rows = rows.filter((r) => r.closed);
  if (q.closed === 'false') rows = rows.filter((r) => !r.closed);
  return rows;
}

function findEvent(data, eventKey) {
  const found = deriveEvents(data).find((e) => e.eventKey === eventKey);
  if (!found) throw new AppError(404, 'EXCEEDANCE_NOT_FOUND', '这次超限不存在：可能限水位改了或水位测报被删，事件已经重新归并');
  return found;
}

function findHandling(data, eventKey) {
  return (data.exceedanceHandlings || []).find((h) => h.eventKey === eventKey) || null;
}

// 登记（或修改）处置：原因、处置措施、处置时刻、处置人
function registerHandling(data, eventKey, payload) {
  const event = findEvent(data, eventKey);
  const errors = {};
  const reason = String(payload.reason || '').trim();
  const measure = String(payload.measure || '').trim();
  const handler = String(payload.handler || '').trim();
  if (!reason) errors.reason = '超限原因要填';
  if (!measure) errors.measure = '处置措施要填';
  if (!handler) errors.handler = '处置人要填';
  let handledAt = '';
  try {
    handledAt = parseDateTime(payload.handledAt, 'handledAt');
  } catch (err) {
    if (err.details) Object.assign(errors, err.details);
  }
  if (handledAt && handledAt < event.startAt) errors.handledAt = '处置时刻不能早于超限起报时刻 ' + event.startAt;
  if (Object.keys(errors).length) {
    throw new AppError(400, 'VALIDATION_FAILED', '处置单没通过校验，请按提示补齐', errors);
  }

  let handling = findHandling(data, eventKey);
  // 只有「复核通过且已测到回落」（真闭环）才锁处置单；
  // 复核通过但水位尚未回落的，仍允许补充处置措施（改后原复核结论作废，需重新复核）
  if (handling && handling.review && handling.review.result === '通过' && event.recovered) {
    throw new AppError(409, 'EXCEEDANCE_CLOSED', '这次超限已复核通过且水位回落闭环，不能再改处置单');
  }
  if (!handling) {
    handling = {
      id: store.nextId('exh', data.exceedanceHandlings || []),
      eventKey,
      reservoirId: event.reservoirId,
      createdAt: store.todayIso(),
    };
    data.exceedanceHandlings.push(handling);
  }
  Object.assign(handling, {
    reason,
    measure,
    handler,
    handledAt,
    handleRemark: String(payload.handleRemark || '').trim(),
  });
  // 处置措施改了，上一轮「不通过」的复核结论作废，需要重新复核
  handling.review = null;
  return decorate(data, event, handling);
}

// 复核：水位是否真落回限水位以内由接口按测报判，复核人只对处置效果下结论
function reviewHandling(data, eventKey, payload) {
  const event = findEvent(data, eventKey);
  const handling = findHandling(data, eventKey);
  if (!handling) throw new AppError(409, 'HANDLING_MISSING', '还没登记处置，不能复核');
  const errors = {};
  const reviewer = String(payload.reviewer || '').trim();
  const result = String(payload.result || '').trim();
  if (!reviewer) errors.reviewer = '复核人要填';
  if (REVIEW_RESULTS.indexOf(result) < 0) errors.result = '复核结果只能是：' + REVIEW_RESULTS.join('、');
  let reviewedAt = '';
  try {
    reviewedAt = parseDateTime(payload.reviewedAt, 'reviewedAt');
  } catch (err) {
    if (err.details) Object.assign(errors, err.details);
  }
  if (reviewedAt && reviewedAt < handling.handledAt) errors.reviewedAt = '复核时刻不能早于处置时刻 ' + handling.handledAt;
  if (Object.keys(errors).length) {
    throw new AppError(400, 'VALIDATION_FAILED', '复核没通过校验，请按提示补齐', errors);
  }
  handling.review = {
    reviewer,
    result,
    reviewedAt,
    note: String(payload.note || '').trim(),
  };
  return decorate(data, event, handling);
}

// 水位记录 id -> 事件 key，供水位记录表链接到处置单
function levelEventIndex(data) {
  const map = {};
  deriveEvents(data).forEach((e) => {
    e.levelIds.forEach((id) => { map[id] = e.eventKey; });
  });
  return map;
}

// 概览用计数
function counts(data) {
  const rows = list(data, {});
  return {
    exceedanceCount: rows.length,
    exceedanceOpenCount: rows.filter((r) => !r.closed).length,
    exceedanceUnhandledCount: rows.filter((r) => r.status === 'open').length,
    exceedanceClosedCount: rows.filter((r) => r.closed).length,
  };
}

module.exports = {
  deriveEvents,
  list,
  findEvent,
  registerHandling,
  reviewHandling,
  counts,
  levelEventIndex,
  REVIEW_RESULTS,
};
