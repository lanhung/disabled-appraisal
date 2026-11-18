import { reliableCertainties } from './fact-certainty.js';

export const HEAD_IMPACT_EVENT_CUE_SOURCE = '(?:头(?:面|颈)?部|身体)(?:受击|遭(?:受)?打击|被击打|被击中)(?:后)?';
export const BLUNT_OBJECT_BODY_IMPACT_CUE = /(?:头(?:面|颈)?部|身体|面部|躯干|(?:(?:左|右)(?:侧)?|双侧)?(?:额|顶|颞|枕){1,3}部|(?:(?:左|右)(?:侧)?|双侧)?(?:肩|胸|背|腹|腰|臂|腿|手|足)部)[^。！？；;\n]{0,12}被[^。！？；;\n]{1,12}击中|被[^。！？；;\n]{1,12}击中(?:头(?:面|颈)?部|身体|面部|躯干|(?:(?:左|右)(?:侧)?|双侧)?(?:额|顶|颞|枕){1,3}部|(?:(?:左|右)(?:侧)?|双侧)?(?:肩|胸|背|腹|腰|臂|腿|手|足)部)/u;

export function historicalSectionHeading(text, start) {
  const historicalTitles = new Set(['既往史', '既往病史', '既往疾病史', '既往损伤史', '既往外伤史']);
  const sectionTitles = [...historicalTitles, '现病史', '主诉', '病程记录', '诊断', '检查结果', '影像学检查',
    '体格检查', '查体', '治疗经过', '手术史', '出院记录', '入院记录'].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`(?:^|\\n)[ \\t]*(${sectionTitles.join('|')})[ \\t]*[:：]?[ \\t]*(?=\\n|$)`, 'g');
  const heading = [...text.slice(0, start).matchAll(pattern)].at(-1);
  if (!heading || !historicalTitles.has(heading[1])) return null;
  return { start: heading.index + heading[0].indexOf(heading[1]) };
}

export function hasNonCurrentClinicalContext(text, start, end) {
  const historicalHeading = historicalSectionHeading(text, start);
  const precedingText = text.slice(0, start);
  const historicalCues = [...precedingText.matchAll(/既往(?:史)?|曾(?:经|于|在|行|接受|做过|做|切除|修补|施行)|过去|此前|历史上|手术史|旧伤|陈旧性?/gu)];
  const currentCues = [...precedingText.matchAll(/(?:本次|此次|当前|目前)(?:事故|外伤|受伤|损伤)?/gu)];
  const latestHistorical = historicalCues.at(-1);
  const latestCurrent = currentCues.at(-1);
  if (historicalHeading && !currentCues.some(cue => cue.index >= historicalHeading.start)) return true;
  const delimiters = ['。', '；', ';', '，', ',', '\n'];
  const clauseStart = Math.max(...delimiters.map(delimiter => text.lastIndexOf(delimiter, start - 1))) + 1;
  const clauseEnd = Math.min(...delimiters.map(delimiter => {
    const index = text.indexOf(delimiter, end);
    return index < 0 ? text.length : index;
  }));
  const preceding = text.slice(Math.max(clauseStart, start - 64), start);
  const following = text.slice(end, Math.min(clauseEnd, end + 32));
  const activeHistoricalCue = latestHistorical && (!latestCurrent || latestHistorical.index > latestCurrent.index);
  return Boolean(activeHistoricalCue && /(?:既往(?:史)?|曾(?:经|于|在|行|接受|做过|做|切除|修补|施行)|过去|此前|历史上|手术史|旧伤|陈旧性?).{0,64}$/u.test(preceding))
    || /(?:未|没有|未曾|否认|拒绝|不拟|不计划|尚未|拟|计划|准备|建议|考虑|可能|将|即将|若|如需|若需|待行).{0,16}$/u.test(preceding)
    || /^(?:尚未实施|未实施|未行|未接受|未完成|尚未完成|计划中|待手术)/u.test(following);
}

export const CURRENT_EVENT_SCOPE_ANCHOR = /(?:(?:本次|此次|本案).{0,20}(?:交通事故|事故|车祸|机动车(?:相撞|碰撞)|汽车(?:相撞|碰撞)|车辆(?:相撞|碰撞)|头(?:面|颈)?部受击|身体受击|外伤|受伤|骨折|损伤|刀伤|砍伤|刺伤|击打|击伤|打伤|摔伤|坠落伤|撞伤|压伤|烧伤|烫伤|打击伤|殴打|袭击|撞击)(?:后|期间|所致)?|(?:交通事故|事故|车祸|外伤|受伤|刀伤|砍伤|刺伤|击打|击伤|打伤|摔伤|坠落伤|撞伤|压伤|烧伤|烫伤)后)/u;

export function currentEventAnchorBefore(text, position) {
  const sentenceStart = Math.max(text.lastIndexOf('。', position - 1), text.lastIndexOf('；', position - 1),
    text.lastIndexOf(';', position - 1), text.lastIndexOf('\n', position - 1)) + 1;
  const preceding = text.slice(sentenceStart, position);
  if (CURRENT_EVENT_SCOPE_ANCHOR.test(preceding)) return true;
  return parseEventDateAnchors(preceding).some(anchor => anchor.index + anchor.length <= preceding.length);
}

export function startsWithNonInjuryDateContext(context) {
  return /^\s*(?:(?:急诊)?(?:行|接受|实施|施行|进行|作|做|采取)(?!走|驶|车|进)[^。！？；;\n]{0,48}(?:手术|术|取出|切除|清除|修补|探查|缝合|固定|复位)|(?:手术记录|手术日期|术中|术后|(?:头颅|颅脑|胸部|腹部|颈椎|胸椎|腰椎|脊柱)?(?:CT|MRI|X线|X片|DR|超声)|影像|检查|复查|入院|出院|诊断|病历|报告))/u
    .test(String(context || ''));
}

export function dateRoleBefore(text, dateIndex) {
  const prefix = String(text || '').slice(Math.max(0, dateIndex - 40), dateIndex);
  if (/(?:受伤及(?:诊疗|治疗)记录|受伤经过(?:及诊疗)?记录|损伤经过记录|受伤情况记录)\s*[:：]\s*$/u.test(prefix)) {
    return 'injury';
  }
  if (/(?:受伤|致伤|事故(?:发生)?|外伤)(?:日期|时间)\s*(?:记载|记录)?\s*(?:为|是|[:：])?\s*$/u.test(prefix)) {
    return 'injury';
  }
  if (/(?:住院|入院|出院|急诊|就诊|CT|MRI|X线|影像|检查|复查|手术|病历|记录|报告|诊断|治疗)[^。！？；;\n]{0,24}(?:日期|时间)\s*(?:记载|记录)?\s*(?:为|是|[:：])?\s*$/u.test(prefix)) {
    return 'clinical';
  }
  return null;
}

export function parseEventDateAnchors(text) {
  const anchors = [];
  const datePatterns = [
    /(?<year>(?:19|20)\d{2})年(?:(?<month>\d{1,2})月(?:(?<day>\d{1,2})日)?)?/gu,
    /(?<year>(?:19|20)\d{2})[-/.](?<month>\d{1,2})[-/.](?<day>\d{1,2})/gu,
  ];
  const source = String(text || '');
  const dateMatches = datePatterns.flatMap(datePattern => [...source.matchAll(datePattern)])
    .sort((left, right) => left.index - right.index);
  for (const match of dateMatches) {
    const dateRole = dateRoleBefore(source, match.index);
    if (dateRole === 'clinical') continue;
    const contextStart = match.index + match[0].length;
    const sentenceEnd = [source.indexOf('。', contextStart), source.indexOf('！', contextStart),
      source.indexOf('？', contextStart), source.indexOf('；', contextStart), source.indexOf(';', contextStart),
      source.indexOf('\n', contextStart)].filter(index => index >= 0).reduce((end, index) => Math.min(end, index), source.length);
    const context = source.slice(contextStart, sentenceEnd);
    const eventCue = new RegExp(String.raw`[^。！？；;\n]{0,18}?(?:因(?:车祸|交通事故|机动车事故|车辆事故)(?:后)?(?:(?:导致|造成))?(?:受伤|致伤|外伤|摔伤|撞伤)|交通事故|事故|车祸|机动车(?:相撞|碰撞)|汽车(?:相撞|碰撞)|车辆(?:相撞|碰撞)|${HEAD_IMPACT_EVENT_CUE_SOURCE}|被(?:汽车|车辆|机动车|摩托车)?撞(?:击)?(?:后(?:倒地|受伤)?|倒地?|伤)|外伤|受伤|骨折|损伤|刀伤|砍伤|刺伤|击打|击伤|打伤|摔伤|坠落伤|撞伤|压伤|烧伤|烫伤)`, 'u').exec(context);
    const bodyImpactCue = BLUNT_OBJECT_BODY_IMPACT_CUE.exec(context);
    const selectedEventCue = eventCue || bodyImpactCue;
    const explicitInjuryDate = dateRole === 'injury';
    if ((!selectedEventCue && !explicitInjuryDate)
      || (!explicitInjuryDate && startsWithNonInjuryDateContext(context))
      || (selectedEventCue && hasNonCurrentClinicalContext(source, contextStart + selectedEventCue.index,
        contextStart + selectedEventCue.index + selectedEventCue[0].length))
      || selectedEventCue && /CT|MRI|X线|影像|报告|检查|复查|入院|出院|诊断|病历|手术|法医/u.test(selectedEventCue[0])) continue;
    const year = Number(match.groups.year);
    const month = match.groups.month == null ? null : Number(match.groups.month);
    const day = match.groups.day == null ? null : Number(match.groups.day);
    if (month != null && (month < 1 || month > 12) || day != null && (day < 1 || day > 31)) continue;
    anchors.push({
      key: `${year}-${month ?? '*'}-${day ?? '*'}`,
      range: { start: year * 10_000 + (month ?? 1) * 100 + (day ?? 1),
        end: year * 10_000 + (month ?? 12) * 100 + (day ?? 31) },
      index: match.index,
      length: match[0].length + (selectedEventCue ? selectedEventCue.index + selectedEventCue[0].length : 0),
      explicitlySeparate: /(?:另(?:一次|一场|一件)|第二次|不同(?:次|一场)?(?:事故|外伤|受伤))/u
        .test(source.slice(Math.max(0, match.index - 24), match.index)),
    });
  }
  const seenDates = new Set();
  return anchors.filter(anchor => {
    if (!seenDates.has(anchor.key)) {
      seenDates.add(anchor.key);
      return true;
    }
    return anchor.explicitlySeparate;
  });
}

export function explicitInjuryEventDateKeys(text) {
  return parseEventDateAnchors(text).filter(anchor => !anchor.key.includes('*'))
    .map(anchor => {
      const [year, month, day] = anchor.key.split('-').map(Number);
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    });
}

export function eventDateAnchorsConflict(anchors) {
  for (let left = 0; left < anchors.length; left += 1) {
    for (let right = left + 1; right < anchors.length; right += 1) {
      if (anchors[left].end < anchors[right].start || anchors[right].end < anchors[left].start) return true;
    }
  }
  return false;
}

export function eventIdForSelectedInjuryDate(facts, selectedDate) {
  if (!Array.isArray(facts) || typeof selectedDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(selectedDate)) {
    return null;
  }
  const eventIds = new Set(facts.filter(fact => fact.field === 'injury_date' && fact.value === selectedDate
    && fact.source === 'description' && reliableCertainties.has(fact.certainty)
    && /^[EU][1-9]\d{0,2}$/u.test(fact.eventId || '')
    && fact.sourceRefs?.some(reference => reference.source === 'description'
      && reference.sourceId === 'description' && reference.evidence === fact.evidence))
    .map(fact => fact.eventId));
  if (eventIds.size !== 1) return null;
  const [eventId] = eventIds;
  return /^E[1-9]\d{0,2}$/u.test(eventId) ? eventId : null;
}

export function normalizeInjuryDateValue(value) {
  if (typeof value === 'string') {
    const chineseDate = value.trim().match(/^((?:19|20)\d{2})年(\d{1,2})月(\d{1,2})日$/u);
    if (chineseDate) return `${chineseDate[1]}-${chineseDate[2].padStart(2, '0')}-${chineseDate[3].padStart(2, '0')}`;
  }
  const numeric = typeof value === 'number' ? value
    : typeof value === 'string' && /^\d{8,13}$/u.test(value.trim()) ? Number(value.trim()) : NaN;
  if (!Number.isFinite(numeric)) return value;

  let isoDate = null;
  if (Number.isInteger(numeric) && numeric >= 19000101 && numeric <= 20991231) {
    const digits = String(numeric);
    const candidate = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
    const date = new Date(`${candidate}T00:00:00.000Z`);
    if (!Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === candidate) isoDate = candidate;
  } else {
    const timestamp = numeric >= 1e12 && numeric <= 4102444800000 ? numeric
      : numeric >= 1e9 && numeric < 1e11 ? numeric * 1000 : NaN;
    if (Number.isFinite(timestamp)) {
      const date = new Date(timestamp);
      if (!Number.isNaN(date.getTime())) isoDate = date.toISOString().slice(0, 10);
    }
  }
  return isoDate || value;
}
