import crypto from 'node:crypto';
import { factExtractionSchema } from './contracts.js';
import { BLUNT_OBJECT_BODY_IMPACT_CUE, currentEventAnchorBefore, CURRENT_EVENT_SCOPE_ANCHOR, dateRoleBefore, eventDateAnchorsConflict,
  hasNonCurrentClinicalContext, historicalSectionHeading, HEAD_IMPACT_EVENT_CUE_SOURCE, normalizeInjuryDateValue,
  parseEventDateAnchors, startsWithNonInjuryDateContext } from './event-date-logic.js';

const FACT_SCHEMA_VERSION = '1.6';
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_FACT_EVIDENCE_CHARS = 1000;
const MAX_FACT_SNAPSHOT_JSON_CHARS = 250_000;
const MAX_NORMALIZED_FACTS = 200;
const MAX_RIB_OCCURRENCES_PER_SOURCE = 40;
const CERTAINTY_SCOPED_FIELDS = new Set(['diagnosis', 'imaging_finding', 'clinical_finding', 'injury_type', 'anatomical_site', 'symptom']);
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/heic', 'image/heif'
]);
const CHINESE_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const ADDITIONAL_BONE_SITES = '颅骨|鼻骨|锁骨|肩胛骨|胸骨|椎体|椎骨|颈椎|胸椎|腰椎|骶椎|骶骨|尾椎|尾骨|骨盆|髋骨|髂骨|耻骨|坐骨|股骨|髌骨|胫骨|腓骨|肱骨|尺骨|桡骨|腕骨|掌骨|指骨|跗骨|距骨|跟骨|舟骨|跖骨|趾骨|颧骨|颌骨';

function normalizeInput(value = '') {
  return String(value)
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t \u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

export function hasSameEyeInjuryContext(side, evidence) {
  if (!['左', '右'].includes(side)) return false;
  const text = normalizeInput(evidence);
  const injuryCues = [...text.matchAll(/(?:外伤|受伤)(前|后)/gu)];
  const injuryCue = injuryCues.at(-1);
  if (!injuryCue || injuryCue[1] !== '后') return false;
  const beforeCue = text.slice(Math.max(0, injuryCue.index - 24), injuryCue.index);
  const adjacentEye = beforeCue.match(/(?:左|右)眼[^。！？；;\n]{0,12}$/u)?.[0];
  if (adjacentEye?.startsWith(`${side}眼`)) return true;
  const afterCue = text.slice(injuryCue.index + injuryCue[0].length,
    injuryCue.index + injuryCue[0].length + 24);
  return new RegExp(`^(?:[^。！？；;\\n]{0,8}(?:伤及|累及|波及|致|导致)[^。！？；;\\n]{0,4}${side}眼|[^。！？；;\\n]{0,4}${side}眼(?:受伤|损伤|受累))`, 'u').test(afterCue);
}

function explicitNegationCoversTerm(text, term) {
  const normalizedText = normalizeInput(text);
  const normalizedTerm = normalizeInput(term);
  if (!normalizedText || !normalizedTerm) return false;
  const offsets = [];
  let from = 0;
  while (from < normalizedText.length) {
    const offset = normalizedText.indexOf(normalizedTerm, from);
    if (offset < 0) break;
    offsets.push(offset);
    from = offset + normalizedTerm.length;
  }
  if (!offsets.length) return false;
  return offsets.every(offset => {
    const prefix = normalizedText.slice(Math.max(0, offset - 80), offset);
    const clauseStart = Math.max(prefix.lastIndexOf('。'), prefix.lastIndexOf('；'), prefix.lastIndexOf('\n')) + 1;
    const clausePrefix = prefix.slice(clauseStart);
    const negations = [...clausePrefix.matchAll(/无|没有|未见|否认|未诉|不伴(?:有)?|未出现/gu)];
    const negation = negations.at(-1);
    if (!negation) return false;
    const afterNegation = clausePrefix.slice(negation.index + negation[0].length);
    return !/(?:但(?:是)?|然而|不过|而(?:有|伴)|伴有|出现|另诉|主诉|同时有)/u.test(afterNegation);
  });
}

function parseNumber(value) {
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Number(text);
  if (!text || !/^[零〇一二两三四五六七八九十百]+$/.test(text)) return null;
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const char of text) {
    if (Object.hasOwn(CHINESE_DIGITS, char)) {
      digit = CHINESE_DIGITS[char];
    } else if (char === '十') {
      section += (digit || 1) * 10;
      digit = 0;
    } else if (char === '百') {
      section += (digit || 1) * 100;
      digit = 0;
    }
  }
  total += section + digit;
  return total || 0;
}

export function quotedDentalDefectCount(evidence, expectedValue) {
  const text = normalizeInput(evidence || '');
  const measurements = [...text.matchAll(/([0-9零〇一二两三四五六七八九十百]+)\s*(?:枚|颗|个)/gu)];
  if (measurements.length !== 1 || !/(?:牙齿|牙|齿)/u.test(text)
    || !/(?:缺失|缺齿|脱落|折断|折裂|断裂)/u.test(text)
    || /(?:约|大约|左右|接近|估计|可疑|疑似|考虑|可能|待排|待查|不排除|未达|低于|小于|不足|不超过|少于|未见|未发现|未记载|否认|排除|既往|既有|曾经|曾有|陈旧|旧伤|此前|术前|义齿|假牙|牙冠|牙桥|种植体)/u.test(text)) return null;
  const measurement = measurements[0];
  const before = text.slice(Math.max(0, measurement.index - 20), measurement.index);
  if (/(?:第|编号|序号)\s*$/u.test(before)
    || /(?:\d+)\s*(?:~|～|〜|-|–|—|至|到)\s*$/u.test(before)) return null;
  const count = parseNumber(measurement[1]);
  return Number.isInteger(count) && count > 0 && count === expectedValue ? count : null;
}

const POSTPOSED_UNCERTAINTY_QUALIFIER = /^(?:\s*[，,：:]?\s*)(?:(?:诊断|性质|结果|考虑)?(?:可疑|疑似|怀疑|考虑|可能|待排|待查|待核实|待确认|不排除|不能排除|未排除|尚未排除|未能排除|不除外|不能除外|未能除外|存疑|未明确|不明确|尚不明确|尚未明确))/u;
const POSTPOSED_MEDICAL_QUALIFIER = /^(?:\s*[，,：:]?\s*)(?:(?:诊断|性质|结果|明确|考虑)?(?:可疑|疑似|怀疑|考虑|可能|待排|待查|待核实|待确认|不排除|不能排除|未排除|尚未排除|未能排除|不除外|不能除外|未能除外|存疑|排除|已排除|未见|未发现|阴性|否认|未明确|不明确|尚不明确|尚未明确))/u;

function certaintyFor(text, start, end) {
  const spanEnd = Math.min(text.length, end);
  const trailingQualifier = POSTPOSED_UNCERTAINTY_QUALIFIER.exec(text.slice(spanEnd));
  const context = text.slice(start, spanEnd + (trailingQualifier?.[0].length || 0));
  if (hasUnresolvedOtherExperiencer(context) || /若(?!干)|如果|假如|倘若|一旦|假设|如有|如出现|如发生|必要时/.test(context)) return 'unknown';
  if (/(?:建议|推荐|需要|拟|计划|应当|应).{0,24}(?:复查|检查|重建|排除)/.test(context)
    && !/(?:已排除|排除后|复查结果|检查结果)/.test(context)) return 'unknown';
  if (/不排除|不能排除|未排除|尚未排除|未能排除|不除外|不能除外|未能除外|可疑|疑似|怀疑|考虑|可能|待排|待查/.test(context)) return 'uncertain';
  if (/排除|未见|未发现|不存在|没有|阴性|否认|无(?=(?:第\s*[0-9零〇一二两三四五六七八九十百]+\s*)?肋骨|骨折)/.test(context)) return 'excluded';
  return 'reported';
}

function certaintyForMention(text, start, end) {
  const spanEnd = Math.min(text.length, end);
  const trailingQualifier = POSTPOSED_MEDICAL_QUALIFIER.exec(text.slice(spanEnd));
  return certaintyFor(text, start, spanEnd + (trailingQualifier?.[0].length || 0));
}

function hasUnresolvedOtherExperiencer(text) {
  const otherSubject = /(?:患者的?父亲|患者的?母亲|其父|其母|家属|父亲|母亲|丈夫|妻子|他人|其他人|另一个人|同事)/g;
  const patient = /(?:患者|受检者|伤者|被鉴定人|本人)/;
  const condition = /(?:骨折|受伤|损伤|休克|诊断|影像|症状|疼痛|腰痛|头痛|胸痛|腹痛|麻木|肿胀|障碍|咳嗽|呼吸困难|瘫痪)/;
  for (const match of text.matchAll(otherSubject)) {
    const following = text.slice(match.index + match[0].length);
    const target = condition.exec(following);
    if (target && !patient.test(following.slice(0, target.index))) return true;
  }
  return false;
}

function hasRibSpecificFractureStatement(text) {
  const ribSites = [...text.matchAll(/肋骨/g)];
  const otherBoneSites = [...text.matchAll(new RegExp(ADDITIONAL_BONE_SITES, 'g'))];
  let ribCursor = 0;
  let otherSiteCursor = 0;
  let lastRibIndex = -1;
  let lastOtherSiteIndex = -1;
  for (const fracture of text.matchAll(/骨折/g)) {
    while (ribCursor < ribSites.length && ribSites[ribCursor].index < fracture.index) {
      lastRibIndex = ribSites[ribCursor++].index;
    }
    while (otherSiteCursor < otherBoneSites.length && otherBoneSites[otherSiteCursor].index < fracture.index) {
      lastOtherSiteIndex = otherBoneSites[otherSiteCursor++].index;
    }
    if (lastRibIndex > lastOtherSiteIndex) return true;
  }
  return false;
}

function datedMedicalObservations(text) {
  const fullYear = /(?:(?<year>(?:19|20)\d{2})年)?(?<month>\d{1,2})月(?<day>\d{1,2})日/gu;
  return [...text.matchAll(fullYear)].map(match => {
    const contextStart = Math.max(0, match.index - 180);
    const priorYear = [...text.slice(contextStart, match.index).matchAll(/((?:19|20)\d{2})年/gu)].at(-1)?.[1];
    const year = Number(match.groups.year || priorYear || 0);
    const month = Number(match.groups.month);
    const day = Number(match.groups.day);
    if (!year || month < 1 || month > 12 || day < 1 || day > 31) return null;
    const timestamp = Date.UTC(year, month - 1, day);
    const date = new Date(timestamp);
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return { index: match.index, end: match.index + match[0].length, timestamp };
  }).filter(Boolean);
}

function documentsPersistentTympanicPerforation(excerpt) {
  return /(?:鼓膜)?穿孔[^。；;\n]{0,16}(?:尚未|仍未|未)(?:自行)?(?:愈合|闭合)|(?:尚未|仍未|未)(?:自行)?(?:愈合|闭合)[^。；;\n]{0,16}(?:鼓膜)?穿孔/u.test(excerpt)
    || /(?:复查|复诊|复测|图像|影像|耳镜|内镜|检查|报告)[^。；;\n]{0,48}(?:仍见|仍有|仍存在|显示|记载|提示|见)[^。；;\n]{0,32}(?:左|右|双侧)?(?:鼓膜[^。；;\n]{0,16})?穿孔/u.test(excerpt);
}

export function confirmsSixWeekUnhealedTympanicPerforation(evidence) {
  const text = normalizeInput(evidence || '');
  if (!/外伤性鼓膜穿孔/u.test(text) || /既往(?:史)?|陈旧性?|旧伤|原有|此前|曾经/u.test(text)
    || /(?:已|完全|已经)(?:自行)?愈合/u.test(text)) return false;
  const dates = datedMedicalObservations(text);
  if (dates.length < 2) return false;
  const observation = date => text.slice(date.index, Math.min(text.length, dates.find(next => next.index > date.index)?.index ?? date.index + 140));
  const initial = dates.find(date => /(?:耳镜|检查|查体|诊断|见|示)[^。；;\n]{0,48}(?:鼓膜[^。；;\n]{0,24})?穿孔/u.test(observation(date))
    && !/(?:未见|未发现|排除|否认|无)鼓膜[^。；;\n]{0,16}穿孔/u.test(observation(date)));
  if (!initial) return false;
  const followup = dates.find(date => {
    if (date.timestamp - initial.timestamp < 42 * 24 * 60 * 60 * 1000) return false;
    return documentsPersistentTympanicPerforation(observation(date));
  });
  if (!followup) return false;
  const leftEvidence = /左(?:侧)?(?:耳|鼓膜)[^。；;\n]{0,24}穿孔|左耳[^。；;\n]{0,24}鼓膜/u.test(text);
  const rightEvidence = /右(?:侧)?(?:耳|鼓膜)[^。；;\n]{0,24}穿孔|右耳[^。；;\n]{0,24}鼓膜/u.test(text);
  if (leftEvidence && rightEvidence) return false;
  return true;
}

function deriveTympanicPerforationDurationFact(text) {
  if (!confirmsSixWeekUnhealedTympanicPerforation(text)) return null;
  const dates = datedMedicalObservations(text);
  const initial = dates.find(date => /(?:耳镜|检查|查体|诊断|见|示)[^。；;\n]{0,48}(?:鼓膜[^。；;\n]{0,24})?穿孔/u.test(
    text.slice(date.index, Math.min(text.length, dates.find(next => next.index > date.index)?.index ?? date.index + 140))));
  const followup = dates.find(date => {
    if (!initial || date.timestamp - initial.timestamp < 42 * 24 * 60 * 60 * 1000) return false;
    const nextDate = dates.find(next => next.index > date.index);
    return documentsPersistentTympanicPerforation(text.slice(date.index, Math.min(text.length, nextDate?.index ?? date.index + 140)));
  });
  if (!initial || !followup || followup.index - initial.index > 1000) return null;
  const yearMention = [...text.slice(Math.max(0, initial.index - 180), initial.index).matchAll(/(?:19|20)\d{2}年/gu)].at(-1);
  const evidenceStart = yearMention ? Math.max(0, initial.index - 180) + yearMention.index : initial.index;
  const nextFollowupDate = dates.find(next => next.index > followup.index);
  const followupEnd = Math.min(text.length, nextFollowupDate?.index ?? followup.index + 140);
  const traumaDiagnosis = text.indexOf('外伤性鼓膜穿孔', followup.index);
  const evidenceEnd = traumaDiagnosis >= followupEnd && traumaDiagnosis - followup.index <= 1000
    ? Math.max(followupEnd, traumaDiagnosis + '外伤性鼓膜穿孔'.length) : followupEnd;
  return { field: 'clinical_finding', value: '外伤性鼓膜穿孔6周不能自行愈合', certainty: 'derived',
    source_type: 'user_text', source_excerpt: text.slice(evidenceStart, evidenceEnd) };
}

function normalizeGcsScoreFacts(inputText) {
  const text = normalizeInput(inputText);
  const findings = [];
  const pattern = /(?:GCS|格拉斯哥昏迷评分)\s*(?:评分|分数)?\s*[:：=]?\s*(1[0-5]|[3-9])\s*分?/giu;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    const certainty = certaintyFor(text, start, end);
    if (certainty !== 'reported' || hasNonCurrentClinicalContext(text, start, end)) continue;
    const evidence = sourceSentence(text, match[0], start) || match[0];
    findings.push({ field: 'gcs_score', value: Number(match[1]),
      certainty: hasConfoundedGcsMeasurementContext(evidence) ? 'unknown' : 'reported', source_type: 'user_text',
      source_excerpt: evidence });
  }
  return findings;
}

function hasConfoundedGcsMeasurementContext(evidence) {
  let context = normalizeInput(evidence || '');
  if (!context) return false;
  context = context.replace(/(?:未(?:使用|予以|予|行|接受|给予)?|无|否认|未见)(?:任何)?(?:全身麻醉|全麻|麻醉|镇静(?:药物|剂)?|肌松(?:药物|剂)?|气管插管|插管|机械通气|呼吸机)/gu, '');
  const scoreIndex = context.search(/(?:GCS|格拉斯哥昏迷评分)/iu);
  if (scoreIndex < 0) return false;
  const beforeScore = context.slice(0, scoreIndex);
  const confounderPattern = /(?:全身麻醉|全麻|麻醉|镇静(?:药物|剂)?|肌松(?:药物|剂)?|气管插管|插管|机械通气|呼吸机)(?:后|中|期间|状态下|情况下|过程(?:中)?|时|下)/gu;
  const confounders = [...beforeScore.matchAll(confounderPattern)];
  if (!confounders.length) return false;
  const lastConfounderEnd = confounders.at(-1).index + confounders.at(-1)[0].length;
  return !/(?:苏醒|清醒|脱离镇静|停用镇静|拔管)后[^，,；;。！？\n]{0,24}$/u.test(beforeScore.slice(lastConfounderEnd));
}

function normalizeReportedSkullFractureDiagnosisFacts(inputText) {
  const text = normalizeInput(inputText);
  const findings = [];
  const diagnosisLabel = /(?:初步|入院|出院|临床)?诊断(?:为|是|[:：])?/gu;
  const fracture = /(?:左|右|双侧)?(?:颞顶|顶枕|额顶|额颞|额枕|颞枕|额颞顶|颞枕顶|额顶枕|顶颞枕|额颞枕|顶颞)骨(?:外板|粉碎性(?:凹陷性?)?|凹陷性?(?:粉碎性)?|开放性)?骨折(?:线)?|(?:左|右|双侧)?(?:额|顶|颞|枕|蝶|筛|鼻|颧|颌)骨(?:外板|粉碎性(?:凹陷性?)?|凹陷性?(?:粉碎性)?|开放性)?骨折(?:线)?|(?:多发)?(?:粉碎(?:性|凹陷性)?|凹陷性|开放性|线性|线状)颅骨骨折(?:线)?|(?:颅底|颅骨)(?:外板|粉碎性(?:凹陷性?)?|凹陷性?(?:粉碎性)?|开放性)?骨折(?:线)?/gu;
  for (const clauseMatch of text.matchAll(/[^。；;\n]+/gu)) {
    const clause = clauseMatch[0];
    const labels = [...clause.matchAll(diagnosisLabel)];
    fracture.lastIndex = 0;
    for (const match of clause.matchAll(fracture)) {
      const end = match.index + match[0].length;
      const label = labels.findLast(item => item.index + item[0].length <= match.index);
      const directObservation = [...clause.slice(0, match.index).matchAll(/(?:可触及|触及|(?:查体|检查|阅片|术中|片)(?:可见|见|示)|(?:CT|影像(?:学)?|X线(?:片)?)(?:检查)?(?:显示|提示|示|见))/gu)].at(-1);
      if (!label && !directObservation) continue;
      const useDirectObservation = directObservation && (!label || directObservation.index > label.index);
      const evidenceStart = useDirectObservation ? directObservation.index : label.index;
      const start = useDirectObservation ? evidenceStart : label.index + label[0].length;
      const previousSeparator = Math.max(clause.lastIndexOf('、', match.index), clause.lastIndexOf('，', match.index),
        clause.lastIndexOf(',', match.index), clause.lastIndexOf(';', match.index));
      const itemStart = Math.max(start, previousSeparator + 1);
      const nextSeparator = clause.slice(end).search(/[、，,;。]/u);
      const itemEnd = nextSeparator < 0 ? clause.length : end + nextSeparator;
      if (certaintyFor(clause, itemStart, itemEnd) !== 'reported'
        || explicitNegationCoversTerm(clause, match[0])
        || hasNonCurrentClinicalContext(text, clauseMatch.index + match.index, clauseMatch.index + end)) continue;
      findings.push({ field: 'diagnosis', value: match[0], certainty: 'reported', source_type: 'user_text',
        source_excerpt: clause.slice(evidenceStart, end).trim() });
    }
  }
  return findings;
}

function normalizeVertebralFractureDiagnosisFacts(inputText) {
  const text = normalizeInput(inputText);
  const findings = [];
  const pattern = /(?:(?:第\s*[0-9零〇一二两三四五六七八九十百]+\s*(?:颈|胸|腰)?椎)|(?:腰\s*[0-9零〇一二两三四五六七八九十百]+\s*椎(?:体)?)|(?:[CTLS]\s*\d+))[^，,。；;\n]{0,16}(?:左|右|双侧)?(?:横突|棘突|椎弓根|椎弓)(?:部)?骨折/giu;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    if (certaintyForMention(text, start, end) !== 'reported' || hasNonCurrentClinicalContext(text, start, end)) continue;
    findings.push({ field: 'diagnosis', value: match[0], certainty: 'reported', source_type: 'user_text',
      source_excerpt: match[0] });
  }
  return findings;
}

function normalizeBrainCompressionEvidenceFacts(inputText) {
  const text = normalizeInput(inputText);
  const findings = [];
  const patterns = [
    { pattern: /脑疝(?:形成)?/gu, field: 'diagnosis', value: '脑疝' },
    { pattern: /中线(?:结构)?(?:偏移|移位)/gu, field: 'imaging_finding', value: '中线偏移' },
  ];
  for (const clauseMatch of text.matchAll(/[^。！？；;\n]+/gu)) {
    const clause = clauseMatch[0];
    for (const { pattern, field, value } of patterns) {
      for (const match of clause.matchAll(new RegExp(pattern.source, pattern.flags))) {
        let certainty = certaintyForMention(clause, match.index, match.index + match[0].length);
        if (certainty === 'reported' && explicitNegationCoversTerm(clause, match[0])) certainty = 'excluded';
        const start = clauseMatch.index + match.index;
        const end = start + match[0].length;
        if (historicalSectionHeading(text, start)
          || certainty !== 'excluded' && hasNonCurrentClinicalContext(text, start, end)) continue;
        findings.push({ field, value, certainty, source_type: 'user_text', source_excerpt: match[0] });
      }
    }
  }
  return findings;
}

export function hasVerifiedModerateShockEvidence(inputText) {
  const text = normalizeInput(inputText);
  if (!text || /[。！？；;\n]/u.test(text)) return false;
  const moderateShock = /(?:中度[^。！？；;\n]{0,8}休克|休克[^。！？；;\n]{0,8}中度)/u.exec(text);
  if (!moderateShock || explicitNegationCoversTerm(text, moderateShock[0])) return false;
  const diagnosisMarkers = [...text.matchAll(/(?:明确诊断|诊断)(?:为|[:：])/gu)];
  const diagnosisMarker = diagnosisMarkers.find(marker => marker.index <= moderateShock.index
    && moderateShock.index - marker.index <= 32);
  if (!diagnosisMarker) return false;
  const injuryCausesShock = /(?:本次|此次|本案)(?:外伤|损伤|创伤|刀伤|刺伤|砍伤|殴打|车祸|交通事故)[^。！？；;\n]{0,16}(?:所致|引起|导致|造成|致|引发)[^。！？；;\n]{0,16}(?:中度[^。！？；;\n]{0,8}休克|休克[^。！？；;\n]{0,8}中度)/u;
  const shockCausedByCurrentInjury = /(?:中度[^。！？；;\n]{0,8}休克|休克[^。！？；;\n]{0,8}中度)[^。！？；;\n]{0,16}(?:由|系)(?:本次|此次|本案)[^。！？；;\n]{0,8}(?:外伤|损伤|创伤|刀伤|刺伤|砍伤|殴打|车祸|交通事故)[^。！？；;\n]{0,8}(?:所致|引起|导致|造成)/u;
  const causalLink = injuryCausesShock.exec(text) || shockCausedByCurrentInjury.exec(text);
  if (!causalLink) return false;
  const relevantStart = Math.max(0, Math.min(diagnosisMarker.index, causalLink.index) - 12);
  const relevantEnd = Math.max(moderateShock.index + moderateShock[0].length,
    causalLink.index + causalLink[0].length);
  const relevantEvidence = text.slice(relevantStart, relevantEnd);
  if (certaintyFor(text, relevantStart, relevantEnd) !== 'reported'
    || hasUnresolvedOtherExperiencer(relevantEvidence)
    || /(?:既往史|既往|既有|陈旧|原有|此前|曾经|术前)/u.test(relevantEvidence)
    || hasNonCurrentClinicalContext(text, moderateShock.index, moderateShock.index + moderateShock[0].length)) return false;
  return true;
}

function normalizeClinicalFindingFacts(inputText) {
  const text = normalizeInput(inputText);
  const findings = [];
  const explicitSevereHeadFindings = [
    /(?:外伤性|创伤性)蛛网膜下腔出血/gu,
    /(?:外伤性|创伤性)迟发性癫痫/gu,
    /(?:广泛性|多发性)?脑挫(?:裂)?伤/gu,
    /(?:神志|意识)(?:浅|深)?昏迷|(?:神志|意识)(?:不清|模糊|障碍)|昏迷/gu,
    /嗜睡|瞳孔不等大|(?:(?:左|右|双侧)侧?)?(?:瞳孔)?(?:对光反射|光反射)(?:迟钝|消失)|(?:不能|无法)按(?:吩咐|指令|命令)动作/gu,
    /病理反射阳性|病理征阳性|Babinski征阳性/gu,
  ];
  for (const match of text.matchAll(/[^。；;\n]+/gu)) {
    const clause = match[0].trim();
    const clauseOffset = match.index + match[0].indexOf(clause);
    const moderateShock = /(?:中度[^。！？；;\n]{0,8}休克|休克[^。！？；;\n]{0,8}中度)/u.exec(clause);
    if (hasVerifiedModerateShockEvidence(clause) && moderateShock
      && !hasNonCurrentClinicalContext(text, clauseOffset + moderateShock.index,
        clauseOffset + moderateShock.index + moderateShock[0].length)) {
      findings.push({ field: 'clinical_finding', value: '各种损伤引起休克(中度)', certainty: 'reported',
        source_type: 'user_text', source_excerpt: clause.slice(0, MAX_FACT_EVIDENCE_CHARS) });
    }
    const renalOperations = [
      { pattern: /(?:左侧|右侧|左|右|单侧|一侧)?肾(?:脏)?切除术/gu, value: '一侧肾切除术后' },
      { pattern: /(?:左侧|右侧|左|右)?肾(?:脏)?修补术/gu, value: '肾修补术后' },
    ];
    for (const { pattern, value } of renalOperations) for (const operation of clause.matchAll(pattern)) {
      const start = clauseOffset + operation.index;
      const end = start + operation[0].length;
      const performed = /(?:手术记录|手术中|行|施行|实施|接受|进行|已做|完成)/u.test(clause)
        && !/(?:未行|未实施|拟行|计划|建议|考虑|拒绝|尚未)/u.test(clause);
      if (!performed || certaintyFor(clause, operation.index, operation.index + operation[0].length) !== 'reported'
        || hasNonCurrentClinicalContext(text, start, end)) continue;
      findings.push({ field: 'clinical_finding', value, certainty: 'reported', source_type: 'user_text',
        source_excerpt: clause.trim().slice(-MAX_FACT_EVIDENCE_CHARS) });
    }
    for (const pattern of explicitSevereHeadFindings) {
      for (const headFinding of clause.matchAll(new RegExp(pattern.source, pattern.flags))) {
        const start = clauseOffset + headFinding.index;
        const end = start + headFinding[0].length;
        const value = headFinding[0];
        if (certaintyForMention(clause, headFinding.index, headFinding.index + headFinding[0].length) !== 'reported'
          || explicitNegationCoversTerm(clause, value)
          || hasNonCurrentClinicalContext(text, start, end)
          || findings.some(fact => fact.field === 'clinical_finding' && fact.value === value
            && fact.source_excerpt === value)) continue;
        findings.push({ field: 'clinical_finding', value, certainty: 'reported', source_type: 'user_text',
          source_excerpt: value });
      }
    }
    const explicitEyeAtrophy = /眼球萎缩(?:塌陷)?/gu;
    for (const eyeAtrophy of clause.matchAll(explicitEyeAtrophy)) {
      const start = clauseOffset + eyeAtrophy.index;
      const end = start + eyeAtrophy[0].length;
      const certainty = certaintyFor(clause, eyeAtrophy.index, Math.min(clause.length, eyeAtrophy.index + eyeAtrophy[0].length + 8));
      const negatesAtrophy = /(?:未见|没有|无|否认|不伴(?:有)?)\s*(?:(?:左|右|双侧|一侧)\s*)?眼球萎缩|眼球萎缩(?:未见|不存在|已排除)/u
        .test(clause.slice(Math.max(0, eyeAtrophy.index - 18), Math.min(clause.length, end + 12)));
      if (certainty !== 'reported' || negatesAtrophy
        || hasNonCurrentClinicalContext(text, start, end)
        || findings.some(fact => fact.field === 'clinical_finding' && fact.value === eyeAtrophy[0]
          && fact.source_excerpt === eyeAtrophy[0])) continue;
      findings.push({ field: 'clinical_finding', value: eyeAtrophy[0], certainty, source_type: 'user_text',
        source_excerpt: eyeAtrophy[0] });
    }
    const explicitEyeHemorrhages = /玻璃体(?:混浊\/积血|积血|出血)|视网膜前出血|视网膜出血/gu;
    for (const eyeFinding of clause.matchAll(explicitEyeHemorrhages)) {
      const start = clauseOffset + eyeFinding.index;
      const end = start + eyeFinding[0].length;
      const certainty = certaintyFor(clause, eyeFinding.index, clause.length);
      if (certainty !== 'reported' || explicitNegationCoversTerm(clause, eyeFinding[0])
        || hasNonCurrentClinicalContext(text, start, end)
        || findings.some(fact => fact.field === 'clinical_finding' && fact.value === eyeFinding[0]
          && fact.source_excerpt === eyeFinding[0])) continue;
      findings.push({ field: 'clinical_finding', value: eyeFinding[0], certainty, source_type: 'user_text',
        source_excerpt: eyeFinding[0] });
    }
    const pupilMeasurements = [
      /左(?:侧)?瞳孔(?:直径)?\s*(?:为|[:：])?\s*(\d+(?:\.\d+)?)\s*(?:mm|毫米)[^。！？；;\n]{0,18}右(?:侧)?瞳孔(?:直径)?\s*(?:为|[:：])?\s*(\d+(?:\.\d+)?)\s*(?:mm|毫米)/gu,
      /右(?:侧)?瞳孔(?:直径)?\s*(?:为|[:：])?\s*(\d+(?:\.\d+)?)\s*(?:mm|毫米)[^。！？；;\n]{0,18}左(?:侧)?瞳孔(?:直径)?\s*(?:为|[:：])?\s*(\d+(?:\.\d+)?)\s*(?:mm|毫米)/gu,
    ];
    for (const pattern of pupilMeasurements) for (const measurement of clause.matchAll(pattern)) {
      const start = clauseOffset + measurement.index;
      const end = start + measurement[0].length;
      if (Number(measurement[1]) === Number(measurement[2])
        || certaintyFor(clause, measurement.index, measurement.index + measurement[0].length) !== 'reported'
        || explicitNegationCoversTerm(clause, '瞳孔不等大')
        || hasNonCurrentClinicalContext(text, start, end)) continue;
      findings.push({ field: 'clinical_finding', value: '瞳孔不等大', certainty: 'derived', source_type: 'derived',
        source_excerpt: measurement[0] });
    }
    const explicitBrainFindings = [
      /(?<evidence>(?<value>(?:(?:左侧|右侧|双侧|左|右)?基底节(?:区)?(?:脑)?|(?:(?:左侧|右侧|双侧|左|右)?(?:丘脑|脑干|小脑)(?:区)?|(?:左|右|双侧)?(?:额|顶|颞|枕)叶)(?:内)?)(?:出血|血肿)))/gu,
      /(?<evidence>(?:(?:左|右|双侧)?(?:额|顶|颞|枕)叶|脑)[^，,。；;\n]{0,6}?(?<value>局部挫伤出血|挫伤出血|(?:脑挫|挫)(?:裂)?伤(?:伴(?:脑内)?(?:出血|血肿))?))/gu,
      /(?<evidence>(?:(?:左|右|双侧)?(?:额|顶|颞|枕)(?:叶|部)|脑)[^，,。；;\n]{0,6}?(?<value>硬膜下血肿|硬膜外血肿|蛛网膜下腔出血|脑内(?:出血|血肿)))/gu,
      /(?<evidence>(?<value>蛛网膜下腔出血|脑内(?:出血|血肿)))/gu,
    ];
    for (const pattern of explicitBrainFindings) for (const brainFinding of clause.matchAll(pattern)) {
      const start = clauseOffset + brainFinding.index;
      const end = start + brainFinding.groups.evidence.length;
      if (findings.some(fact => fact.field === 'clinical_finding'
        && fact.value === brainFinding.groups.value
        && fact.source_excerpt?.includes(brainFinding.groups.evidence))) continue;
      if (certaintyFor(clause, brainFinding.index, brainFinding.index + brainFinding.groups.evidence.length) !== 'reported'
        || hasNonCurrentClinicalContext(text, start, end)) continue;
      findings.push({ field: 'clinical_finding', value: brainFinding.groups.value, certainty: 'reported',
        source_type: 'user_text', source_excerpt: brainFinding.groups.evidence });
    }
    const explicitHeadInjuries = /(?:头部|头颅|颅脑)(?:外伤|损伤|受伤)/gu;
    for (const headInjury of clause.matchAll(explicitHeadInjuries)) {
      const start = clauseOffset + headInjury.index;
      const end = start + headInjury[0].length;
      if (certaintyFor(clause, headInjury.index, headInjury.index + headInjury[0].length) !== 'reported'
        || explicitNegationCoversTerm(clause, headInjury[0])
        || hasNonCurrentClinicalContext(text, start, end)
        || findings.some(fact => fact.field === 'clinical_finding' && fact.value === headInjury[0]
          && fact.source_excerpt === headInjury[0])) continue;
      findings.push({ field: 'clinical_finding', value: headInjury[0], certainty: 'reported',
        source_type: 'user_text', source_excerpt: headInjury[0] });
    }
    const brainCompressionPattern = /(?<evidence>(?<value>(?:(?:左|右|双侧|两侧)?(?:侧)?脑室|脑组织|脑实质)(?:受压|压迫)(?:变形|狭窄|变窄|移位)?))/gu;
    for (const compression of clause.matchAll(brainCompressionPattern)) {
      const start = clauseOffset + compression.index;
      const end = start + compression.groups.evidence.length;
      if (certaintyFor(clause, compression.index, compression.index + compression.groups.evidence.length) !== 'reported'
        || hasNonCurrentClinicalContext(text, start, end)
        || findings.some(fact => fact.field === 'clinical_finding' && fact.value === compression.groups.value
          && fact.source_excerpt === compression.groups.evidence)) continue;
      findings.push({ field: 'clinical_finding', value: compression.groups.value, certainty: 'reported',
        source_type: 'user_text', source_excerpt: compression.groups.evidence });
    }
    if (certaintyFor(clause, 0, clause.length) !== 'reported') continue;
    const skullBaseCsfLeak = /(?:颅底骨折|中颅凹骨折)[^，,。；;\n]{0,16}脑脊液(?:耳漏|鼻漏|漏)|脑脊液(?:耳漏|鼻漏|漏)[^，,。；;\n]{0,16}(?:颅底骨折|中颅凹骨折)/u.exec(clause);
    if (skullBaseCsfLeak) {
      const leakTerm = /脑脊液(?:耳漏|鼻漏|漏)/u.exec(skullBaseCsfLeak[0])?.[0] || '';
      const skullBaseTerm = /(?:颅底骨折|中颅凹骨折)/u.exec(skullBaseCsfLeak[0])?.[0] || '';
      if (leakTerm && skullBaseTerm && !explicitNegationCoversTerm(clause, leakTerm)
        && !explicitNegationCoversTerm(clause, skullBaseTerm)
        && !hasNonCurrentClinicalContext(text, clauseOffset + skullBaseCsfLeak.index,
          clauseOffset + skullBaseCsfLeak.index + skullBaseCsfLeak[0].length)) {
        findings.push({ field: 'clinical_finding', value: '颅底骨折伴脑脊液漏', certainty: 'reported',
          source_type: 'user_text', source_excerpt: skullBaseCsfLeak[0] });
      }
    }
    const eyeGlobeLoss = /(?:一侧|左|右)(?:侧)?眼(?:球)?(?:已|已经)摘除|(?:一侧|左|右)(?:侧)?眼球缺失|一侧眼球萎缩|(?:行|实施|接受)(?:了)?(?:一侧|单侧|左|右)(?:侧)?眼(?:球)?摘除(?:术)?/u.exec(clause);
    if (eyeGlobeLoss && !hasNonCurrentClinicalContext(text, clauseOffset + eyeGlobeLoss.index,
      clauseOffset + eyeGlobeLoss.index + eyeGlobeLoss[0].length)) {
      findings.push({ field: 'clinical_finding', value: /萎缩/u.test(eyeGlobeLoss[0]) ? '一侧眼球萎缩' : '一侧眼球缺失',
        certainty: 'reported', source_type: 'user_text',
        source_excerpt: evidenceExcerptForScope(text, clause, clauseOffset + eyeGlobeLoss.index, eyeGlobeLoss[0].length) });
    }
    const subgalealHematomaArea = /帽状腱膜下血肿[^。；;\n]{0,120}?(?:血肿)?(?:范围|面积)[^。；;\n]{0,24}?(\d+(?:\.\d+)?)\s*(?:cm\s*2|平方厘米)(?:以上|及以上)?/u.exec(clause);
    if (subgalealHematomaArea) {
      const measurement = Number(subgalealHematomaArea[1]);
      const measurementContext = clause.slice(subgalealHematomaArea.index,
        subgalealHematomaArea.index + subgalealHematomaArea[0].length);
      const areaMarker = Math.max(measurementContext.lastIndexOf('范围'), measurementContext.lastIndexOf('面积'));
      const areaQualifierContext = measurementContext.slice(Math.max(0, areaMarker));
      const measurementStart = subgalealHematomaArea.index + subgalealHematomaArea[0].lastIndexOf(subgalealHematomaArea[1]);
      const measurementEnd = measurementStart + subgalealHematomaArea[1].length;
      if (measurement >= 50 && !/约|大约|左右|接近|不超过|不足|未达|小于|低于/u.test(areaQualifierContext)
        && !hasNonCurrentClinicalContext(text, clauseOffset + subgalealHematomaArea.index, clauseOffset + measurementEnd)) {
        findings.push({ field: 'clinical_finding', value: '帽状腱膜下血肿范围50.0cm2以上', certainty: 'reported',
          source_type: 'user_text', source_excerpt: clause.trim() });
      }
    }
    const correctedAcuityPattern = /(右|左)眼[^，,。；;\n]{0,8}?矫正视力\s*(?:为|[:：])?\s*(\d+(?:\.\d+)?)(?![\d.])(?=\s*(?:[，,。；;）)\]]|$))/gu;
    for (const acuity of clause.matchAll(correctedAcuityPattern)) {
      const side = acuity[1];
      const acuityValue = Number(acuity[2]);
      const start = clauseOffset + acuity.index;
      const end = start + acuity[0].length;
      if (acuityValue <= 0.5 && hasSameEyeInjuryContext(side, clause.slice(0, acuity.index + acuity[0].length))
        && certaintyFor(clause, acuity.index, acuity.index + acuity[0].length) === 'reported'
        && !hasNonCurrentClinicalContext(text, start, end)) {
        const evidenceStart = Math.max(0, acuity.index - 64);
        findings.push({ field: 'clinical_finding', value: '一眼矫正视力减退至0.5以下', certainty: 'reported',
          source_type: 'user_text', source_excerpt: clause.slice(evidenceStart, acuity.index + acuity[0].length).trim() });
      }
    }
    const completedProcedure = (pattern, requireAdult = false, requireCompletedCue = false) => {
      const procedure = [...clause.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))]
        .find(candidate => !hasNonCurrentClinicalContext(text, clauseOffset + candidate.index,
          clauseOffset + candidate.index + candidate[0].length));
      if (!procedure) return null;
      if (requireCompletedCue) {
        const prefix = clause.slice(Math.max(0, procedure.index - 20), procedure.index);
        if (/(?:拟|计划|建议|考虑|可能|需|须|将|准备)[^。；;\n]{0,12}$/u.test(prefix)
          || !/(?:已|已经)?(?:行|施行|实施|接受|进行|完成|做)(?:了)?[^。；;\n]{0,8}$/u.test(prefix)) return null;
      }
      const adultCue = requireAdult ? clause.match(/(?:成年人|成人|年满\s*18\s*周岁|18\s*岁以上)/u) : null;
      if (requireAdult && !adultCue) return null;
      const causeCue = [...clause.slice(0, procedure.index).matchAll(/本次(?:事故|外伤)|此次(?:事故|外伤)|因(?:本次)?(?:交通)?事故|因(?:本次)?外伤|(?:事故|外伤)(?:所致|导致)/gu)].at(-1);
      const start = requireAdult ? adultCue.index : causeCue?.index ?? Math.max(0, procedure.index - 160);
      const end = procedure.index + procedure[0].length;
      if (requireAdult && end - start > 1000) return null;
      const evidenceStart = end - Math.min(1000, end - start);
      return { evidence: clause.slice(requireAdult ? start : evidenceStart, end) };
    };
    const spleenRemoval = completedProcedure(/脾(?:脏)?(?:全|全部|完全)?切除术/u, true);
    if (spleenRemoval
      && !/脾.{0,4}部分切除/u.test(clause)) {
      findings.push({ field: 'clinical_finding', value: '成年人脾切除术后', certainty: 'reported',
        source_type: 'user_text', source_excerpt: spleenRemoval.evidence });
    }
    const kidneyRemoval = completedProcedure(/(?:一侧|单侧|左(?:侧)?|右(?:侧)?)\s*肾(?:脏)?(?:全)?切除术?/u, false, true);
    if (kidneyRemoval
      && !/双侧.{0,4}肾.{0,3}切除/.test(clause)) {
      findings.push({ field: 'clinical_finding', value: '一侧肾切除术后', certainty: 'reported',
        source_type: 'user_text', source_excerpt: kidneyRemoval.evidence });
    }
    const kidneyRepair = completedProcedure(/肾(?:脏)?修补术?/u, false, true);
    if (kidneyRepair) {
      findings.push({ field: 'clinical_finding', value: '肾修补术后', certainty: 'reported',
        source_type: 'user_text', source_excerpt: kidneyRepair.evidence });
    }
    const chestWallPenetration = completedProcedure(/胸壁.{0,8}(?:穿透创|贯通伤)|(?:穿透创|贯通伤).{0,8}胸壁/u);
    if (chestWallPenetration) {
      findings.push({ field: 'clinical_finding', value: '胸壁穿透创', certainty: 'reported',
        source_type: 'user_text', source_excerpt: chestWallPenetration.evidence });
    }
    const parotidTransection = /(?:横断|切断|断裂)腮腺|腮腺(?:实质)?(?:横断|切断|断裂)/u.exec(clause);
    if (parotidTransection && !hasNonCurrentClinicalContext(text,
      clauseOffset + parotidTransection.index, clauseOffset + parotidTransection.index + parotidTransection[0].length)) {
      findings.push({ field: 'clinical_finding', value: '腮腺实质性损伤', certainty: 'reported',
        source_type: 'user_text', source_excerpt: parotidTransection[0] });
    }
    const gradeOneMouthOpeningDifficulty = /张口困难\s*(?:Ⅰ|I|一)\s*度/u.exec(clause);
    if (gradeOneMouthOpeningDifficulty && !hasNonCurrentClinicalContext(text,
      clauseOffset + gradeOneMouthOpeningDifficulty.index,
      clauseOffset + gradeOneMouthOpeningDifficulty.index + gradeOneMouthOpeningDifficulty[0].length)) {
      findings.push({ field: 'clinical_finding', value: '损伤致张口困难I度', certainty: 'reported',
        source_type: 'user_text', source_excerpt: gradeOneMouthOpeningDifficulty[0] });
    }
    for (const symptom of ['听力下降', '听力减退', '听力丧失', '耳鸣', '耳聋', '耳痛', '头晕', '眩晕', '头痛',
      '视物模糊', '视力下降', '溢泪', '流泪', '肿胀', '麻木', '活动受限', '恶心', '呕吐', '咳嗽', '胸闷', '气促', '呼吸困难', '疼痛']) {
      for (const occurrence of clause.matchAll(new RegExp(symptom, 'gu'))) {
        const start = clauseOffset + occurrence.index;
        const end = start + occurrence[0].length;
        if (certaintyFor(clause, occurrence.index, occurrence.index + occurrence[0].length) !== 'reported'
          || explicitNegationCoversTerm(clause, symptom)
          || hasNonCurrentClinicalContext(text, start, end)) continue;
        findings.push({ field: 'symptom', value: symptom, certainty: 'reported', source_type: 'user_text',
          source_excerpt: symptom });
      }
    }
  }
  const tympanicDuration = deriveTympanicPerforationDurationFact(text);
  if (tympanicDuration) findings.push(tympanicDuration);
  return findings;
}

const pericardialRuptureEvidencePattern = /心包(?:膜)?(?:(?!(?:心脏|(?:右|左|双侧)?心室|(?:右|左|双侧)?心房|右室|左室|肺|胸膜|纵隔|大血管|肝|肾|脾|腹膜))[^，,。！？；;\n]){0,24}?(?:破裂|破口|裂口|裂伤|撕裂|裂开|破损|刺破|穿孔)/u;
const cardiacRuptureEvidencePattern = /(?:(?:心脏|(?:右|左|双侧)?心室|(?:右|左|双侧)?心房|右室|左室)[^，,。！？；;\n]{0,24}(?:破裂|破口|裂口|穿通伤|穿透伤|裂伤|撕裂|刺破|穿孔)|(?:破裂|破口|裂口|穿通伤|穿透伤|裂伤|撕裂|刺破|穿孔)[^，,。！？；;\n]{0,18}(?:心脏|(?:右|左|双侧)?心室|(?:右|左|双侧)?心房|右室|左室))/u;
const pericardialRuptureAbsentPattern = /(?:心包(?:膜)?[^，,。！？；;\n]{0,16}(?:未破裂|没有破裂|无破裂|未见(?:破裂|破口|裂口|裂伤)|排除(?:破裂|破口|裂口|裂伤))|(?:未|没有|无|否认|排除)(?:见)?[^，,。！？；;\n]{0,8}心包(?:膜)?[^，,。！？；;\n]{0,12}(?:破裂|破口|裂口|裂伤|撕裂|穿孔))/u;
const cardiacRuptureAbsentPattern = /(?:(?:心脏|(?:右|左|双侧)?心室|(?:右|左|双侧)?心房|右室|左室)[^，,。！？；;\n]{0,16}(?:未破裂|没有破裂|无破裂|未见(?:破裂|破口|裂口|穿通伤|裂伤)|排除(?:破裂|破口|裂口|穿通伤|裂伤))|(?:未|没有|无|否认|排除)(?:见)?[^，,。！？；;\n]{0,8}(?:心脏|(?:右|左|双侧)?心室|(?:右|左|双侧)?心房|右室|左室)[^，,。！？；;\n]{0,12}(?:破裂|破口|裂口|穿通伤|穿透伤|裂伤|撕裂|穿孔))/u;
const cardiacWallNotPenetratedPattern = /(?:(?:心脏|(?:右|左|双侧)?心室|右室|左室)[^。！？；;\n]{0,28}(?:未|没有|并未)(?:穿透|穿入|贯穿)[^，,。！？；;\n]{0,12}(?:心腔|心脏|心室)|(?:未|没有|并未)(?:穿透|穿入|贯穿)[^，,。！？；;\n]{0,12}(?:心腔|心脏|心室))/u;
const cardiacSitePattern = /双侧心室|双侧心房|右心室|左心室|右心房|左心房|右室|左室|心室|心房|心脏/gu;

function sameCardiacSite(left, right) {
  if (!left || !right) return false;
  const side = value => /^(?:左|右|双侧)/u.exec(value)?.[0] || '';
  const region = value => value.replace(/^(?:左|右|双侧)/u, '');
  return region(left) === region(right) && (!side(left) || !side(right) || side(left) === side(right));
}

function cardiacWallNotPenetratedForMatch(clause, match) {
  const matchSite = [...match[0].matchAll(cardiacSitePattern)].at(-1)?.[0];
  for (const negative of clause.matchAll(new RegExp(cardiacWallNotPenetratedPattern.source, 'gu'))) {
    const distance = Math.min(Math.abs(negative.index - (match.index + match[0].length)),
      Math.abs(match.index - (negative.index + negative[0].length)));
    if (distance > 48) continue;
    const negativeSite = [...negative[0].matchAll(cardiacSitePattern)].at(-1)?.[0];
    if (matchSite && negativeSite && !sameCardiacSite(matchSite, negativeSite)) continue;
    const between = negative.index < match.index
      ? clause.slice(negative.index + negative[0].length, match.index)
      : clause.slice(match.index + match[0].length, negative.index);
    if (!negativeSite && matchSite
      && [...between.matchAll(cardiacSitePattern)].some(site => sameCardiacSite(site[0], matchSite))) continue;
    return negative;
  }
  return null;
}

function hasDirectCardiacRuptureSupport(value, evidence) {
  const pattern = value === '心包破裂' ? pericardialRuptureEvidencePattern
    : value === '心脏破裂' ? cardiacRuptureEvidencePattern : null;
  if (!pattern) return false;
  const directMorphology = value === '心包破裂'
    ? /(?:全层|破口|裂口|裂伤|撕裂|刺破|穿孔)/u
    : /(?:穿通伤|穿透伤|破口|裂口|裂伤|撕裂|刺破|穿孔)/u;
  const explicitDiagnosis = /(?:诊断|确诊|病理|影像|CT|超声|报告)(?:明确记载|明确诊断为|诊断为|提示为|提示|示|为|记载)?[^，,。！？；;\n]{0,24}(?:心脏|心包|(?:右|左|双侧)?心室|(?:右|左|双侧)?心房|右室|左室)[^，,。！？；;\n]{0,16}(?:破裂|破口|裂口|裂伤|撕裂|刺破|穿孔)/u;
  return String(evidence || '').split(/[。！？；;\n]/u).some(segment => {
    if (!pattern.test(segment)) return false;
    const procedureContext = /(?:拟行|拟施行|计划|建议|手术名称|手术记录|术后|修补术|修复术|缝合术)/u.test(segment);
    return !procedureContext || explicitDiagnosis.test(segment) || directMorphology.test(segment);
  });
}

export function isCanonicalCardiacRuptureEvidence(value, evidence) {
  const text = normalizeInput(evidence);
  if (!text || /(?:既往史|既往|既有|陈旧|原有|此前|曾经|术前)/u.test(text)) return false;
  if (value === '心包破裂') return hasDirectCardiacRuptureSupport(value, text);
  if (value === '心脏破裂') return hasDirectCardiacRuptureSupport(value, text)
    && !cardiacWallNotPenetratedPattern.test(text);
  return false;
}

function normalizeCardiacRuptureFacts(inputText) {
  const text = normalizeInput(inputText);
  const findings = [];
  const patterns = [
    { pattern: pericardialRuptureEvidencePattern, value: '心包破裂', cardiac: false },
    { pattern: cardiacRuptureEvidencePattern, value: '心脏破裂', cardiac: true },
  ];
  for (const { pattern, value, cardiac } of patterns) {
    for (const clauseMatch of text.matchAll(/[^。！？；;\n]+/gu)) {
      const clause = clauseMatch[0];
      for (const match of clause.matchAll(new RegExp(pattern.source, 'gu'))) {
        const absoluteStart = clauseMatch.index + match.index;
        const absoluteEnd = absoluteStart + match[0].length;
        if (hasNonCurrentClinicalContext(text, absoluteStart, absoluteEnd)) continue;
        const commaBoundaries = ['，', ','];
        const leftBoundary = Math.max(...commaBoundaries.map(delimiter => clause.lastIndexOf(delimiter, match.index - 1))) + 1;
        const rightBoundary = commaBoundaries.map(delimiter => {
          const index = clause.indexOf(delimiter, match.index + match[0].length);
          return index < 0 ? clause.length : index;
        }).reduce((minimum, index) => Math.min(minimum, index), clause.length);
        const localContext = clause.slice(leftBoundary, rightBoundary).trim();
        let certainty = certaintyFor(localContext, 0, localContext.length);
        const nonPenetratingHeartWound = cardiac ? cardiacWallNotPenetratedForMatch(clause, match) : null;
        const explicitlyAbsent = (cardiac ? cardiacRuptureAbsentPattern : pericardialRuptureAbsentPattern)
          .test(localContext);
        if (certainty === 'reported' && !explicitlyAbsent && !nonPenetratingHeartWound
          && !isCanonicalCardiacRuptureEvidence(value, localContext)) continue;
        if ((nonPenetratingHeartWound || explicitlyAbsent) && certainty === 'reported') certainty = 'excluded';
        const sourceExcerpt = certainty === 'reported' ? match[0]
          : nonPenetratingHeartWound ? clause.slice(Math.min(match.index, nonPenetratingHeartWound.index),
            Math.max(match.index + match[0].length,
              nonPenetratingHeartWound.index + nonPenetratingHeartWound[0].length)).trim() : localContext;
        if (!findings.some(fact => fact.value === value && fact.certainty === certainty
          && fact.source_excerpt === sourceExcerpt)) {
          findings.push({ field: 'clinical_finding', value, certainty, source_type: 'user_text',
            source_excerpt: sourceExcerpt });
        }
      }
    }
  }
  return findings;
}

function normalizeGastrointestinalNonFullThicknessRuptureFacts(inputText) {
  const text = normalizeInput(inputText);
  const findings = [];
  const pattern = /(?<site>胃|小肠|大肠|结肠|直肠|肠|胆囊|胆道)[^。！？；;\n]{0,24}?(?:非全层破裂|浆膜(?:层)?[^。！？；;\n]{0,12}(?:破裂|裂伤)|浆肌层[^。！？；;\n]{0,12}(?:破裂|裂伤)|肌层[^。！？；;\n]{0,12}(?:破裂|裂伤))/gu;
  for (const clauseMatch of text.matchAll(/[^。！？；;\n]+/gu)) {
    const clause = clauseMatch[0];
    for (const match of clause.matchAll(pattern)) {
      const start = clauseMatch.index + match.index;
      const end = start + match[0].length;
      if (certaintyFor(clause, match.index, match.index + match[0].length) !== 'reported'
        || /全层破裂/u.test(match[0]) || hasNonCurrentClinicalContext(text, start, end)) continue;
      const value = /^(?:胃)$/u.test(match.groups.site) ? '胃非全层破裂'
        : /^(?:胆囊)$/u.test(match.groups.site) ? '胆囊非全层破裂'
          : /^(?:胆道)$/u.test(match.groups.site) ? '胆道非全层破裂' : '肠非全层破裂';
      findings.push({ field: 'clinical_finding', value, certainty: 'reported', source_type: 'user_text',
        source_excerpt: match[0].trim() });
    }
  }
  return findings;
}

function normalizeGastrointestinalFullThicknessRuptureFacts(inputText) {
  const text = normalizeInput(inputText);
  const findings = [];
  const pattern = /(?<site>十二指肠|乙状结肠|小肠|大肠|结肠|直肠|胃壁|胃|胆囊|胆总管|胆管|胆道|肠)[^。！？；;\n]{0,24}?(?:全层[^。！？；;\n]{0,8}(?:破裂|裂口|裂伤|破口|撕裂)|(?:破裂|裂口|裂伤|破口|撕裂)[^。！？；;\n]{0,8}全层)/gu;
  const valueForSite = site => /^(?:胃壁|胃)$/u.test(site) ? '胃全层破裂'
    : /^(?:胆囊)$/u.test(site) ? '胆囊全层破裂'
      : /^(?:胆总管|胆管|胆道)$/u.test(site) ? '胆道全层破裂' : '肠全层破裂';
  for (const clauseMatch of text.matchAll(/[^。！？；;\n]+/gu)) {
    const clause = clauseMatch[0];
    for (const match of clause.matchAll(pattern)) {
      const start = clauseMatch.index + match.index;
      const end = start + match[0].length;
      if (certaintyFor(text, start, end) !== 'reported' || hasNonCurrentClinicalContext(text, start, end)
        || /(?:非全层|仅见.{0,8}(?:浆膜|肌层)|未见全层)/u.test(match[0])) continue;
      findings.push({ field: 'clinical_finding', value: valueForSite(match.groups.site), certainty: 'reported',
        source_type: 'user_text', source_excerpt: match[0].trim() });
    }
  }
  return findings;
}

export function normalizeImplantedProsthesisDamageFacts(inputText) {
  const text = normalizeInput(inputText);
  const aliases = '(?:颅骨修补材料|人工晶体|义眼座|固定义齿|种植牙|阴茎假体|人工关节|起搏器|支架)';
  const injuryCue = [...text.matchAll(/(?:本次|此次)(?:交通)?(?:事故|外伤|受伤|损伤)|(?:19|20)\d{2}年[^。；;\n]{0,32}被[^。；;\n]{0,8}(?:拳击|殴打|击打|打伤)/gu)]
    .find(match => !hasNonCurrentClinicalContext(text, match.index, match.index + match[0].length));
  if (!injuryCue) return [];
  const damagePattern = new RegExp(`(${aliases})[^。；;\\n]{0,56}(?:损坏|破损|破裂|缺损|脱位|脱出)`, 'gu');
  const repairPattern = new RegExp(`(${aliases})[^。；;\\n]{0,56}(?:(?:手术|术)[^。；;\\n]{0,12}(?:更换|修补|修复)|(?:更换|修补|修复)[^。；;\\n]{0,12}(?:手术|术))`, 'gu');
  const damages = [...text.matchAll(damagePattern)];
  const repairs = [...text.matchAll(repairPattern)];
  const damage = damages.find(match => match.index > injuryCue.index && certaintyFor(text, match.index,
    match.index + match[0].length) === 'reported'
    && !hasNonCurrentClinicalContext(text, match.index, match.index + match[0].length));
  if (!damage) return [];
  const repair = repairs.find(match => match.index > damage.index && match[1] === damage[1]
    && certaintyFor(text, match.index, match.index + match[0].length) === 'reported'
    && !hasNonCurrentClinicalContext(text, match.index, match.index + match[0].length));
  if (!repair) return [];
  const damageEvidence = text.slice(injuryCue.index, damage.index + damage[0].length);
  const repairEvidence = text.slice(injuryCue.index, repair.index + repair[0].length);
  return [
    { field: 'clinical_finding', value: '置入式假体装置损坏', certainty: 'reported',
      source_type: 'user_text', source_excerpt: damageEvidence },
    { field: 'clinical_finding', value: '置入式假体装置需要手术修复', certainty: 'reported',
      source_type: 'user_text', source_excerpt: repairEvidence },
  ];
}

function normalizeNasalSeptumCombinationFacts(inputText) {
  const text = normalizeInput(inputText);
  const findings = [];
  const pattern = /鼻骨骨折[^。；;\n]{0,24}(?:合并|伴|及|和|与|、|，|,)[^。；;\n]{0,12}鼻中隔骨折/gu;
  for (const clauseMatch of text.matchAll(/[^。；;\n]+/gu)) {
    const clause = clauseMatch[0];
    for (const match of clause.matchAll(pattern)) {
      if (certaintyForMention(clause, match.index, match.index + match[0].length) !== 'reported'
        || hasNonCurrentClinicalContext(text, clauseMatch.index + match.index,
          clauseMatch.index + match.index + match[0].length)) continue;
      findings.push({ field: 'diagnosis', value: '鼻骨骨折合并鼻中隔骨折', certainty: 'reported',
        source_type: 'user_text', source_excerpt: match[0].trim() });
    }
  }
  return findings;
}

function normalizeNasalFrontalProcessCombinationFacts(inputText) {
  const text = normalizeInput(inputText);
  const findings = [];
  const pattern = /(?:鼻骨骨折[^。；;\n]{0,24}(?:合并|伴|及|和|与|、|，|,)[^。；;\n]{0,12}上颌骨额突(?:部)?骨折|上颌骨额突(?:部)?骨折[^。；;\n]{0,24}(?:合并|伴|及|和|与|、|，|,)[^。；;\n]{0,12}鼻骨骨折)/gu;
  for (const clauseMatch of text.matchAll(/[^。！？；;\n]+/gu)) {
    const clause = clauseMatch[0];
    for (const match of clause.matchAll(pattern)) {
      const site = /上颌骨额突(?:部)?骨折/u.exec(match[0]);
      if (!site) continue;
      const start = clauseMatch.index + match.index + site.index;
      const end = start + site[0].length;
      const certainty = certaintyForMention(text, start, end);
      if (certainty !== 'reported' || hasNonCurrentClinicalContext(text, start, end)) continue;
      findings.push({ field: 'diagnosis', value: site[0], certainty, source_type: 'user_text',
        source_excerpt: match[0].trim() });
    }
  }
  return findings;
}

function hasSplitExplicitEventEvidence(text, matches) {
  const eventCues = [...text.matchAll(/(?<current>(?:本次|此次|当前)(?:交通)?(?:事故|外伤|车祸|受伤|损伤))|(?<separate>(?:(?:另(?:一次|一场)|另一(?:次|场)|第(?:二|两)次|其他(?:一次|一场))(?:交通)?(?:事故|外伤|车祸|受伤|损伤)|(?:非同一|不同)(?:次)?(?:交通)?(?:事故|外伤|车祸|受伤|损伤)))/gu)];
  const contexts = matches.map(match => {
    const cue = [...eventCues].reverse().find(candidate => candidate.index <= match.index);
    return cue?.groups.current ? 'current' : cue?.groups.separate ? 'separate' : null;
  });
  const explicitContexts = new Set(contexts.filter(Boolean));
  return explicitContexts.size > 1 || explicitContexts.has('separate') && contexts.includes(null);
}

function normalizeCraniotomyProcedureFacts(inputText) {
  const text = normalizeInput(inputText);
  const findings = [];
  const pattern = /开颅[^。！？；;\n]{0,72}(?:清除|探查|减压|切除|修补|整复|手术|术)/gu;
  for (const match of text.matchAll(pattern)) {
    const contextStart = Math.max(0, match.index - 32);
    const prefix = text.slice(contextStart, match.index);
    const context = text.slice(contextStart, match.index + match[0].length);
    if (!/(?:手术(?:名称|为|记录)?|行|接受|施行|实施|进行|术后)/u.test(prefix)
      || /(?:拟行|拟施行|计划|建议|考虑|未行|未施行|拒绝)/u.test(prefix)
      || hasNonCurrentClinicalContext(text, match.index, match.index + match[0].length)) continue;
    const certainty = certaintyFor(text, contextStart, match.index + match[0].length);
    if (certainty !== 'reported') continue;
    findings.push({ id: `CRANIOTOMY${match.index}`, field: 'clinical_finding', value: '开颅术后', certainty,
      source_type: 'user_text', source_excerpt: context.trim() });
  }
  return findings;
}

export function findExplicitOpenSkullDuralDiagnoses(inputText) {
  const text = normalizeInput(inputText);
  const duraDamage = '(?:破口|开放|破损|破裂|撕裂|裂伤)';
  const hardDura = '(?:硬脑膜|硬膜(?!下))';
  const cranialBone = '(?:颅骨|(?:额顶|额颞|顶枕|枕顶|额|顶|枕|颞)骨)';
  const openFracture = `(?:开放性${cranialBone}骨折|${cranialBone}[^。！？；;\\n]{0,12}开放性骨折)`;
  const pattern = new RegExp(`(?:${openFracture}[^。！？；;\\n]{0,32}${hardDura}[^。！？；;\\n]{0,20}${duraDamage}|${hardDura}[^。！？；;\\n]{0,20}${duraDamage}[^。！？；;\\n]{0,32}${openFracture})`, 'gu');
  return [...text.matchAll(pattern)].filter(match => certaintyFor(text, match.index, match.index + match[0].length) === 'reported'
    && !hasNonCurrentClinicalContext(text, match.index, match.index + match[0].length)
    && !/(?:未见|未发现|没有|否认|排除)[^。！？；;\\n]{0,20}(?:开放性(?:颅骨|(?:额顶|额颞|顶枕|枕顶|额|顶|枕|颞)骨)骨折|硬脑膜(?:破口|开放|破损|破裂|损伤|撕裂|裂伤)|硬膜(?!下)(?:破口|开放|破损|破裂|损伤|撕裂|裂伤))|硬脑膜(?:未见|无|未有)?(?:未破裂|未破损|完整)|硬膜(?!下)(?:未见|无|未有)?(?:未破裂|未破损|完整)/u
      .test(text.slice(match.index, match.index + match[0].length)));
}

function findExplicitSkullBrainCommunication(inputText) {
  const text = normalizeInput(inputText);
  return [...text.matchAll(/(?:颅骨外伤|颅骨损伤|颅骨骨折)[^。！？；;\n]{0,16}(?:与|和)[^。！？；;\n]{0,16}(?:脑内组织|脑组织|脑内|颅内)相通/gu)]
    .filter(match => certaintyFor(text, match.index, match.index + match[0].length) === 'reported'
      && !hasNonCurrentClinicalContext(text, match.index, match.index + match[0].length));
}

function findDefiniteDuralRuptureDiagnoses(inputText) {
  const text = normalizeInput(inputText);
  return [...text.matchAll(/(?:(?:法医|医学会诊|影像会诊|诊断|复核|分析|认为|明确|证实|确诊)[^。！？；;\n]{0,24})?(?:硬脑膜|硬膜(?!下))[^。！？；;\n]{0,12}(?:破裂|破损|撕裂|裂伤)(?:伤)?(?:明确|诊断成立|成立|确诊|征象|可能|疑似)?/gu)]
    .filter(match => certaintyFor(text, match.index, match.index + match[0].length) === 'reported'
      && !hasNonCurrentClinicalContext(text, match.index, match.index + match[0].length)
      && !/(?:提示|征象|考虑|可能|疑似|不排除)/u.test(match[0])
      && !explicitNegationCoversTerm(match[0], '硬脑膜'));
}

function findExplicitSkullBrainDuralPair(inputText) {
  const text = normalizeInput(inputText);
  const communication = findExplicitSkullBrainCommunication(text);
  const dura = findDefiniteDuralRuptureDiagnoses(text);
  if (communication.length !== 1 || dura.length !== 1 || hasExplicitDuralRuptureNegation(text)) return null;
  if (!hasSingleExplicitInjuryEvent(text)) return null;
  if (hasSplitExplicitEventEvidence(text, [communication[0], dura[0]])) return null;
  const start = Math.min(communication[0].index, dura[0].index);
  const end = Math.max(communication[0].index + communication[0][0].length,
    dura[0].index + dura[0][0].length);
  if (end - start > 420 || hasInterveningRepeatInjury(text, [communication[0], dura[0]])) return null;
  return { index: start, evidence: text.slice(start, end) };
}

function hasExplicitDuralRuptureNegation(text) {
  return /(?:未见|未发现|没有|否认|排除)[^，,。！？；;\\n]{0,20}(?:硬脑膜|硬膜(?!下))(?:有)?(?:破口|开放|破损|破裂|撕裂|裂伤|损伤|异常(?:改变|信号|征象)?)|(?:硬脑膜|硬膜(?!下))(?:(?:未见|无|未有)(?:破口|开放|破损|破裂|撕裂|裂伤|损伤|异常(?:改变|信号|征象)?)|结构完整|未破口|未开放|未破裂|未破损|完整)/u.test(text);
}

function hasInterveningRepeatInjury(text, matches) {
  const ordered = matches.filter(Boolean).sort((left, right) => left.index - right.index);
  const repeatedInjury = /(?:(?:(?:后来|之后|随后|此后|其后|再后来)[^。！？；;\\n]{0,20})?(?:再次|又一次|第二次|重新)(?:发生(?:了)?[^。！？；;\\n]{0,8})?(?:(?:头|胸|腹|背|腰|面|颈|身体|肢体)(?:部)?)?(?:摔倒|跌倒|受伤|外伤|摔伤|坠落|车祸|事故|撞伤|受袭)|(?:(?:后来|之后|随后|此后|其后|再后来)[^。！？；;\\n]{0,20})?又(?:发生(?:了)?一次|一次)(?:(?:头|胸|腹|背|腰|面|颈|身体|肢体)(?:部)?)?(?:摔倒|跌倒|受伤|外伤|摔伤|坠落|车祸|事故|撞伤|受袭))/u;
  for (let index = 1; index < ordered.length; index += 1) {
    const previousEnd = ordered[index - 1].index + ordered[index - 1][0].length;
    if (ordered[index].index > previousEnd && repeatedInjury.test(text.slice(previousEnd, ordered[index].index))) return true;
  }
  return false;
}

function hasOpenSkullDuralReviewIssue(inputText) {
  const text = normalizeInput(inputText);
  const datedEvents = parseEventDateAnchors(text);
  if (datedEvents.length && (datedEvents.length > 1 || datedEvents[0].index > 0)) {
    const segments = datedEvents[0].index > 0 ? [text.slice(0, datedEvents[0].index)] : [];
    for (let index = 0; index < datedEvents.length; index += 1) {
      segments.push(text.slice(datedEvents[index].index, datedEvents[index + 1]?.index ?? text.length));
    }
    return segments.some(segment => hasOpenSkullDuralReviewIssue(segment));
  }
  const direct = findExplicitOpenSkullDuralDiagnoses(text);
  if (direct.length && hasExplicitDuralRuptureNegation(text)) return true;
  if (findExplicitSkullBrainCommunication(text).length && findDefiniteDuralRuptureDiagnoses(text).length
    && hasExplicitDuralRuptureNegation(text)) return true;
  const openComponents = [...text.matchAll(/(?:开放性颅脑损伤[^。；;\\n]{0,32}颅骨骨折|颅骨骨折[^。；;\\n]{0,32}开放性颅脑损伤|(?:开放性(?:颅骨|(?:额顶|额颞|顶枕|枕顶|额|顶|枕|颞)骨)|(?:颅骨|(?:额顶|额颞|顶枕|枕顶|额|顶|枕|颞)骨)[^。！？；;\\n]{0,12}开放性)[^。！？；;\\n]{0,8}骨折)/gu)];
  const duralComponents = [...text.matchAll(/(?:术中|手术记录|探查|骨折中心|骨折处|骨折断端|骨折缝|骨折裂隙|(?:取出|移除|清除|去除)[^。！？；;\\n]{0,24}后)[^。！？；;\\n]{0,100}(?:硬脑膜|硬膜(?!下))[^。！？；;\\n]{0,24}(?:破口|开放|破损|破裂|撕裂|裂伤)|(?:骨折中心|骨折处|骨折断端|骨折缝|骨折裂隙)[^。！？；;\\n]{0,24}脑脊液[^。！？；;\\n]{0,20}(?:流出|外流)/gu)];
  if (openComponents.some(open => duralComponents.some(dura => hasInterveningRepeatInjury(text, [open, dura])))) return true;
  const scalpLacerations = [...text.matchAll(/头皮[^。！？\n]{0,32}(?:撕裂伤|撕裂|裂伤|裂创|裂口)/gu)]
    .filter(match => certaintyFor(text, match.index, match.index + match[0].length) === 'reported'
      && !hasNonCurrentClinicalContext(text, match.index, match.index + match[0].length));
  const skullFractures = [...text.matchAll(/(?:颅骨[^。！？\n]{0,24}骨折|(?:左|右|双侧)?(?:额顶|额颞|顶枕|枕顶|额|顶|枕|颞)骨[^。！？\n]{0,16}骨折)/gu)]
    .filter(match => certaintyFor(text, match.index, match.index + match[0].length) === 'reported'
      && !hasNonCurrentClinicalContext(text, match.index, match.index + match[0].length));
  const duralPenetrations = [...text.matchAll(/(?:(?:骨折|碎骨片|碎骨|骨片)[^。！？\n]{0,24}(?:刺破|穿破|刺入)硬脑膜|硬脑膜[^。！？\n]{0,16}(?:被|有)?(?:骨折|碎骨片|碎骨|骨片)[^。！？\n]{0,8}(?:刺破|穿破|刺入))/gu)]
    .filter(match => certaintyFor(text, match.index, match.index + match[0].length) === 'reported'
      && !explicitNegationCoversTerm(text.slice(match.index, match.index + match[0].length), '硬脑膜')
      && !hasNonCurrentClinicalContext(text, match.index, match.index + match[0].length));
  return scalpLacerations.some(scalp => skullFractures.some(skull => duralPenetrations.some(penetration =>
    hasInterveningRepeatInjury(text, [scalp, skull, penetration]))));
}

function cranialSiteSignals(text, match) {
  const sentenceStart = Math.max(text.lastIndexOf('。', match.index - 1), text.lastIndexOf('！', match.index - 1),
    text.lastIndexOf('？', match.index - 1), text.lastIndexOf('；', match.index - 1),
    text.lastIndexOf(';', match.index - 1), text.lastIndexOf('\n', match.index - 1)) + 1;
  const before = text.slice(Math.max(sentenceStart, match.index - 24), match.index);
  const ownRegionMatches = [...match[0].matchAll(/[额顶颞枕]/gu)];
  const regionSource = ownRegionMatches.length ? match[0] : before;
  const regionMatches = ownRegionMatches.length ? ownRegionMatches : [...before.matchAll(/[额顶颞枕]/gu)];
  const regions = new Set();
  if (regionMatches.length) {
    let first = regionMatches.length - 1;
    while (first > 0 && regionMatches[first].index - regionMatches[first - 1].index <= 2) first -= 1;
    for (const region of regionMatches.slice(first)) regions.add(region[0]);
    const sitePrefix = regionSource.slice(Math.max(0, regionMatches[first].index - 4), regionMatches[first].index);
    const sideToken = [...sitePrefix.matchAll(/双侧|左|右/gu)].at(-1)?.[0];
    if (sideToken === '双侧') return { sides: new Set(['左', '右']), regions };
    if (sideToken) return { sides: new Set([sideToken]), regions };
    return { sides: new Set(), regions };
  }
  const nearby = `${before}${match[0]}`;
  const sideToken = [...nearby.matchAll(/双侧|左|右/gu)].at(-1)?.[0];
  return {
    sides: new Set(sideToken === '双侧' ? ['左', '右'] : sideToken ? [sideToken] : []),
    regions,
  };
}

function cranialSitesConflict(text, fracture, gas) {
  const fractureSite = cranialSiteSignals(text, fracture);
  const gasSite = cranialSiteSignals(text, gas);
  const overlaps = (left, right) => [...left].some(value => right.has(value));
  return fractureSite.sides.size && gasSite.sides.size && !overlaps(fractureSite.sides, gasSite.sides)
    || fractureSite.regions.size && gasSite.regions.size && !overlaps(fractureSite.regions, gasSite.regions);
}

function normalizeOpenSkullDuralRuptureFacts(inputText) {
  const text = normalizeInput(inputText);
  const duraDamage = '(?:破口|开放|破损|破裂|撕裂|裂伤)';
  const datedEvents = parseEventDateAnchors(text);
  if (datedEvents.length && (datedEvents.length > 1 || datedEvents[0].index > 0)) {
    const segments = datedEvents[0].index > 0 ? [text.slice(0, datedEvents[0].index)] : [];
    for (let index = 0; index < datedEvents.length; index += 1) {
      segments.push(text.slice(datedEvents[index].index, datedEvents[index + 1]?.index ?? text.length));
    }
    return segments.flatMap(segment => normalizeOpenSkullDuralRuptureFacts(segment));
  }
  const directDiagnoses = findExplicitOpenSkullDuralDiagnoses(text);
  if (directDiagnoses.length === 1 && !hasExplicitDuralRuptureNegation(text)) {
    const diagnosis = directDiagnoses[0];
    const evidence = diagnosis[0];
    if (!explicitNegationCoversTerm(evidence, '颅骨骨折')
      && !explicitNegationCoversTerm(evidence, '硬脑膜')) {
      return [{ id: `OSD${diagnosis.index}`, field: 'clinical_finding', value: '开放性颅骨骨折伴硬脑膜破裂',
        certainty: 'reported', source_type: 'user_text', source_excerpt: evidence }];
    }
  }
  const explicitPair = findExplicitSkullBrainDuralPair(text);
  if (explicitPair) {
    return [{ id: `OSD${explicitPair.index}`, field: 'clinical_finding',
      value: '开放性颅骨骨折伴硬脑膜破裂', certainty: 'derived', source_type: 'derived',
      source_excerpt: explicitPair.evidence }];
  }
  const cranialBone = '(?:颅骨|(?:额顶|额颞|顶枕|枕顶|额|顶|枕|颞)骨)';
  const openCranialFractures = [...text.matchAll(new RegExp(`(?:开放性${cranialBone}|${cranialBone}[^。！？；;\\n]{0,12}开放性)[^。！？；;\\n]{0,8}骨折`, 'gu'))]
    .filter(match => certaintyFor(text, match.index, match.index + match[0].length) === 'reported'
      && !hasNonCurrentClinicalContext(text, match.index, match.index + match[0].length));
  const hardDura = '(?:硬脑膜|硬膜(?!下))';
  const operativeDuralDamage = [...text.matchAll(new RegExp(`(?:术中|手术记录|探查|(?:取出|移除|清除|去除)[^。！？；;\\n]{0,24}后)[^。！？；;\\n]{0,80}${hardDura}[^。！？；;\\n]{0,28}${duraDamage}`, 'gu'))]
    .filter(match => certaintyFor(text, match.index, match.index + match[0].length) === 'reported'
      && !hasNonCurrentClinicalContext(text, match.index, match.index + match[0].length));
  const duraNegation = hasExplicitDuralRuptureNegation(text);
  const operativeDateRanges = parseEventDateAnchors(text).map(anchor => anchor.range);
  if (openCranialFractures.length && operativeDuralDamage.length && !duraNegation
    && hasSingleExplicitInjuryEvent(text) && !eventDateAnchorsConflict(operativeDateRanges)) {
    const open = openCranialFractures[0];
    const dura = operativeDuralDamage[0];
    const start = Math.min(open.index, dura.index);
    const end = Math.max(open.index + open[0].length, dura.index + dura[0].length);
    const evidence = text.slice(start, end);
    if (end - start <= 420 && !hasSplitExplicitEventEvidence(text, [open, dura])
      && !hasInterveningRepeatInjury(text, [open, dura])) {
      return [{ field: 'clinical_finding', value: '开放性颅骨骨折伴硬脑膜破裂', certainty: 'derived',
        source_type: 'derived', source_excerpt: evidence.trim() }];
    }
  }
  const openSkullDiagnosis = [...text.matchAll(/开放性颅脑损伤[^。；;\n]{0,32}颅骨骨折|颅骨骨折[^。；;\n]{0,32}开放性颅脑损伤/gu)]
    .filter(match => certaintyFor(text, match.index, match.index + match[0].length) === 'reported'
      && !hasNonCurrentClinicalContext(text, match.index, match.index + match[0].length));
  if (!openSkullDiagnosis.length) {
    const openBrainDiagnoses = [...text.matchAll(/开放性颅脑损伤/gu)]
      .filter(match => certaintyFor(text, match.index, match.index + match[0].length) === 'reported'
        && !hasNonCurrentClinicalContext(text, match.index, match.index + match[0].length));
    const skullFractureDiagnoses = [...text.matchAll(/(?:颅骨[^。！？；;\n]{0,24}(?:骨折|骨裂)|(?:左|右|双侧)?(?:额顶|额颞|顶枕|枕顶|额|顶|枕|颞)骨[^。！？；;\n]{0,24}(?:骨折|骨裂))/gu)]
      .filter(match => certaintyFor(text, match.index, match.index + match[0].length) === 'reported'
        && !hasNonCurrentClinicalContext(text, match.index, match.index + match[0].length));
    const open = openBrainDiagnoses[0];
    const fracture = open && [...skullFractureDiagnoses].sort((left, right) =>
      Math.abs(left.index - open.index) - Math.abs(right.index - open.index))[0];
    if (openBrainDiagnoses.length === 1 && fracture
      && !eventDateAnchorsConflict(parseEventDateAnchors(text).map(anchor => anchor.range))) {
      const start = Math.min(open.index, fracture.index);
      const end = Math.max(open.index + open[0].length, fracture.index + fracture[0].length);
      const evidence = text.slice(start, end);
      if (end - start <= 180 && !hasSplitExplicitEventEvidence(text, [open, fracture])
        && !hasInterveningRepeatInjury(text, [open, fracture])) {
        openSkullDiagnosis.push(Object.assign([evidence], { index: start }));
      }
    }
  }
  if (openSkullDiagnosis.length === 1 && operativeDuralDamage.length === 1 && !duraNegation
    && !eventDateAnchorsConflict(parseEventDateAnchors(text).map(anchor => anchor.range))) {
    const open = openSkullDiagnosis[0];
    const dura = operativeDuralDamage[0];
    const start = Math.min(open.index, dura.index);
    const end = Math.max(open.index + open[0].length, dura.index + dura[0].length);
    const evidence = text.slice(start, end);
    if (end - start <= 420 && !hasSplitExplicitEventEvidence(text, [open, dura])
      && !hasInterveningRepeatInjury(text, [open, dura])) {
      return [{ field: 'clinical_finding', value: '开放性颅骨骨折伴硬脑膜破裂', certainty: 'derived',
        source_type: 'derived', source_excerpt: evidence.trim() }];
    }
  }
  const operativeMeningealRupture = [...text.matchAll(/(?:术中|手术记录|探查)[^。！？\n]{0,180}脑膜沿(?:伤口|创口)[^。！？\n]{0,16}方向(?:破裂|破开|裂开)/gu)]
    .filter(match => certaintyFor(text, match.index, match.index + match[0].length) === 'reported'
      && !hasNonCurrentClinicalContext(text, match.index, match.index + match[0].length));
  if (openSkullDiagnosis.length === 1 && operativeMeningealRupture.length === 1
    && !eventDateAnchorsConflict(parseEventDateAnchors(text).map(anchor => anchor.range))) {
    const open = openSkullDiagnosis[0];
    const meninges = operativeMeningealRupture[0];
    const start = Math.min(open.index, meninges.index);
    const end = Math.max(open.index + open[0].length, meninges.index + meninges[0].length);
    const evidence = text.slice(start, end);
    if (end - start <= 420 && !hasSplitExplicitEventEvidence(text, [open, meninges])
      && !hasInterveningRepeatInjury(text, [open, meninges])) {
      return [{ field: 'clinical_finding', value: '开放性颅骨骨折伴硬脑膜破裂', certainty: 'derived',
        source_type: 'derived', source_excerpt: evidence.trim() }];
    }
  }
  const fractureCsfFlow = [...text.matchAll(/(?:骨折中心|骨折处|骨折断端|骨折缝|骨折裂隙)[^。；;\n]{0,24}脑脊液[^。；;\n]{0,20}(?:流出|外流)|脑脊液[^。；;\n]{0,20}(?:由|从)(?:骨折中心|骨折处|骨折断端|骨折缝|骨折裂隙)[^。；;\n]{0,16}(?:流出|外流)/gu)]
    .filter(match => certaintyFor(text, match.index, match.index + match[0].length) === 'reported'
      && !explicitNegationCoversTerm(text.slice(match.index, match.index + match[0].length), '脑脊液')
      && !hasNonCurrentClinicalContext(text, match.index, match.index + match[0].length));
  const dateRanges = parseEventDateAnchors(text).map(anchor => anchor.range);
  if (openSkullDiagnosis.length === 1 && fractureCsfFlow.length === 1 && !eventDateAnchorsConflict(dateRanges)) {
    const open = openSkullDiagnosis[0];
    const flow = fractureCsfFlow[0];
    const start = Math.min(open.index, flow.index);
    const end = Math.max(open.index + open[0].length, flow.index + flow[0].length);
    const evidence = text.slice(start, end);
    if (end - start <= 420 && !hasSplitExplicitEventEvidence(text, [open, flow])
      && !hasInterveningRepeatInjury(text, [open, flow])
      && !/既往史|既往病史|陈旧性?|此前|旧伤/u.test(evidence)) {
      return [{ field: 'clinical_finding', value: '开放性颅骨骨折伴硬脑膜破裂', certainty: 'derived',
        source_type: 'derived', source_excerpt: evidence.trim() }];
    }
  }
  const scalpLacerations = [...text.matchAll(/头皮[^。！？\n]{0,32}(?:撕裂伤|撕裂|裂伤|裂创|裂口)/gu)]
    .filter(match => certaintyFor(text, match.index, match.index + match[0].length) === 'reported'
      && !hasNonCurrentClinicalContext(text, match.index, match.index + match[0].length));
  const skullFractures = [...text.matchAll(/(?:颅骨[^。！？\n]{0,24}(?:骨折|骨裂)|(?:左|右|双侧)?(?:额顶|额颞|颞顶|顶枕|枕顶|颞枕顶|颞枕|额|顶|颞|枕)(?:部|骨)?[^。！？\n]{0,8}(?:骨折|骨裂))/gu)]
    .filter(match => certaintyFor(text, match.index, match.index + match[0].length) === 'reported'
      && !hasNonCurrentClinicalContext(text, match.index, match.index + match[0].length));
  const headWoundsDeepToBone = [...text.matchAll(/(?:头皮|头部)[^。！？\n]{0,32}(?:伤口|创口|裂伤|裂口)[^。！？\n]{0,20}(?:深至|深达|深及|达至|达)(?:骨(?:面|质)|颅骨)/gu)]
    .filter(match => certaintyFor(text, match.index, match.index + match[0].length) === 'reported'
      && !hasNonCurrentClinicalContext(text, match.index, match.index + match[0].length));
  const fractureDuralPenetrations = [...text.matchAll(/(?:(?:骨折|碎骨片|碎骨|骨片)[^。！？\n]{0,24}(?:刺破|穿破|刺入)硬脑膜|硬脑膜[^。！？\n]{0,16}(?:被|有)?(?:骨折|碎骨片|碎骨|骨片)[^。！？\n]{0,8}(?:刺破|穿破|刺入))/gu)]
    .filter(match => certaintyFor(text, match.index, match.index + match[0].length) === 'reported'
      && !explicitNegationCoversTerm(text.slice(match.index, match.index + match[0].length), '硬脑膜')
      && !hasNonCurrentClinicalContext(text, match.index, match.index + match[0].length));
  const duralNegation = hasExplicitDuralRuptureNegation(text)
    || /(?:未见|未发现|没有|否认|排除)[^。！？；;\n]{0,20}骨折[^。！？；;\n]{0,16}(?:刺破|穿破)硬脑膜/u.test(text);
  const intracerebralBoneFragments = [...text.matchAll(/(?:骨片|碎骨片)[^。！？；;\n]{0,20}(?:嵌入|刺入|进入)[^。！？；;\n]{0,12}脑实质/gu)]
    .filter(match => certaintyFor(text, match.index, match.index + match[0].length) === 'reported'
      && !explicitNegationCoversTerm(text.slice(match.index, match.index + match[0].length), '脑实质')
      && !hasNonCurrentClinicalContext(text, match.index, match.index + match[0].length));
  if (headWoundsDeepToBone.length && intracerebralBoneFragments.length && operativeDuralDamage.length
    && !duralNegation && hasSingleExplicitInjuryEvent(text)) {
    const fragment = intracerebralBoneFragments[0];
    const skull = skullFractures.reduce((nearest, candidate) =>
      !nearest || Math.abs(candidate.index - fragment.index) < Math.abs(nearest.index - fragment.index)
        ? candidate : nearest, null);
    const matches = [headWoundsDeepToBone[0], skull, fragment, operativeDuralDamage[0]];
    const nearestFracture = skull && Math.abs(skull.index - fragment.index) <= 80;
    if (nearestFracture && !hasInterveningRepeatInjury(text, matches)) {
      const start = Math.min(...matches.map(match => match.index));
      const end = Math.max(...matches.map(match => match.index + match[0].length));
      const eventAnchor = parseEventDateAnchors(text).find(anchor => anchor.index <= start);
      const evidenceStart = eventAnchor?.index ?? start;
      const evidence = text.slice(evidenceStart, end);
      if (end - evidenceStart <= 420 && !hasSplitExplicitEventEvidence(text, matches)
        && !/(?:既往史|既往病史|陈旧性?|此前|旧伤)/u.test(evidence)) {
        return [{ field: 'clinical_finding', value: '开放性颅骨骨折伴硬脑膜破裂', certainty: 'derived',
          source_type: 'derived', source_excerpt: evidence.trim() }];
      }
    }
  }
  const intracranialGas = [...text.matchAll(/(?:(?:颅骨内板下|(?:硬膜下|硬膜外|颅内)血肿(?:内)?)[^，,。！？；;\n]{0,24}(?:见|有|伴)?[^，,。！？；;\n]{0,12}(?:气体(?:密度影)?|积气)|气颅)/gu)]
    .filter(match => certaintyFor(text, match.index, match.index + match[0].length) === 'reported'
      && !explicitNegationCoversTerm(text.slice(match.index, match.index + match[0].length), /气颅/u.test(match[0]) ? '气颅' : '气体')
      && !hasNonCurrentClinicalContext(text, match.index, match.index + match[0].length));
  const siteSpecificSkullFractures = skullFractures.filter(skull => /[额顶颞枕]/u.test(skull[0]));
  let linkedGasRuptureEvidence = null;
  for (const gas of [...intracranialGas].reverse()) {
    for (const fracture of siteSpecificSkullFractures) {
      if (Math.abs(gas.index - fracture.index) > 240 || cranialSitesConflict(text, fracture, gas)) continue;
      const wound = headWoundsDeepToBone.find(candidate => !cranialSitesConflict(text, candidate, fracture)
        && !cranialSitesConflict(text, candidate, gas));
      if (wound) {
        linkedGasRuptureEvidence = { gas, fracture, wound };
        break;
      }
    }
    if (linkedGasRuptureEvidence) break;
  }
  if (linkedGasRuptureEvidence && !duralNegation && !eventDateAnchorsConflict(dateRanges)) {
    const matches = [linkedGasRuptureEvidence.wound, linkedGasRuptureEvidence.fracture, linkedGasRuptureEvidence.gas];
    const start = Math.min(...matches.map(match => match.index));
    const end = Math.max(...matches.map(match => match.index + match[0].length));
    const evidence = text.slice(start, end);
    if (end - start <= 420 && !hasSplitExplicitEventEvidence(text, matches)
      && !hasInterveningRepeatInjury(text, matches)
      && !/(?:既往史|既往病史|陈旧性?|此前|旧伤)/u.test(evidence)) {
      return [{ field: 'clinical_finding', value: '开放性颅骨骨折伴硬脑膜破裂', certainty: 'derived',
        source_type: 'derived', source_excerpt: evidence.trim() }];
    }
  }
  if (!scalpLacerations.length || !skullFractures.length || !fractureDuralPenetrations.length || duralNegation
    || eventDateAnchorsConflict(dateRanges)) return [];
  const matched = [...scalpLacerations, ...skullFractures, ...fractureDuralPenetrations];
  const start = Math.min(...matched.map(match => match.index));
  const end = Math.max(...matched.map(match => match.index + match[0].length));
  const evidence = text.slice(start, end);
  if (end - start > 420 || hasSplitExplicitEventEvidence(text, matched) || hasInterveningRepeatInjury(text, matched)
    || /既往史|既往病史|陈旧性?|此前|旧伤/u.test(evidence)) return [];
  return [{ field: 'clinical_finding', value: '开放性颅骨骨折伴硬脑膜破裂', certainty: 'derived',
    source_type: 'derived', source_excerpt: evidence.trim() }];
}

export function hasSupportedOpenSkullDuralRuptureEvidence(inputText) {
  return normalizeOpenSkullDuralRuptureFacts(inputText)
    .some(fact => fact.value === '开放性颅骨骨折伴硬脑膜破裂');
}

function hasUnverifiedEyeContentEvisceration(sourceText) {
  const text = normalizeInput(sourceText || '');
  for (const clauseMatch of text.matchAll(/[^。！？；;\n]+/gu)) {
    const clause = clauseMatch[0];
    for (const match of clause.matchAll(/(?:左|右|一侧|单侧)?眼内容物(?:剜除|剜出)(?:术)?/gu)) {
      const start = clauseMatch.index + match.index;
      const end = start + match[0].length;
      if (certaintyFor(clause, match.index, match.index + match[0].length) !== 'reported'
        || hasNonCurrentClinicalContext(text, start, end)) continue;
      if (/(?:眼球(?:缺失|缺如|不存在|摘除|摘除术|萎缩|保留|残留)|(?:缺失|缺如|不存在|萎缩|保留|残留)(?:的)?眼球)/u.test(clause)) continue;
      return true;
    }
  }
  return false;
}

function normalizeCheekPenetratingWoundFacts(inputText) {
  const text = normalizeInput(inputText);
  const findings = [];
  const pattern = /(?<site>(?:左|右|双侧)?(?:面颊|脸颊|口角(?:内|外)?侧?))[^。；;，,\n]{0,12}(?:贯通创|贯通伤|穿透创|穿透伤)/gu;
  for (const clauseMatch of text.matchAll(/[^。；;\n]+/gu)) {
    const clause = clauseMatch[0];
    for (const match of clause.matchAll(pattern)) {
      if (certaintyFor(clause, match.index, match.index + match[0].length) !== 'reported'
        || hasNonCurrentClinicalContext(text, clauseMatch.index + match.index,
          clauseMatch.index + match.index + match[0].length)) continue;
      findings.push({ field: 'clinical_finding', value: '面颊穿透创', certainty: 'reported',
        source_type: 'user_text', source_excerpt: match[0].trim() });
    }
  }
  return findings;
}

function normalizeNeckAsphyxiaFacts(inputText) {
  const text = normalizeInput(inputText);
  const neckInjuries = [...text.matchAll(/(?:颈部|颈项)[^。；;\n]{0,36}(?:掐|勒|扼|压迫|损伤|受伤|挫伤)|(?:掐|勒|扼)颈/gu)]
    .filter(match => !hasNonCurrentClinicalContext(text, match.index, match.index + match[0].length));
  if (!neckInjuries.length) return [];

  const skinSpotPattern = /(?:面部|颜面(?:部)?|颈部|上胸(?:部)?)[^。；;\n]{0,60}(?:针尖(?:大小|样)?|散在(?:的)?|点状)?出血点/gu;
  const conjunctivalBleedingPattern = /(?:球睑|球|睑)结膜(?:下)?[^。；;\n]{0,16}出血(?:斑点)?/gu;
  const skinSpots = [...text.matchAll(skinSpotPattern)]
    .filter(match => certaintyFor(text, match.index, match.index + match[0].length) === 'reported'
      && !hasNonCurrentClinicalContext(text, match.index, match.index + match[0].length));
  const conjunctivalBleeding = [...text.matchAll(conjunctivalBleedingPattern)]
    .filter(match => certaintyFor(text, match.index, match.index + match[0].length) === 'reported'
      && !hasNonCurrentClinicalContext(text, match.index, match.index + match[0].length));

  for (const skinSpotsFact of skinSpots) for (const conjunctivalFact of conjunctivalBleeding) {
    const interveningEvidence = skinSpotsFact.index < conjunctivalFact.index
      ? text.slice(skinSpotsFact.index + skinSpotsFact[0].length, conjunctivalFact.index)
      : text.slice(conjunctivalFact.index + conjunctivalFact[0].length, skinSpotsFact.index);
    if (/[。；;\n]/u.test(interveningEvidence)) continue;
    const signStart = Math.min(skinSpotsFact.index, conjunctivalFact.index);
    const signEnd = Math.max(skinSpotsFact.index + skinSpotsFact[0].length,
      conjunctivalFact.index + conjunctivalFact[0].length);
    const neckInjury = neckInjuries.find(match => Math.abs(match.index - signStart) <= 320);
    if (!neckInjury) continue;
    const evidenceStart = Math.min(neckInjury.index, signStart);
    const evidenceEnd = Math.max(neckInjury.index + neckInjury[0].length, signEnd);
    const evidence = text.slice(evidenceStart, evidenceEnd).trim();
    return [{ field: 'clinical_finding', value: '颈部损伤出现窒息征象', certainty: 'derived',
      source_type: 'derived', source_excerpt: evidence }];
  }
  return [];
}

export function normalizeMuscleStrengthFacts(inputText, { eventScopedEvidence = false } = {}) {
  const text = normalizeInput(inputText);
  const findings = [];
  const strength = /(?<region>四肢|双上肢|双下肢|左上肢|右上肢|左下肢|右下肢|左侧肢体|右侧肢体|上肢|下肢)?\s*肌力(?:(?:检查|测定|记录)(?:结果)?)?\s*(?:为|约|达)?\s*(?<grade>[0-6]|[IVX]+|[ⅠⅡⅢⅣⅤⅥ])\s*级/giu;
  const romanGrades = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, 'Ⅰ': 1, 'Ⅱ': 2, 'Ⅲ': 3, 'Ⅳ': 4, 'Ⅴ': 5, 'Ⅵ': 6 };
  for (const clauseMatch of text.matchAll(/[^。！？；;\n]+/gu)) {
    const clause = clauseMatch[0].trim();
    const clauseOffset = clauseMatch.index + clauseMatch[0].indexOf(clause);
    const lowStrengthLimbs = new Set();
    let explicitThreshold = false;
    for (const match of clause.matchAll(strength)) {
      const certainty = certaintyFor(clause, match.index, match.index + match[0].length);
      findings.push({ field: 'clinical_finding', value: match[0].replace(/\s+/g, ''), certainty,
        source_type: 'user_text', source_excerpt: clause, source_position: clauseOffset + match.index });
      const gradeText = match.groups.grade.toUpperCase();
      const grade = /^\d$/u.test(gradeText) ? Number(gradeText) : romanGrades[gradeText];
      if (!Number.isFinite(grade) || grade > 3) continue;
      const region = match.groups.region || '';
      if (region === '四肢') {
        for (const limb of ['left-arm', 'right-arm', 'left-leg', 'right-leg']) lowStrengthLimbs.add(limb);
      } else if (region === '双上肢') {
        lowStrengthLimbs.add('left-arm'); lowStrengthLimbs.add('right-arm');
      } else if (region === '双下肢') {
        lowStrengthLimbs.add('left-leg'); lowStrengthLimbs.add('right-leg');
      } else if (region === '左上肢' || region === '左侧肢体') lowStrengthLimbs.add('left-arm');
      else if (region === '右上肢') lowStrengthLimbs.add('right-arm');
      else if (region === '左下肢') lowStrengthLimbs.add('left-leg');
      else if (region === '右下肢' || region === '右侧肢体') lowStrengthLimbs.add('right-leg');
      else if (region === '上肢') lowStrengthLimbs.add('unspecified-arm');
      else if (region === '下肢') lowStrengthLimbs.add('unspecified-leg');
    }
    explicitThreshold = /(?:三肢以上|四肢)肌力\s*(?:均|均为|均在)?\s*(?:[0-3]|[ⅠⅡⅢ])\s*级以下/u.test(clause);
    const quadriplegia = clause.match(/四肢瘫/u);
    const negativeQuadriplegia = /(?:未见|未发现|没有|否认|排除|无)[^，,。；;]{0,16}四肢瘫/u.test(clause);
    const certainty = quadriplegia ? certaintyFor(clause, quadriplegia.index, quadriplegia.index + quadriplegia[0].length) : null;
    const historicalQuadriplegia = quadriplegia && hasNonCurrentClinicalContext(text,
      clauseOffset + quadriplegia.index, clauseOffset + quadriplegia.index + quadriplegia[0].length);
    if (quadriplegia && !negativeQuadriplegia && !historicalQuadriplegia && ['reported', 'observed'].includes(certainty)
      && (explicitThreshold || lowStrengthLimbs.size >= 3)) {
      findings.push({ field: 'clinical_finding', value: '四肢瘫（三肢以上肌力3级以下）', certainty: 'derived',
        source_type: 'derived', source_excerpt: clause, source_position: clauseOffset + quadriplegia.index });
    }
  }
  for (const sentenceMatch of text.matchAll(/[^。！？\n]+/gu)) {
    const sentence = sentenceMatch[0];
    const quadriplegiaMatches = [...sentence.matchAll(/四肢瘫/gu)]
      .filter(match => !/(?:未见|未发现|没有|否认|排除|无)[^，,。；;]{0,16}$/u
        .test(sentence.slice(Math.max(0, match.index - 20), match.index))
        && ['reported', 'observed'].includes(certaintyFor(sentence, match.index, match.index + match[0].length))
        && !hasNonCurrentClinicalContext(text, sentenceMatch.index + match.index,
          sentenceMatch.index + match.index + match[0].length));
    if (!quadriplegiaMatches.length) continue;
    strength.lastIndex = 0;
    const measurements = [...sentence.matchAll(strength)].filter(match => {
      const gradeText = match.groups.grade.toUpperCase();
      const grade = /^\d$/u.test(gradeText) ? Number(gradeText) : romanGrades[gradeText];
      return Number.isFinite(grade) && grade <= 3
        && ['reported', 'observed'].includes(certaintyFor(sentence, match.index, match.index + match[0].length))
        && !hasNonCurrentClinicalContext(text, sentenceMatch.index + match.index,
          sentenceMatch.index + match.index + match[0].length);
    });
    for (const quadriplegia of quadriplegiaMatches) {
      const strengthMatches = measurements.filter(measurement => {
        const start = Math.min(quadriplegia.index, measurement.index);
        const end = Math.max(quadriplegia.index + quadriplegia[0].length,
          measurement.index + measurement[0].length);
        const bridge = sentence.slice(start, end);
        const distance = Math.abs(quadriplegia.index - measurement.index);
        const eventScopedMatches = [quadriplegia, measurement].map(match => ({
          ...match, index: sentenceMatch.index + match.index,
        }));
        return distance <= 120 && !/(?:复查|复诊|后续|再次|出院时|术后|较后)/u.test(bridge)
          && !hasSplitExplicitEventEvidence(text, eventScopedMatches)
          && [...bridge.matchAll(/(?:19|20)\d{2}年\d{1,2}月\d{1,2}日/gu)].length <= 1;
      });
      const lowLimbs = new Set();
      for (const match of strengthMatches) {
        const region = match.groups.region || '';
        if (region === '四肢') {
          for (const limb of ['left-arm', 'right-arm', 'left-leg', 'right-leg']) lowLimbs.add(limb);
        } else if (region === '双上肢') {
          lowLimbs.add('left-arm'); lowLimbs.add('right-arm');
        } else if (region === '双下肢') {
          lowLimbs.add('left-leg'); lowLimbs.add('right-leg');
        } else if (region === '左上肢' || region === '左侧肢体') lowLimbs.add('left-arm');
        else if (region === '右上肢') lowLimbs.add('right-arm');
        else if (region === '左下肢') lowLimbs.add('left-leg');
        else if (region === '右下肢' || region === '右侧肢体') lowLimbs.add('right-leg');
      }
      if (lowLimbs.size < 3) continue;
      const sourcePosition = sentenceMatch.index + quadriplegia.index;
      if (findings.some(fact => normalizeInput(fact.value) === normalizeInput('四肢瘫（三肢以上肌力3级以下）')
        && Math.abs((fact.source_position || 0) - sourcePosition) <= 120)) continue;
      findings.push({ field: 'clinical_finding', value: '四肢瘫（三肢以上肌力3级以下）', certainty: 'derived',
        source_type: 'derived', source_excerpt: sentence.trim(), source_position: sourcePosition });
    }
  }
  return [...findings, ...normalizeCervicalCordQuadriplegiaFacts(text, { eventScopedEvidence })];
}

function normalizeCervicalCordQuadriplegiaFacts(inputText, { eventScopedEvidence = false } = {}) {
  const text = normalizeInput(inputText);
  if (!eventScopedEvidence && !hasSingleExplicitInjuryEvent(text)
    || /(?:既往(?:史)?|曾经|曾有|陈旧|原有|此前|另一次(?:事故|外伤|受伤)|不同事件)/u.test(text)) return [];
  const diagnosis = [...text.matchAll(/(?:颈椎|颈髓|颈脊髓)[^。！？；;\n]{0,40}(?:损伤|骨折)[^。！？；;\n]{0,24}(?:不全瘫|瘫痪|瘫)/gu)]
    .find(match => ['reported', 'observed'].includes(certaintyFor(text, match.index, match.index + match[0].length))
      && !hasNonCurrentClinicalContext(text, match.index, match.index + match[0].length));
  if (!diagnosis) return [];
  const armStrengthPatterns = [
    /双上肢\s*肌力(?:检查)?\s*(?:为|约|达)?\s*([0-3]|[ⅠⅡⅢ])\s*级/gu,
    /双侧[^。！？；;\n]{0,80}(?:肱二头肌|肱三头肌|腕伸肌|腕屈肌|指深屈肌|小指展肌|三角肌)[^。！？；;\n]{0,60}肌力(?:检查)?\s*(?:为|约|达)?\s*([0-3]|[ⅠⅡⅢ])\s*级/gu,
  ];
  const bilateralArmStrength = armStrengthPatterns.flatMap(pattern => [...text.matchAll(pattern)])
    .sort((left, right) => left.index - right.index)
    .find(match => ['reported', 'observed'].includes(certaintyFor(text, match.index, match.index + match[0].length))
      && !hasNonCurrentClinicalContext(text, match.index, match.index + match[0].length));
  const bilateralLegStrength = [...text.matchAll(/双下肢[^。！？；;\n]{0,120}?肌力(?:检查)?\s*(?:为|约|达)?\s*([0-3]|[ⅠⅡⅢ])\s*级/gu)]
    .find(match => ['reported', 'observed'].includes(certaintyFor(text, match.index, match.index + match[0].length))
      && !hasNonCurrentClinicalContext(text, match.index, match.index + match[0].length));
  if (!bilateralArmStrength || !bilateralLegStrength) return [];
  const grade = value => ({ I: 1, II: 2, III: 3, 'Ⅰ': 1, 'Ⅱ': 2, 'Ⅲ': 3 })[value.toUpperCase()] ?? Number(value);
  if (grade(bilateralArmStrength[1]) > 3 || grade(bilateralLegStrength[1]) > 3) return [];
  const start = diagnosis.index;
  const end = Math.max(bilateralArmStrength.index + bilateralArmStrength[0].length,
    bilateralLegStrength.index + bilateralLegStrength[0].length);
  const evidence = text.slice(Math.min(start, bilateralArmStrength.index, bilateralLegStrength.index), end);
  const certainty = certaintyFor(text, Math.min(start, bilateralArmStrength.index, bilateralLegStrength.index), end);
  if (!['reported', 'observed'].includes(certainty)) return [];
  return [{ field: 'clinical_finding', value: '四肢瘫（三肢以上肌力3级以下）', certainty: 'derived',
    source_type: 'derived', source_excerpt: evidence, source_position: start }];
}

function normalizeOrbitalWallFractureFacts(inputText) {
  const text = normalizeInput(inputText);
  const findings = [];
  const wall = '(?:内侧壁|内壁|外侧壁|外壁|下壁|上壁|内|外|底)';
  const wallList = new RegExp(`眶\\s*${wall}(?:\\s*(?:、|，|,|及|和|与)?\\s*(?:眶\\s*)?${wall})+\\s*骨折`, 'gu');
  for (const match of text.matchAll(wallList)) {
    const start = match.index;
    const end = start + match[0].length;
    const delimiters = ['。', '；', ';', '\n'];
    const clauseStart = Math.max(...delimiters.map(delimiter => text.lastIndexOf(delimiter, start - 1))) + 1;
    if (certaintyFor(text, clauseStart, end) !== 'reported' || hasNonCurrentClinicalContext(text, start, end)) continue;
    const walls = new Set([...match[0].matchAll(/(?:眶\s*)?(内侧壁|内壁|外侧壁|外壁|下壁|上壁|内|外|底)/gu)]
      .map(found => /^(?:内侧壁|内壁|内)$/u.test(found[1]) ? 'medial'
        : /^(?:下壁|底)$/u.test(found[1]) ? 'inferior'
          : found[1] === '上壁' ? 'superior' : 'lateral'));
    if (walls.size < 2) continue;
    findings.push({ id: `OW${start}`, field: 'distinct_orbital_wall_fracture_count', value: walls.size,
      certainty: 'derived', source_type: 'user_text', source_excerpt: match[0] });
  }
  return findings;
}

function normalizeSharedSuffixBoneFractureFacts(inputText) {
  const text = normalizeInput(inputText);
  const findings = [];
  const sitePattern = /(?:左侧|右侧|左|右|双侧|两侧)?(?:眼)?眶(?:内侧壁|内壁|外侧壁|外壁|下壁|上壁|底壁|底)|(?:左侧|右侧|左|右|双侧|两侧)?(?:额|顶|颞|枕|蝶|筛|鼻|颧|上颌|下颌)骨/gu;
  const boundaries = ['。', '！', '？', '!', '?', '\n'];
  for (const fracture of text.matchAll(/骨折/gu)) {
    const end = fracture.index + fracture[0].length;
    const start = Math.max(...boundaries.map(boundary => text.lastIndexOf(boundary, fracture.index - 1))) + 1;
    const prefix = text.slice(start, fracture.index);
    const tokens = [...prefix.matchAll(sitePattern)];
    if (!tokens.length || prefix.slice(tokens.at(-1).index + tokens.at(-1)[0].length).trim()) continue;

    const sharedSites = [tokens.at(-1)];
    for (let index = tokens.length - 2; index >= 0; index -= 1) {
      const following = sharedSites[0];
      const separator = prefix.slice(tokens[index].index + tokens[index][0].length, following.index);
      if (!/^[\s、，,及和与]+$/u.test(separator)) break;
      sharedSites.unshift(tokens[index]);
    }
    if (sharedSites.length < 2) continue;
    const certainty = certaintyForMention(text, start, end);
    if (hasNonCurrentClinicalContext(text, start, end)) continue;
    const first = sharedSites[0];
    const evidence = text.slice(start + first.index, end).trim();
    const precedingText = text.slice(start, start + first.index);
    const field = /(?:CT|MRI|X线|X片|DR|影像|阅片|报告|片示)/iu.test(precedingText)
      ? 'imaging_finding' : 'diagnosis';
    for (const site of sharedSites) {
      findings.push({ id: `BF${fracture.index}-${site.index}`, field, value: `${site[0]}骨折`, certainty,
        source_type: 'derived', source_excerpt: evidence, sharedFracturePredicate: true });
    }
  }
  return findings;
}

export function hasExplicitOrbitalFractureEnophthalmosLink(inputText) {
  const text = normalizeInput(inputText);
  const orbitalFracture = /(?:眼)?眶(?:内侧壁|内壁|下壁|底(?:壁)?|上壁|外侧壁|外壁|壁)?\s*骨折/u;
  const causalLink = /(?:眼)?眶(?:内侧壁|内壁|下壁|底(?:壁)?|上壁|外侧壁|外壁|壁)?骨折(?:(?!骨折)[^。；;]){0,20}(?:致|导致|造成|引起|所致|后遗)(?:(?!骨折)[^。；;]){0,12}(?:眼球)?内陷|(?:眼球)?内陷(?:(?!骨折)[^。；;]){0,20}(?:由|因|系)(?:(?!骨折)[^。；;]){0,8}(?:眼)?眶(?:内侧壁|内壁|下壁|底(?:壁)?|上壁|外侧壁|外壁|壁)?骨折/u;
  return orbitalFracture.test(text) && causalLink.test(text);
}

export function limbLengthDifferenceCauseAnchor(inputText) {
  const text = normalizeInput(inputText);
  const cause = '(?:本次|此次|当前)(?:交通)?(?:事故|外伤|受伤|损伤|[^。；;\\n]{1,8}骨折)';
  const limbDifference = '(?:双|两)(?:上|下)肢(?:相对)?(?:长度|长短)(?:相差|差值|差距|差异)';
  const direct = new RegExp(`(?<cause>${cause})(?:(?!骨折)[^。；;\\n]){0,16}(?:致|导致|造成|引起|所致)(?:(?!骨折)[^。；;\\n]){0,16}${limbDifference}`, 'u').exec(text);
  const reverse = new RegExp(`${limbDifference}[^。；;\\n]{0,28}(?:由|因|系)(?<cause>${cause})`, 'u').exec(text);
  const matchedCause = direct?.groups?.cause || reverse?.groups?.cause || null;
  return matchedCause?.replace(/^(?:本次|此次|当前)(?:交通)?/u, '') || null;
}

export function hasExplicitLimbLengthDifferenceLink(inputText) {
  return Boolean(limbLengthDifferenceCauseAnchor(inputText));
}

function normalizeLimbLengthDifferenceFacts(inputText) {
  const text = normalizeInput(inputText);
  const findings = [];
  for (const clauseMatch of text.matchAll(/[^。；;\n]+/gu)) {
    const clause = clauseMatch[0];
    const clauseOffset = clauseMatch.index;
    const measurements = [...clause.matchAll(/(?:双|两)(?:上|下)肢(?:相对)?(?:长度|长短)(?:相差|差值|差距|差异)\s*(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(cm|厘米|mm|毫米)/gu)];
    if (measurements.length !== 1 || !hasExplicitLimbLengthDifferenceLink(clause)) continue;
    const measurement = measurements[0];
    const start = clauseOffset + measurement.index;
    const end = start + measurement[0].length;
    if (certaintyFor(text, clauseOffset, end) !== 'reported' || hasNonCurrentClinicalContext(text, start, end)) continue;
    const amount = /^\d/u.test(measurement[1]) ? Number(measurement[1]) : parseNumber(measurement[1]);
    const centimetres = /^(?:mm|毫米)$/u.test(measurement[2]) ? amount / 10 : amount;
    if (!Number.isFinite(centimetres) || centimetres < 0) continue;
    findings.push({ id: `LLD${start}`, field: 'limb_length_difference_cm', value: centimetres,
      certainty: 'derived', source_type: 'user_text', source_excerpt: clause.trim() });
  }
  return findings;
}

function normalizeOrbitalWallEnophthalmosFacts(inputText) {
  const text = normalizeInput(inputText);
  const findings = [];
  for (const clauseMatch of text.matchAll(/[^。；;\n]+/gu)) {
    const clause = clauseMatch[0];
    const clauseOffset = clauseMatch.index;
    if (!hasExplicitOrbitalFractureEnophthalmosLink(clause)) continue;
    const fractureSide = /(?:左|右|双侧|两侧)(?=侧?眼?眶(?:内侧壁|内壁|下壁|底(?:壁)?|上壁|外侧壁|外壁|壁)?\s*骨折)/u.exec(clause)?.[0] || null;
    const enophthalmosSide = /(?:左|右|双侧|两侧)(?=侧?眼球?内陷)/u.exec(clause)?.[0] || null;
    const sideOf = side => /^(?:左)$/u.test(side || '') ? 'left'
      : /^(?:右)$/u.test(side || '') ? 'right'
        : side ? 'bilateral' : null;
    const fractureLaterality = sideOf(fractureSide);
    const eyeLaterality = sideOf(enophthalmosSide);
    if (fractureLaterality && eyeLaterality && fractureLaterality !== 'bilateral'
      && eyeLaterality !== 'bilateral' && fractureLaterality !== eyeLaterality) continue;
    const boundary = Math.max(0, clauseOffset);
    for (const measurement of clause.matchAll(/(?:眼球)?内陷(?:约|为|达|测得)?\s*(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(cm|厘米|mm|毫米)/gu)) {
      const start = clauseOffset + measurement.index;
      const end = start + measurement[0].length;
      const preceding = clause.slice(0, measurement.index);
      const historicalCues = [...preceding.matchAll(/既往(?:史)?|既有|陈旧性?|原有|此前|曾(?:经|于|在)|历史上/gu)];
      const currentCues = [...preceding.matchAll(/(?:本次|此次|当前|目前)(?:事故|外伤|受伤|损伤)?/gu)];
      if (historicalCues.length && (!currentCues.length
        || historicalCues.at(-1).index > currentCues.at(-1).index)) continue;
      if (certaintyFor(text, boundary, end) !== 'reported' || hasNonCurrentClinicalContext(text, start, end)) continue;
      const amount = /^\d/u.test(measurement[1]) ? Number(measurement[1]) : parseNumber(measurement[1]);
      const centimetres = /^(?:mm|毫米)$/u.test(measurement[2]) ? amount / 10 : amount;
      if (!Number.isFinite(centimetres) || centimetres < 0) continue;
      findings.push({ id: `OEN${start}`, field: 'orbital_enophthalmos_cm', value: centimetres,
        certainty: 'derived', source_type: 'user_text', source_excerpt: clause.trim() });
      if (centimetres >= 0.2) {
        findings.push({ id: `OE${start}`, field: 'orbital_wall_enophthalmos', value: true,
          certainty: 'derived', source_type: 'user_text', source_excerpt: clause.trim() });
      }
    }
  }
  return findings;
}

function normalizeSharedHeadingWoundLengthFacts(text) {
  const findings = [];
  const amount = '(\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百]+)';
  const scarHeading = /(?:创口|伤口|创痕|划痕|划伤|瘢痕|疤痕|切口|裂口|裂创|裂伤)\s*[:：]\s*/gu;
  const listPattern = new RegExp(`(?:分别|各)\\s*(?:(?:为|长|长度)\\s*)?(${amount}(?:\\s*(?:cm|厘米)?\\s*[、,，]\\s*${amount})+)\\s*(?:cm|厘米)`, 'gu');
  const singlePattern = new RegExp(`${amount}\\s*(?:cm|厘米)`, 'gu');

  for (const sentence of text.matchAll(/[^。！？\n]+/gu)) {
    scarHeading.lastIndex = 0;
    const heading = scarHeading.exec(sentence[0]);
    if (!heading) continue;
    const headingClauseStart = Math.max(sentence[0].lastIndexOf('；', heading.index - 1),
      sentence[0].lastIndexOf(';', heading.index - 1)) + 1;
    const headingPrefix = sentence[0].slice(headingClauseStart, heading.index);
    if (/(?:未见|未发现|无|没有|否认|排除)[^；;]{0,12}$/u.test(headingPrefix)) continue;
    const headingEnd = heading.index + heading[0].length;
    for (const segment of sentence[0].slice(headingEnd).matchAll(/[^；;]+/gu)) {
      const segmentText = segment[0];
      const segmentStart = headingEnd + segment.index;
      if (/^[^；;:：]{1,16}[:：]/u.test(segmentText.trimStart())
        || /(?:创口|伤口|创痕|划痕|划伤|瘢痕|疤痕|切口|裂口|裂创|裂伤)\s*[:：]/u.test(segmentText)) break;
      if (!scalpWoundRegion(segmentText)) continue;
      const evidence = sentence[0].slice(heading.index, segmentStart + segmentText.length).trim();
      const certainty = certaintyFor(sentence[0], headingClauseStart, segmentStart + segmentText.length);
      if (!['reported', 'excluded', 'uncertain', 'unknown'].includes(certainty)) continue;
      const values = [];
      listPattern.lastIndex = 0;
      for (const list of segmentText.matchAll(listPattern)) {
        const listOffset = list.index + list[0].indexOf(list[1]);
        for (const token of list[1].matchAll(new RegExp(amount, 'gu'))) {
          values.push({ token: token[0], offset: listOffset + token.index });
        }
      }
      if (!values.length) {
        singlePattern.lastIndex = 0;
        for (const match of segmentText.matchAll(singlePattern)) {
          const beforeValue = segmentText.slice(Math.max(0, match.index - 12), match.index);
          const afterValue = segmentText.slice(match.index + match[0].length, match.index + match[0].length + 16);
          const adjacentDimension = /[×xX*]\s*(?:宽|高|深)?\s*$/u.test(beforeValue)
            || /^\s*(?:cm|厘米)?\s*[×xX*]\s*\d/u.test(afterValue);
          if (adjacentDimension) continue;
          values.push({ token: match[1], offset: match.index });
        }
      }
      for (const { token, offset } of values) {
        const value = /^\d+(?:\.\d+)?$/u.test(token) ? Number(token) : parseNumber(token);
        if (!Number.isFinite(value)) continue;
        const valueOffset = sentence.index + segmentStart + offset;
        findings.push({ id: `WL${valueOffset}`, field: 'wound_length_cm', value, certainty,
          source_type: 'user_text', source_excerpt: evidence, parserKey: `${valueOffset}:${value}` });
      }
    }
  }
  return findings;
}

function woundLengthEvidenceStart(clause, measurementStart) {
  const sitePattern = /(?:左侧|右侧|左|右|双侧|两侧)?(?:左耳|右耳|双耳|两耳|头顶部|额顶部|后枕部|颞枕部|顶枕部|颞顶部|头皮|头部|发际内|发际外|额部|前额|额头|颞部|枕部|眉弓|眉部|眼眶|眼上睑|眼下睑|下睑缘|上睑|眼睑|眼外侧|颧面部|面部|脸部|面颊|颊部|颊|颧部|鼻唇沟|鼻部|鼻背|鼻梁|鼻翼|耳廓|耳部|外耳|口唇|上唇|下唇|唇红|唇黏膜|口腔|下颌|颈部|颈前|锁骨|胸前|胸部|胸骨|背部|肩胛|肩部|上臂|肘部|前臂|腕部|手背|手指|掌部|腹部|腰部|臀部|髋部|大腿|股部|小腿|膝部|踝部|足背|足部|趾部|躯干|四肢)/gu;
  const preceding = clause.slice(0, measurementStart);
  const boundaries = [...preceding.matchAll(/[，、,；;]/gu)];
  for (let index = boundaries.length - 1; index >= 0; index -= 1) {
    const start = boundaries[index].index + boundaries[index][0].length;
    if (sitePattern.test(clause.slice(start, measurementStart))) return start;
    sitePattern.lastIndex = 0;
  }
  const locations = [...preceding.matchAll(sitePattern)];
  const prior = locations.at(-2);
  const last = locations.at(-1);
  if (prior && last && /^(?:左耳|右耳|双耳|两耳)$/u.test(prior[0])
    && /^(?:耳廓|耳部|外耳)$/u.test(last[0])
    && !/[，、,；;]/u.test(preceding.slice(prior.index + prior[0].length, last.index))) return prior.index;
  if (last) {
    const contextStart = Math.max(0, last.index - 40);
    const context = clause.slice(contextStart, last.index);
    const examinationHeading = context.match(/(?:法医临床检查结果|法医检查|检查记录|查体记录|检查结果|查体)(?:所见|见|记录)?[：:]?\s*$/u);
    if (examinationHeading) return contextStart + examinationHeading.index;
  }
  if (prior && last && /^(?:(?:左侧|右侧|左|右|双侧|两侧))?(?:头顶部|额顶部|后枕部|颞枕部|顶枕部|颞顶部|枕部|颞部)$/u.test(prior[0])
    && last[0] === '头皮' && !/[，、,；;]/u.test(preceding.slice(prior.index + prior[0].length, last.index))) {
    return prior.index;
  }
  if (prior && last && /(?:头顶部|额顶部|后枕部|颞枕部|顶枕部|颞顶部|头皮|发际内|发际外|枕部|颞部)/u.test(prior[0])
    && /(?:额部|前额|额头|眉弓|眉部|眼眶|下睑缘|上睑|眼睑|眼外侧|面部|脸部|面颊|颊部|颊|颧部|鼻唇沟|鼻部|鼻背|鼻梁|鼻翼|口唇|上唇|下唇|下颌)/u.test(last[0])) {
    const relation = preceding.slice(prior.index + prior[0].length, last.index);
    if (/(?:至|到|经|延|连)/u.test(relation) && !/[，、,；;]/u.test(relation)) return prior.index;
  }
  return last?.index ?? Math.max(0, measurementStart - 12);
}

function nearestLengthLesionCue(text, measurementOffset) {
  const start = Math.max(0, measurementOffset - 32);
  const end = Math.min(text.length, measurementOffset + 32);
  const cuePattern = /(?:皮肤)?(?:表浅|浅表)?划痕|创口|伤口|创痕|瘢痕|疤痕|切口|裂口|裂创|裂伤|划伤/gu;
  let nearest = null;
  for (const match of text.slice(start, end).matchAll(cuePattern)) {
    const cueStart = start + match.index;
    const cueEnd = cueStart + match[0].length;
    const distance = cueEnd <= measurementOffset ? measurementOffset - cueEnd
      : cueStart >= measurementOffset ? cueStart - measurementOffset : 0;
    if (!nearest || distance < nearest.distance) nearest = { value: match[0], distance };
  }
  return nearest?.value || '';
}

function isOperativeIncisionLengthAtOffset(text, measurementOffset) {
  const clauseStart = Math.max(text.lastIndexOf('。', measurementOffset - 1), text.lastIndexOf('；', measurementOffset - 1),
    text.lastIndexOf(';', measurementOffset - 1), text.lastIndexOf('\n', measurementOffset - 1)) + 1;
  const clauseEndCandidates = ['。', '；', ';', '\n'].map(delimiter => {
    const index = text.indexOf(delimiter, measurementOffset);
    return index < 0 ? text.length : index;
  });
  const clause = text.slice(clauseStart, Math.min(...clauseEndCandidates));
  const localOffset = measurementOffset - clauseStart;
  const beforeMeasurement = clause.slice(0, localOffset);
  const afterMeasurement = clause.slice(localOffset);
  const postoperativeExamination = /术后[^。；;\n]{0,64}(?:活体检验|法医检验|检验|检查|复查)/u.test(beforeMeasurement);
  const suturedWound = /(?:缝合|缝闭)[^。；;\n]{0,8}(?:手术)?(?:切口|创口|伤口)/u.test(afterMeasurement);
  if (postoperativeExamination && suturedWound) return true;

  const amount = '(?:\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百]+)';
  const dimension = `${amount}\\s*(?:cm|厘米)?\\s*[×xX*]\\s*${amount}\\s*(?:cm|厘米)?`;
  const measuredWoundList = new RegExp(
    `(?<first>${dimension})\\s*(?:及|和|[、,，])\\s*(?<second>${dimension})\\s*(?:两|二|2)处(?:损伤)?(?:创口|伤口|裂伤)`, 'gu');
  for (const match of text.matchAll(measuredWoundList)) {
    const firstStart = match.index + match[0].indexOf(match.groups.first);
    const secondStart = match.index + match[0].indexOf(match.groups.second);
    const isFirstMeasurement = measurementOffset >= firstStart
      && measurementOffset < firstStart + match.groups.first.length;
    const isSecondMeasurement = measurementOffset >= secondStart
      && measurementOffset < secondStart + match.groups.second.length;
    if (isFirstMeasurement || isSecondMeasurement) return false;
  }
  const operativeProcedure = '(?:手术|开颅|开胸|剖胸|开腹|剖腹|术中(?:以|沿|作|取|另作|另取))';
  const incisionTerm = '(?:切口|切开|锯开胸骨)';
  const surgicalIncisionLengthPatterns = [
    new RegExp(`${operativeProcedure}[^。；;\\n]{0,32}?(?<measurement>${amount}\\s*(?:cm|厘米))[^。；;\\n]{0,12}?${incisionTerm}`, 'gu'),
    new RegExp(`${operativeProcedure}[^。；;\\n]{0,24}?${incisionTerm}[^。；;\\n]{0,12}?(?<measurement>${amount}\\s*(?:cm|厘米))`, 'gu'),
  ];
  const priorExaminationHeading = text.slice(Math.max(0, clauseStart - 64), clauseStart);
  const examinationSection = /(?:活体检验|法医临床检查结果|法医检验|检验所见|法医检查)/u.test(beforeMeasurement)
    || /(?:活体检验|法医临床检查结果|法医检验|检验所见|法医检查)[：:]?\s*$/u.test(priorExaminationHeading);
  if (examinationSection && suturedWound) {
    const currentMeasurement = [...text.matchAll(new RegExp(`${amount}\\s*(?:cm|厘米)`, 'gu'))]
      .find(match => measurementOffset >= match.index && measurementOffset < match.index + match[0].length);
    const currentSite = currentMeasurement ? woundMeasurementSiteAt(text, currentMeasurement.index) : null;
    if (currentMeasurement && currentSite) {
      const currentValueText = currentMeasurement[0].match(/^(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)/u)?.[0];
      const currentValue = /^\d/u.test(currentValueText || '') ? Number(currentValueText) : parseNumber(currentValueText);
      const priorText = text.slice(0, clauseStart);
      const incisionMeasurement = /(?<amount>\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:cm|厘米)/gu;
      const priorSurgicalIncision = priorText.split(/[。！？；;\n\r]+/u).some(section => {
        if (!new RegExp(operativeProcedure, 'u').test(section)
          || !new RegExp(incisionTerm, 'u').test(section) || !section.includes(currentSite)
          || /既往|既有|陈旧|旧伤|此前|曾经|曾有|历史上|另一次(?:事故|外伤|受伤|手术)|不同事件/u.test(section)) return false;
        return [...section.matchAll(incisionMeasurement)].some(match => {
          const amountText = match.groups.amount;
          const priorValue = /^\d/u.test(amountText) ? Number(amountText) : parseNumber(amountText);
          return priorValue === currentValue;
        });
      });
      if (priorSurgicalIncision) return true;
    }
  }
  const nearby = text.slice(Math.max(0, measurementOffset - 24), Math.min(text.length, measurementOffset + 40));
  const explicitlySurgicalScar = /(?:手术|开颅|开胸|剖胸|开腹|剖腹)[^。；;\n]{0,18}(?:切口|瘢痕|疤痕)/u.test(nearby)
    && /(?:瘢痕|疤痕)/u.test(nearby);
  if (explicitlySurgicalScar) return true;
  const explicitlyMeasuredScar = /(?:瘢痕|疤痕)/u.test(nearby)
    && /(?:遗留|形成|瘢痕(?:长|长度)|疤痕(?:长|长度))/u.test(nearby);
  if (!explicitlyMeasuredScar) {
    for (const pattern of surgicalIncisionLengthPatterns) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const measurementStart = match.index + match[0].indexOf(match.groups.measurement);
        if (measurementOffset >= measurementStart
          && measurementOffset < measurementStart + match.groups.measurement.length) return true;
      }
    }
  }
  const localContext = text.slice(Math.max(0, measurementOffset - 16), Math.min(text.length, measurementOffset + 24));
  if (/(?:手术|开颅|引流)(?:后)?\s*(?:缝合)?\s*(?:切口|创口|伤口)/u.test(localContext)
    && !/(?:瘢痕|疤痕)/u.test(localContext)) return true;
  const start = Math.max(0, measurementOffset - 32);
  const end = Math.min(text.length, measurementOffset + 32);
  const context = text.slice(start, end);
  const cuePattern = /(?:(?:手术|开颅|引流)(?:后)?\s*(?:缝合)?\s*(?<operative>切口|创口|伤口)|(?<ordinary>创口|伤口|创痕|划痕|划伤|瘢痕|疤痕|切口|裂口|裂创|裂伤))/gu;
  let nearest = null;
  for (const match of context.matchAll(cuePattern)) {
    const lesion = match.groups.operative || match.groups.ordinary;
    const cueStart = start + match.index + match[0].lastIndexOf(lesion);
    const cueEnd = cueStart + lesion.length;
    const distance = measurementOffset < cueStart ? cueStart - measurementOffset
      : measurementOffset > cueEnd ? measurementOffset - cueEnd : 0;
    if (!nearest || distance < nearest.distance) {
      nearest = { operative: Boolean(match.groups.operative), cueStart, cueEnd, distance };
    }
  }
  if (!nearest?.operative) return false;
  const cueContext = text.slice(Math.max(0, nearest.cueStart - 12), Math.min(text.length, nearest.cueEnd + 20));
  return !/(?:瘢痕|疤痕)/u.test(cueContext);
}

function isSkinScratchLengthAtOffset(text, measurementOffset) {
  return /划痕/u.test(nearestLengthLesionCue(text, measurementOffset));
}

function woundMeasurementSiteAt(text, position) {
  const prefix = text.slice(Math.max(0, position - 36), position);
  const pattern = /(?:双侧|两侧|左侧|右侧|左|右)?(上下唇|上唇|下唇|口唇|唇部|耳廓内|耳廓外|耳廓|耳背|耳屏|耳垂|耳前|耳后|鼻背|鼻梁|鼻翼|鼻部|鼻|面部|脸部|额部|颧部|眼睑|眼眶|眼|颈部|颈|外阴|阴茎|阴囊|头皮|会阴|胸部正中|前胸正中|胸骨正中|腹部正中|上腹正中|下腹正中|腹部|胸部|背部)/gu;
  const matches = [...prefix.matchAll(pattern)];
  return matches.at(-1)?.[1] || null;
}

function isWoundDepthMeasurement(text, position) {
  const boundary = Math.max(text.lastIndexOf('。', position - 1), text.lastIndexOf('；', position - 1),
    text.lastIndexOf(';', position - 1), text.lastIndexOf('\n', position - 1));
  const prefix = text.slice(Math.max(boundary + 1, position - 12), position);
  return /(?:深|深度)\s*(?:约|为|达)?\s*$/u.test(prefix);
}

function isAggregateWoundLengthSummary(text, position) {
  const boundary = Math.max(text.lastIndexOf('。', position - 1), text.lastIndexOf('；', position - 1),
    text.lastIndexOf(';', position - 1), text.lastIndexOf('\n', position - 1));
  const prefix = text.slice(Math.max(boundary + 1, position - 96), position);
  return /(?:多处|多个|多条|(?:两|二|三|四|五|六|七|八|九|十|百|[2-9]\d*|1\d{1,})\s*(?:处|道|条))/u.test(prefix)
    && /(?:创口|伤口|创痕|裂口|裂创|裂伤|瘢痕|疤痕)/u.test(prefix)
    && /(?:总长(?:度)?|累计长(?:度)?|长度合计|长度累计)\s*(?:约|为|达)?\s*$/u.test(prefix);
}

function normalizeWoundLengthFacts(inputText) {
  const text = normalizeInput(inputText);
  const findings = normalizeSharedHeadingWoundLengthFacts(text);
  const measurementAmount = '(?:\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百]+)';
  const lengthThenDepthPattern = new RegExp(
    `(${measurementAmount})\\s*(?:cm|厘米)\\s*[、,，]\\s*(?:深|深度)(?:约|为|达)?\\s*(${measurementAmount})\\s*(?:cm|厘米)?(?=[^。；;\\n]{0,8}(?:创口|伤口|创痕|裂口|裂创|裂伤))`, 'gu');
  for (const clauseMatch of text.matchAll(/[^。；;\n]+/gu)) {
    const clause = clauseMatch[0];
    lengthThenDepthPattern.lastIndex = 0;
    for (const match of clause.matchAll(lengthThenDepthPattern)) {
      const value = /^\d+(?:\.\d+)?$/u.test(match[1]) ? Number(match[1]) : parseNumber(match[1]);
      if (!Number.isFinite(value) || certaintyFor(clause, match.index, match.index + match[0].length) !== 'reported') continue;
      const valueOffset = clauseMatch.index + match.index + match[0].indexOf(match[1]);
      findings.push({ id: `WL${valueOffset}`, field: 'wound_length_cm', value, certainty: 'reported',
        source_type: 'user_text', source_excerpt: clause.trim(), parserKey: `${valueOffset}:${value}` });
    }
  }
  const patterns = [
    /(?:竖形|斜形|环形|三角形|弧形|横形|纵形)[^，、,。；;\n]{0,8}(?:创口|伤口)\s*约\s*(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:cm|厘米)/gu,
    /(?:裂口|裂创|裂伤|划伤)\s*(?:(?:长度|长)\s*)?约\s*(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:cm|厘米)/gu,
    /(?:创口|伤口|创痕|划痕|划伤|瘢痕|疤痕|切口|裂口|裂创|裂伤)\s*(?:(?:长度|长)\s*)?(?:为|达)?\s*(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:cm|厘米)/gu,
    /(?:瘢痕|疤痕)\s*(?:(?:长度|长)\s*)?(?:约|为|达)\s*(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:cm|厘米)/gu,
    /(?:创口|伤口|创痕|划痕|划伤|瘢痕|疤痕|切口|裂口|裂创|裂伤)[^，、,。；;\n]{0,12}?(?:[，,]\s*)?(?:长|长度)(?:约|为)?\s*(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:cm|厘米)/gu,
    /(?:创口|伤口|创痕|划痕|划伤|瘢痕|疤痕|切口|裂口|裂创|裂伤)[^。；;\n]{0,12}?(?:[，,]\s*)?(?:入院|急诊|法医)?(?:查体|检查)(?:记录)?(?:见|测得|量得)?(?:长|长度)(?:约|为)?\s*(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:cm|厘米)/gu,
    /(?:长|长度)(?:约|为)?\s*(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:cm|厘米)[^，、,。；;\n]{0,12}(?:创口|伤口|创痕|划痕|划伤|瘢痕|疤痕|切口|裂口|裂创|裂伤)/gu,
    /(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:cm|厘米)(?:长|长的|大小|纵形|纵向|横形|横向|线形|缝合|縫合){1,3}[^，、,。；;\n]{0,8}(?:创口|伤口|创痕|划痕|划伤|瘢痕|疤痕|切口|裂口|裂创|裂伤)/gu,
    /(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:cm|厘米)[^，、,。；;\n]{0,16}(?:创口|伤口|创痕|划痕|划伤|瘢痕|疤痕|切口|裂口|裂创|裂伤)/gu,
  ];
  for (const clauseMatch of text.matchAll(/[^。；;\n]+/gu)) {
    const clause = clauseMatch[0];
    const clauseOffset = clauseMatch.index;
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of clause.matchAll(pattern)) {
        if (isInternalOrganTearMeasurement(clause, match.index, match.index + match[0].length)) continue;
        const valueOffsetInClause = match.index + match[0].indexOf(match[1]);
        const beforeValue = clause.slice(Math.max(0, valueOffsetInClause - 20), valueOffsetInClause);
        const afterValue = clause.slice(valueOffsetInClause + match[1].length,
          valueOffsetInClause + match[1].length + 24);
        const explicitWoundLengthBeforeValue = /(?:创口|伤口|创痕|瘢痕|疤痕|切口|裂口|裂创|裂伤)[^，、,。；;\n]{0,12}(?:长|长度|为|约|达)\s*$/u.test(beforeValue);
        const followsBoneFractureMeasurement = /^\s*(?:cm|厘米)?\s*(?:颅骨|额骨|顶骨|枕骨|颞骨|骨折|骨片|骨脊)/u.test(afterValue);
        if (followsBoneFractureMeasurement && !explicitWoundLengthBeforeValue) continue;
        const hasAdjacentDimension = /[×xX*]\s*(?:宽|高|深)?\s*$/u.test(beforeValue)
          || /^\s*(?:cm|厘米)?\s*[×xX*]\s*(?:宽|高|深)?\s*\d/u.test(afterValue);
        const hasExplicitLengthRelation = /(?:长|长度)\s*(?:约|为|达)?\s*$/u.test(beforeValue);
        if (hasAdjacentDimension && !hasExplicitLengthRelation) continue;
        const value = /^\d+(?:\.\d+)?$/.test(match[1]) ? Number(match[1]) : parseNumber(match[1]);
        if (!Number.isFinite(value)) continue;
        const certaintyStart = Math.max(0, match.index - 12);
        const contextStart = woundLengthEvidenceStart(clause, match.index);
        const contextEnd = match.index + match[0].length;
        const certainty = certaintyFor(clause, certaintyStart, contextEnd);
        if (!['reported', 'excluded', 'uncertain', 'unknown'].includes(certainty)) continue;
        const evidence = clause.slice(contextStart, contextEnd).trim();
        const valueOffset = clauseOffset + valueOffsetInClause;
        findings.push({ id: `WL${valueOffset}`, field: 'wound_length_cm', value, certainty,
          source_type: 'user_text', source_excerpt: evidence, parserKey: `${valueOffset}:${value}` });
      }
    }
  }
  const amountWithoutCapture = '(?:\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百]+)';
  const woundTerm = '(?:创口|伤口|创痕|划痕|划伤|瘢痕|疤痕|切口|裂口|裂创|裂伤)';
  const conjoinedWoundLengthPattern = new RegExp(
    `(${amountWithoutCapture})\\s*(?:cm|厘米)[^，、,。；;\\n]{0,10}?${woundTerm}\\s*(?:及|和|以及)\\s*(${amountWithoutCapture})\\s*(?:cm|厘米)[^，、,。；;\\n]{0,10}?${woundTerm}`, 'gu');
  for (const clauseMatch of text.matchAll(/[^。；;\n]+/gu)) {
    const clause = clauseMatch[0];
    const clauseOffset = clauseMatch.index;
    conjoinedWoundLengthPattern.lastIndex = 0;
    for (const match of clause.matchAll(conjoinedWoundLengthPattern)) {
      const certainty = certaintyFor(clause, Math.max(0, match.index - 12), match.index + match[0].length);
      if (!['reported', 'excluded', 'uncertain', 'unknown'].includes(certainty)) continue;
      const contextStart = woundLengthEvidenceStart(clause, match.index);
      const evidence = clause.slice(contextStart, match.index + match[0].length).trim();
      let cursor = 0;
      for (const token of [match[1], match[2]]) {
        const tokenOffsetInMatch = match[0].indexOf(token, cursor);
        if (tokenOffsetInMatch < 0) continue;
        const value = /^\d+(?:\.\d+)?$/u.test(token) ? Number(token) : parseNumber(token);
        if (!Number.isFinite(value)) continue;
        const valueOffset = clauseOffset + match.index + tokenOffsetInMatch;
        findings.push({ id: `WL${valueOffset}`, field: 'wound_length_cm', value, certainty,
          source_type: 'user_text', source_excerpt: evidence, parserKey: `${valueOffset}:${value}` });
        cursor = tokenOffsetInMatch + token.length;
      }
    }
  }
  const dimensionAmount = '(\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百]+)';
  const stitchedWoundDimensionPatterns = [
    new RegExp(`${dimensionAmount}\\s*(?:cm|厘米)?\\s*[×xX*]\\s*${dimensionAmount}\\s*(?:cm|厘米)\\s*(?:[“”"]?Y[“”"]?形)?(?:缝合)?(?:创口|伤口|创痕|划痕|划伤|裂口|裂伤|切口)`, 'gu'),
    new RegExp(`(?:缝合)?(?:创口|伤口|创痕|划痕|划伤|裂口|裂伤|切口)[^，、,。；;\\n]{0,12}?${dimensionAmount}\\s*(?:cm|厘米)?\\s*[×xX*]\\s*${dimensionAmount}\\s*(?:cm|厘米)`, 'gu'),
  ];
  for (const clauseMatch of text.matchAll(/[^。；;\n]+/gu)) {
    const clause = clauseMatch[0];
    const clauseOffset = clauseMatch.index;
    for (const pattern of stitchedWoundDimensionPatterns) {
      pattern.lastIndex = 0;
      for (const match of clause.matchAll(pattern)) {
        const first = /^\d+(?:\.\d+)?$/u.test(match[1]) ? Number(match[1]) : parseNumber(match[1]);
        const second = /^\d+(?:\.\d+)?$/u.test(match[2]) ? Number(match[2]) : parseNumber(match[2]);
        if (!Number.isFinite(first) || !Number.isFinite(second)) continue;
        const longAxis = Math.max(first, second);
        const shortAxis = Math.min(first, second);
        if (shortAxis <= 0 || longAxis / shortAxis < 1.5) continue;
        const longToken = first >= second ? match[1] : match[2];
        const valueOffsetInClause = match.index + match[0].indexOf(longToken);
        const certainty = certaintyFor(clause, match.index, match.index + match[0].length);
        if (!['reported', 'excluded', 'uncertain', 'unknown'].includes(certainty)) continue;
        const evidenceStart = Math.max(0, match.index - 16);
        const evidence = clause.slice(evidenceStart, match.index + match[0].length).trim();
        const valueOffset = clauseOffset + valueOffsetInClause;
        findings.push({ id: `WL${valueOffset}`, field: 'wound_length_cm', value: longAxis, certainty,
          source_type: 'user_text', source_excerpt: evidence, parserKey: `${valueOffset}:${longAxis}` });
      }
    }
  }
  const separatelyMeasuredWoundDimensionsPattern = new RegExp(
    `(?:[二两2-9]处|多处)(?:缝合)?(?:创口|伤口|创痕|划痕|划伤|裂口|裂伤|切口)[^，、,。；;\\n]{0,16}?[，,]?\\s*分别\\s*${dimensionAmount}\\s*(?:cm|厘米)?\\s*[×xX*]\\s*${dimensionAmount}\\s*(?:cm|厘米)\\s*[、，,]\\s*${dimensionAmount}\\s*(?:cm|厘米)?\\s*[×xX*]\\s*${dimensionAmount}\\s*(?:cm|厘米)`, 'gu');
  for (const clauseMatch of text.matchAll(/[^。；;\n]+/gu)) {
    const clause = clauseMatch[0];
    const clauseOffset = clauseMatch.index;
    separatelyMeasuredWoundDimensionsPattern.lastIndex = 0;
    for (const match of clause.matchAll(separatelyMeasuredWoundDimensionsPattern)) {
      for (const [lengthToken, widthToken] of [[match[1], match[2]], [match[3], match[4]]]) {
        const length = /^\d+(?:\.\d+)?$/u.test(lengthToken) ? Number(lengthToken) : parseNumber(lengthToken);
        const width = /^\d+(?:\.\d+)?$/u.test(widthToken) ? Number(widthToken) : parseNumber(widthToken);
        if (!Number.isFinite(length) || !Number.isFinite(width) || width <= 0
          || Math.max(length, width) / Math.min(length, width) < 1.5) continue;
        const value = Math.max(length, width);
        const valueToken = length >= width ? lengthToken : widthToken;
        const valueOffset = clauseOffset + match.index + match[0].indexOf(valueToken);
        const evidenceStart = Math.max(0, match.index - 16);
        findings.push({ id: `WL${valueOffset}`, field: 'wound_length_cm', value, certainty: 'reported',
          source_type: 'user_text', source_excerpt: clause.slice(evidenceStart, match.index + match[0].length).trim(),
          parserKey: `${valueOffset}:${value}` });
      }
    }
  }
  const regionalWoundSegmentPattern = new RegExp(
    `(?:面部|颈部|头部|头皮|下颌|颏下|下唇|上唇)\\s*(?:创口|创痕|划痕|划伤|瘢痕|疤痕)?\\s*(?:长|长度)?\\s*(?:为)?\\s*${dimensionAmount}\\s*(?:cm|厘米)`, 'gu');
  for (const clauseMatch of text.matchAll(/[^。；;\n]+/gu)) {
    const clause = clauseMatch[0];
    const clauseOffset = clauseMatch.index;
    if (!/(?:其中|总长|长度合计)/u.test(clause)
      || !/(?:创口|伤口|创痕|划痕|划伤|瘢痕|疤痕|切口|裂口|裂创|裂伤)/u.test(clause)
      || certaintyFor(clause, 0, clause.length) !== 'reported') continue;
    regionalWoundSegmentPattern.lastIndex = 0;
    for (const match of clause.matchAll(regionalWoundSegmentPattern)) {
      const value = /^\d+(?:\.\d+)?$/u.test(match[1]) ? Number(match[1]) : parseNumber(match[1]);
      if (!Number.isFinite(value)) continue;
      const valueOffset = clauseOffset + match.index + match[0].indexOf(match[1]);
      findings.push({ id: `WL${valueOffset}`, field: 'wound_length_cm', value, certainty: 'reported',
        source_type: 'user_text', source_excerpt: clause.slice(Math.max(0, match.index - 6), match.index + match[0].length).trim(),
        parserKey: `${valueOffset}:${value}` });
    }
  }
  const linearScarDimensionPattern = /(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:cm|厘米)?\s*[×xX*]\s*(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:cm|厘米)/gu;
  for (const clauseMatch of text.matchAll(/[^。；;\n]+/gu)) {
    const clause = clauseMatch[0];
    const clauseOffset = clauseMatch.index;
    const scarPositions = [...clause.matchAll(/瘢痕|疤痕/gu)].map(match => match.index);
    const linearShapePositions = [...clause.matchAll(/横(?:行|向)|纵(?:行|向)|线状|条状/gu)].map(match => match.index);
    if (!scarPositions.length) continue;
    linearScarDimensionPattern.lastIndex = 0;
    for (const match of clause.matchAll(linearScarDimensionPattern)) {
      const scarNearDimension = scarPositions.some(position => Math.abs(position - match.index) <= 32);
      const shapeNearDimension = linearShapePositions.some(position => position >= match.index - 32
        && position <= match.index + match[0].length + 32);
      if (!scarNearDimension) continue;
      const first = /^\d+(?:\.\d+)?$/u.test(match[1]) ? Number(match[1]) : parseNumber(match[1]);
      const second = /^\d+(?:\.\d+)?$/u.test(match[2]) ? Number(match[2]) : parseNumber(match[2]);
      if (!Number.isFinite(first) || !Number.isFinite(second)) continue;
      const longAxis = Math.max(first, second);
      const shortAxis = Math.min(first, second);
      if (shortAxis <= 0 || longAxis / shortAxis < 1.5) continue;
      const measurementContext = clause.slice(Math.max(0, match.index - 16), match.index + match[0].length + 16);
      const clearlyLinearByDimensions = longAxis / shortAxis >= 10
        && !/(?:片状|斑片|椭圆|类圆|不规则)/u.test(measurementContext);
      if (!shapeNearDimension && !clearlyLinearByDimensions) continue;
      const firstIsLength = first >= second;
      const value = firstIsLength ? first : second;
      const valueOffsetInClause = match.index + (firstIsLength
        ? match[0].indexOf(match[1]) : match[0].lastIndexOf(match[2]));
      const certainty = certaintyFor(clause, match.index, match.index + match[0].length);
      if (!['reported', 'excluded', 'uncertain', 'unknown'].includes(certainty)) continue;
      const valueOffset = clauseOffset + valueOffsetInClause;
      findings.push({ id: `WL${valueOffset}`, field: 'wound_length_cm', value, certainty,
        source_type: 'user_text', source_excerpt: clause.trim(), parserKey: `${valueOffset}:${value}` });
    }
  }
  const separateDimensionAmount = '(?:\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百]+)';
  const separatelyMeasuredWoundDimensions = new RegExp(
    `(?<first>${separateDimensionAmount})\\s*(?:cm|厘米)?\\s*[×xX*]\\s*(?<firstWidth>${separateDimensionAmount})\\s*(?:cm|厘米)?`
      + `\\s*(?:及|和|[、,，])\\s*(?<second>${separateDimensionAmount})\\s*(?:cm|厘米)?\\s*[×xX*]\\s*`
      + `(?<secondWidth>${separateDimensionAmount})\\s*(?:cm|厘米)?\\s*(?:两|二|2)处(?:损伤)?(?:创口|伤口|裂伤)`, 'gu');
  for (const clauseMatch of text.matchAll(/[^。；;\n]+/gu)) {
    const clause = clauseMatch[0];
    const clauseOffset = clauseMatch.index;
    separatelyMeasuredWoundDimensions.lastIndex = 0;
    for (const match of clause.matchAll(separatelyMeasuredWoundDimensions)) {
      const certainty = certaintyFor(clause, match.index, match.index + match[0].length);
      if (certainty !== 'reported') continue;
      const first = /^\d+(?:\.\d+)?$/u.test(match.groups.first) ? Number(match.groups.first)
        : parseNumber(match.groups.first);
      const firstWidth = /^\d+(?:\.\d+)?$/u.test(match.groups.firstWidth) ? Number(match.groups.firstWidth)
        : parseNumber(match.groups.firstWidth);
      const second = /^\d+(?:\.\d+)?$/u.test(match.groups.second) ? Number(match.groups.second)
        : parseNumber(match.groups.second);
      const secondWidth = /^\d+(?:\.\d+)?$/u.test(match.groups.secondWidth) ? Number(match.groups.secondWidth)
        : parseNumber(match.groups.secondWidth);
      if (![first, firstWidth, second, secondWidth].every(Number.isFinite)
        || Math.min(first, firstWidth, second, secondWidth) <= 0) continue;
      const firstValue = Math.max(first, firstWidth);
      const firstShortAxis = Math.min(first, firstWidth);
      const secondValue = Math.max(second, secondWidth);
      const secondShortAxis = Math.min(second, secondWidth);
      const firstToken = first >= firstWidth ? match.groups.first : match.groups.firstWidth;
      const secondToken = second >= secondWidth ? match.groups.second : match.groups.secondWidth;
      const firstDimensionStart = match[0].indexOf(match.groups.first);
      const firstOffsetInMatch = match[0].indexOf(firstToken, firstDimensionStart);
      const firstDimensionEnd = match[0].indexOf(match.groups.firstWidth, firstDimensionStart)
        + match.groups.firstWidth.length;
      const secondDimensionStart = match[0].indexOf(match.groups.second, firstDimensionEnd);
      const secondOffsetInMatch = match[0].indexOf(secondToken, secondDimensionStart);
      const measuredLengths = [
        ...(firstValue / firstShortAxis >= 1.5 ? [[firstValue, firstOffsetInMatch]] : []),
        ...(secondValue / secondShortAxis >= 1.5 ? [[secondValue, secondOffsetInMatch]] : []),
      ];
      for (const [value, tokenOffset] of measuredLengths) {
        if (tokenOffset < 0) continue;
        const valueOffset = clauseOffset + match.index + tokenOffset;
        findings.push({ id: `WL${valueOffset}`, field: 'wound_length_cm', value, certainty,
          source_type: 'user_text', source_excerpt: clause.slice(Math.max(0, match.index - 20),
            match.index + match[0].length).trim(), parserKey: `${valueOffset}:${value}` });
      }
    }
  }
  const amount = '(\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百]+)';
  const pairedLengthPattern = new RegExp(`(?:创口|伤口|瘢痕|疤痕|切口|裂口|裂创|裂伤)[^。；;\\n]{0,32}(?:分别|各)?长\\s*${amount}\\s*(?:cm|厘米)\\s*(?:[、,，]|和|及)\\s*${amount}\\s*(?:cm|厘米)`, 'gu');
  for (const clauseMatch of text.matchAll(/[^。；;\n]+/gu)) {
    const clause = clauseMatch[0];
    const clauseOffset = clauseMatch.index;
    pairedLengthPattern.lastIndex = 0;
    for (const match of clause.matchAll(pairedLengthPattern)) {
      const certainty = certaintyFor(clause, match.index, match.index + match[0].length);
      if (!['reported', 'excluded', 'uncertain', 'unknown'].includes(certainty)) continue;
      let cursor = match.index;
      const evidenceStart = Math.max(clause.lastIndexOf('；', match.index), clause.lastIndexOf(';', match.index),
        clause.lastIndexOf('。', match.index), clause.lastIndexOf('\n', match.index)) + 1;
      const evidence = clause.slice(evidenceStart, match.index + match[0].length).trim();
      for (const token of [match[1], match[2]]) {
        const tokenOffset = clause.indexOf(token, cursor);
        if (tokenOffset < 0) continue;
        const value = /^\d+(?:\.\d+)?$/u.test(token) ? Number(token) : parseNumber(token);
        if (!Number.isFinite(value)) continue;
        const end = tokenOffset + token.length;
        const unitEnd = clause.slice(end).match(/^\s*(?:cm|厘米)/u)?.[0].length || 0;
        const valueOffset = clauseOffset + tokenOffset;
        findings.push({ id: `WL${valueOffset}`, field: 'wound_length_cm', value, certainty,
          source_type: 'user_text', source_excerpt: evidence, parserKey: `${valueOffset}:${value}` });
        cursor = end + unitEnd;
      }
    }
  }
  const woundLengthListPattern = new RegExp(
    `(?:创口|伤口|创痕|划痕|划伤|瘢痕|疤痕|切口|裂口|裂创|裂伤)[^。；;\\n]{0,32}?(?:分别|各)\\s*(?:(?:为|长|长度)\\s*)?(?:约|大约)?\\s*(${amount}(?:\\s*(?:cm|厘米)?\\s*(?:[、,，+＋]|和|及)\\s*${amount})+)\\s*(?:cm|厘米)`, 'gu');
  for (const clauseMatch of text.matchAll(/[^。；;\n]+/gu)) {
    const clause = clauseMatch[0];
    const clauseOffset = clauseMatch.index;
    woundLengthListPattern.lastIndex = 0;
    for (const match of clause.matchAll(woundLengthListPattern)) {
      const certainty = certaintyFor(clause, match.index, match.index + match[0].length);
      if (!['reported', 'excluded', 'uncertain', 'unknown'].includes(certainty)) continue;
      const evidenceStart = Math.max(clause.lastIndexOf('；', match.index), clause.lastIndexOf(';', match.index),
        clause.lastIndexOf('。', match.index), clause.lastIndexOf('\n', match.index)) + 1;
      const evidence = clause.slice(evidenceStart, match.index + match[0].length).trim();
      const listOffset = match[0].indexOf(match[1]);
      for (const tokenMatch of match[1].matchAll(new RegExp(amount, 'gu'))) {
        const token = tokenMatch[0];
        const value = /^\d+(?:\.\d+)?$/u.test(token) ? Number(token) : parseNumber(token);
        if (!Number.isFinite(value)) continue;
        const tokenOffset = match.index + listOffset + tokenMatch.index;
        const end = tokenOffset + token.length;
        const valueOffset = clauseOffset + tokenOffset;
        findings.push({ id: `WL${valueOffset}`, field: 'wound_length_cm', value, certainty,
          source_type: 'user_text', source_excerpt: evidence,
          parserKey: `${valueOffset}:${value}` });
      }
    }
  }
  const amountToken = '(?:\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百]+)';
  const countedWoundList = `(?<count>${amountToken})\\s*处[^。；;\\n]{0,28}?`
    + `(?:(?:分别|各)?(?:约|大约|为|长|长度)\\s*)?`
    + `(?<values>${amountToken}(?:\\s*(?:cm|厘米)?\\s*(?:[、,，]|和|及)\\s*(?:约|大约)?${amountToken})+)\\s*(?:cm|厘米)?`;
  const countedWoundLengthListPatterns = [
    new RegExp(`${countedWoundList}[^。；;\\n]{0,24}(?:创口|伤口|创痕|划痕|划伤|瘢痕|疤痕|切口|裂口|裂创|裂伤)`, 'gu'),
    new RegExp(`(?<count>${amountToken})\\s*处[^。；;\\n]{0,28}?(?:创口|伤口|创痕|划痕|划伤|瘢痕|疤痕|切口|裂口|裂创|裂伤)[^。；;\\n]{0,20}?(?:[，,]\\s*)?(?:(?:分别|各)?(?:约|大约|为|长|长度)\\s*|(?:约|大约)?)(?<values>${amountToken}(?:\\s*(?:cm|厘米)?\\s*(?:[、,，]|和|及)\\s*(?:约|大约)?${amountToken})+)\\s*(?:cm|厘米)?`, 'gu'),
    new RegExp(`(?<values>${amountToken}(?:\\s*(?:cm|厘米)?\\s*(?:[、,，]|和|及)\\s*(?:约|大约)?${amountToken})+\\s*(?:cm|厘米)?)\\s*(?<count>${amountToken})\\s*处[^。；;\\n]{0,16}(?:创口|伤口|创痕|划痕|划伤|瘢痕|疤痕|切口|裂口|裂创|裂伤)`, 'gu'),
  ];
  for (const clauseMatch of text.matchAll(/[^。；;\\n]+/gu)) {
    const clause = clauseMatch[0];
    const clauseOffset = clauseMatch.index;
    for (const pattern of countedWoundLengthListPatterns) {
      pattern.lastIndex = 0;
      for (const match of clause.matchAll(pattern)) {
        const count = parseNumber(match.groups.count);
        const values = [...match.groups.values.matchAll(new RegExp(amountToken, 'gu'))];
        if (!Number.isInteger(count) || count < 2 || values.length < 2 || values.length > count) continue;
        const certainty = certaintyFor(clause, match.index, match.index + match[0].length);
        if (!['reported', 'excluded', 'uncertain', 'unknown'].includes(certainty)) continue;
        const listStart = match.index + match[0].indexOf(match.groups.values);
        for (const tokenMatch of values) {
          const token = tokenMatch[0];
          const tokenOffsetInClause = listStart + tokenMatch.index;
          const precedingValueText = clause.slice(Math.max(0, tokenOffsetInClause - 8), tokenOffsetInClause);
          if (/[×xX*]\s*(?:宽|高|深)?\s*$/u.test(precedingValueText)) continue;
          const value = /^\d+(?:\.\d+)?$/u.test(token) ? Number(token) : parseNumber(token);
          if (!Number.isFinite(value)) continue;
          const valueOffset = clauseOffset + tokenOffsetInClause;
          findings.push({ id: `WL${valueOffset}`, field: 'wound_length_cm', value, certainty,
            source_type: 'user_text', source_excerpt: clause.trim(), parserKey: `${valueOffset}:${value}` });
        }
      }
    }
  }
  const explicitlyMeasuredPlusLengthPattern = new RegExp(
    `(?:创口|伤口|创痕|划痕|划伤|瘢痕|疤痕|切口|裂口|裂创|裂伤)[^。；;，,\\n]{0,24}?(${amount}\\s*(?:cm|厘米)\\s*[+＋]\\s*${amount}\\s*(?:cm|厘米))`, 'giu');
  for (const clauseMatch of text.matchAll(/[^。；;\n]+/gu)) {
    const clause = clauseMatch[0];
    const clauseOffset = clauseMatch.index;
    explicitlyMeasuredPlusLengthPattern.lastIndex = 0;
    for (const match of clause.matchAll(explicitlyMeasuredPlusLengthPattern)) {
      const certainty = certaintyFor(clause, match.index, match.index + match[0].length);
      if (!['reported', 'excluded', 'uncertain', 'unknown'].includes(certainty)) continue;
      const evidenceStart = Math.max(clause.lastIndexOf('；', match.index), clause.lastIndexOf(';', match.index),
        clause.lastIndexOf('。', match.index), clause.lastIndexOf('\n', match.index)) + 1;
      const evidence = clause.slice(evidenceStart, match.index + match[0].length).trim();
      const groupOffset = match[0].indexOf(match[1]);
      for (const tokenMatch of match[1].matchAll(new RegExp(amount, 'gu'))) {
        const token = tokenMatch[0];
        const value = /^\d+(?:\.\d+)?$/u.test(token) ? Number(token) : parseNumber(token);
        if (!Number.isFinite(value)) continue;
        const valueOffset = clauseOffset + match.index + groupOffset + tokenMatch.index;
        findings.push({ id: `WL${valueOffset}`, field: 'wound_length_cm', value, certainty,
          source_type: 'user_text', source_excerpt: evidence, parserKey: `${valueOffset}:${value}` });
      }
    }
  }
  const regionPatterns = [
    { pattern: new RegExp(`(?:其中|[，,、])\\s*${amount}\\s*(?:cm|厘米)(?:长)?\\s*(?:位于|在|属于)\\s*(面部|脸部|颈前部|颈部|头部|头皮|耳廓|口唇|眼睑)(?:区域|部)?`, 'gu'), amountIndex: 1, siteIndex: 2 },
    { pattern: new RegExp(`其中\\s*(面部|脸部|颈前部|颈部|头部|头皮|耳廓|口唇|眼睑)(?:区域|部|部分|创口)?\\s*(?:创口)?\\s*(?:长|长度)(?:约|为|达)?\\s*${amount}\\s*(?:cm|厘米)`, 'gu'), amountIndex: 2, siteIndex: 1 },
    { pattern: new RegExp(`(?:其中|[，,、])\\s*(面部|脸部|头部|头皮)(?:区域|段|部分)?(?:创口|伤口)?\\s*${amount}\\s*(?:cm|厘米)`, 'gu'), amountIndex: 2, siteIndex: 1 },
  ];
  for (const clauseMatch of text.matchAll(/[^。；;\n]+/gu)) {
    const clause = clauseMatch[0];
    const clauseOffset = clauseMatch.index;
    for (const { pattern, amountIndex, siteIndex } of regionPatterns) {
      pattern.lastIndex = 0;
      for (const match of clause.matchAll(pattern)) {
        const prefix = clause.slice(0, match.index);
    const woundCues = [...prefix.matchAll(/创口|伤口|划痕|划伤|瘢痕|疤痕|切口|裂口|裂创|裂伤/gu)];
        const woundCue = woundCues.at(-1);
        const relation = woundCue ? clause.slice(woundCue.index, match.index) : '';
        if (!woundCue || relation.length > 90 || !(/^其中/u.test(match[0]) || /其中/u.test(relation))) continue;
        const amountToken = match[amountIndex];
        const value = /^\d+(?:\.\d+)?$/u.test(amountToken) ? Number(amountToken) : parseNumber(amountToken);
        if (!Number.isFinite(value)) continue;
        const certainty = certaintyFor(clause, match.index, match.index + match[0].length);
        if (!['reported', 'excluded', 'uncertain', 'unknown'].includes(certainty)) continue;
        const evidence = match[0].trim();
        const valueOffset = clauseOffset + match.index + match[0].indexOf(amountToken);
        findings.push({ id: `WL${valueOffset}`, field: 'wound_length_cm', value, certainty,
          source_type: 'user_text', source_excerpt: evidence, parserKey: `${valueOffset}:${value}`,
          regionEvidence: { site: match[siteIndex], injuryType: woundCue[0] } });
      }
    }
  }
  const listedScarLengthsPattern = new RegExp(
    `((?:${amount}\\s*(?:cm|厘米)\\s*(?:[、,，]|和|及)\\s*)+${amount}\\s*(?:cm|厘米))(?=[^。；;\\n]{0,8}(?:瘢痕|疤痕))`, 'gu');
  for (const clauseMatch of text.matchAll(/[^。；;\n]+/gu)) {
    const clause = clauseMatch[0];
    const clauseOffset = clauseMatch.index;
    listedScarLengthsPattern.lastIndex = 0;
    for (const match of clause.matchAll(listedScarLengthsPattern)) {
      const certainty = certaintyFor(clause, match.index, match.index + match[0].length);
      if (!['reported', 'excluded', 'uncertain', 'unknown'].includes(certainty)) continue;
      for (const tokenMatch of match[1].matchAll(new RegExp(amount, 'gu'))) {
        const value = /^\d+(?:\.\d+)?$/u.test(tokenMatch[0]) ? Number(tokenMatch[0]) : parseNumber(tokenMatch[0]);
        if (!Number.isFinite(value)) continue;
        const valueOffset = clauseOffset + match.index + tokenMatch.index;
        findings.push({ id: `WL${valueOffset}`, field: 'wound_length_cm', value, certainty,
          source_type: 'user_text', source_excerpt: clause.trim(), parserKey: `${valueOffset}:${value}` });
      }
    }
  }
  const siteLedScarLengthPattern = new RegExp(
    `(?:左|右|双侧|两侧)?(?:颞枕部|顶枕部|后枕部|枕骨隆突部|枕项部|颞顶部|额顶部|头顶部|额部|颞部|顶部|枕部|头皮|颈后|颈部|项部)(?:发际线?(?:内|外))?\\s*(${amount})\\s*(?:cm|厘米)`, 'gu');
  for (const clauseMatch of text.matchAll(/[^。；;\n]+/gu)) {
    const clause = clauseMatch[0];
    const clauseOffset = clauseMatch.index;
    if (!/(?:瘢痕|疤痕)/u.test(clause)) continue;
    siteLedScarLengthPattern.lastIndex = 0;
    for (const match of clause.matchAll(siteLedScarLengthPattern)) {
      const certainty = certaintyFor(clause, match.index, match.index + match[0].length);
      if (!['reported', 'excluded', 'uncertain', 'unknown'].includes(certainty)) continue;
      const value = /^\d+(?:\.\d+)?$/u.test(match[1]) ? Number(match[1]) : parseNumber(match[1]);
      if (!Number.isFinite(value)) continue;
      const scarCue = /(?:头皮)?(?:瘢痕|疤痕)/u.exec(clause.slice(match.index + match[0].length));
      if (!scarCue || scarCue.index > 64) continue;
      const evidenceEnd = match.index + match[0].length + scarCue.index + scarCue[0].length;
      const evidence = clause.slice(match.index, evidenceEnd).trim();
      const valueOffset = clauseOffset + match.index + match[0].indexOf(match[1]);
      findings.push({ id: `WL${valueOffset}`, field: 'wound_length_cm', value, certainty,
        source_type: 'user_text', source_excerpt: evidence, parserKey: `${valueOffset}:${value}` });
    }
  }
  return [...new Map(findings.map(fact => [fact.parserKey, fact])).values()]
    .filter(fact => !isWoundDepthMeasurement(text, Number(fact.id.slice(2)))
      && !isAggregateWoundLengthSummary(text, Number(fact.id.slice(2)))
      && !isSkinScratchLengthAtOffset(text, Number(fact.id.slice(2)))
      && !isOperativeIncisionLengthAtOffset(text, Number(fact.id.slice(2))));
}

function normalizeSkinScratchClinicalFacts(inputText) {
  const text = normalizeInput(inputText);
  const findings = [];
  const scratchPattern = /(?:皮肤)?(?:表浅|浅表)?划痕/gu;
  const amount = '(?:\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百]+)';
  for (const clauseMatch of text.matchAll(/[^。；;\\n]+/gu)) {
    const clause = clauseMatch[0];
    const clauseOffset = clauseMatch.index;
    scratchPattern.lastIndex = 0;
    for (const scratch of clause.matchAll(scratchPattern)) {
      const scratchEnd = scratch.index + scratch[0].length;
      const before = clause.slice(Math.max(0, scratch.index - 28), scratch.index);
      const after = clause.slice(scratchEnd, scratchEnd + 32);
      const precedingDimension = new RegExp(`(${amount}(?:\\s*(?:cm|厘米))?\\s*[×xX*]\\s*${amount}\\s*(?:cm|厘米)?)\\s*$`, 'u')
        .exec(before);
      const precedingLength = new RegExp(`(${amount}\\s*(?:cm|厘米))\\s*$`, 'u').exec(before);
      const followingLength = new RegExp(`^\\s*(?:(?:长|长度)\\s*)?(?:约|为|达)?\\s*(${amount})\\s*(cm|厘米)`, 'u')
        .exec(after);
      const precedingMeasurement = precedingDimension || precedingLength;
      const valueStart = precedingMeasurement ? scratch.index - precedingMeasurement[1].length : scratch.index;
      const valueEnd = followingLength ? scratchEnd + followingLength[0].length : scratchEnd;
      const value = clause.slice(valueStart, valueEnd).trim();
      const certainty = certaintyFor(clause, valueStart, valueEnd);
      if (!value || !['reported', 'excluded', 'uncertain', 'unknown'].includes(certainty)) continue;
      const evidence = clause.slice(Math.max(0, valueStart - 12), valueEnd).trim();
      findings.push({ id: `SF${clauseOffset + valueStart}`, field: 'clinical_finding', value, certainty,
        source_type: 'user_text', source_excerpt: evidence });
    }
  }
  return [...new Map(findings.map(fact => [JSON.stringify([fact.source_excerpt, fact.value]), fact])).values()];
}

function explicitWoundMultiplicity(fact) {
  const evidence = normalizeInput(fact.source_excerpt || '');
  if (!/(?:创口|伤口|创痕|划痕|划伤|瘢痕|疤痕|切口|裂口|裂创|裂伤)/u.test(evidence)
    || /[×xX*]|分别|各/u.test(evidence)) return 1;
  const count = evidence.match(/([0-9零〇一二两三四五六七八九十百]+)\s*(?:处|道)/u);
  const measurements = [...evidence.matchAll(/(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:cm|厘米)/gu)];
  if (!count || measurements.length !== 1) return 1;
  const lengthValues = [...evidence.slice(count.index + count[0].length, measurements[0].index)
    .matchAll(/\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+/gu)];
  if (lengthValues.length > 0) return 1;
  const multiplicity = parseNumber(count[1]);
  return Number.isInteger(multiplicity) && multiplicity >= 2 && multiplicity <= 12 ? multiplicity : 1;
}

function scalpWoundRegion(evidence) {
  const text = normalizeInput(evidence || '');
  if (/(?:面部|脸部|眉|眼睑|眼外侧|眼外眦|外眦|面颊|颊部|颊|鼻部|口唇|下颌)/u.test(text)) return null;
  const region = text.match(/枕骨隆突部|枕项部|头顶部|额顶部|后枕部|颞枕部|顶枕部|颞顶部|颞部|顶部|枕部|头皮/u)?.[0];
  if (!region) return null;
  if (/顶部/u.test(region)) return 'top';
  if (/颞枕|顶枕|后枕|枕部/u.test(region)) return 'occipital';
  return 'scalp';
}

function woundMeasurementExcerpt(text, fact) {
  const positionMatch = /^WL(\d+)$/u.exec(String(fact.id || ''));
  if (!positionMatch) return normalizeInput(fact.source_excerpt || '');
  const position = Number(positionMatch[1]);
  if (!Number.isInteger(position) || position < 0 || position >= text.length) {
    return normalizeInput(fact.source_excerpt || '');
  }
  const preceding = text.slice(0, position);
  const following = text.slice(position);
  const start = Math.max(preceding.lastIndexOf('，'), preceding.lastIndexOf(','), preceding.lastIndexOf('、'),
    preceding.lastIndexOf('；'), preceding.lastIndexOf(';'), preceding.lastIndexOf('。'), preceding.lastIndexOf('\n')) + 1;
  const stops = ['，', ',', '、', '；', ';', '。', '\n'].map(delimiter => {
    const index = following.indexOf(delimiter);
    return index < 0 ? Infinity : position + index;
  });
  const end = Math.min(...stops);
  const localExcerpt = text.slice(start, Number.isFinite(end) ? end : text.length).trim()
    || normalizeInput(fact.source_excerpt || '');
  const countMatches = [...text.matchAll(/([0-9零〇一二两三四五六七八九十百]+)\s*(?:处|道)/gu)]
    .filter(match => match.index <= position && position - match.index <= 120);
  for (const count of countMatches.reverse()) {
    const segmentStart = Math.max(text.lastIndexOf('；', count.index), text.lastIndexOf(';', count.index),
      text.lastIndexOf('。', count.index), text.lastIndexOf('\n', count.index)) + 1;
    const segmentEnd = ['；', ';', '。', '\n'].map(delimiter => {
      const index = following.indexOf(delimiter);
      return index < 0 ? Infinity : position + index;
    }).reduce((minimum, index) => Math.min(minimum, index), Infinity);
    const group = text.slice(segmentStart, Number.isFinite(segmentEnd) ? segmentEnd : text.length).trim();
    const groupCounts = [...group.matchAll(/[0-9零〇一二两三四五六七八九十百]+\s*(?:处|道)/gu)];
    const measured = [...group.matchAll(/(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:cm|厘米)/gu)];
    const countValue = parseNumber(count[1]);
    const containsMeasurement = measured.some(match => {
      const amount = match[0].match(/^(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)/u)?.[0];
      const value = amount && /^\d/u.test(amount) ? Number(amount) : parseNumber(amount || '');
      return value === fact.value && position >= segmentStart + match.index
        && position < segmentStart + match.index + match[0].length;
    });
    if (groupCounts.length === 1 && Number.isInteger(countValue) && countValue >= 2
      && measured.length >= 1 && measured.length <= countValue && containsMeasurement
      && /(?:创口|伤口|创痕|划痕|划伤|瘢痕|疤痕|切口|裂口|裂创|裂伤)/u.test(group)
      && scalpWoundRegion(group)) return group;
  }
  const sourceExcerpt = normalizeInput(fact.source_excerpt || '');
  const sourceMeasurements = [...sourceExcerpt.matchAll(/(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:cm|厘米)/gu)];
  const includesOtherBodySite = /(?:手(?:背|掌|指|腕|部|食指|中指|无名指|小指|拇指)|腕部|前臂|上臂|肩部|背部|腰部|腹部|胸部|颈部|肘部|膝部|踝部|足背|大腿|小腿)/u.test(sourceExcerpt);
  if (!includesOtherBodySite && sourceMeasurements.length >= 2 && scalpWoundRegion(sourceExcerpt)
    && /(?:创口|伤口|创痕|划痕|划伤|瘢痕|疤痕|切口|裂口|裂创|裂伤)/u.test(sourceExcerpt)
    && /(?:分别|各|[、,，和及])/u.test(sourceExcerpt)) return sourceExcerpt;
  return localExcerpt;
}

function scalpWoundAnatomicSite(evidence) {
  const text = normalizeInput(evidence || '');
  const match = /(?:(双侧|两侧|左侧|右侧|左|右))?(颞枕部|顶枕部|后枕部|枕骨隆突部|枕项部|颞顶部|额顶部|头顶部|颞部|顶部|枕部|头皮)/u.exec(text);
  return match ? `${match[1] || ''}${match[2]}` : null;
}

function hasSeparateObservationCueBetweenMeasurements(text, sentenceStart, facts) {
  if (facts.length < 2) return false;
  const positions = facts.map(fact => Number(String(fact.id).slice(2)))
    .filter(position => Number.isInteger(position)).sort((a, b) => a - b);
  if (positions.length < 2) return false;
  const start = positions[0] - sentenceStart;
  const end = positions.at(-1) - sentenceStart;
  const betweenMeasurements = text.slice(start, end);
  return /(?:19|20)\d{2}年(?:\d{1,2}月)?(?:\d{1,2}日)?|手术后|术后|再次|复查|复诊|后续|随后|此后|之后|随访|再检查/gu.test(betweenMeasurements);
}

function isUnsegmentedFaceScalpMeasurement(fact) {
  if (fact.regionEvidence?.site) return false;
  const broadEvidence = normalizeInput(fact.source_excerpt || '');
  const localEvidence = (fact.sourceRefs || []).filter(reference => reference.source === fact.source
    && typeof reference.evidence === 'string' && normalizeInput(reference.evidence) !== broadEvidence)
    .map(reference => normalizeInput(reference.evidence));
  const evidenceVariants = localEvidence.length ? localEvidence : [broadEvidence];
  const faceSite = '(?:面部|脸部|额部|前额|额头|眉弓|眉部|眉|眼外侧|眼外眦|外眦|眼睑|上睑|下睑|内眦|颊部|颊|颧部|鼻唇沟|鼻部|鼻背|鼻梁|口唇|上唇|下唇|下颌)';
  const scalpSite = '(?:额顶部|头顶部|颞顶部|顶枕部|后枕部|颞枕部|顶部|枕部|颞部|头皮|发际内|发际线)';
  const mixedPattern = new RegExp(`${faceSite}.{0,14}${scalpSite}|${scalpSite}.{0,14}${faceSite}`, 'u');
  const separateMeasuredSites = evidenceVariants.some(evidence => {
    const measurements = [...evidence.matchAll(/(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:cm|厘米)/gu)];
    const sites = [...evidence.matchAll(new RegExp(`${faceSite}|${scalpSite}`, 'gu'))];
    const wounds = [...evidence.matchAll(/创口|伤口|裂口|裂创|裂伤|切口|瘢痕|疤痕/gu)];
    return measurements.length >= 2 && sites.length >= 2 && wounds.length >= 2
      && /(?:两处|多处|分别|各自|两道|多道)/u.test(evidence);
  });
  if (separateMeasuredSites) return false;
  return evidenceVariants.every(evidence => !/(?:头顶部|额顶部)[^。；;]{0,12}发际(?:内|线内)/u.test(evidence)
    && !/发际(?:内|线内)[^。；;]{0,12}(?:头顶部|额顶部)/u.test(evidence)
    && mixedPattern.test(evidence));
}

function hasScalpCueBefore(text, index) {
  const segmentStart = Math.max(text.lastIndexOf('；', index - 1), text.lastIndexOf(';', index - 1)) + 1;
  const prefix = text.slice(segmentStart, index);
  const scalp = [...prefix.matchAll(/头顶部|额顶部|后枕部|颞枕部|顶枕部|颞顶部|枕骨隆突部|枕项部|顶部|枕部|颞部|头皮|发际内|发际线/gu)].at(-1);
  const face = [...prefix.matchAll(/面部|脸部|额部|前额|额头|眉弓|眉部|眉|眼外侧|眼外眦|外眦|眼睑|上睑|下睑|内眦|颧部|鼻唇沟|鼻部|鼻背|鼻梁|口唇|上唇|下唇|下颌/gu)].at(-1);
  return Boolean(scalp && (!face || scalp.index > face.index));
}

export function explicitScalpScarCountTotal(inputText) {
  const text = normalizeInput(inputText);
  return [...text.matchAll(/(?=([0-9零〇一二两三四五六七八九十百]+)\s*(?:条|道)[^。；;]{0,24}(?:瘢痕|疤痕))/gu)]
    .filter(match => hasScalpCueBefore(text, match.index))
    .reduce((sum, match) => sum + (parseNumber(match[1]) || 0), 0);
}

function getEnumeratedScalpWoundGroupStatus(candidates) {
  const groups = new Map();
  for (const fact of candidates) {
    const evidence = fact.measurementExcerpt || normalizeInput(fact.source_excerpt || '');
    if (/(?:瘢痕|疤痕)/u.test(evidence) || !/(?:创口|伤口|创痕|划伤|裂口|裂创|裂伤)/u.test(evidence)) continue;
    const match = evidence.match(/([0-9零〇一二两三四五六七八九十百]+)\s*(?:处|道)[^。；;]{0,48}?(?:创口|伤口|创痕|划痕|划伤|裂口|裂创|裂伤)/u);
    if (!match || !scalpWoundRegion(evidence)) continue;
    const count = parseNumber(match[1]);
    if (!Number.isFinite(count) || count < 2) continue;
    const group = groups.get(evidence) || { count, facts: [] };
    if (group.count !== count) continue;
    group.facts.push(fact);
    groups.set(evidence, group);
  }
  return {
    found: groups.size > 0,
    complete: [...groups.values()].every(group => group.count === group.facts.length),
  };
}

function normalizeScalpWoundAggregateFacts(inputText, woundFacts) {
  const text = normalizeInput(inputText);
  const findings = [];
  for (const sentence of text.matchAll(/[^。！？\n]+/gu)) {
    if (sentence[0].length > 500 || [...sentence[0].matchAll(/(?:19|20)\d{2}年?\d{0,2}月?\d{0,2}日?/gu)].length > 1) continue;
    const hasHistoricalWound = /(?:既往|曾经|陈旧|旧伤|此前|之前|原有|既有|历史)[^。；;\n]{0,48}(?:创口|伤口|瘢痕|外伤|损伤)/u.test(sentence[0]);
    const explicitlyNoHistoricalWound = /(?:既往(?:史)?(?:未见|无|没有|否认|排除)|(?:未见|无|没有|否认|排除)(?:既往|历史|旧伤))/u.test(sentence[0]);
    if (hasHistoricalWound && !explicitlyNoHistoricalWound) continue;
    const start = sentence.index;
    const end = start + sentence[0].length;
    const explicitScalpTotals = [...new Map(woundFacts.filter(fact => {
      const position = Number(String(fact.id).slice(2));
      return Number.isInteger(position) && position >= start && position < end
        && ['reported', 'observed'].includes(fact.certainty) && Number.isFinite(fact.value) && fact.value > 0
        && /(?:头顶部|额顶部|后枕部|颞枕部|顶枕部|颞顶部|枕骨隆突部|枕项部|顶部|枕部|头皮)[^。；;]{0,18}(?:创口|伤口|瘢痕|疤痕)[^。；;]{0,18}(?:总长|总长度|累计长度)/u
          .test(fact.source_excerpt);
    }).map(fact => [`${fact.id}:${fact.value}`, fact])).values()];
    if (explicitScalpTotals.length === 1) {
      const total = explicitScalpTotals[0];
      findings.push({ id: `SW${start}`, field: 'aggregate_wound_length_cm', value: total.value,
        certainty: 'derived', source_type: 'derived', source_excerpt: total.source_excerpt,
        derived_from: [total.id] });
      continue;
    }
    const candidates = [...new Map(woundFacts.filter(fact => {
      const position = Number(String(fact.id).slice(2));
      return Number.isInteger(position) && position >= start && position < end
        && ['reported', 'observed'].includes(fact.certainty)
        && Number.isFinite(fact.value) && fact.value > 0;
    }).map(fact => [`${fact.id}:${fact.value}`, fact])).values()]
      .filter(fact => !isWholeMeasurementWithRegionSegments(fact, woundFacts)
        && !isUnsegmentedFaceScalpMeasurement(fact))
      .map(fact => {
        const sourceExcerpt = normalizeInput(fact.source_excerpt || '');
        const countMatch = sourceExcerpt.match(/([0-9零〇一二两三四五六七八九十百]+)\s*(?:处|道)/u);
        const sourceMeasurementCount = [...sourceExcerpt.matchAll(/(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:cm|厘米)/gu)].length;
        const sourceCountIsComplete = countMatch && parseNumber(countMatch[1]) === sourceMeasurementCount;
        const hasExplicitListCue = /(?:分别|各)/u.test(sourceExcerpt);
        const includesOtherBodySite = /(?:手(?:背|掌|指|腕|部|食指|中指|无名指|小指|拇指)|腕部|前臂|上臂|肩部|背部|腰部|腹部|胸部|颈部|肘部|膝部|踝部|足背|大腿|小腿)/u.test(sourceExcerpt);
        const measurementExcerpt = !includesOtherBodySite && scalpWoundRegion(sourceExcerpt) && (sourceCountIsComplete || hasExplicitListCue
          || !countMatch && sourceMeasurementCount >= 2 && /(?:、|,|，|和|及)/u.test(sourceExcerpt))
          ? sourceExcerpt : woundMeasurementExcerpt(text, fact);
        return { ...fact, measurementExcerpt,
          region: scalpWoundRegion(measurementExcerpt),
          multiplicity: explicitWoundMultiplicity(fact) };
      })
      .filter(fact => fact.region);
    if (hasSeparateObservationCueBetweenMeasurements(sentence[0], start, candidates)) continue;
    const byRegion = new Map();
    for (const fact of candidates) {
      const current = byRegion.get(fact.region) || [];
      current.push(fact);
      byRegion.set(fact.region, current);
    }
    const enumeratedWounds = sentence[0].match(/([0-9零〇一二两三四五六七八九十百]+)(?:处|道)[^。；;]{0,48}?(?:创口|伤口|创痕|划伤|裂口|裂创|裂伤)/u);
    const enumeratedCount = enumeratedWounds && hasScalpCueBefore(sentence[0], enumeratedWounds.index)
      ? parseNumber(enumeratedWounds[1]) : null;
    const hasExplicitWoundCount = Number.isFinite(enumeratedCount) && enumeratedCount > 1
      && [...byRegion.values()].some(items => items.length === enumeratedCount);
    const countedScalpGroups = getEnumeratedScalpWoundGroupStatus(candidates);
    const allCountedScalpGroupsAreComplete = !countedScalpGroups.found || countedScalpGroups.complete;
    const hasFullyMeasuredCountedGroups = countedScalpGroups.found && countedScalpGroups.complete;
    const listedScarMeasurements = sentence[0].match(/((?:\d+(?:\.\d+)?\s*(?:cm|厘米)\s*[、,，]\s*)+\d+(?:\.\d+)?\s*(?:cm|厘米))[^。；;]{0,8}(?:瘢痕|疤痕)/u);
    const listedScarMeasurementCount = listedScarMeasurements && hasScalpCueBefore(sentence[0], listedScarMeasurements.index)
      ? [...listedScarMeasurements[1].matchAll(/\d+(?:\.\d+)?\s*(?:cm|厘米)/gu)].length : 0;
    const explicitScarCountTotal = explicitScalpScarCountTotal(sentence[0]);
    const hasRepeatedWoundMeasurement = candidates.some(fact => fact.multiplicity > 1);
    const namedScalpSites = candidates.map(fact => scalpWoundAnatomicSite(fact.measurementExcerpt));
    const hasDistinctNamedScalpSites = candidates.length >= 2 && namedScalpSites.every(Boolean)
      && new Set(namedScalpSites).size === candidates.length;
    const explicitSeparateWounds = allCountedScalpGroupsAreComplete && (hasRepeatedWoundMeasurement
      || candidates.length >= 2 && (hasExplicitWoundCount
        || hasFullyMeasuredCountedGroups
        || explicitScarCountTotal > 1 && explicitScarCountTotal === candidates.length
        || listedScarMeasurementCount === candidates.length
        || hasDistinctNamedScalpSites
        || /另(?:见|有)/u.test(sentence[0])
          && [...sentence[0].matchAll(/(?=(?:头顶部|额顶部|后枕部|颞枕部|顶枕部|颞顶部|枕骨隆突部|枕项部|顶部|枕部|颞部|头皮|发际内|发际线)[^。；;]{0,24}(?:创口|伤口|创痕|划伤|裂口|裂创|裂伤|缝合创|瘢痕|疤痕))/gu)].length >= 2));
    const scalpMeasurements = woundFacts.filter(fact => ['reported', 'observed'].includes(fact.certainty)
      && Number.isFinite(fact.value) && fact.value > 0 && scalpWoundRegion(fact.source_excerpt));
    const oneDocumentedScalpWound = candidates.length === 1 && candidates[0].multiplicity === 1
      && byRegion.size === 1 && scalpMeasurements.length === 1;
    if (!oneDocumentedScalpWound
      && (byRegion.size < 2 || [...byRegion.values()].some(items => items.length !== 1)) && !explicitSeparateWounds) continue;
    const parents = explicitSeparateWounds ? [...byRegion.values()].flat() : [...byRegion.values()].map(items => items[0]);
    const value = Math.round(parents.reduce((sum, fact) => sum + fact.value * fact.multiplicity, 0) * 100) / 100;
    findings.push({ id: `SW${start}`, field: 'aggregate_wound_length_cm', value, certainty: 'derived',
      source_type: 'derived', source_excerpt: sentence[0].trim(),
      derived_from: parents.map(fact => fact.id) });
  }
  return findings;
}

function isInternalOrganTearMeasurement(clause, start = 0, end = clause.length) {
  const context = clause.slice(Math.max(0, start - 24), Math.min(clause.length, end + 20));
  return /(?:肺(?:部|组织|叶|上叶|下叶)?|肝(?:脏|组织)?|脾(?:脏|组织)?|肾(?:脏|组织)?|胃壁|肠壁|心脏|(?:右|左|双侧)?心室|(?:右|左|双侧)?心房|右室|左室|心包(?:膜)?)[^，、,。；;\n]{0,16}(?:裂口|裂伤|裂创|破裂)/u.test(context);
}

function normalizeLungLacerationFacts(inputText) {
  const text = normalizeInput(inputText);
  const findings = [];
  for (const clause of text.matchAll(/[^。；;\n]+/gu)) {
    const evidence = clause[0].trim();
    if (!/(?:诊断|确诊|诊断为|诊断记载|诊断明确|术中见|手术见)[^。；;\n]{0,80}肺裂伤/u.test(evidence)
      || /(?:无|未见|未发现|排除|否认)[^。；;\n]{0,24}肺裂伤/u.test(evidence)
      || hasNonCurrentClinicalContext(text, clause.index, clause.index + clause[0].length)) continue;
    const certainty = certaintyFor(text, clause.index, clause.index + clause[0].length);
    if (!['reported', 'observed', 'uncertain', 'unknown'].includes(certainty)) continue;
    findings.push({ id: `LL${clause.index}`, field: 'diagnosis', value: '肺裂伤', certainty,
      source_type: 'user_text', source_excerpt: evidence });
  }
  return findings;
}

function normalizeBowelBladderIncontinenceFacts(inputText) {
  const text = normalizeInput(inputText);
  const findings = [];
  const pattern = /大小便失禁|大便(?:、|和|及|与)?小便失禁|小便(?:、|和|及|与)?大便失禁/gu;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    const certainty = certaintyFor(text, start, end);
    if (!['reported', 'observed', 'uncertain', 'unknown'].includes(certainty)
      || hasNonCurrentClinicalContext(text, start, end)) continue;
    findings.push({ id: `BI${start}`, field: 'clinical_finding', value: '伴大便、小便失禁', certainty,
      source_type: 'user_text', source_excerpt: match[0] });
  }
  return findings;
}

function facialWoundLocation(evidence, value, regionEvidence = null) {
  if (regionEvidence?.site === '头皮') return null;
  if (regionEvidence?.site === '面部' && /(?:创口|伤口|创痕|裂口|裂创|裂伤|切口|瘢痕|疤痕)/u.test(regionEvidence.injuryType || '')) {
    return '面部';
  }
  const text = normalizeInput(evidence || '');
  const amount = '(\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百]+)';
  const faceSite = /眼内眦|眼外侧|眼外眦|外眦|眼上方|眼下方|下睑|上睑|眼睑|眉弓|眉部|前额|额部|额头|面颊|颊部|颊|颧部|鼻唇沟|鼻背|鼻梁|鼻部|鼻翼|口唇|唇上方|唇下方|上唇|下唇|唇部|下颌|面部|脸部/u;
  const sitePattern = /眼内眦|眼外侧|眼外眦|外眦|眼上方|眼下方|下睑|上睑|眼睑|眉弓|眉部|前额|额部|额头|面颊|颊部|颊|颧部|鼻唇沟|鼻背|鼻梁|鼻部|鼻翼|口唇|唇上方|唇下方|上唇|下唇|唇部|下颌|面部|脸部|头顶部|额顶部|颞部|枕部|头皮|头部|颈部|颈|胸部|胸|腹部|腹|背部|背|腰部|腰|肩部|肩|上肢|下肢|大腿|小腿|手部|手指|手|膝部|膝|足部|足|踝部|踝|肋骨|骨盆/gu;
  const measurePattern = new RegExp(`${amount}(?=\\s*(?:cm|厘米|[、,，和及×xX*+]))`, 'gu');
  for (const measurement of text.matchAll(measurePattern)) {
    const measuredValue = /^\d/u.test(measurement[1]) ? Number(measurement[1]) : parseNumber(measurement[1]);
    if (measuredValue !== value) continue;
    const afterValue = text.slice(measurement.index + measurement[0].length,
      measurement.index + measurement[0].length + 24);
    const followsPlusCombinedLength = new RegExp(`^\\s*\\+\\s*${amount}\\s*(?:cm|厘米)`, 'u').test(afterValue);
    if (!/^\s*(?:cm|厘米)/u.test(afterValue)
      && !/^(?:\s*[、,，和及]\s*[^。；;]{0,18})?(?:cm|厘米)/u.test(afterValue)
      && !/^\s*[×xX*]\s*\d+(?:\.\d+)?\s*(?:cm|厘米)/u.test(afterValue)
      && !followsPlusCombinedLength) continue;
    const prefix = text.slice(0, measurement.index);
    const sentenceStart = Math.max(prefix.lastIndexOf('。'), prefix.lastIndexOf('；'), prefix.lastIndexOf(';'),
      prefix.lastIndexOf('\n')) + 1;
    if (/[×xX*]\s*$/u.test(prefix.slice(Math.max(sentenceStart, measurement.index - 8)))) continue;
    sitePattern.lastIndex = 0;
    const locations = [...prefix.slice(sentenceStart).matchAll(sitePattern)];
    const location = locations.at(-1);
    const suffix = text.slice(measurement.index + measurement[0].length,
      Math.min(text.length, measurement.index + measurement[0].length + 24));
    sitePattern.lastIndex = 0;
    const forwardLocation = sitePattern.exec(suffix);
    const explicitForwardRegion = forwardLocation
      && /^(?:\s*(?:cm|厘米)?\s*(?:位于|在|属于))/u.test(suffix.slice(0, forwardLocation.index));
    const selectedLocation = explicitForwardRegion ? forwardLocation[0] : location?.[0];
    if (!selectedLocation || !faceSite.test(selectedLocation)) continue;
    const localStart = Math.max(sentenceStart, measurement.index - 70);
    const localEvidence = text.slice(localStart, measurement.index + measurement[0].length + 24);
    const woundCues = [...localEvidence.matchAll(/皮肤划痕|划痕|划伤|创口|伤口|创痕|裂口|裂创|裂伤|切口|瘢痕|疤痕/gu)];
    const nearestWoundCue = woundCues.sort((left, right) =>
      Math.abs(localStart + left.index - measurement.index) - Math.abs(localStart + right.index - measurement.index))[0];
    if (!nearestWoundCue || /^(?:皮肤)?划痕$/u.test(nearestWoundCue[0])) continue;
    const siteStart = explicitForwardRegion ? measurement.index + measurement[0].length + forwardLocation.index
      : sentenceStart + location.index;
    const preceding = text.slice(Math.max(sentenceStart, siteStart - 8), siteStart);
    const side = [...preceding.matchAll(/左侧|右侧|左|右|双侧|两侧/gu)].at(-1)?.[0] || '';
    return `${side}${selectedLocation}`;
  }
  return null;
}

function isWholeMeasurementWithRegionSegments(fact, allMeasurements) {
  if (fact.field !== 'wound_length_cm' || fact.regionEvidence?.site || !Number.isFinite(fact.value)) return false;
  const segments = allMeasurements.filter(candidate => candidate !== fact && candidate.field === 'wound_length_cm'
    && (candidate.certainty === fact.certainty || candidate.derived_from?.includes(fact.id))
    && candidate.regionEvidence?.site && Number.isFinite(candidate.value));
  const sites = new Set(segments.map(candidate => candidate.regionEvidence.site));
  const segmentTotal = Math.round(segments.reduce((sum, candidate) => sum + candidate.value, 0) * 100) / 100;
  return sites.size >= 2 && segmentTotal === fact.value;
}

function woundFactPosition(fact) {
  return Number.isInteger(fact?.source_position) ? fact.source_position : Number(String(fact?.id || '').slice(2));
}

function normalizeHairlineWoundSegmentFacts(inputText, woundFacts) {
  const text = normalizeInput(inputText);
  const findings = [];
  const amount = '(\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百]+)';
  const outsidePattern = new RegExp(`发际(?:线)?(?:外|上)(?:长度|长)?(?:约|为|达)?\\s*${amount}\\s*(?:cm|厘米)`, 'gu');
  const insidePattern = new RegExp(`发际(?:线)?(?:内|下)(?:长度|长)?(?:约|为|达)?\\s*${amount}\\s*(?:cm|厘米)`, 'gu');
  const belowHairlinePattern = new RegExp(`(?:其中|其中的|其中一段|其中部分)\\s*${amount}\\s*(?:cm|厘米)[^。；;\\n]{0,12}(?:位于|在)发际(?:线)?(?:下|内)`, 'gu');
  const aboveHairlinePattern = new RegExp(`(?:其中|其中的|其中一段|其中部分)\\s*${amount}\\s*(?:cm|厘米)[^。；;\\n]{0,12}(?:位于|在)发际(?:线)?(?:上|外)`, 'gu');
  const wholeMeasurementPattern = new RegExp(`(?:创口|伤口|创痕|裂口|裂创|裂伤|瘢痕|疤痕)[^。；;\\n]{0,12}?(?:长|长度)(?:约|为|达)?\\s*${amount}\\s*(?:cm|厘米)`, 'gu');
  for (const sentence of text.matchAll(/[^。！？\n]+/gu)) {
    if (sentence[0].length > 500 || certaintyFor(sentence[0], 0, sentence[0].length) !== 'reported'
      || /(?:既往|曾经|陈旧|旧伤|此前|之前|原有|既有|历史)[^。；;\n]{0,48}(?:创口|伤口|瘢痕|外伤|损伤)/u.test(sentence[0])) continue;
    outsidePattern.lastIndex = 0;
    insidePattern.lastIndex = 0;
    const outside = [...sentence[0].matchAll(outsidePattern)];
    const inside = [...sentence[0].matchAll(insidePattern)];
    belowHairlinePattern.lastIndex = 0;
    aboveHairlinePattern.lastIndex = 0;
    const belowHairline = [...sentence[0].matchAll(belowHairlinePattern)];
    const aboveHairline = [...sentence[0].matchAll(aboveHairlinePattern)];
    const explicitSubset = outside.length === 1 && inside.length === 0 && belowHairline.length === 0
      && aboveHairline.length === 0 ? { match: outside[0], isFace: false }
      : outside.length === 0 && inside.length === 1 && belowHairline.length === 0
        && aboveHairline.length === 0 ? { match: inside[0], isFace: true }
        : outside.length === 0 && inside.length === 0 && belowHairline.length === 1
          && aboveHairline.length === 0 ? { match: belowHairline[0], isFace: true }
          : outside.length === 0 && inside.length === 0 && belowHairline.length === 0
            && aboveHairline.length === 1 ? { match: aboveHairline[0], isFace: false } : null;
    if (explicitSubset && /(?:额部|额头|前额|面部|脸部)/u.test(sentence[0])
      && /(?:创口|伤口|划伤|裂口|裂创|裂伤|瘢痕|疤痕)/u.test(sentence[0])) {
      wholeMeasurementPattern.lastIndex = 0;
      const subset = explicitSubset.match;
      const subsetLength = /^\d/u.test(subset[1]) ? Number(subset[1]) : parseNumber(subset[1]);
      const wholeMatches = [...sentence[0].matchAll(wholeMeasurementPattern)]
        .filter(match => match.index < subset.index && subset.index - match.index <= 80)
        .sort((left, right) => right.index - left.index);
      const whole = wholeMatches[0];
      if (whole && Number.isFinite(subsetLength) && subsetLength > 0) {
        const wholeLength = /^\d/u.test(whole[1]) ? Number(whole[1]) : parseNumber(whole[1]);
        const faceLength = explicitSubset.isFace ? subsetLength : Math.round((wholeLength - subsetLength) * 100) / 100;
        const scalpLength = explicitSubset.isFace ? Math.round((wholeLength - subsetLength) * 100) / 100 : subsetLength;
        const wholeValueOffset = sentence.index + whole.index + whole[0].indexOf(whole[1]);
        const totalFact = woundFacts.find(fact => fact.field === 'wound_length_cm' && fact.certainty === 'reported'
          && fact.value === wholeLength && Number(String(fact.id).slice(2)) === wholeValueOffset);
        if (totalFact && wholeLength > subsetLength && faceLength > 0 && scalpLength > 0) {
          const sourceExcerpt = sentence[0].trim();
          const injuryType = sourceExcerpt.match(/瘢痕|疤痕|裂口|裂创|裂伤|创口|伤口|划伤/u)?.[0] || '创口';
          const subsetValueOffset = sentence.index + subset.index + subset[0].indexOf(subset[1]);
          findings.push({ id: `HLI${subsetValueOffset}`, field: 'wound_length_cm', value: faceLength,
            certainty: 'derived', source_type: 'derived', derived_from: [totalFact.id], source_excerpt: sourceExcerpt,
            source_position: subsetValueOffset,
            regionEvidence: { site: '面部', injuryType } });
          findings.push({ id: `HLO${subsetValueOffset}`, field: 'wound_length_cm', value: scalpLength,
            certainty: 'derived', source_type: 'derived', derived_from: [totalFact.id], source_excerpt: sourceExcerpt,
            source_position: subsetValueOffset,
            regionEvidence: { site: '头皮', injuryType } });
          continue;
        }
      }
    }
    if (outside.length !== 1 || inside.length !== 1
      || !/(?:额部|额头|前额|面部|脸部)/u.test(sentence[0])
      || !/(?:创口|伤口|划伤|裂口|裂创|裂伤|瘢痕|疤痕)/u.test(sentence[0])) continue;
    const valueOf = match => /^\d+(?:\.\d+)?$/u.test(match[1]) ? Number(match[1]) : parseNumber(match[1]);
    const outsideLength = valueOf(outside[0]);
    const insideLength = valueOf(inside[0]);
    if (!Number.isFinite(outsideLength) || !Number.isFinite(insideLength) || outsideLength <= 0 || insideLength <= 0) continue;
    const totalLength = Math.round((outsideLength + insideLength) * 100) / 100;
    const sentenceStart = sentence.index;
    const sentenceEnd = sentenceStart + sentence[0].length;
    const totalFacts = woundFacts.filter(fact => {
      const position = Number(String(fact.id).slice(2));
      return fact.field === 'wound_length_cm' && fact.certainty === 'reported' && fact.value === totalLength
        && Number.isInteger(position) && position >= sentenceStart && position < sentenceEnd
        && Math.min(Math.abs(position - (sentenceStart + outside[0].index)),
          Math.abs(position - (sentenceStart + inside[0].index))) <= 80;
    });
    const totalFact = totalFacts.length === 1 ? totalFacts[0] : null;
    if (!totalFact || !/(?:额部|额头|前额|面部|脸部)/u.test(totalFact.source_excerpt)
      || !/(?:创口|伤口|划伤|裂口|裂创|裂伤|瘢痕|疤痕)/u.test(totalFact.source_excerpt)) continue;
    const sourceExcerpt = sentence[0].trim();
    const injuryType = sourceExcerpt.match(/瘢痕|疤痕|裂口|裂创|裂伤|创口|伤口|划伤/u)?.[0] || '创口';
    const positionOf = match => sentenceStart + match.index + match[0].indexOf(match[1]);
    findings.push({ id: `HLI${positionOf(inside[0])}`, field: 'wound_length_cm', value: insideLength,
      certainty: 'derived', source_type: 'derived', derived_from: [totalFact.id], source_excerpt: sourceExcerpt,
      regionEvidence: { site: '面部', injuryType } });
    findings.push({ id: `HLO${positionOf(outside[0])}`, field: 'wound_length_cm', value: outsideLength,
      certainty: 'derived', source_type: 'derived', derived_from: [totalFact.id], source_excerpt: sourceExcerpt,
      regionEvidence: { site: '头皮', injuryType } });
  }
  return findings;
}

function normalizeFacialWoundAggregateFacts(inputText, woundFacts) {
  const text = normalizeInput(inputText);
  const findings = [];
  for (const sentence of text.matchAll(/[^。！？\n]+/gu)) {
    if (sentence[0].length > 500 || [...sentence[0].matchAll(/(?:19|20)\d{2}年?\d{0,2}月?\d{0,2}日?/gu)].length > 1) continue;
    const start = sentence.index;
    const end = start + sentence[0].length;
    const candidates = [...new Map(woundFacts.filter(fact => {
      const position = woundFactPosition(fact);
      return Number.isInteger(position) && position >= start && position < end
        && ['reported', 'derived'].includes(fact.certainty) && Number.isFinite(fact.value) && fact.value > 0;
    }).map(fact => [`${fact.id}:${fact.value}`, fact])).values()]
      .filter(fact => !isWholeMeasurementWithRegionSegments(fact, woundFacts)
        && !isUnsegmentedFaceScalpMeasurement(fact))
      .map(fact => {
        const broadEvidence = normalizeInput(fact.source_excerpt || '');
        const localEvidence = (fact.sourceRefs || []).filter(reference => reference.source === fact.source
          && typeof reference.evidence === 'string' && normalizeInput(reference.evidence) !== broadEvidence)
          .map(reference => reference.evidence);
        const locationEvidence = localEvidence.length ? localEvidence.join('；') : fact.source_excerpt;
        return { ...fact, location: facialWoundLocation(locationEvidence, fact.value, fact.regionEvidence),
          multiplicity: fact.certainty === 'derived' ? 1 : explicitWoundMultiplicity(fact) };
      }).filter(fact => fact.location);
    if (hasSeparateObservationCueBetweenMeasurements(sentence[0], start, candidates)) continue;
    const byLocation = new Map();
    for (const fact of candidates) {
      const current = byLocation.get(fact.location) || [];
      current.push(fact);
      byLocation.set(fact.location, current);
    }
    const selected = [];
    let explicitSameSiteMultiple = false;
    for (const factsAtLocation of byLocation.values()) {
      if (factsAtLocation.length === 1) {
        selected.push(factsAtLocation[0]);
        if (factsAtLocation[0].multiplicity > 1) explicitSameSiteMultiple = true;
        continue;
      }
      const sharedEvidence = new Set(factsAtLocation.map(fact => fact.source_excerpt));
      if (sharedEvidence.size === 1 && /(?:[零〇一二两三四五六七八九十百0-9]+处|[零〇一二两三四五六七八九十百0-9]+道|多处|多道)/u.test(factsAtLocation[0].source_excerpt)) {
        selected.push(...factsAtLocation);
        explicitSameSiteMultiple = true;
        continue;
      }
      const explicitSiteCount = factsAtLocation.map(fact => {
        const match = fact.source_excerpt.match(/([零〇一二两三四五六七八九十百0-9]+)\s*(?:处|道)/u);
        return match && /(?:分别|各)/u.test(fact.source_excerpt) ? parseNumber(match[1]) : null;
      });
      if (explicitSiteCount.every(count => count === factsAtLocation.length)) {
        selected.push(...factsAtLocation);
        explicitSameSiteMultiple = true;
        continue;
      }
      const positions = factsAtLocation.map(woundFactPosition).filter(Number.isInteger);
      if (positions.length === factsAtLocation.length) {
        const span = sentence[0].slice(Math.min(...positions) - start, Math.max(...positions) - start);
        const joinedWoundDescriptions = factsAtLocation.some(fact => /(?:及|和|以及)/u.test(fact.source_excerpt)
          && [...fact.source_excerpt.matchAll(/创口|伤口|创痕|划痕|划伤|瘢痕|疤痕|切口|裂口|裂创|裂伤/gu)].length >= 2);
        if (/(?:另见|另有|另处|另外|此外)/u.test(span)
          || /(?:及|和|以及)/u.test(span) && joinedWoundDescriptions) selected.push(...factsAtLocation);
      }
    }
    const selectedWoundCount = selected.reduce((sum, fact) => sum + fact.multiplicity, 0);
    if (selectedWoundCount < 2 || byLocation.size < 2 && !explicitSameSiteMultiple) continue;
    const value = Math.round(selected.reduce((sum, fact) => sum + fact.value * fact.multiplicity, 0) * 100) / 100;
    findings.push({ id: `FW${start}`, field: 'aggregate_wound_length_cm', value, certainty: 'derived',
      source_type: 'derived', source_excerpt: [...new Set(selected.map(fact => fact.source_excerpt))].join('；'),
      derived_from: selected.map(fact => fact.id), aggregateRegion: 'face' });
  }
  return findings;
}

function auricleSiteAt(text, position) {
  const prefix = text.slice(Math.max(0, position - 28), position);
  const matches = [...prefix.matchAll(/(?:(双侧|两侧|左侧|右侧|左|右))?(耳廓内|耳廓外|耳屏|耳垂|耳背|耳前|耳后|耳廓)/gu)];
  const match = matches.at(-1);
  if (!match) return null;
  const between = prefix.slice(match.index + match[0].length);
  if (between.length > 16 || /(?:头皮|额部|颞部|面部|之后|复查|再次)/u.test(between)) return null;
  const side = /^(?:双侧|两侧)/u.test(match[1] || '') ? 'bilateral'
    : /^(?:左侧|左)/u.test(match[1] || '') ? 'left'
      : /^(?:右侧|右)/u.test(match[1] || '') ? 'right' : 'unknown';
  return { side, site: match[2] };
}

function normalizeAuricleWoundAggregateFacts(inputText, woundFacts) {
  const text = normalizeInput(inputText);
  const findings = [];
  for (const sentence of text.matchAll(/[^。！？\n]+/gu)) {
    if (sentence[0].length > 500) continue;
    const start = sentence.index;
    const end = start + sentence[0].length;
    const candidates = [...new Map(woundFacts.filter(fact => {
      const position = Number(String(fact.id).slice(2));
      return Number.isInteger(position) && position >= start && position < end
        && fact.certainty === 'reported' && Number.isFinite(fact.value) && fact.value > 0;
    }).map(fact => [`${fact.id}:${fact.value}`, fact])).values()]
      .map(fact => {
        const position = Number(String(fact.id).slice(2));
        return { ...fact, position, site: auricleSiteAt(text, position) };
      })
      .filter(fact => !isWholeMeasurementWithRegionSegments(fact, woundFacts))
      .filter(fact => fact.site && /(?:创口|伤口|裂口|裂创|裂伤|瘢痕|疤痕)/u.test(fact.source_excerpt || ''));
    if (!candidates.length || new Set(candidates.map(fact => fact.site.side)).size !== 1) continue;
    const sites = new Set(candidates.map(fact => fact.site.site));
    const sameSiteListed = [...new Set(candidates.map(fact => fact.site.site))].some(site => {
      const group = candidates.filter(fact => fact.site.site === site);
      if (group.length < 2) return false;
      const offsets = group.map(fact => fact.position).sort((a, b) => a - b);
      const between = text.slice(offsets[0], offsets.at(-1) + 1);
      return /(?:、|,|，|和|及)/u.test(between)
        && group.every(fact => fact.source_excerpt === group[0].source_excerpt);
    });
    if (candidates.length > 1 && sites.size < 2 && !sameSiteListed) continue;
    const value = Math.round(candidates.reduce((sum, fact) => sum + fact.value, 0) * 100) / 100;
    findings.push({ id: `AWL${start}`, field: 'aggregate_wound_length_cm', value, certainty: 'derived',
      source_type: 'derived', source_excerpt: sentence[0].trim(), aggregateRegion: 'auricle',
      derived_from: candidates.map(fact => fact.id) });
  }
  return findings;
}

function normalizeAggregateWoundLengthFacts(inputText) {
  const text = normalizeInput(inputText);
  const findings = [];
  const amount = '(\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百]+)';
  const woundCount = '(?:多处|多个|多条|[零〇一二两三四五六七八九十百0-9]+\\s*(?:处|道|条))';
  const bodySurfaceSite = '(?<site>(?:左侧|右侧|左|右|双侧|两侧)?(?:面部|脸部|额部|前额|额头|眉弓|眉部|面颊|颧部|鼻部|鼻背|鼻梁|鼻翼|鼻唇沟|口唇|上唇|下唇|下颌|头部|头皮|额顶部|头顶部|颞顶部|顶枕部|后枕部|颞枕部|枕部|颞部|耳廓|耳部|颈前部|颈前|颈部|颈|外阴|阴茎|阴囊|肢体|上肢|下肢|上臂|前臂|肘部|腕部|肩部|手部|手掌|手背|手指|掌部|髋部|大腿|股部|膝部|小腿|踝部|足部|足背|趾部|胸部|腹部|背部|腰部))';
  const pattern = new RegExp(`(?:全身)?(?:${bodySurfaceSite}[^。；;\\n]{0,24})?(?<count>${woundCount})[^。；;\\n]{0,24}(?:皮肤)?(?:创口|裂伤|伤口|瘢痕|疤痕)[^。；;\\n]{0,24}(?:总长(?:度)?|累计长(?:度)?|长度合计|长度累计)(?:约为|为|约|达)?\\s*(?<amount>${amount})\\s*(?:cm|厘米)`, 'gu');
  for (const clauseMatch of text.matchAll(/[^。；;\\n]+/gu)) {
    const clause = clauseMatch[0];
    pattern.lastIndex = 0;
    for (const match of clause.matchAll(pattern)) {
      const token = match.groups.amount;
      const value = /^\d+(?:\.\d+)?$/.test(token) ? Number(token) : parseNumber(token);
      if (!Number.isFinite(value) || value < 0
        || certaintyFor(clause, match.index, match.index + match[0].length) !== 'reported') continue;
      const limbSites = [...match[0].matchAll(/(?:左侧|右侧|左|右|双侧|两侧)?(?:肢体|上肢|下肢|上臂|前臂|肘部|腕部|肩部|手部|手掌|手背|手指|掌部|髋部|大腿|股部|膝部|小腿|踝部|足部|足背|趾部)/gu)]
        .map(site => site[0]);
      findings.push({ id: `AW${clauseMatch.index + match.index}`, field: 'aggregate_wound_length_cm', value,
        certainty: 'reported', source_type: 'user_text', source_excerpt: match[0].trim(),
        ...(limbSites.length ? { regionEvidence: { site: limbSites[0], sites: limbSites } } : {}),
        ...(match.groups.site && /(?:面部|脸部)/u.test(match.groups.site) ? { aggregateRegion: 'face' } : {}) });
    }
  }
  return findings;
}

function normalizeBilateralIncisorLossFacts(inputText) {
  const text = normalizeInput(inputText);
  const findings = [];
  const pattern = /1\s*[╋＋+┼]\s*1(?:上颌)?(?:(?:前|中切)牙)?(?:牙齿)?(?:新鲜)?(?:缺失|脱落)/gu;
  for (const clauseMatch of text.matchAll(/[^。；;\n]+/gu)) {
    const clause = clauseMatch[0];
    pattern.lastIndex = 0;
    for (const match of clause.matchAll(pattern)) {
      if (certaintyFor(clause, Math.max(0, match.index - 12), match.index + match[0].length) !== 'reported') continue;
      findings.push({ id: `DL${clauseMatch.index + match.index}`, field: 'dental_loss_count', value: 2,
        certainty: 'reported', source_type: 'user_text', source_excerpt: match[0].trim() });
    }
  }
  return findings;
}

function normalizeLipWoundLengthFacts(inputText) {
  const text = normalizeInput(inputText);
  return normalizeWoundLengthFacts(text)
    .filter(fact => fact.certainty === 'reported' && /(?:上唇|下唇|口唇|唇部|上下唇)/u.test(woundMeasurementSiteAt(text,
      Number(String(fact.id).slice(2))) || '') && /(?:唇|口唇)/u.test(fact.source_excerpt)
        && /(?:创口|伤口|划伤|裂口|裂创|裂伤|瘢痕|疤痕)/u.test(fact.source_excerpt)
      && !/(?:黏膜|粘膜)/u.test(fact.source_excerpt))
    .map(fact => ({ id: `LW${fact.id}`, field: 'lip_wound_length_cm', value: fact.value,
      certainty: 'derived', source_type: 'derived', derived_from: [fact.id], source_excerpt: fact.source_excerpt }));
}

function normalizeLipThroughWoundFacts(inputText) {
  const text = normalizeInput(inputText);
  const findings = [];
  const lipLengths = normalizeLipWoundLengthFacts(text);
  const diagnosisPattern = /(?:下唇|上唇|口唇)(?:部)?\s*(?:贯通伤|全层裂创)/gu;
  const diagnoses = [...text.matchAll(diagnosisPattern)];
  for (const diagnosis of diagnoses) {
    const site = /下唇/.test(diagnosis[0]) ? '下唇' : /上唇/.test(diagnosis[0]) ? '上唇' : '口唇';
    const clause = sourceClause(text, diagnosis[0]) || diagnosis[0];
    if (certaintyFor(clause, 0, clause.length) !== 'reported' || /既往|此前|曾经|陈旧|旧伤|另一次|再次/u.test(clause)) continue;
    const diagnosisCountForSite = diagnoses.filter(candidate => (site === '口唇'
      ? /(?:下唇|上唇|口唇)/.test(candidate[0]) : candidate[0].includes(site))).length;
    if (diagnosisCountForSite !== 1) continue;
    const diagnosisId = `LTD${diagnosis.index}`;
    const nearbyLipLengths = lipLengths.filter(fact => {
      const offset = Number(fact.id.match(/^LWWL(\d+)$/)?.[1]);
      return Number.isFinite(offset) && Math.abs(offset - diagnosis.index) <= 600
        && (site === '口唇' ? /(?:下唇|上唇|口唇)/u.test(fact.source_excerpt)
          : fact.source_excerpt.includes(site));
    });
    if (!nearbyLipLengths.length) continue;
    findings.push({ id: diagnosisId, field: 'clinical_finding', value: diagnosis[0], certainty: 'reported',
      source_type: 'user_text', source_excerpt: diagnosis[0] });
    for (const lipLength of nearbyLipLengths) {
      const woundLengthId = lipLength.derived_from?.[0];
      if (!woundLengthId) continue;
      findings.push({ id: `LPT${diagnosis.index}_${lipLength.id}`, field: 'lip_through_wound_length_cm',
        value: lipLength.value, certainty: 'derived', source_type: 'derived',
        derived_from: [diagnosisId, woundLengthId], source_excerpt: '' });
    }
  }
  return findings;
}

function normalizeCrossRegionWoundRatioFacts(inputText, suppliedLengthFacts = null) {
  const text = normalizeInput(inputText);
  const findings = [];
  const amount = '(\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百]+)';
  const pattern = new RegExp(`(?:见|有)\\s*${amount}\\s*(?:cm|厘米)(?:长)?[^。；;\\n]{0,16}创口\\s*[，,]?\\s*其中[^。；;\\n]{0,24}面部创口长\\s*${amount}\\s*(?:cm|厘米)\\s*[，,]\\s*[^。；;\\n]{0,24}(?:头皮|头部)创口长\\s*${amount}\\s*(?:cm|厘米)`, 'gu');
  const lengthFacts = suppliedLengthFacts || normalizeWoundLengthFacts(text);
  for (const clauseMatch of text.matchAll(/[^。；;\\n]+/gu)) {
    const clause = clauseMatch[0];
    const clauseOffset = clauseMatch.index;
    pattern.lastIndex = 0;
    for (const match of clause.matchAll(pattern)) {
      const measuredNumber = value => /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : parseNumber(value);
      const totalLength = measuredNumber(match[1]);
      const faceLength = measuredNumber(match[2]);
      const headLength = measuredNumber(match[3]);
      if (![totalLength, faceLength, headLength].every(Number.isFinite)
        || Math.abs(totalLength - faceLength - headLength) > 0.1
        || certaintyFor(clause, match.index, match.index + match[0].length) !== 'reported') continue;
      const evidence = match[0].trim();
      const normalizedEvidence = normalizeInput(evidence);
      const faceFacts = lengthFacts.filter(fact => fact.value === faceLength && /面部/.test(fact.source_excerpt)
        && normalizedEvidence.includes(normalizeInput(fact.source_excerpt)));
      const headFacts = lengthFacts.filter(fact => fact.value === headLength && /(?:头皮|头部)/.test(fact.source_excerpt)
        && normalizedEvidence.includes(normalizeInput(fact.source_excerpt)));
      if (faceFacts.length !== 1 || headFacts.length !== 1) continue;
      findings.push({ id: `CR${clauseOffset + match.index}`, field: 'cross_region_wound_ratio',
        value: faceLength / 4.5 + headLength / 8, certainty: 'derived', source_type: 'derived',
        derived_from: [faceFacts[0].id, headFacts[0].id], source_excerpt: evidence });
    }
  }
  const hairlineSegments = lengthFacts.filter(fact => fact.regionEvidence?.site === '面部'
    && fact.derived_from?.length === 1);
  for (const face of hairlineSegments) {
    const parentId = face.derived_from[0];
    const scalp = lengthFacts.find(fact => fact.regionEvidence?.site === '头皮'
      && fact.derived_from?.length === 1 && fact.derived_from[0] === parentId);
    if (!scalp || face.source_excerpt !== scalp.source_excerpt || !Number.isFinite(face.value)
      || !Number.isFinite(scalp.value)) continue;
    const parent = lengthFacts.find(fact => fact.id === parentId && fact.field === 'wound_length_cm');
    if (!parent || Math.abs(parent.value - face.value - scalp.value) > 0.1) continue;
    findings.push({ id: `CRH${parentId}`, field: 'cross_region_wound_ratio',
      value: face.value / 4.5 + scalp.value / 8, certainty: 'derived', source_type: 'derived',
      derived_from: [face.id, scalp.id], source_excerpt: face.source_excerpt });
  }
  return findings;
}

function normalizeEarScalpWoundRatioFacts(inputText) {
  const text = normalizeInput(inputText);
  const findings = [];
  const amount = '(\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百]+)';
  const patterns = [
    new RegExp(`(?:一条)?[^。；;\\n]{0,12}(?:跨|横跨)耳廓(?:及|和|与)头皮[^。；;\\n]{0,12}(?:缝合)?(?:创口|伤口|裂口|裂创|裂伤)(?:总长|长)(?:约|为)?${amount}\\s*(?:cm|厘米)[^。；;\\n]{0,16}其中[^。；;\\n]{0,12}耳廓(?:创口|裂伤)?长(?:约|为)?${amount}\\s*(?:cm|厘米)[^。；;\\n]{0,12}[，,、]\\s*头皮(?:创口|裂伤)?长(?:约|为)?${amount}\\s*(?:cm|厘米)`, 'gu'),
    new RegExp(`[^。；;\\n]{0,32}耳廓[^。；;\\n]{0,24}(?<![\\d.])${amount}\\s*(?:cm|厘米)[^。；;\\n]{0,8}(?:缝合)?(?:创口|伤口|裂口|裂伤)[^。；;\\n]{0,24}其中\\s*(?<![\\d.])${amount}\\s*(?:cm|厘米)\\s*(?:位于|在|属于)\\s*耳廓[^。；;\\n]{0,8}[，,、]\\s*(?<![\\d.])${amount}\\s*(?:cm|厘米)\\s*(?:位于|在|属于)\\s*头皮`, 'gu'),
  ];
  const measuredLengths = normalizeWoundLengthFacts(text);
  const measuredNumber = value => /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : parseNumber(value);
  for (const clauseMatch of text.matchAll(/[^。；;\\n]+/gu)) {
    const clause = clauseMatch[0];
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of clause.matchAll(pattern)) {
        const totalLength = measuredNumber(match[1]);
        const auricleLength = measuredNumber(match[2]);
        const scalpLength = measuredNumber(match[3]);
        if (![totalLength, auricleLength, scalpLength].every(Number.isFinite)
          || Math.abs(totalLength - auricleLength - scalpLength) > 0.1
          || certaintyFor(clause, match.index, match.index + match[0].length) !== 'reported') continue;
        const evidence = match[0].trim();
        const parents = measuredLengths.filter(fact => fact.certainty === 'reported' && fact.value > 0
          && evidence.includes(fact.source_excerpt));
        const auricle = parents.find(fact => fact.value === auricleLength
          && (fact.regionEvidence?.site === '耳廓' || /耳廓(?:创口|裂伤)?长/u.test(fact.source_excerpt)));
        const scalp = parents.find(fact => fact.value === scalpLength
          && (fact.regionEvidence?.site === '头皮' || /头皮(?:创口|裂伤)?长/u.test(fact.source_excerpt)));
        const whole = parents.find(fact => fact.value === totalLength && !fact.regionEvidence?.site);
        const explicitTotal = Number(evidence.match(/(?:创口)?总长\s*(\d+(?:\.\d+)?)\s*(?:cm|厘米)/u)?.[1]);
        if (!auricle || !scalp || auricle.id === scalp.id
          || whole && [auricle.id, scalp.id].includes(whole.id)
          || !whole && (!Number.isFinite(explicitTotal) || Math.abs(explicitTotal - totalLength) > 0.1)) continue;
        findings.push({ id: `ES${clauseMatch.index + match.index}`, field: 'ear_scalp_wound_ratio',
          value: auricleLength / 6 + scalpLength / 8, certainty: 'derived', source_type: 'derived',
          derived_from: [auricle.id, scalp.id, ...(whole ? [whole.id] : [])], source_excerpt: evidence });
      }
    }
  }
  return findings;
}

function normalizeAuricleDefectRatioFacts(inputText) {
  const text = normalizeInput(inputText);
  const findings = [];
  const amount = '(\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百]+)';
  const pattern = new RegExp(`(左|右)耳廓缺损面积\\s*${amount}\\s*(?:cm2|平方厘米)[，,;；]\\s*(?:(对侧)|(左|右))耳面积\\s*${amount}\\s*(?:cm2|平方厘米)`, 'gu');
  const measuredNumber = value => /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : parseNumber(value);
  for (const clauseMatch of text.matchAll(/[^。；;\n]+/gu)) {
    const clause = clauseMatch[0];
    pattern.lastIndex = 0;
    for (const match of clause.matchAll(pattern)) {
      const defectSide = match[1];
      const referenceSide = match[4];
      const defectArea = measuredNumber(match[2]);
      const referenceArea = measuredNumber(match[5]);
      const oppositeSide = defectSide === '左' ? '右' : '左';
      if (referenceSide && referenceSide !== oppositeSide || !Number.isFinite(defectArea)
        || !Number.isFinite(referenceArea) || defectArea < 0 || referenceArea <= 0
        || certaintyFor(clause, match.index, match.index + match[0].length) !== 'reported') continue;
      findings.push({ id: `ADR${clauseMatch.index + match.index}`, field: 'auricle_defect_ratio',
        value: defectArea / referenceArea, certainty: 'derived', source_type: 'derived', source_excerpt: match[0] });
    }
  }
  return findings;
}

function normalizeFacialSkinAbnormalityAreaFacts(inputText) {
  const text = normalizeInput(inputText);
  const findings = [];
  const amount = '(\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百]+)';
  const areaPattern = new RegExp(`(?:面积|累计面积)[^。；;\\n]{0,12}?(${amount})\\s*(?:cm2|平方厘米)`, 'gu');
  const percentPattern = new RegExp(`(?:累计)?(?:达|达到|占)(?:面部|脸部)面积(?:的)?\\s*(?:${amount}\\s*(?:%|％)|百分之${amount})`, 'gu');
  for (const clauseMatch of text.matchAll(/[^。；;]+/gu)) {
    const clause = clauseMatch[0];
    const faceIndex = clause.search(/面部|脸部|面颊|颊部|颊/u);
    const findingMatches = [...clause.matchAll(/色素显著异常|色素异常|色素沉着|片状细小瘢痕|细小瘢痕/gu)];
    const finding = findingMatches[0];
    if (faceIndex < 0 || !finding || Math.abs(finding.index - faceIndex) > 80) continue;
    const dateAnchors = [...clause.matchAll(/(?:19|20)\d{2}年\d{1,2}月\d{1,2}日/gu)]
      .filter(match => match.index < faceIndex);
    const evidenceStart = dateAnchors.at(-1)?.index ?? Math.max(0, faceIndex - 8);
    areaPattern.lastIndex = 0;
    const area = areaPattern.exec(clause);
    if (area && area.index >= finding.index && area.index - finding.index <= 100) {
      const bridge = clause.slice(finding.index + finding[0].length, area.index);
      const token = area[1];
      const value = /^\d+(?:\.\d+)?$/.test(token) ? Number(token) : parseNumber(token);
      if (Number.isFinite(value)
        && !/(?:胸部|背部|肩部|上臂|前臂|腕部|手部|大腿|小腿|臀部|髂部|枕部)/u.test(bridge)) {
        const evidenceEnd = area.index + area[0].length;
        const evidence = clause.slice(evidenceStart, evidenceEnd).trim();
        const certainty = certaintyFor(clause, evidenceStart, evidenceEnd);
        findings.push({ field: 'facial_skin_abnormality_area_cm2', value, certainty, source_type: 'user_text',
          source_excerpt: evidence, parserKey: `${clauseMatch.index + area.index}:${area[0]}` });
      }
    }
    percentPattern.lastIndex = 0;
    const percentMatches = [...clause.matchAll(percentPattern)];
    if (percentMatches.length !== 1 || findingMatches.length !== 1) continue;
    for (const percent of percentMatches) {
      const token = percent[1] || percent[2];
      const value = /^\d/u.test(token) ? Number(token) : parseNumber(token);
      const bridge = clause.slice(finding.index + finding[0].length, percent.index);
      if (!Number.isFinite(value) || value < 0 || value > 100
        || percent.index < finding.index || percent.index - finding.index > 100
        || /(?:胸部|背部|肩部|上臂|前臂|腕部|手部|大腿|小腿|臀部|髂部|枕部)/u.test(bridge)) continue;
      const evidenceEnd = percent.index + percent[0].length;
      const evidence = clause.slice(evidenceStart, evidenceEnd).trim();
      const certainty = certaintyFor(clause, evidenceStart, evidenceEnd);
      findings.push({ field: 'facial_skin_abnormality_area_percent', value, certainty, source_type: 'user_text',
        source_excerpt: evidence, parserKey: `${clauseMatch.index + percent.index}:${percent[0]}` });
    }
  }
  return [...new Map(findings.map(fact => [fact.parserKey, fact])).values()]
    .filter(fact => !isInternalOrganTearMeasurement(fact.source_excerpt));
}

function normalizeSurfaceScarAreaFacts(inputText) {
  const text = normalizeInput(inputText);
  const findings = [];
  const amount = '(\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百]+)';
  const sitePattern = /颈前三角区|颈前部|颈前|颈部|面部|脸部|面颊|颊部|颧部|鼻部|耳廓/gu;
  const scarPattern = /增生瘢痕|瘢痕|疤痕/gu;
  const areaPattern = new RegExp(`(单块面积|单个面积|面积累计|累计面积|总面积|面积合计|面积)(?:约|为|达)?\\s*(${amount})\\s*(?:cm2|平方厘米)`, 'gu');
  for (const clauseMatch of text.matchAll(/[^。；;]+/gu)) {
    const clause = clauseMatch[0];
    const sites = [...clause.matchAll(sitePattern)];
    const siteNames = [...new Set(sites.map(site => site[0]))];
    const scars = [...clause.matchAll(scarPattern)];
    areaPattern.lastIndex = 0;
    const areas = [...clause.matchAll(areaPattern)];
    if (siteNames.length !== 1 || !scars.length || areas.length !== 1
      || Math.min(...scars.map(scar => Math.abs(scar.index - sites[0].index))) > 80) continue;
    const [area] = areas;
    const beforeArea = clause.slice(Math.max(0, area.index - 20), area.index);
    if (/(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:-|–|—|至|到)\s*$/u.test(beforeArea)) continue;
    const areaMarker = area[1];
    const aggregate = /累计|总面积|合计/u.test(areaMarker);
    const multiple = /(?:多块|多处|多个|[两二三四五六七八九十百0-9]+\s*块)/u.test(clause.slice(sites[0].index, area.index));
    if (multiple && !aggregate) continue;
    const token = area[2];
    const value = /^\d+(?:\.\d+)?$/u.test(token) ? Number(token) : parseNumber(token);
    if (!Number.isFinite(value) || value < 0) continue;
    const evidenceStart = sites[0].index;
    const evidenceEnd = area.index + area[0].length;
    const certainty = certaintyFor(clause, evidenceStart, evidenceEnd);
    findings.push({ id: `SSA${clauseMatch.index + area.index}`, field: aggregate
      ? 'aggregate_surface_scar_area_cm2' : 'surface_scar_area_cm2', value, certainty,
    source_type: 'user_text', source_excerpt: clause.slice(evidenceStart, evidenceEnd).trim(),
    regionEvidence: { site: siteNames[0] }, parserKey: `${clauseMatch.index + area.index}:${value}` });
  }
  return [...new Map(findings.map(fact => [fact.parserKey, fact])).values()];
}

function evidenceHasMeasurement(evidence, value, pattern) {
  if (!Number.isFinite(value)) return false;
  for (const match of evidence.matchAll(pattern)) {
    const sourceValue = /^\d+(?:\.\d+)?$/.test(match[1]) ? Number(match[1]) : parseNumber(match[1]);
    if (Number.isFinite(sourceValue) && sourceValue === value) return true;
  }
  return false;
}

function evidenceHasPercentageMeasurement(evidence, value) {
  const pattern = /(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:%|％)|百分之(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)/gu;
  for (const match of evidence.matchAll(pattern)) {
    const token = match[1] || match[2];
    const sourceValue = /^\d+(?:\.\d+)?$/u.test(token) ? Number(token) : parseNumber(token);
    if (Number.isFinite(sourceValue) && sourceValue === value) return true;
  }
  return false;
}

function assessmentScopeExclusions(text) {
  const exclusions = [];
  const segments = /[^。；;\n]+(?:[。；;\n]|$)/gu;
  const matches = [...text.matchAll(segments)];
  const domains = [
    { scope: /头部|头颅|颅脑|颅内|头皮|颅骨|额骨|顶骨|枕骨|颞骨|硬脑膜|脑脊液|脑膜|脑损伤|开颅/u,
      finding: /头部|头颅|颅脑|颅内|头皮|颅骨|额骨|顶骨|枕骨|颞骨|硬脑膜|脑脊液|脑膜|脑损伤|开颅/u },
    { scope: /面部|颜面|脸部|面颊|颊部|颧部|鼻部|鼻骨|颌面|下颌|口唇|唇部|眉部|眼睑/u,
      finding: /面部|颜面|脸部|面颊|颊部|颧部|鼻部|鼻骨|鼻梁|鼻翼|颌面|下颌|上颌|口唇|唇部|眉部|眼睑|颧骨/u },
    { scope: /眼球|眼眶|眼部|眼睛|视神经|视力|眼/u,
      finding: /眼球|眼眶|眼部|眼睛|视神经|视力|眼/u },
    { scope: /颈部|颈椎|咽喉|喉部|喉|甲状软骨|环状软骨|会厌|舌骨|甲状腺|颈动脉|颈部血管/u,
      finding: /颈部|颈椎|咽喉|喉部|喉|甲状软骨|环状软骨|会厌|舌骨|甲状腺|颈动脉|颈部血管/u },
    { scope: /胸部|胸壁|胸腔|肋骨|肋软骨|肺|胸骨|气胸|血胸/u,
      finding: /胸部|胸壁|胸腔|肋骨|肋软骨|肺|胸骨|气胸|血胸|支气管|胸膜/u },
    { scope: /腹部|腹腔|腹膜|肝脏|肝|脾脏|脾|胰腺|胰|肾脏|肾|胃肠|肠道/u,
      finding: /腹部|腹腔|腹膜|肝脏|肝|脾脏|脾|胰腺|胰|肾脏|肾|胃肠|肠道|胃|十二指肠|胆囊|胆道/u },
    { scope: /脊柱|脊髓|椎体|椎骨|颈椎|胸椎|腰椎|骶椎|尾椎|背部|腰部/u,
      finding: /脊柱|脊髓|椎体|椎骨|颈椎|胸椎|腰椎|骶椎|尾椎|背部|腰部/u },
    { scope: /心脏|心包|冠状动脉|心肌/u, finding: /心脏|心包|冠状动脉|心肌/u },
    { scope: /上肢|上臂|前臂|肱骨|尺骨|桡骨|腕部|腕骨|手部|左手|右手|手掌|手背|手指|掌骨|指骨|肩部|肩胛|锁骨/u,
      finding: /上肢|上臂|前臂|肱骨|尺骨|桡骨|腕部|腕骨|手部|左手|右手|手掌|手背|手指|手|掌骨|指骨|肩部|肩胛|锁骨|肩/u },
    { scope: /下肢|左腿|右腿|腿部|大腿|股骨|髋部|髋骨|膝部|膝骨|小腿|胫骨|腓骨|踝部|踝骨|足部|左足|右足|左脚|右脚|足背|足骨|趾部|趾骨|跗骨|跖骨|骨盆|髂骨|耻骨|坐骨/u,
      finding: /下肢|大腿|股骨|髋部|髋骨|膝部|膝骨|小腿|胫骨|腓骨|踝部|踝骨|足部|足背|足|趾部|趾骨|跗骨|跖骨|骨盆|髂骨|耻骨|坐骨/u },
    { scope: /泌尿|膀胱|尿道|输尿管|生殖器|睾丸|附睾|阴茎|阴囊|子宫|卵巢|输卵管|前列腺/u,
      finding: /泌尿|膀胱|尿道|输尿管|生殖器|睾丸|附睾|阴茎|阴囊|子宫|卵巢|输卵管|前列腺/u },
  ];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const segment = match[0];
    const marker = /不属于|不在|不纳入|未纳入|不列入|排除在|不作为|不用于/u.exec(segment);
    if (!marker) continue;
    const suffix = segment.slice(marker.index);
    const scopeMatch = /(?:本次|此次|该次|本项)(.{0,28})(?:评估|鉴定|分析).{0,8}范围/u.exec(suffix);
    if (!scopeMatch) continue;
    const subject = segment.slice(0, marker.index);
    const excludedDomains = domains.filter(domain => domain.scope.test(subject));
    const scopeDomains = domains.filter(domain => domain.scope.test(scopeMatch[1]));
    const inclusionPattern = /(?:但|但是|不过|而|同时|并且|且)\s*[，,]?\s*(?:[^。；;，,]{0,48}?(?:属于|纳入|列入|作为)[^。；;，,]{0,24}(?:本次|此次|该次|本项).{0,12}(?:评估|鉴定|分析)(?:范围|内容)?|(?:本次|此次|该次|本项).{0,12}(?:评估|鉴定|分析)(?:范围|内容)?(?:包括|包含)[^。；;，,]{1,40})/u;
    let inclusionLocation = match.index + marker.index;
    let includedTail = suffix.match(inclusionPattern);
    if (!includedTail) {
      const next = matches[index + 1];
      const nextSegment = next?.[0] || '';
      const leadingConnector = /^\s*(?:但|但是|不过|而|同时|并且|且)/u.exec(nextSegment);
      const nextInclusion = leadingConnector && nextSegment.slice(leadingConnector.index).match(inclusionPattern);
      if (nextInclusion) {
        includedTail = nextInclusion;
        inclusionLocation = next.index + nextInclusion.index;
      }
    }
    const sentenceEnd = match.index + segment.length;
    const includedStart = includedTail ? inclusionLocation + includedTail.index : null;
    const includedEnd = includedTail ? includedStart + includedTail[0].length : null;
    exclusions.push({ start: match.index, subjectEnd: match.index + marker.index, end: match.index + segment.length,
      domains: excludedDomains,
      scopeDomains,
      excludedEnd: includedStart ?? sentenceEnd,
      includedStart,
      includedEnd,
      sentenceEnd,
      historicalOnly: /既往|早期|此前|曾经|历史|旧伤|陈旧|过去/u.test(subject) });
  }
  return exclusions;
}

function factIsOutsideAssessmentScope(text, evidence, value) {
  if (typeof evidence !== 'string' || typeof value !== 'string') return false;
  const evidenceStart = text.indexOf(evidence);
  if (evidenceStart < 0) return false;
  const valueOffset = evidence.indexOf(value);
  const valueStart = evidenceStart + (valueOffset >= 0 ? valueOffset : 0);
  const localStart = valueOffset >= 0
    ? Math.max(-1, ...['。', '；', ';', '，', ',', '、', '\n']
      .map(delimiter => evidence.lastIndexOf(delimiter, valueOffset - 1))) + 1 : 0;
  const localEnds = valueOffset >= 0 ? ['。', '；', ';', '，', ',', '、', '\n']
    .map(delimiter => evidence.indexOf(delimiter, valueOffset + value.length)).filter(index => index >= 0) : [];
  const valueContext = valueOffset >= 0
    ? evidence.slice(localStart, localEnds.length ? Math.min(...localEnds) : evidence.length) : evidence;
  return assessmentScopeExclusions(text).some(exclusion => {
    if (exclusion.includedStart != null && valueStart >= exclusion.includedStart && valueStart < exclusion.includedEnd) return false;
    if (valueStart >= exclusion.start && valueStart < exclusion.excludedEnd) return true;
    const factFollowsExclusion = valueStart >= (exclusion.includedEnd ?? exclusion.end)
      || valueOffset < 0 && evidenceStart < exclusion.end && evidenceStart + evidence.length > exclusion.end;
    if (exclusion.historicalOnly && currentEventAnchorBefore(text, valueStart)
      && (!exclusion.scopeDomains.length || exclusion.scopeDomains.some(domain =>
        domain.finding.test(`${value} ${valueContext}`)))) return false;
    return exclusion.domains.length > 0 && factFollowsExclusion
      && exclusion.domains.some(domain => domain.finding.test(`${value} ${valueContext}`)
        || valueOffset < 0 && evidenceStart < exclusion.end && evidenceStart + evidence.length > exclusion.end
          && domain.finding.test(evidence.slice(Math.max(0, exclusion.end - evidenceStart))));
  });
}

function evidenceExcerptForScope(text, fallback, factStart, factLength) {
  const explicitlyIncluded = assessmentScopeExclusions(text).some(exclusion => exclusion.includedStart != null
    && factStart >= exclusion.includedStart && factStart < exclusion.includedEnd);
  return explicitlyIncluded ? text.slice(factStart, factStart + factLength) : fallback;
}

function removeOutOfScopeAssessmentSegments(text) {
  const exclusions = assessmentScopeExclusions(text);
  const segments = /[^。；;，,\n]+(?:[。；;，,\n]|$)/gu;
  let filtered = '';
  for (const match of text.matchAll(segments)) {
    const start = match.index;
    const end = start + match[0].length;
    let segment = match[0];
    for (const exclusion of exclusions) {
      const overlapStart = Math.max(start, exclusion.start);
      const overlapEnd = Math.min(end, exclusion.excludedEnd);
      if (overlapStart < overlapEnd) segment = `${segment.slice(0, overlapStart - start)}${segment.slice(overlapEnd - start)}`;
    }
    const explicitlyIncluded = exclusions.some(exclusion => exclusion.includedStart != null
      && start < exclusion.includedEnd && end > exclusion.includedStart);
    const excludedByDomain = !explicitlyIncluded && exclusions.some(exclusion => {
      if (exclusion.historicalOnly) {
        if ((currentEventAnchorBefore(text, start) || CURRENT_EVENT_SCOPE_ANCHOR.test(segment))
          && (!exclusion.scopeDomains.length || exclusion.scopeDomains.some(domain => domain.finding.test(segment)))) return false;
      }
      return exclusion.domains.some(domain => domain.finding.test(segment));
    });
    if (!excludedByDomain) filtered += segment;
  }
  return filtered;
}

function isAdministrativeDispositionWithoutClinicalFinding(value) {
  const text = normalizeInput(String(value ?? ''));
  const disposition = /(?:因(?:患者|家属).{0,12}(?:要求|选择|拒绝|决定).{0,8}(?:出院|转院)|(?:要求|选择|拒绝|决定|办理).{0,12}(?:出院|转院)|(?:出院|转院).{0,12}(?:手续|要求|选择|拒绝|决定))/u;
  const clinicalEvidence = /病情|症状|体征|检查|诊断|影像|骨折|出血|血肿|损伤|功能|疼痛|头晕|头痛|意识|神经|治疗效果|治疗终结/u;
  return disposition.test(text) && !clinicalEvidence.test(text);
}

function aggregateRibRootCounts(facts, sourceTexts) {
  const groups = new Map();
  for (const fact of facts) {
    if (fact.field !== 'fractured_rib_numbers' || !fact.eventId || !Array.isArray(fact.value)
      || !['reported', 'observed', 'derived'].includes(fact.certainty)) continue;
    const key = JSON.stringify([fact.source, fact.eventId, fact.certainty]);
    groups.set(key, [...(groups.get(key) || []), fact]);
  }
  for (const numberFacts of groups.values()) {
    const parserIds = new Set(numberFacts.map(fact => fact.parserId).filter(Boolean));
    if (!parserIds.size) continue;
    const componentCounts = facts.filter(fact => fact.field === 'fractured_rib_count'
      && fact.source === numberFacts[0].source && (!fact.eventId || fact.eventId === numberFacts[0].eventId)
      && fact.parserDerivedFrom?.some(id => parserIds.has(id)));

    const knownLocations = new Set();
    const knownNumbers = new Set();
    const unknownNumbers = new Set();
    for (const fact of numberFacts) {
      const laterality = fact.parserRibLaterality || facts.find(candidate => candidate.field === 'laterality' && candidate.source === fact.source
        && candidate.eventId === fact.eventId && candidate.certainty === fact.certainty && candidate.evidence === fact.evidence)?.value;
      for (const number of fact.value) {
        if (laterality === 'bilateral') {
          knownLocations.add(`left:${number}`); knownLocations.add(`right:${number}`); knownNumbers.add(number);
        } else if (laterality === 'left' || laterality === 'right') {
          knownLocations.add(`${laterality}:${number}`); knownNumbers.add(number);
        } else unknownNumbers.add(number);
      }
    }
    const rootCount = knownLocations.size + [...unknownNumbers].filter(number => !knownNumbers.has(number)).length;
    const previousCount = componentCounts.reduce((sum, fact) => sum + fact.value, 0);
    if (!Number.isInteger(rootCount) || rootCount < 1
      || numberFacts.length === 1 && rootCount === previousCount) continue;

    const evidence = numberFacts[0].evidence;
    const rawIds = [...new Set(componentCounts.flatMap(fact => fact.rawIds || []))];
    const sourceRefs = numberFacts[0].sourceRefs || [];
    const componentSet = new Set(componentCounts);
    facts.splice(0, facts.length, ...facts.filter(fact => !componentSet.has(fact)));
    facts.push({ field: 'fractured_rib_count', value: rootCount, certainty: 'derived', source: numberFacts[0].source,
      evidence, eventId: numberFacts[0].eventId, sourceRefs, finding: factFinding('fractured_rib_count', rootCount, 'derived'),
      parserDerivedFrom: [...parserIds], ...(rawIds.length ? { rawIds } : {}) });
  }
}

function normalizeRibFacts(inputText) {
  const text = normalizeInput(inputText);
  const explicitSingleRibEvent = hasSingleExplicitCurrentRibEvent(text);
  const facts = [];
  let truncated = false;
  let processedRibOccurrences = 0;
  let cachedRibClause = null;
  let cachedRibClauseHasFracture = false;
  const pattern = /肋骨|肋(?=\s*(?:及|和|与|、|，|,)\s*(?:(?:左|右|两侧|双侧)侧?\s*)?第\s*[0-9零〇一二两三四五六七八九十百]+\s*肋)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (processedRibOccurrences >= MAX_RIB_OCCURRENCES_PER_SOURCE) { truncated = true; break; }
    processedRibOccurrences += 1;
    const clauseStart = Math.max(text.lastIndexOf('。', match.index), text.lastIndexOf('；', match.index), text.lastIndexOf(';', match.index), text.lastIndexOf('，', match.index), text.lastIndexOf(',', match.index), text.lastIndexOf('\n', match.index)) + 1;
    const clauseTail = text.slice(match.index);
    const clauseEndOffset = clauseTail.search(/[。；;，,\n]/);
    const clauseEnd = clauseEndOffset < 0 ? text.length : match.index + clauseEndOffset;
    const clauseText = text.slice(clauseStart, clauseEndOffset < 0 ? text.length : match.index + clauseEndOffset);
    if (clauseText !== cachedRibClause) {
      cachedRibClause = clauseText;
      cachedRibClauseHasFracture = hasRibSpecificFractureStatement(clauseText);
    }
    if (!cachedRibClauseHasFracture) continue;
    const prefix = text.slice(clauseStart, match.index).slice(-80);
    const historicalHeading = historicalSectionHeading(text, clauseStart);
    const ordinalRange = prefix.match(/第\s*([0-9零〇一二两三四五六七八九十百]+)\s*(?:至|到|[-－–—~～])\s*(?:第\s*)?([0-9零〇一二两三四五六七八九十百]+)(?:\s*(?:根|条))?$/);
    const ordinal = ordinalRange || prefix.match(/第\s*[0-9零〇一二两三四五六七八九十百]+(?:(?:\s*(?:根|条))?\s*(?:、|，|,|和|及|与)\s*(?:第\s*)?[0-9零〇一二两三四五六七八九十百]+(?:\s*(?:根|条))?)*\s*(?:根|条)?$/);
    const count = prefix.match(/(?:共|累计)?\s*([0-9零〇一二两三四五六七八九十百]+)\s*(根|条)$/);
    const sideMatch = [...prefix.matchAll(ribSidePattern())].at(-1);
    const segment = `${sideMatch?.[0] || ''}${ordinal?.[0] || count?.[0] || ''}`;
    const matchedFractureEnd = text.indexOf('骨折', match.index);
    const fractureEnd = matchedFractureEnd >= 0 && matchedFractureEnd < pattern.lastIndex
      ? matchedFractureEnd : text.indexOf('骨折', pattern.lastIndex);
    let assertionEnd = fractureEnd >= 0 && fractureEnd < clauseEnd ? fractureEnd + 2 : clauseEnd;
    const postposedQualifier = text.slice(assertionEnd, clauseEnd)
      .match(/^\s*(?:(?:[（(【\[]\s*)?(?:(?:为|系|属)\s*)?(?:可疑|疑似|怀疑|考虑|可能|待排|待查|存疑|待确认|既往(?:史)?|曾经|曾有|陈旧性?|旧伤))/u);
    if (postposedQualifier) assertionEnd += postposedQualifier[0].length;
    const assertionContext = text.slice(clauseStart, assertionEnd);
    const temporalCues = [...assertionContext.matchAll(/既往(?:史)?|曾经|曾有|陈旧性?|旧伤|本次(?:事故后)?|此次(?:事故后)?|当前|目前/g)];
    const latestTemporalCue = temporalCues.at(-1);
    const latestCueIsCurrent = latestTemporalCue && /^(?:本次|此次|当前|目前)/.test(latestTemporalCue[0]);
    const certaintyStart = latestCueIsCurrent ? clauseStart + latestTemporalCue.index + latestTemporalCue[0].length : clauseStart;
    const certainty = certaintyFor(text, certaintyStart, assertionEnd);
    const side = sideScopeFromToken(sideMatch?.[0] || '');
    const numberTokens = ordinalRange
      ? (() => {
          const first = parseNumber(ordinalRange[1]);
          const last = parseNumber(ordinalRange[2]);
          return Number.isInteger(first) && Number.isInteger(last) && first >= 1 && last >= first && last <= 12
            ? Array.from({ length: last - first + 1 }, (_, index) => first + index) : [];
        })()
      : [...(ordinal?.[0] || count?.[0] || '').matchAll(/(?:第\s*)?([0-9零〇一二两三四五六七八九十百]+)/g)]
        .map((item) => parseNumber(item[1]))
        .filter((number) => Number.isInteger(number) && number > 0);
    const isRibCount = Boolean(count && !ordinal);
    const prefixStart = match.index - prefix.length;
    const sourceStarts = [sideMatch?.index, ordinal?.index, count?.index].filter((index) => Number.isInteger(index));
    let excerptStart = prefixStart + (sourceStarts.length ? Math.min(...sourceStarts) : prefix.length);
    const qualifierMatches = [...prefix.matchAll(/不排除|不能排除|可疑|疑似|怀疑|考虑|可能|待排|待查|若(?!干)|如果|假如|倘若|一旦|假设|如有|如出现|如发生|必要时|排除|未见|未发现|不存在|没有|无(?=(?:第\s*[0-9零〇一二两三四五六七八九十百]+\s*)?肋骨|骨折)/g)];
    if (qualifierMatches.length) excerptStart = Math.min(excerptStart, prefixStart + qualifierMatches.at(-1).index);
    const following = text.slice(pattern.lastIndex, Math.min(text.length, pattern.lastIndex + 36));
    const excerptEndOffset = following.search(/[。；;，,\n]/);
    const excerptEnd = excerptEndOffset < 0 ? pattern.lastIndex + Math.min(following.length, 20) : pattern.lastIndex + excerptEndOffset;
    const historicalExcerpt = historicalHeading ? text.slice(historicalHeading.start, excerptEnd).trim() : '';
    const historicalEvidenceTooLong = historicalExcerpt.length > 1000;
    const sourceExcerpt = historicalHeading && !historicalEvidenceTooLong ? historicalExcerpt
      : text.slice(excerptStart, excerptEnd).trim();
    const sentenceDelimiters = explicitSingleRibEvent ? ['。', '\n', '!', '！', '?', '？']
      : ['。', '；', ';', '\n', '!', '！', '?', '？'];
    const sentenceStart = Math.max(...sentenceDelimiters.map(delimiter => text.lastIndexOf(delimiter, match.index))) + 1;
    const sentenceTail = text.slice(pattern.lastIndex);
    const sentenceEndOffset = sentenceTail.search(explicitSingleRibEvent ? /[。\n!?！？]/ : /[。；;\n!?！？]/);
    const sentenceEnd = sentenceEndOffset < 0 ? text.length : pattern.lastIndex + sentenceEndOffset;
    const sentenceText = text.slice(sentenceStart, sentenceEnd);
    const sentenceFollowing = text.slice(pattern.lastIndex, sentenceEnd);
    // A sentence total can cover several rib mentions, but never infer its scope across another fracture site.
    const sentenceClauses = sentenceText.split(explicitSingleRibEvent ? /[，,、；;]/ : /[，,、]/);
    const fractureDetails = sentenceClauses.filter(clause => /骨折/.test(clause)
      && !/(?:共|累计)\s*[0-9零〇一二两三四五六七八九十百]+\s*处骨折/.test(clause));
    const additionalBoneSite = new RegExp(ADDITIONAL_BONE_SITES);
    const hasUnrelatedFractureClause = fractureDetails.some(clause => !/肋骨/.test(clause)
      || additionalBoneSite.test(clause)
      || /(?:既往(?:史)?|曾经|曾有|陈旧性?|旧伤)/.test(clause)
      || certaintyFor(clause, 0, clause.length) !== 'reported'
      || hasUnresolvedOtherExperiencer(clause)
      || [...clause.matchAll(/骨折/g)].length > [...clause.matchAll(/肋骨/g)].length);
    const aggregateSiteCounts = hasUnrelatedFractureClause ? [] : [...sentenceFollowing.matchAll(
      /(?:^|[，,、；;])\s*(?:共|累计)\s*([0-9零〇一二两三四五六七八九十百]+)\s*处(?=骨折)/g)];
    const ordinalPattern = /第\s*[0-9零〇一二两三四五六七八九十百]+(?:(?:\s*(?:根|条))?\s*(?:、|，|,|和|及|与)\s*(?:第\s*)?[0-9零〇一二两三四五六七八九十百]+(?:\s*(?:根|条))?)*\s*(?:根|条)?肋骨/g;
    const sentenceRibNumbers = new Set([...sentenceText.matchAll(ordinalPattern)].flatMap(item =>
      [...item[0].matchAll(/(?:第\s*)?([0-9零〇一二两三四五六七八九十百]+)/g)]
        .map(number => parseNumber(number[1])).filter(number => Number.isInteger(number) && number > 0)));
    const sentenceAggregateCounts = [...sentenceText.matchAll(
      /(?:共|累计)\s*([0-9零〇一二两三四五六七八九十百]+)\s*处(?=\s*(?:肋骨\s*)?骨折)/g)];
    const aggregateCountCoversMultipleRibs = sentenceAggregateCounts.length === 1 && sentenceRibNumbers.size > 1;
    const add = (field, value, itemCertainty = certainty, sourceType = 'user_text', derivedFrom) => {
      const fact = {
        id: `F${facts.length + 1}`, field, value, certainty: itemCertainty,
        source_type: sourceType,
        ...(sourceType === 'derived' ? { derived_from: derivedFrom || [] } : { source_excerpt: sourceExcerpt })
      };
      facts.push(fact);
      return fact;
    };

    const latestCueIsHistorical = latestTemporalCue && !latestCueIsCurrent;
    if (historicalHeading || latestCueIsHistorical) {
      add('prior_injury', 'rib_fracture', historicalEvidenceTooLong ? 'unknown' : certainty);
      continue;
    }

    add('injury_type', 'rib_fracture');
    add('anatomical_site', '肋骨');
    if (side) add('laterality', side);
    if (isRibCount && numberTokens.length) {
      add('fractured_rib_count', numberTokens[0]);
    } else if (numberTokens.length) {
      const ribNumbersFact = add('fractured_rib_numbers', [...new Set(numberTokens)].sort((a, b) => a - b));
      ribNumbersFact.parserRibLaterality = side;
      const derivedCertainty = ['reported', 'observed'].includes(certainty) ? 'derived' : certainty;
      if (!(aggregateCountCoversMultipleRibs && numberTokens.length === 1)) {
        const rootCount = side === 'bilateral' ? ribNumbersFact.value.length * 2 : ribNumbersFact.value.length;
        add('fractured_rib_count', rootCount, derivedCertainty, 'derived', [ribNumbersFact.id]);
      }
    }

    const explicitSiteCount = aggregateSiteCounts.length === 1 ? aggregateSiteCounts[0]
      : following.match(/^\s*(?:骨折\s*[，,、]?\s*)?[，,、]?\s*(?:共|累计)?\s*([0-9零〇一二两三四五六七八九十百]+)\s*处/)
        || clauseText.match(/(?:共|累计)?\s*([0-9零〇一二两三四五六七八九十百]+)\s*处(?=\s*(?:肋骨\s*)?骨折)/);
    if (explicitSiteCount) {
      const siteCount = parseNumber(explicitSiteCount[1]);
      const perRibCountCoveredByEventTotal = aggregateCountCoversMultipleRibs && siteCount === 1
        && sentenceAggregateCounts.some(item => parseNumber(item[1]) > 1);
      if (perRibCountCoveredByEventTotal) continue;
      const siteCountFact = add('fracture_site_count', siteCount);
      siteCountFact.source_excerpt = `${explicitSiteCount[1]}处`;
    }
  }
  if (truncated) Object.defineProperty(facts, 'truncated', { value: true });
  return facts;
}

function boundNormalizedFacts(facts) {
  let size = 2;
  let truncated = false;
  const bounded = [];
  for (const fact of facts) {
    const factSize = JSON.stringify(fact).length + (bounded.length ? 1 : 0);
    if (bounded.length >= MAX_NORMALIZED_FACTS || size + factSize > MAX_FACT_SNAPSHOT_JSON_CHARS) {
      truncated = true;
      continue;
    }
    bounded.push(fact);
    size += factSize;
  }
  facts.splice(0, facts.length, ...bounded);
  return truncated;
}

function normalizeGenericNegativeFractureFacts(inputText) {
  const text = normalizeInput(inputText);
  return text.split(/(?<=[。；;，,\n])/u).map(clause => clause.trim()).filter(clause => {
    if (!/骨折/.test(clause) || /肋骨/.test(clause) || canonicalCertainty(clause, 'reported') !== 'excluded') return false;
    return /未见|未发现|排除|不存在|没有|无|阴性|否认/.test(clause);
  }).map(source_excerpt => ({
    field: 'injury_type', value: 'fracture', certainty: 'excluded', source_type: 'user_text', source_excerpt,
  }));
}

const fractureSitePatterns = [
  ['rib', /肋骨/u], ['clavicle', /锁骨/u], ['scapula', /肩胛骨/u], ['humerus', /肱骨/u],
  ['forearm', /尺骨|桡骨|前臂/u], ['hand', /(?:手(?:掌|背|指)(?:骨)?|腕骨|掌骨|指骨|手(?=(?:部|X线|X片|CT|骨折|未见|未发现|阴性|无|外伤|受伤|损伤|活动|肿胀|压痛)))/iu],
  ['pelvis', /骨盆|髂骨|耻骨|坐骨/u], ['femur', /股骨/u], ['lower_leg', /胫骨|腓骨/u],
  ['foot', /足部|足骨|跖骨|趾骨|跟骨|距骨/u], ['spine', /椎骨|椎体|脊柱/u],
  ['skull', /颅骨|头骨/u], ['nasal', /鼻骨/u], ['face', /颧骨|下颌骨/u], ['sternum', /胸骨/u],
];

function certaintyEvidenceForFact(field, value, evidence) {
  if (CERTAINTY_SCOPED_FIELDS.has(field) && typeof value === 'string' && value) {
    const exactValueIndex = evidence.indexOf(value);
    if (exactValueIndex >= 0) {
      const delimiters = ['。', '！', '？', '；', ';', '，', ',', '、', '及', '和', '与', '\n'];
      const start = Math.max(-1, ...delimiters.map(delimiter => evidence.lastIndexOf(delimiter, exactValueIndex - 1))) + 1;
      const ends = delimiters.map(delimiter => evidence.indexOf(delimiter, exactValueIndex + value.length)).filter(index => index >= 0);
      const end = ends.length ? Math.min(...ends) : evidence.length;
      return evidence.slice(start, end).trim() || evidence;
    }
  }
  if (!['injury_type', 'anatomical_site'].includes(field) || typeof value !== 'string') return evidence;
  const valueSites = value.toLowerCase() === 'rib_fracture' ? ['rib']
    : fractureSitePatterns.filter(([, pattern]) => pattern.test(value)).map(([site]) => site);
  if (valueSites.length !== 1) return evidence;
  const pattern = fractureSitePatterns.find(([candidate]) => candidate === valueSites[0])[1];
  const matches = [...evidence.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))];
  if (!matches.length) return evidence;
  const exactValueIndex = evidence.indexOf(value);
  let target = exactValueIndex >= 0 ? matches.find(match => match.index >= exactValueIndex
    && match.index < exactValueIndex + value.length) : null;
  if (!target && matches.length === 1) target = matches[0];
  if (!target) return evidence;
  const delimiters = ['。', '；', ';', '、', '，', ',', '\n'];
  const start = Math.max(-1, ...delimiters.map(delimiter => evidence.lastIndexOf(delimiter, target.index - 1))) + 1;
  const ends = delimiters.map(delimiter => evidence.indexOf(delimiter, target.index)).filter(index => index >= 0);
  const end = ends.length ? Math.min(...ends) : evidence.length;
  return evidence.slice(start, end).trim() || evidence;
}

function fractureEvidenceScope(fact) {
  const evidence = String(fact.evidence || '');
  if (!/(?:骨折|fracture)/iu.test(evidence)) return null;
  const matches = fractureSitePatterns.flatMap(([site, pattern]) => [...evidence.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))]
    .map(match => ({ site, index: match.index })));
  const value = String(fact.value ?? '');
  const valueSites = value.toLowerCase() === 'rib_fracture' ? ['rib']
    : fractureSitePatterns.filter(([, pattern]) => pattern.test(value)).map(([site]) => site);
  const sitesInEvidence = [...new Set(matches.map(match => match.site))];
  const selectedSite = valueSites.length === 1 && sitesInEvidence.includes(valueSites[0]) ? valueSites[0]
    : sitesInEvidence.length === 1 ? sitesInEvidence[0] : null;
  if (!selectedSite) return null;
  const occurrences = matches.filter(match => match.site === selectedSite);
  const scopes = occurrences.map(match => {
    const prefix = evidence.slice(Math.max(0, match.index - 16), match.index);
    const laterality = prefix.match(/(左|右)(?:侧|边)?(?:第\s*[0-9零〇一二两三四五六七八九十百]+\s*(?:根|条)?\s*)?$/u)?.[1];
    return laterality === '左' ? 'left' : laterality === '右' ? 'right' : null;
  });
  const uniqueLateralities = [...new Set(scopes)];
  if (uniqueLateralities.length > 1) return null;
  return { site: selectedSite, laterality: uniqueLateralities[0] || null };
}

function fracturesAtClearlyDifferentSites(leftFact, rightFact) {
  const left = fractureEvidenceScope(leftFact);
  const right = fractureEvidenceScope(rightFact);
  return Boolean(left && right && (left.site !== right.site
    || left.laterality && right.laterality && left.laterality !== right.laterality));
}

function stableJson(value) {
  if (Array.isArray(value)) {
    const normalized = value.map(stableJson);
    if (normalized.every(item => typeof item === 'number')) return normalized.sort((a, b) => a - b);
    return normalized;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableJson(value[key])]));
  }
  return typeof value === 'string' ? normalizeInput(value) : value;
}

function canonicalCertainty(evidence, proposed) {
  if (hasUnresolvedOtherExperiencer(evidence) || /若(?!干)|如果|假如|倘若|一旦|假设|如有|如出现|如发生|必要时/.test(evidence)) return 'unknown';
  if (/(?:未提及|未记载|未记录|无记载|没有记载|未说明|未描述)/u.test(evidence)) return 'unknown';
  if (/(?:建议|推荐|需要|拟|计划|应当|应).{0,24}(?:复查|检查|重建|排除)/.test(evidence)
    && !/(?:已排除|排除后|复查结果|检查结果)/.test(evidence)) return 'unknown';
  if (/不排除|不能排除|未排除|尚未排除|未能排除|不除外|不能除外|未能除外|可疑|疑似|怀疑|疑问|存疑|待确认|待排|待查|考虑|可能|[?？]/u.test(evidence)) return 'uncertain';
  if (/排除|未见|未发现|不存在|阴性|否认/.test(evidence)) return 'excluded';
  return ['reported', 'observed', 'derived', 'conflicted', 'unknown'].includes(proposed) ? proposed : 'reported';
}

function negativeClaimIsQuoted(value, evidence) {
  if (typeof value !== 'string') return true;
  const negation = /未见|未发现|未提示|未查见|未检查出|未提及|未记载|没有|不存在|否认/u;
  const claim = value.split(/[，,；;。！？\n]/u).find(part => negation.test(part));
  if (!claim) return true;
  const marker = claim.match(negation)?.[0];
  const target = claim.slice(claim.indexOf(marker) + marker.length)
    .replace(/(?:记载|描述|显示|发现|检查|提示|证明|征象|表现)$/u, '').trim();
  if (!target) return false;
  return String(evidence || '').split(/[，,；;。！？\n]/u)
    .some(part => negation.test(part) && normalizeInput(part).includes(normalizeInput(target)));
}

function canonicalMissingMaterials(items = []) {
  const aliases = [
    [/^(?:applicable_assessment_standard_entries|assessment_standard|鉴定标准条款|可适用的伤情鉴定标准条款).*$/i, '可适用的鉴定标准条款'],
    [/^(?:definitive_diagnosis|diagnosis_certificate|diagnosis_proof|diagnosis_materials|diagnosis_report|明确诊断|医学诊断结果|诊断证明|诊断资料|诊断报告|诊断意见|胸部损伤诊断).*$/i, '明确诊断或复查结论'],
    [/^(?:fracture_site_count|骨折处数)(?:未在(?:原文|材料)中?明确(?:记载|说明|提供)|未明确).*$/i, '骨折处数未在原文中明确记载，需核实'],
    [/^(?:临床诊断(?:报告|资料)).*$/i, '明确诊断或复查结论'],
    [/^(?:imaging_examination|imaging_report|影像学?检查(?:报告|资料)?|影像资料|影像学资料|影像学图像|胸部影像学?检查(?:报告|资料)?|胸部影像资料).*$/i, '影像检查报告'],
    [/^(?:sixth_rib_laterality|laterality|肋骨侧别|侧别).*$/i, '肋骨侧别'],
  ];
  return [...new Set(items.filter(item => typeof item === 'string').map(item => {
    const normalized = normalizeInput(item).replace(/[：:，,。；;]+$/g, '');
    return aliases.find(([pattern]) => pattern.test(normalized))?.[1] || normalized;
  }).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function normalizeFactExtractionResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const rawFacts = Array.isArray(value.facts) ? value.facts : value.facts;
  const facts = Array.isArray(rawFacts) ? rawFacts.map(fact => {
    if (!fact || typeof fact !== 'object' || Array.isArray(fact)) return fact;
    const source = fact.source || (fact.source_type === 'image_observation' ? 'image' : 'description');
    return {
      ...(typeof fact.id === 'string' ? { id: fact.id } : {}),
      ...(typeof fact.eventId === 'string' || fact.eventId === null ? { eventId: fact.eventId } : {}),
      field: fact.field,
      value: fact.value,
      certainty: fact.certainty,
      source,
      evidence: typeof fact.evidence === 'string' ? fact.evidence : (typeof fact.source_excerpt === 'string' ? fact.source_excerpt : ''),
    };
  }) : rawFacts;
  const rawConflicts = Array.isArray(value.conflicts) ? value.conflicts : value.conflicts;
  const conflicts = Array.isArray(rawConflicts) ? rawConflicts.map(conflict => {
    if (typeof conflict === 'string') return {
      factIds: [...new Set(conflict.match(/\bF\d+\b/g) || [])], reason: normalizeInput(conflict).slice(0, 1000),
    };
    if (!conflict || typeof conflict !== 'object' || Array.isArray(conflict)) return conflict;
    const ids = conflict.factIds ?? conflict.fact_ids ?? conflict.between ?? [];
    const reason = conflict.reason ?? conflict.description;
    return { factIds: ids, reason };
  }) : rawConflicts;
  return {
    facts,
    missingMaterials: value.missingMaterials ?? value.missing_information,
    conflicts,
    requiresReview: value.requiresReview ?? value.requires_review,
  };
}

function sourceClause(sourceText, evidence, position = null) {
  const text = normalizeInput(sourceText || '');
  const quote = normalizeInput(evidence || '');
  if (!quote) return '';
  const index = Number.isInteger(position) && text.slice(position, position + quote.length) === quote
    ? position : text.indexOf(quote);
  if (index < 0) return '';
  const left = Math.max(text.lastIndexOf('。', index), text.lastIndexOf('；', index), text.lastIndexOf(';', index), text.lastIndexOf('，', index), text.lastIndexOf(',', index), text.lastIndexOf('\n', index)) + 1;
  const quoteEnd = index + quote.length;
  const tail = text.slice(quoteEnd);
  const endOffset = tail.search(/[。；;，,\n]/);
  const right = endOffset < 0 ? text.length : quoteEnd + endOffset;
  const clause = text.slice(left, right).trim();
  if (clause.length <= MAX_FACT_EVIDENCE_CHARS) return clause;
  const quoteOffset = index - left;
  const quoteWindow = Math.min(quote.length, MAX_FACT_EVIDENCE_CHARS);
  const windowStart = Math.max(0, Math.min(clause.length - MAX_FACT_EVIDENCE_CHARS,
    quoteOffset - Math.floor((MAX_FACT_EVIDENCE_CHARS - quoteWindow) / 2)));
  return clause.slice(windowStart, windowStart + MAX_FACT_EVIDENCE_CHARS);
}

function sourceSentence(sourceText, evidence, position = null) {
  const text = normalizeInput(sourceText || '');
  const quote = normalizeInput(evidence || '');
  const index = quote && Number.isInteger(position) && text.slice(position, position + quote.length) === quote
    ? position : quote ? text.indexOf(quote) : -1;
  if (index < 0) return '';
  const left = Math.max(text.lastIndexOf('。', index), text.lastIndexOf('！', index), text.lastIndexOf('？', index),
    text.lastIndexOf('\n', index)) + 1;
  const quoteEnd = index + quote.length;
  const tail = text.slice(quoteEnd);
  const endOffset = tail.search(/[。！？\n]/);
  return text.slice(left, endOffset < 0 ? text.length : quoteEnd + endOffset).trim();
}

function uniqueSourceClauseForExactValue(sourceText, value) {
  const text = normalizeInput(sourceText || '');
  const quote = normalizeInput(value || '');
  if (!quote) return undefined;
  const clauses = new Set();
  for (let position = text.indexOf(quote); position >= 0; position = text.indexOf(quote, position + quote.length)) {
    clauses.add(sourceClause(text, quote, position));
    if (clauses.size > 1) return null;
  }
  return clauses.size ? clauses.values().next().value : undefined;
}

function diagnosisEvidenceSupportsValue(value, evidence) {
  const normalizedValue = normalizeInput(value || '');
  const normalizedEvidence = normalizeInput(evidence || '');
  if (!normalizedValue || !normalizedEvidence) return false;
  if (normalizedEvidence.includes(normalizedValue)) return true;

  const siteGroups = [
    ['左眼', '右眼', '双眼', '两眼', '眼球'], ['眼眶', '眶壁', '眶'], ['左鼻骨', '右鼻骨', '鼻骨', '鼻部'],
    ['左额骨', '右额骨', '额骨', '额部'], ['眉弓'], ['肋骨'], ['上颌骨', '下颌骨', '颌骨', '颞颌'],
    ['骨盆', '耻骨', '髋臼'], ['颈部'], ['胸部'], ['腹部'], ['脊柱', '椎体'], ['股骨'], ['胫骨'], ['腓骨'],
    ['髌骨'], ['肱骨'], ['尺骨'], ['桡骨'], ['锁骨'], ['肩胛骨'], ['肺'], ['脾'], ['肾'], ['肝'], ['心脏'],
    ['手指', '掌骨'], ['足', '跖骨', '趾骨'],
  ];
  const valueSiteGroups = siteGroups.filter(group => group.some(site => normalizedValue.includes(normalizeInput(site))));
  const diagnosisMarkers = ['外伤性', '骨折', '挫裂伤', '挫伤', '撕裂', '裂伤', '裂创', '损伤', '弱视', '屈光不正',
    '玻璃体积血', '积血', '血肿', '出血', '脱位', '断裂', '青光眼', '破裂', '穿通伤', '缺损', '损害'];
  const sideForSite = (text, group) => {
    for (const site of group) {
      const normalizedSite = normalizeInput(site);
      const index = text.indexOf(normalizedSite);
      if (index < 0) continue;
      const nearby = text.slice(Math.max(0, index - 4), index + normalizedSite.length);
      if (/(?:双侧|两侧|左右)/u.test(nearby)) return 'bilateral';
      if (/左/u.test(nearby)) return 'left';
      if (/右/u.test(nearby)) return 'right';
    }
    return null;
  };
  const sideCompatible = valueSiteGroups.every(group => {
    const valueSide = sideForSite(normalizedValue, group);
    if (!valueSide) return true;
    const evidenceSide = sideForSite(normalizedEvidence, group);
    return valueSide === evidenceSide || evidenceSide === 'bilateral';
  });
  return valueSiteGroups.length > 0 && sideCompatible
    && valueSiteGroups.every(group => group.some(site => normalizedEvidence.includes(normalizeInput(site))))
    && diagnosisMarkers.some(marker => normalizedValue.includes(marker) && normalizedEvidence.includes(marker));
}

function eventDateAnchors(sourceText, evidence) {
  const text = normalizeInput(sourceText || '');
  const quote = normalizeInput(evidence || '');
  if (!text || !quote) return [];
  const contexts = [];
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const index = text.indexOf(quote, searchFrom);
    if (index < 0) break;
    const left = Math.max(text.lastIndexOf('。', index), text.lastIndexOf('！', index), text.lastIndexOf('？', index),
      text.lastIndexOf('；', index), text.lastIndexOf(';', index), text.lastIndexOf('\n', index)) + 1;
    const quoteEnd = index + quote.length;
    const candidates = ['。', '！', '？', '；', ';', '\n'].map(delimiter => text.indexOf(delimiter, quoteEnd))
      .filter(position => position >= 0);
    const right = candidates.length ? Math.min(...candidates) : text.length;
    contexts.push(text.slice(left, right));
    searchFrom = quoteEnd;
  }
  if (!contexts.length) contexts.push(quote);

  const anchors = new Map();
  for (const context of contexts) {
    for (const anchor of parseEventDateAnchors(context)) anchors.set(anchor.key, anchor.range);
  }
  return [...anchors.values()];
}

function imageTextSections(sourceText) {
  const text = normalizeInput(sourceText);
  const marker = /(?:^|\n)【图片([1-6])】(?:\n|$)/g;
  const matches = [...text.matchAll(marker)];
  const imageNumbers = matches.map(match => match[1]);
  return matches.map((match, index) => ({
    sourceId: imageNumbers.filter(imageNumber => imageNumber === match[1]).length === 1
      ? `image-${match[1]}` : null,
    text: text.slice(match.index + match[0].length, matches[index + 1]?.index ?? text.length).trim(),
  }));
}

function sourceRefsForFact(source, evidence, sourceText) {
  const quote = normalizeInput(evidence).replace(/^【图片[1-6]】\s*/, '');
  if (!quote) return [];
  const referencesAt = (sourceId, text) => {
    const normalizedText = normalizeInput(text);
    const positions = [];
    let truncated = false;
    for (let position = normalizedText.indexOf(quote); position >= 0;
      position = normalizedText.indexOf(quote, position + Math.max(1, quote.length))) {
      if (positions.length === 200) { truncated = true; break; }
      positions.push({ normalizedStart: position, normalizedEnd: position + quote.length });
    }
    if (!positions.length) return [{ source, sourceId, evidence: quote }];
    return [{ source, sourceId, evidence: quote,
      ...(positions.length === 1 ? positions[0] : { positions }), ...(truncated ? { positionsComplete: false } : {}) }];
  };
  if (source === 'description') return referencesAt('description', sourceText);
  const matchingPages = imageTextSections(sourceText).filter(page => normalizeInput(page.text).includes(quote));
  if (matchingPages.some(page => page.sourceId === null)) return referencesAt(null, sourceText);
  if (matchingPages.length) return matchingPages.flatMap(page => referencesAt(page.sourceId, page.text));
  return referencesAt(null, sourceText);
}

function mergeSourceRefs(...referenceLists) {
  const references = new Map();
  for (const reference of referenceLists.flat()) {
    const key = JSON.stringify([reference.source, reference.sourceId, reference.evidence]);
    const prior = references.get(key);
    if (!prior) { references.set(key, reference); continue; }
    const positionsForReference = item => item.positions || (Number.isInteger(item.normalizedStart)
      && Number.isInteger(item.normalizedEnd) ? [{ normalizedStart: item.normalizedStart, normalizedEnd: item.normalizedEnd }] : []);
    const positions = [...new Map([...positionsForReference(prior), ...positionsForReference(reference)]
      .map(position => [JSON.stringify(position), position])).values()];
    const { normalizedStart: _start, normalizedEnd: _end, positions: _positions, ...base } = prior;
    references.set(key, { ...base, ...(positions.length === 1 ? positions[0]
      : positions.length ? { positions: positions.slice(0, 200) } : {}),
    ...(prior.positionsComplete === false || reference.positionsComplete === false
      || positions.length > 200 ? { positionsComplete: false } : {}) });
  }
  return [...references.values()];
}

function sourceReferenceMatches(reference, { description = '', recognizedText = '' } = {}) {
  const quote = normalizeInput(reference?.evidence);
  if (!quote) return false;
  const hasStart = Number.isInteger(reference.normalizedStart);
  const hasEnd = Number.isInteger(reference.normalizedEnd);
  if (reference.positionsComplete === false || hasStart !== hasEnd || Array.isArray(reference.positions) && (!reference.positions.length
    || reference.positions.some(position => !Number.isInteger(position.normalizedStart)
      || !Number.isInteger(position.normalizedEnd) || position.normalizedEnd <= position.normalizedStart))
    || Array.isArray(reference.positions) && (hasStart || hasEnd)) return false;
  const matchesAt = text => {
    const normalizedText = normalizeInput(text);
    const positions = Array.isArray(reference.positions) ? reference.positions : (hasStart && hasEnd
      ? [{ normalizedStart: reference.normalizedStart, normalizedEnd: reference.normalizedEnd }] : []);
    if (!positions.length) return normalizedText.includes(quote);
    return positions.some(position => position.normalizedEnd - position.normalizedStart === quote.length
      && normalizedText.slice(position.normalizedStart, position.normalizedEnd) === quote);
  };
  if (reference.source === 'description') {
    if (reference.sourceId !== 'description' && reference.sourceId !== null) return false;
    if (Number.isInteger(reference.normalizedStart) !== Number.isInteger(reference.normalizedEnd)) return false;
    return matchesAt(description);
  }
  if (reference.source !== 'image') return false;
  if (Number.isInteger(reference.normalizedStart) !== Number.isInteger(reference.normalizedEnd)) return false;
  if (reference.sourceId === null) return matchesAt(recognizedText);
  return imageTextSections(recognizedText).some(page => page.sourceId === reference.sourceId && matchesAt(page.text));
}

function hasSingleExplicitCurrentRibEvent(text) {
  const normalized = normalizeInput(text || '');
  const currentCuePattern = /(?:本次|此次|当前)(?:事故|外伤|受伤|损伤)(?:后)?/g;
  const sameEventCuePattern = /同一次(?:事故|外伤|受伤|损伤)/g;
  const currentCues = [...normalized.matchAll(currentCuePattern)].map(match => match[0].replace(/后$/, ''));
  const sameEventCues = [...normalized.matchAll(sameEventCuePattern)];
  const assaultCues = [...normalized.matchAll(/(?:受|遭|被(?:他人)?)(?:殴打|拳打|击打|击伤|砍伤|击)后/gu),
    ...normalized.matchAll(new RegExp(HEAD_IMPACT_EVENT_CUE_SOURCE, 'gu'))]
    .filter(match => !hasNonCurrentClinicalContext(normalized, match.index, match.index + match[0].length));
  const eventCues = currentCues.length ? currentCues : sameEventCues.length ? sameEventCues.map(() => '同一次事件')
    : assaultCues.map(() => '单次明确殴打事件');
  const datedEventAnchors = parseEventDateAnchors(normalized);
  let otherEventMentions = normalized;
  for (const anchor of [...datedEventAnchors].reverse()) {
    otherEventMentions = `${otherEventMentions.slice(0, anchor.index)}${otherEventMentions.slice(anchor.index + anchor.length)}`;
  }
  otherEventMentions = otherEventMentions.replace(currentCuePattern, '').replace(sameEventCuePattern, '')
    .replace(/(?:受|遭|被(?:他人)?)(?:殴打|拳打|击打|击伤|砍伤|击)后/gu, '')
    .replace(new RegExp(HEAD_IMPACT_EVENT_CUE_SOURCE, 'gu'), '');
  otherEventMentions = otherEventMentions.replace(
    /(?:CT|MRI|X线(?:片)?|影像(?:学)?检查|检查|复查)[^。；;\n]{0,20}(?:未见|未发现|未提示|排除|无)[^。；;\n]{0,24}(?:事故|外伤|受伤|损伤)/gu, '');
  if (!eventCues.length || new Set(eventCues).size !== 1 || /事故|外伤|受伤/.test(otherEventMentions)
    || eventDateAnchorsConflict(datedEventAnchors.map(anchor => anchor.range))) return false;
  const affirmativePriorRibInjury = normalized.split(/[。；;\n]/).some(clause =>
    /(?:既往(?:史)?|曾经|曾有|陈旧性?|旧伤)/.test(clause)
      && /(?:肋骨|骨折|损伤)/.test(clause)
      && !/(?:没有|无|未见|未发现|排除|否认)/.test(clause));
  return !affirmativePriorRibInjury;
}

function hasExplicitCurrentInjuryEvidence(evidence) {
  const text = normalizeInput(evidence || '');
  const cues = [...text.matchAll(/(?:本次|此次|当前)(?:交通)?(?:事故|外伤|受伤|损伤)(?:后|中)?|(?:车祸|交通事故|外伤|砍伤|殴打)后/gu),
    ...text.matchAll(new RegExp(HEAD_IMPACT_EVENT_CUE_SOURCE, 'gu'))];
  return cues.some(cue => {
    const nearby = text.slice(cue.index + cue[0].length, cue.index + cue[0].length + 40);
    return /(?:受伤|骨折|破裂|损伤|挫伤|创口|穿透创|贯通伤|出血|脱位|撕裂|断裂|昏迷|神志障碍|意识障碍)/u.test(nearby)
      && !/(?:未见|未发现|排除|否认)/u.test(nearby);
  });
}

function hasRetrospectiveClinicalEvidence(evidence) {
  return /既往(?:史)?|既有|历史(?:病历|手术|病史|资料)|陈旧|原有|此前|曾(?:经|于|在|行|接受|做过|做|切除|修补|施行)/u
    .test(normalizeInput(evidence || ''));
}

function hasSingleExplicitInjuryEvent(text) {
  const normalized = normalizeInput(text || '');
  const datedEvents = parseEventDateAnchors(normalized);
  if (datedEvents.length) return datedEvents.length === 1 && !eventDateAnchorsConflict(datedEvents.map(anchor => anchor.range));
  let eventCues = [...normalized.matchAll(/因(?:车祸|交通事故|机动车事故|车辆事故)(?:后)?(?:(?:导致|造成))?(?:受伤|致伤|外伤|摔伤|撞伤)|(?:本次|此次|当前)(?:交通)?(?:事故|外伤|受伤|损伤)|(?:车祸|交通事故|外伤|刺伤|刀伤|刀刺伤|砍伤|击伤|摔伤|坠落伤|撞伤|压伤|烧伤|烫伤)后|(?:机动车|汽车|车辆|摩托车)(?:相撞|碰撞)后|(?:步行|行走)(?:时)?被[^。；;\n]{0,12}(?:电动自行车|自行车|机动车|汽车|车辆|摩托车)(?:撞倒|撞击|撞伤)|被(?:汽车|车辆|机动车|摩托车)?撞(?:击)?(?:后(?:倒地|受伤)?|倒地?|伤)|(?:枪击(?:头(?:面)?部|头颈部)?|枪伤|枪弹伤)后|(?:19|20)\d{2}年\d{1,2}月\d{1,2}日[^。；;\n]{0,24}(?:(?:菜刀|刀具|利器|锐器|锤|棍|工具)[^。；;\n]{0,6})?(?:刀伤|砍伤|刺伤|刺入|击伤)|(?:外伤|受伤)致[^。；;\n]{0,24}(?:损伤|骨折|创伤)|(?:头(?:面|颈)?部|身体)受伤后|(?:头(?:面|颈)?部|身体)(?:受|遭)[^。；;\n]{0,10}(?:打伤|击伤|砸伤|击打|殴打)|(?:他人|人)用[^。；;\n]{1,12}(?:打伤|击伤|砸伤)(?:头(?:面)?部|面部|面颊|脸颊|口角)|被(?:他人|人)?(?:用|以)?[^。；;\n]{1,12}(?:打伤|击伤|砸伤)头(?:面)?部/gu),
    ...normalized.matchAll(new RegExp(HEAD_IMPACT_EVENT_CUE_SOURCE, 'gu'))]
    .filter(match => !hasNonCurrentClinicalContext(normalized, match.index, match.index + match[0].length));
  if (!eventCues.length) {
    eventCues = [...normalized.matchAll(new RegExp(BLUNT_OBJECT_BODY_IMPACT_CUE.source, 'gu'))]
      .filter(match => !hasNonCurrentClinicalContext(normalized, match.index, match.index + match[0].length));
  }
  const dateRanges = parseEventDateAnchors(normalized).map(anchor => anchor.range);
  return eventCues.length === 1 && !eventDateAnchorsConflict(dateRanges);
}

function sentenceContainingEvidence(text, evidence) {
  const normalizedText = normalizeInput(text || '');
  const quote = normalizeInput(evidence || '');
  const position = normalizedText.indexOf(quote);
  if (!quote || position < 0) return quote;
  const sentenceStart = Math.max(normalizedText.lastIndexOf('。', position - 1), normalizedText.lastIndexOf('；', position - 1),
    normalizedText.lastIndexOf(';', position - 1), normalizedText.lastIndexOf('\n', position - 1)) + 1;
  const sentenceEnd = [normalizedText.indexOf('。', position + quote.length), normalizedText.indexOf('；', position + quote.length),
    normalizedText.indexOf(';', position + quote.length), normalizedText.indexOf('\n', position + quote.length)]
    .filter(index => index >= 0).reduce((nearest, index) => Math.min(nearest, index), normalizedText.length);
  return normalizedText.slice(sentenceStart, sentenceEnd);
}

function hasExplicitlyUnlinkedChestInjuryEvidence(evidence, sourceDescription = '') {
  const text = sentenceContainingEvidence(sourceDescription, evidence) || normalizeInput(evidence || '');
  return /(?:未说明|未明确|未能确认|尚不明确|无法确认|不能确认)[^。；;\n]{0,36}(?:胸部|胸外伤|肋骨)[^。；;\n]{0,36}(?:与|和)[^。；;\n]{0,28}(?:头部|颅脑)[^。；;\n]{0,24}(?:事件)?(?:关联|相关|因果关系|是否为同一(?:次)?(?:事件|外伤|事故))/u.test(text)
    || /(?:胸部|胸外伤|肋骨)[^。；;\n]{0,24}(?:与|和)(?:头部|颅脑)[^。；;\n]{0,24}(?:无关|不相关|非同一次|不同事件)/u.test(text);
}

function isExplicitlyUnlinkedChestInjuryFact(fact, sourceDescription = '') {
  return /肋骨|胸部|胸外伤/u.test(`${fact.field} ${fact.value} ${fact.evidence}`)
    && hasExplicitlyUnlinkedChestInjuryEvidence(fact.evidence, sourceDescription);
}

function assignDatedEventIds(facts, sourceDescription) {
  const source = normalizeInput(sourceDescription || '');
  const events = parseEventDateAnchors(source);
  let unlinkedIndex = 1;
  for (const fact of facts) {
    if (fact.source !== 'description' || typeof fact.evidence !== 'string' || !fact.evidence) continue;
    if (isExplicitlyUnlinkedChestInjuryFact(fact, sourceDescription)) {
      delete fact.eventId;
      continue;
    }
    if (fact.field === 'injury_date') {
      const targetDate = normalizeInjuryDateValue(fact.value);
      const matchingEvents = events.flatMap((event, index) => {
        const [year, month, day] = event.key.split('-');
        const value = month === '*' ? year : day === '*' ? `${year}-${month.padStart(2, '0')}`
          : `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
        return value === targetDate ? [{ eventId: `E${index + 1}` }] : [];
      });
      if (matchingEvents.length === 1) {
        fact.eventId = matchingEvents[0].eventId;
        continue;
      }
    }
    const quote = normalizeInput(fact.evidence);
    const eventIds = new Set();
    let position = source.indexOf(quote);
    while (position >= 0) {
      const end = position + quote.length;
      const eventIndex = events.findIndex((event, index) => position >= event.index
        && end <= (events[index + 1]?.index ?? source.length));
      if (eventIndex >= 0) eventIds.add(`E${eventIndex + 1}`);
      position = source.indexOf(quote, position + 1);
    }
    if (eventIds.size === 1) fact.eventId = [...eventIds][0];
    else if (events.length) fact.eventId = `U${unlinkedIndex++}`;
  }
  const factsByParserId = new Map(facts.filter(fact => fact.parserId).map(fact => [fact.parserId, fact]));
  for (const fact of facts) {
    if (fact.field !== 'aggregate_wound_length_cm' || fact.certainty !== 'derived'
      || !Array.isArray(fact.parserDerivedFrom) || fact.parserDerivedFrom.length === 0) continue;
    const parents = fact.parserDerivedFrom.map(id => factsByParserId.get(id));
    const parentEventIds = new Set(parents.map(parent => parent?.eventId));
    if (parents.every(parent => parent && parent.eventId) && parentEventIds.size === 1) {
      fact.eventId = [...parentEventIds][0];
    }
  }
  return events;
}

function clinicalInjuryPhrases(evidence) {
  const text = normalizeInput(evidence || '');
  const phrases = new Set();
  for (const match of text.matchAll(/[\u4e00-\u9fff]{1,4}(?:骨折|破裂|挫伤|损伤|创口|穿透创|贯通伤|出血|脱位|撕裂|断裂)/gu)) {
    for (let start = 0; start <= match[0].length - 3; start += 1) {
      const phrase = match[0].slice(start);
      if (phrase.length >= 4 || /^(?:肺|脾|肾|肝|胰)破裂$/u.test(phrase)) phrases.add(phrase);
    }
  }
  return phrases;
}

function linkExplicitlyCausedProcedureToCurrentInjury(facts, sourceDescription) {
  const datedEvents = assignDatedEventIds(facts, sourceDescription);
  if (datedEvents.length > 1) return;
  const positive = fact => ['reported', 'observed', 'derived'].includes(fact.certainty)
    && fact.source === 'description';
  const explicitlyUnlinkedChestInjury = fact => isExplicitlyUnlinkedChestInjuryFact(fact, sourceDescription);
  for (const fact of facts) {
    if (explicitlyUnlinkedChestInjury(fact)) delete fact.eventId;
  }
  const anchors = facts.filter(fact => positive(fact)
    && ['diagnosis', 'imaging_finding', 'clinical_finding', 'injury_type', 'anatomical_site'].includes(fact.field)
    && !explicitlyUnlinkedChestInjury(fact)
    && hasExplicitCurrentInjuryEvidence(fact.evidence));
  const singleSourceEvent = hasSingleExplicitInjuryEvent(sourceDescription);
  if (!anchors.length && !singleSourceEvent) return;
  const anchorEventIds = new Set(anchors.map(fact => fact.eventId).filter(eventId => eventId && !/^U\d+$/u.test(eventId)));
  if (anchorEventIds.size > 1) return;
  const currentFacts = facts.filter(fact => positive(fact) && fact.field !== 'prior_injury'
    && !hasRetrospectiveClinicalEvidence(fact.evidence) && !explicitlyUnlinkedChestInjury(fact));
  const currentEventIds = new Set(currentFacts.map(fact => fact.eventId)
    .filter(eventId => eventId && !/^U\d+$/u.test(eventId)));
  if (currentEventIds.size > 1) return;
  const usedEventIds = new Set(facts.map(fact => fact.eventId).filter(Boolean));
  let eventId = [...anchorEventIds][0] || [...currentEventIds][0] || null;
  if (!eventId) {
    let number = 1;
    while (usedEventIds.has(`E${number}`)) number += 1;
    eventId = `E${number}`;
  }
  for (const anchor of anchors) if (!anchor.eventId) anchor.eventId = eventId;

  const datedEventRanges = parseEventDateAnchors(sourceDescription).map(anchor => anchor.range);
  const oneUnambiguousEvent = !eventDateAnchorsConflict(datedEventRanges)
    && (singleSourceEvent || anchors.length > 0);
  if (oneUnambiguousEvent) {
    for (const fact of currentFacts) if (!fact.eventId || /^U\d+$/u.test(fact.eventId)) fact.eventId = eventId;
  }

  for (const procedure of facts) {
    if (!positive(procedure) || !['treatment', 'clinical_finding'].includes(procedure.field)
      || procedure.eventId && procedure.eventId !== eventId || hasRetrospectiveClinicalEvidence(procedure.evidence)
      || explicitlyUnlinkedChestInjury(procedure)
      || !/(?:因|由于|由|导致|所致|致使)[^，,。；;]{1,30}(?:需要|需|须|接受|施行|实施|进行|行)?[^，,。；;]{0,12}(?:手术|切除|修补|摘除|固定术)/u
        .test(normalizeInput(procedure.evidence))) continue;
    const linked = anchors.some(anchor => {
      const value = normalizeInput(String(anchor.value ?? ''));
      if (value.length >= 4 && normalizeInput(procedure.evidence).includes(value)) return true;
      const anchorPhrases = clinicalInjuryPhrases(anchor.evidence);
      return [...clinicalInjuryPhrases(procedure.evidence)].some(phrase => anchorPhrases.has(phrase));
    });
    if (linked) procedure.eventId = eventId;
  }
}

function factFinding(field, value, certainty) {
  const labels = {
    anatomical_site: '解剖部位', injury_site: '受伤部位', injury_cause: '致伤机制', injury_date: '受伤时间',
    age_at_injury_years: '受伤时年龄（周岁）',
    age_at_assessment_years: '评残/鉴定时年龄（周岁）',
    injury_type: '损伤类型', laterality: '侧别', fractured_rib_numbers: '骨折肋骨序号',
    fractured_rib_count: '骨折肋骨根数', fracture_site_count: '骨折处数', symptom: '症状',
    contusion_tbsa_percent: '挫伤占体表面积比例（百分比）',
    burn_tbsa_ii_plus_percent: 'II度以上烧烫伤体表面积比例（百分比）',
    burn_tbsa_deep_ii_plus_percent: '深II度以上烧烫伤体表面积比例（百分比）',
    burn_tbsa_iii_percent: 'III度烧烫伤体表面积比例（百分比）',
    burn_area_face_first_degree_cm2: '面部I度烧烫伤面积（平方厘米）',
    burn_area_neck_first_degree_cm2: '颈部I度烧烫伤面积（平方厘米）',
    burn_area_neck_superficial_second_degree_cm2: '颈部浅II度烧烫伤面积（平方厘米）',
    burn_area_body_first_degree_cm2: '体表I度烧烫伤面积（平方厘米）',
    burn_area_body_superficial_second_degree_cm2: '体表浅II度烧烫伤面积（平方厘米）',
    scalp_defect_area_cm2: '头皮皮肤缺损面积（平方厘米）',
    skull_defect_area_cm2: '颅骨缺损面积（平方厘米）',
    organ_hematoma_diameter_cm: '肝脾实质内血肿直径（厘米）',
    scalp_avulsion_area_cm2: '头皮撕脱伤面积（平方厘米）',
    skin_avulsion_area_cm2: '皮肤撕脱伤面积（平方厘米）',
    skin_defect_area_cm2: '皮肤缺损面积（平方厘米）',
    skin_abrasion_area_cm2: '皮肤擦伤面积（平方厘米）',
    skin_contusion_area_cm2: '皮肤挫伤面积（平方厘米）',
    scalp_abrasion_area_cm2: '头皮擦伤面积（平方厘米）',
    diagnosis: '诊断', imaging_finding: '影像检查结果', treatment: '治疗情况',
    clinical_finding: '临床事实',
    gcs_score: 'GCS评分',
    orbital_enophthalmos_cm: '眼球内陷深度（厘米）',
    limb_length_difference_cm: '双侧肢体长度差（厘米）',
    bone_shortening_cm: '骨折缩短长度（厘米）',
    bone_angulation_degrees: '骨折成角度数（度）',
    joint_function_loss_percent: '具名关节功能丧失比例（百分比）',
    functional_impairment: '功能情况', prior_injury: '既往损伤',
    wound_length_cm: '创口或瘢痕长度（厘米）',
    aggregate_wound_length_cm: '多处创口累计长度（厘米）',
    facial_scar_width_cm: '面部条状瘢痕宽度（厘米）',
    aggregate_facial_scar_length_cm: '面部条状瘢痕累计长度（厘米）',
    facial_center_scar_length_cm: '面部中心区条状瘢痕长度（厘米）',
    surface_scar_area_cm2: '瘢痕单块面积（平方厘米）',
    aggregate_surface_scar_area_cm2: '瘢痕累计面积（平方厘米）',
    dental_loss_count: '牙齿缺失或折断数',
    lip_wound_length_cm: '唇部创口或瘢痕长度（厘米）',
    lip_through_wound_length_cm: '唇部贯通创相关皮肤长度（厘米）',
    cross_region_wound_ratio: '头面部跨部位创口系数和',
    ear_scalp_wound_ratio: '同一耳廓/头皮创口系数和',
    auricle_defect_ratio: '耳廓缺损面积占对侧耳面积比例',
    facial_skin_abnormality_area_cm2: '面部色素异常/沉着或细小瘢痕面积（平方厘米）',
    facial_skin_abnormality_area_percent: '面部瘢痕或色素异常占面部面积比例（百分比）',
  };
  const displayValue = Array.isArray(value) ? value.join('、') : (typeof value === 'object' ? JSON.stringify(value) : String(value ?? ''));
  const qualifier = certainty === 'uncertain' ? '（疑似/待核实）' : certainty === 'excluded' ? '（已排除）' : certainty === 'conflicted' ? '（存在冲突）' : '';
  return `${labels[field] || '其他事实'}：${displayValue}${qualifier}`.slice(0, 1000);
}

function isRibAlias(field) {
  return /rib|fractur|骨折|affected_side|laterality/i.test(field);
}

function ribSidePattern() {
  const compactRibOrdinal = '(?:第\\s*)?[0-9零〇一二两三四五六七八九十百]+(?:\\s*(?:、|，|,|[-–—至])\\s*(?:第\\s*)?[0-9零〇一二两三四五六七八九十百]+)*\\s*(?:根|条)?\\s*肋骨?';
  const ribOrdinalStart = '(?:第\\s*)?[0-9零〇一二两三四五六七八九十百]+';
  return new RegExp(`左右两侧|左右侧|双侧|两侧|左侧|左边|右侧|右边|左(?=${compactRibOrdinal})|右(?=${compactRibOrdinal})|左(?=${ribOrdinalStart})|右(?=${ribOrdinalStart})`, 'gu');
}

function sideScopeFromToken(token) {
  if (/左右|两侧|双侧/u.test(token)) return 'bilateral';
  if (/左/u.test(token)) return 'left';
  if (/右/u.test(token)) return 'right';
  return null;
}

function canonicalField(field) {
  const value = String(field || '').trim().normalize('NFKC').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  if (/^(?:left_chest_pain|subjective_complaint|complaint|pain|symptom)$/.test(value) || /(?:_pain|_symptom)$/.test(value)) return 'symptom';
  if (value === 'injury_site') return 'anatomical_site';
  if (value === 'injury_time') return 'injury_date';
  if (/^(?:affected_side|body_side)$/.test(value)) return 'laterality';
  return /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : 'other';
}

function isQuotedPhysicalExamObservation(evidence, value) {
  const text = normalizeInput(`${evidence || ''} ${value || ''}`);
  const hasPhysicalExamSource = /(?:法医(?:临床)?检查|体格检查|查体|体检记录|临床检查|康复检查)(?:结果|所见)?[：:]?\s*(?:见|记录|显示|发现|可见)?/u.test(text);
  return hasPhysicalExamSource && /瘢痕|疤痕|创口|伤口|划痕|裂创|裂伤|撕裂|肌力|感觉|活动|萎缩|肿胀|压痛/u.test(text);
}

function physicalExamEvidenceContext(sourceText, evidence) {
  const text = normalizeInput(sourceText || '');
  const quote = normalizeInput(evidence || '');
  const quoteStart = text.indexOf(quote);
  if (!quote || quoteStart < 0) return null;
  if (/(?:法医(?:临床)?检查|体格检查|查体|体检记录|临床检查|康复检查)(?:结果|所见)?[：:]?\s*(?:见|记录|显示|发现|可见)?/u.test(quote)) return quote;
  const examMarker = /(?:法医(?:临床)?检查|体格检查|查体|体检记录|临床检查|康复检查)(?:结果|所见)?[：:]?(?:见|记录|显示|发现|可见)?/gu;
  const candidates = [...text.slice(Math.max(0, quoteStart - 180), quoteStart).matchAll(examMarker)];
  const marker = candidates.at(-1);
  if (!marker) return null;
  const markerStart = Math.max(0, quoteStart - 180) + marker.index;
  const between = text.slice(markerStart + marker[0].length, quoteStart);
  if (/(?:CT|MRI|X线|X片|DR|超声|影像|阅片|片示)/iu.test(between)) return null;
  const sourceEnd = quoteStart + quote.length;
  return text.slice(markerStart, sourceEnd);
}

function normalizeExplicitInjuryDateFacts(inputText) {
  const text = normalizeInput(inputText || '');
  return parseEventDateAnchors(text)
    .filter(anchor => !hasNonCurrentClinicalContext(text, anchor.index, anchor.index + anchor.length))
    .map(anchor => {
      const [year, month, day] = anchor.key.split('-');
      const value = month === '*' ? year : day === '*' ? `${year}-${month.padStart(2, '0')}`
        : `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      return { id: `ID${anchor.index}`, field: 'injury_date', value, certainty: 'reported',
        source_type: 'user_text', source_excerpt: text.slice(anchor.index, anchor.index + anchor.length) };
    });
}

function isNonInjuryDateClaim(evidence, value) {
  const targetDate = normalizeInjuryDateValue(value);
  if (!targetDate) return false;
  const text = normalizeInput(evidence || '');
  const datePatterns = [
    /(?<year>(?:19|20)\d{2})年(?:(?<month>\d{1,2})月(?:(?<day>\d{1,2})日)?)?/gu,
    /(?<year>(?:19|20)\d{2})[-/.](?<month>\d{1,2})[-/.](?<day>\d{1,2})/gu,
  ];
  const dateMatches = datePatterns.flatMap(datePattern => [...text.matchAll(datePattern)])
    .sort((left, right) => left.index - right.index);
  for (const match of dateMatches) {
    const month = match.groups.month == null ? null : Number(match.groups.month);
    const day = match.groups.day == null ? null : Number(match.groups.day);
    const dateValue = month == null ? match.groups.year
      : day == null ? `${match.groups.year}-${String(month).padStart(2, '0')}`
        : `${match.groups.year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (dateValue !== targetDate) continue;
    if (dateRoleBefore(text, match.index) === 'clinical') return true;
    const contextStart = match.index + match[0].length;
    const sentenceEnd = [text.indexOf('。', contextStart), text.indexOf('！', contextStart),
      text.indexOf('？', contextStart), text.indexOf('；', contextStart), text.indexOf(';', contextStart),
      text.indexOf('\n', contextStart)].filter(index => index >= 0)
      .reduce((end, index) => Math.min(end, index), text.length);
    if (startsWithNonInjuryDateContext(text.slice(contextStart, sentenceEnd))) return true;
  }
  return false;
}

function stableFactKey(fact) {
  const evidence = normalizeInput(fact.evidence || '').replace(/[。！？；;，,]+$/u, '');
  return JSON.stringify([fact.field, fact.value, fact.certainty, fact.source, evidence, fact.eventId || null,
    fact.parserRibLaterality || null, fact.field === 'wound_length_cm' ? fact.parserId || null : null]);
}

function overlappingWoundMeasurement(first, second, sourceTexts) {
  if (first.field !== 'wound_length_cm' || second.field !== 'wound_length_cm'
    || first.value !== second.value
    || first.source !== second.source || (first.eventId || null) !== (second.eventId || null)) return false;
  const firstParserOffset = Number(String(first.parserId || '').match(/^WL(\d+)$/u)?.[1]);
  const secondParserOffset = Number(String(second.parserId || '').match(/^WL(\d+)$/u)?.[1]);
  if (Number.isInteger(firstParserOffset) && Number.isInteger(secondParserOffset)) {
    return firstParserOffset === secondParserOffset;
  }
  const sourceText = sourceTexts[first.source];
  if (!sourceText || !first.evidence || !second.evidence) return false;
  const evidenceStarts = evidence => {
    const starts = [];
    let index = sourceText.indexOf(evidence);
    while (index >= 0) {
      starts.push(index);
      index = sourceText.indexOf(evidence, index + 1);
    }
    return starts;
  };
  const measurementStarts = (evidence, starts) => {
    const positions = new Set();
    const pattern = /([0-9]+(?:\.[0-9]+)?|[零〇一二两三四五六七八九十百]+)\s*(mm|毫米|cm|厘米)/gu;
    for (const start of starts) {
      pattern.lastIndex = 0;
      for (const match of evidence.matchAll(pattern)) {
        const amount = /^\d+(?:\.\d+)?$/.test(match[1]) ? Number(match[1]) : parseNumber(match[1]);
        const value = /^(?:mm|毫米)$/u.test(match[2]) ? Number((amount / 10).toFixed(6)) : amount;
        if (value === first.value) positions.add(start + match.index);
      }
    }
    return positions;
  };
  const firstPositions = measurementStarts(first.evidence, evidenceStarts(first.evidence));
  const secondPositions = measurementStarts(second.evidence, evidenceStarts(second.evidence));
  return [...firstPositions].some(position => secondPositions.has(position));
}

function deduplicateOverlappingWoundMeasurements(facts, sourceTexts) {
  const unique = [];
  for (const fact of facts) {
    const index = unique.findIndex(existing => overlappingWoundMeasurement(existing, fact, sourceTexts));
    if (index < 0) {
      unique.push(fact);
      continue;
    }
    const existing = unique[index];
    const preferred = fact.evidence.length > existing.evidence.length ? fact : existing;
    unique[index] = {
      ...preferred,
      rawIds: [...new Set([...(existing.rawIds || []), ...(fact.rawIds || [])])],
      sourceRefs: mergeSourceRefs(existing.sourceRefs || [], fact.sourceRefs || []),
      ...(existing.regionEvidence || fact.regionEvidence
        ? { regionEvidence: existing.regionEvidence || fact.regionEvidence } : {}),
      ...(existing.parserId || fact.parserId ? { parserId: preferred.parserId || existing.parserId || fact.parserId } : {}),
      ...(existing.parserDerivedFrom || fact.parserDerivedFrom
        ? { parserDerivedFrom: [...new Set([...(existing.parserDerivedFrom || []), ...(fact.parserDerivedFrom || [])])] } : {}),
    };
  }
  return unique;
}

function compareFactIds(a, b) {
  return Number(a.slice(1)) - Number(b.slice(1));
}

function canonicalConflictReason(facts) {
  const fields = [...new Set(facts.map(fact => fact.field))].sort();
  if (!fields.length) return '材料存在需要复核的冲突记载。';
  const label = fields.length === 1 ? fields[0] : fields.join('、');
  return `事实字段“${label}”存在相互矛盾的来源记载，需人工复核。`;
}

function explicitLateralityDiscrepancy(text) {
  const sitePairs = [
    [/左(?:侧|边)?耳(?:廓|背|垂|屏)?/u, /右(?:侧|边)?耳(?:廓|背|垂|屏)?/u],
    [/左(?:侧)?眼(?:眶)?/u, /右(?:侧)?眼(?:眶)?/u],
    [/左(?:侧)?鼻(?:骨|部)?/u, /右(?:侧)?鼻(?:骨|部)?/u],
    [/左(?:侧|边)?(?:第\s*[0-9零〇一二两三四五六七八九十百]+\s*肋骨|肋骨)/u,
      /右(?:侧|边)?(?:第\s*[0-9零〇一二两三四五六七八九十百]+\s*肋骨|肋骨)/u],
    [/左(?:侧|边)?(?:肩|上臂|前臂|腕|手|髋|股|膝|小腿|踝|足)/u,
      /右(?:侧|边)?(?:肩|上臂|前臂|腕|手|髋|股|膝|小腿|踝|足)/u],
  ];
  return [...String(text || '').matchAll(/[^。！？\n]+/gu)].some(([sentence]) => {
    const explicitlyDisputed = /(?:侧别|左右|部位).{0,10}(?:不一致|不符|相矛盾|冲突|待核|需核实)|(?:不一致|不符|相矛盾|冲突|待核|需核实).{0,10}(?:侧别|左右|部位)/u.test(sentence);
    if (!explicitlyDisputed || /(?:无|不存在).{0,3}(?:不一致|不符|相矛盾|冲突)/u.test(sentence)) return false;
    return sitePairs.some(([left, right]) => left.test(sentence) && right.test(sentence));
  });
}

function explicitLateralityScope(evidence) {
  const sides = new Set([...String(evidence || '').matchAll(ribSidePattern())]
    .map(([token]) => sideScopeFromToken(token)).filter(Boolean));
  return sides.size === 1 ? [...sides][0] : null;
}

function onlyCrossLateralityRibCountDisagreement(facts) {
  if (facts.length < 2 || facts.some(fact => fact.field !== 'fractured_rib_count' || !Number.isFinite(fact.value))) return false;
  for (let leftIndex = 0; leftIndex < facts.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < facts.length; rightIndex += 1) {
      const left = facts[leftIndex], right = facts[rightIndex];
      if (left.value === right.value) continue;
      const leftScope = explicitLateralityScope(left.evidence);
      const rightScope = explicitLateralityScope(right.evidence);
      if (!leftScope || !rightScope || leftScope === rightScope) return false;
    }
  }
  return true;
}

function conflictingFactPair(left, right) {
  if (!left || !right || left.field !== right.field) return false;
  const sameValue = JSON.stringify(left.value) === JSON.stringify(right.value);
  const affirmative = new Set(['reported', 'observed', 'derived']);
  const differentFractureSites = ['injury_type', 'anatomical_site'].includes(left.field)
    && fracturesAtClearlyDifferentSites(left, right);
  const certaintyConflict = !differentFractureSites && sameValue && (
    affirmative.has(left.certainty) && right.certainty === 'excluded'
    || affirmative.has(right.certainty) && left.certainty === 'excluded'
    || new Set([left.certainty, right.certainty]).has('uncertain') && new Set([left.certainty, right.certainty]).has('excluded')
  );
  const fractureSpecificityConflict = !differentFractureSites && left.field === 'injury_type' && !sameValue
    && new Set([left.certainty, right.certainty]).has('uncertain')
    && new Set([left.certainty, right.certainty]).has('excluded')
    && new Set([left.value, right.value]).has('fracture')
    && new Set([left.value, right.value]).has('rib_fracture');
  const differentRibSideScope = left.field === 'fractured_rib_count'
    && explicitLateralityScope(left.evidence) && explicitLateralityScope(right.evidence)
    && explicitLateralityScope(left.evidence) !== explicitLateralityScope(right.evidence);
  const conflictingCount = ['fractured_rib_count', 'fracture_site_count'].includes(left.field)
    && !sameValue && left.evidence !== right.evidence
    && !differentRibSideScope
    && /报告|病历|复查|检查/.test(left.evidence) && /报告|病历|复查|检查/.test(right.evidence);
  return certaintyConflict || fractureSpecificityConflict || conflictingCount;
}

function normalizeBodySurfaceContusionFacts(inputText) {
  const text = normalizeInput(inputText || '');
  const facts = [];
  for (const sentence of text.matchAll(/[^。！？\n]+/gu)) {
    const clause = sentence[0];
    if (!/挫伤/u.test(clause) || /擦伤|烧伤|烫伤|瘢痕|疤痕/u.test(clause)) continue;
    const percentages = [...clause.matchAll(/(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*[%％]/gu)];
    if (percentages.length !== 1 || /(?:cm\s*2|平方厘米)/iu.test(clause)) continue;
    const measurement = percentages[0];
    const prefix = clause.slice(Math.max(0, measurement.index - 50), measurement.index);
    const contusion = prefix.lastIndexOf('挫伤');
    if (contusion < 0) continue;
    const fullContusionIndex = Math.max(0, measurement.index - 50) + contusion;
    const beforeMeasurement = clause.slice(Math.max(0, measurement.index - 30), measurement.index);
    if (/(?:\d+(?:\.\d+)?)\s*(?:-|–|—|至|到)\s*$/u.test(beforeMeasurement)) continue;
    const contextStart = Math.max(0, fullContusionIndex - 24);
    const local = clause.slice(fullContusionIndex, measurement.index + measurement[0].length);
    const certaintyContext = clause.slice(contextStart, measurement.index + measurement[0].length);
    if (!/挫伤[^，,；;]{0,24}面积/u.test(local)
      || !/(?:体表面积|TBSA)/iu.test(local)
      || /(?:未达|低于|小于|不足|不超过|少于|超过|大于|至少|以上|以下|约|大约|左右|接近|估计)/u.test(certaintyContext)) continue;
    const certainty = certaintyFor(certaintyContext, 0, certaintyContext.length);
    const value = /^\d/u.test(measurement[1]) ? Number(measurement[1]) : parseNumber(measurement[1]);
    if (!Number.isFinite(value) || value < 0 || value > 100) continue;
    facts.push({ id: `BSC${sentence.index + measurement.index}`, field: 'contusion_tbsa_percent', value,
      certainty, source_type: 'user_text', source_excerpt: clause.slice(-MAX_FACT_EVIDENCE_CHARS) });
  }
  return facts;
}

function normalizeBurnTbsaFacts(inputText) {
  const text = normalizeInput(inputText || '');
  const facts = [];
  for (const sentence of text.matchAll(/[^。！？\n]+/gu)) {
    const clause = sentence[0];
    const measurements = [...clause.matchAll(/(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*[%％]/gu)];
    const degrees = [...clause.matchAll(/(深\s*)?(III|Ⅲ|三|II|Ⅱ|二)\s*(?:度|o|°)(?:以上|及以上)?/giu)];
    if (measurements.length !== 1 || degrees.length !== 1 || !/烧(?:烫)?伤|烫伤/u.test(clause)
      || !/(?:体表面积|TBSA)/iu.test(clause) || !/面积/u.test(clause)) continue;
    const measurement = measurements[0];
    const degree = degrees[0];
    const degreeText = normalizeInput(degree[2]).toUpperCase();
    const isThirdDegree = degreeText === 'III' || degreeText === '三';
    const isSecondDegree = degreeText === 'II' || degreeText === '二';
    const surfaceCue = Math.max(clause.lastIndexOf('体表面积', measurement.index), clause.lastIndexOf('TBSA', measurement.index));
    if ((!isThirdDegree && !isSecondDegree) || surfaceCue < 0 || degree.index > surfaceCue
      || measurement.index - surfaceCue > 24) continue;
    const nearMeasurement = clause.slice(Math.max(0, measurement.index - 28), measurement.index);
    if (/(?:约|大约|左右|接近|估计|未达|低于|小于|不足|不超过|少于|超过|大于|至少)/u.test(nearMeasurement)
      || /(?:\d+(?:\.\d+)?)\s*(?:-|–|—|至|到)\s*$/u.test(nearMeasurement)) continue;
    const contextStart = Math.max(0, degree.index - 24);
    const certainty = certaintyFor(clause.slice(contextStart, measurement.index + measurement[0].length), 0,
      measurement.index + measurement[0].length - contextStart);
    const value = /^\d/u.test(measurement[1]) ? Number(measurement[1]) : parseNumber(measurement[1]);
    if (!Number.isFinite(value) || value < 0 || value > 100) continue;
    const fields = isThirdDegree
      ? ['burn_tbsa_iii_percent']
      : degree[1] ? ['burn_tbsa_deep_ii_plus_percent', 'burn_tbsa_ii_plus_percent'] : ['burn_tbsa_ii_plus_percent'];
    for (const field of fields) facts.push({ id: `BURN${sentence.index + measurement.index}_${field}`, field, value,
      certainty, source_type: 'user_text', source_excerpt: clause.slice(-MAX_FACT_EVIDENCE_CHARS) });
  }
  return facts;
}

function normalizeLocalBurnAreaFacts(inputText) {
  const text = normalizeInput(inputText || '');
  const facts = [];
  const number = '(\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百]+)';
  const fields = [
    { field: 'burn_area_face_first_degree_cm2', site: /面部|脸部|颜面/u, degree: /(?:(?<!I)I(?!I)|Ⅰ|一)\s*(?:度|o|°)(?!以上|及以上)/iu },
    { field: 'burn_area_neck_first_degree_cm2', site: /颈部/u, degree: /(?:(?<!I)I(?!I)|Ⅰ|一)\s*(?:度|o|°)(?!以上|及以上)/iu },
    { field: 'burn_area_neck_superficial_second_degree_cm2', site: /颈部/u, degree: /浅\s*(?:II|Ⅱ|二)\s*(?:度|o|°)(?!以上|及以上)/iu },
    { field: 'burn_area_body_first_degree_cm2', site: /体表|身体/u, degree: /(?:(?<!I)I(?!I)|Ⅰ|一)\s*(?:度|o|°)(?!以上|及以上)/iu },
    { field: 'burn_area_body_superficial_second_degree_cm2', site: /体表|身体/u, degree: /浅\s*(?:II|Ⅱ|二)\s*(?:度|o|°)(?!以上|及以上)/iu },
  ];
  for (const sentence of text.matchAll(/[^。！？\n]+/gu)) {
    const clause = sentence[0];
    const measurements = [...clause.matchAll(new RegExp(`${number}\\s*(?:cm\\s*2|平方厘米)`, 'giu'))];
    const degrees = [...clause.matchAll(/浅\s*(?:II|Ⅱ|二)\s*(?:度|o|°)(?!以上|及以上)|(?:(?<!I)I(?!I)|Ⅰ|一)\s*(?:度|o|°)(?!以上|及以上)/giu)];
    const sites = [...clause.matchAll(/面部|脸部|颜面|颈部|体表|身体/gu)];
    if (measurements.length !== 1 || degrees.length !== 1 || sites.length !== 1
      || !/烧(?:烫)?伤|烫伤/u.test(clause)
      || /(?:未达|低于|小于|不足|不超过|少于|超过|大于|至少|约|大约|左右|接近|估计|可疑|疑似|考虑|可能|待排|不排除|未见|未发现|否认|排除|无)/u.test(clause)
      || /(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:-|–|—|至|到)\s*$/u
        .test(clause.slice(0, measurements[0].index))) continue;
    const measurement = measurements[0];
    const value = /^\d/u.test(measurement[1]) ? Number(measurement[1]) : parseNumber(measurement[1]);
    if (!Number.isFinite(value) || value < 0) continue;
    const matched = fields.find(item => item.site.test(clause) && item.degree.test(clause));
    if (!matched) continue;
    facts.push({ id: `BURNAREA${sentence.index + measurement.index}`, field: matched.field, value,
      certainty: certaintyFor(clause, 0, clause.length), source_type: 'user_text', source_excerpt: clause.slice(-MAX_FACT_EVIDENCE_CHARS) });
  }
  return facts;
}

function normalizeScalpSurfaceAreaFacts(inputText) {
  const text = normalizeInput(inputText || '');
  const facts = [];
  const amount = '(\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百]+)';
  for (const sentence of text.matchAll(/[^。！？\n]+/gu)) {
    const clause = sentence[0];
    const measurements = [...clause.matchAll(new RegExp(`${amount}\\s*(?:cm\\s*2|平方厘米)`, 'giu'))];
    const sitePattern = /头皮|头顶部|额顶部|颞顶部|颞枕部|顶枕部|枕顶部|枕部/gu;
    const sites = [...clause.matchAll(sitePattern)];
    const hasDefect = /缺损/u.test(clause);
    const hasAvulsion = /撕脱(?:伤|创)?/u.test(clause);
    if (measurements.length !== 1 || sites.length !== 1 || hasDefect === hasAvulsion || !/面积/u.test(clause)
      || /(?:约|大约|左右|接近|估计|可疑|疑似|考虑|可能|待排|不排除|未达|低于|小于|不足|不超过|少于|超过|大于|至少|未见|未发现|否认|排除|无|既往|陈旧|术前|术后|手术切口|供皮区|植皮|移植|切除)/u.test(clause)
      || new RegExp(`(?:${amount})\\s*(?:-|–|—|至|到)\\s*$`, 'u')
        .test(clause.slice(0, measurements[0].index))) continue;
    const measurement = measurements[0];
    const value = /^\d/u.test(measurement[1]) ? Number(measurement[1]) : parseNumber(measurement[1]);
    if (!Number.isFinite(value) || value < 0) continue;
    facts.push({ id: `SSA${sentence.index + measurement.index}`,
      field: hasDefect ? 'scalp_defect_area_cm2' : 'scalp_avulsion_area_cm2', value,
      certainty: certaintyFor(clause, 0, clause.length), source_type: 'user_text', source_excerpt: clause.slice(-MAX_FACT_EVIDENCE_CHARS) });
  }
  return facts;
}

function normalizeSkinSurfaceAreaFacts(inputText) {
  const text = normalizeInput(inputText || '');
  const facts = [];
  const amount = '(\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百]+)';
  const descriptors = [
    { field: 'skull_defect_area_cm2', pattern: /颅骨缺损/u },
    { field: 'skin_avulsion_area_cm2', pattern: /撕脱(?:伤|创)?/u },
    { field: 'skin_defect_area_cm2', pattern: /(?:皮肤(?:组织)?|头皮)缺损/u },
    { field: 'skin_abrasion_area_cm2', pattern: /擦伤/u },
    { field: 'skin_contusion_area_cm2', pattern: /挫伤/u },
  ];
  const excludedContext = /(?:约|大约|左右|接近|估计|可疑|疑似|考虑|可能|待排|不排除|未达|低于|小于|不足|不超过|少于|超过|大于|至少|未见|未发现|否认|排除|无|既往|陈旧|术前|术后|手术切口|供皮区|植皮|移植|切除)/u;
  for (const sentence of text.matchAll(/[^。！？\n]+/gu)) {
    const segments = sentence[0].split(/[，,；;]|或者|或/u).map(value => value.trim()).filter(Boolean);
    for (const [segmentIndex, clause] of segments.entries()) {
      const measurements = [...clause.matchAll(new RegExp(`${amount}\\s*(?:cm\\s*2|平方厘米)`, 'giu'))];
      const matches = descriptors.filter(item => item.pattern.test(clause));
      if (measurements.length !== 1 || matches.length !== 1 || !/面积/u.test(clause)
        || excludedContext.test(clause)
        || new RegExp(`(?:${amount})\\s*(?:-|–|—|至|到)\\s*$`, 'u')
          .test(clause.slice(0, measurements[0].index))) continue;
      const descriptor = matches[0];
      if (descriptor.field === 'skin_defect_area_cm2' && !/(?:皮肤(?:组织)?|头皮)缺损/u.test(clause)) continue;
      const measurement = measurements[0];
      const value = /^\d/u.test(measurement[1]) ? Number(measurement[1]) : parseNumber(measurement[1]);
      if (!Number.isFinite(value) || value < 0) continue;
      const parserIndex = sentence.index + segmentIndex;
      const excerpt = clause.slice(-MAX_FACT_EVIDENCE_CHARS);
      facts.push({ id: `SKINAREA${parserIndex}`, field: descriptor.field, value,
        certainty: certaintyFor(clause, 0, clause.length), source_type: 'user_text', source_excerpt: excerpt });
      if (descriptor.field === 'skin_abrasion_area_cm2'
        && /(?:头皮|头顶部|额顶部|颞顶部|颞枕部|顶枕部|枕顶部|枕部)/u.test(clause)) {
        facts.push({ id: `SCALPABRASION${parserIndex}`, field: 'scalp_abrasion_area_cm2', value,
          certainty: certaintyFor(clause, 0, clause.length), source_type: 'user_text', source_excerpt: excerpt });
      }
    }
  }
  return facts;
}

function normalizeOrganHematomaDiameterFacts(inputText) {
  const text = normalizeInput(inputText || '');
  const facts = [];
  const amount = '(\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百]+)';
  const measurementPattern = new RegExp(`${amount}\\s*(cm|厘米|mm|毫米)`, 'giu');
  const excludedContext = /(?:约|大约|左右|接近|估计|可疑|疑似|考虑|可能|待排|不排除|未达|低于|小于|不足|不超过|少于|超过|大于|至少|未见|未发现|否认|排除|无|既往|陈旧|术前|术后)/u;
  for (const sentence of text.matchAll(/[^。！？\n]+/gu)) {
    for (const [segmentIndex, clause] of sentence[0].split(/[，,；;]|或者|或/u).map(value => value.trim()).filter(Boolean).entries()) {
      const measurements = [...clause.matchAll(measurementPattern)];
      const organs = [...clause.matchAll(/肝(?:脏)?|脾(?:脏)?/gu)];
      if (measurements.length !== 1 || organs.length !== 1 || excludedContext.test(clause)
        || !/(?:肝(?:脏)?|脾(?:脏)?)实质(?:内)?血肿/u.test(clause)
        || !/血肿[^，,；;]{0,8}直径/u.test(clause)
        || !/直径[^，,；;]{0,8}(?:\d|[零〇一二两三四五六七八九十百])/u.test(clause)) continue;
      const measurement = measurements[0];
      if (!new RegExp(`直径[^，,；;]{0,8}${amount}\\s*(?:cm|厘米|mm|毫米)`, 'iu').test(clause)) continue;
      if (new RegExp(`(?:${amount})\\s*(?:-|–|—|至|到)\\s*$`, 'u')
        .test(clause.slice(0, measurement.index))) continue;
      const parsed = /^\d/u.test(measurement[1]) ? Number(measurement[1]) : parseNumber(measurement[1]);
      const value = /^(?:mm|毫米)$/iu.test(measurement[2]) ? parsed / 10 : parsed;
      if (!Number.isFinite(value) || value < 0) continue;
      facts.push({ id: `HEMATOMADIAMETER${sentence.index + segmentIndex}`, field: 'organ_hematoma_diameter_cm', value,
        certainty: certaintyFor(clause, 0, clause.length), source_type: 'user_text', source_excerpt: clause.slice(-MAX_FACT_EVIDENCE_CHARS) });
    }
  }
  return facts;
}

function normalizeExtractedFacts(value, { description = '', recognizedText = '' } = {}) {
  const parsed = factExtractionSchema.parse(normalizeFactExtractionResponse(value));
  const rawFactIds = new Set(parsed.facts.map(fact => fact.id).filter(Boolean));
  let invalidModelConflict = parsed.conflicts.some(conflict => {
    const ids = [...new Set(conflict.factIds)];
    return ids.length > 0 && ids.length < 2 || ids.some(id => !rawFactIds.has(id));
  });
  const unlinkedConflictWarnings = parsed.conflicts.filter(conflict => conflict.factIds.length === 0
    && typeof conflict.reason === 'string' && conflict.reason.trim()).map(conflict => normalizeInput(conflict.reason).slice(0, 1000));
  const raw = {
    ...parsed,
    conflicts: parsed.conflicts.filter(conflict => {
      const ids = [...new Set(conflict.factIds)];
      return ids.length >= 2 && ids.every(id => rawFactIds.has(id));
    }),
  };
  // IDs are optional in model output, but every audit entry needs an ID and
  // a traceable mapping. Validate model conflict references before generating
  // IDs so a guessed reference cannot become valid through this assignment.
  let nextRawFactNumber = 1;
  for (const fact of raw.facts) {
    if (fact.id) continue;
    while (rawFactIds.has(`raw-${nextRawFactNumber}`)) nextRawFactNumber += 1;
    fact.id = `raw-${nextRawFactNumber++}`;
    rawFactIds.add(fact.id);
  }
  const sourceTexts = { description: normalizeInput(description), image: normalizeInput(recognizedText) };
  const eyeContentEviscerationNeedsReview = Object.values(sourceTexts).some(hasUnverifiedEyeContentEvisceration);
  const facts = [];
  const factsByKey = new Map();
  let invalidEvidence = false;
  let confoundedGcsMeasurement = false;
  let invalidInjuryType = false;
  let invalidSymptomFact = false;
  let unresolvedOtherSubjectFact = false;
  let invalidClinicalTemporalContext = false;
  let invalidEventLink = false;
  let unsupportedSiteCount = false;
  let factCountExceeded = false;
  let openSkullDuralReviewIssue = false;
  const ribFields = new Set(['injury_type', 'anatomical_site', 'laterality', 'fractured_rib_numbers', 'fractured_rib_count', 'fracture_site_count']);
  const usedEventIds = new Set(raw.facts.map(fact => fact.eventId).filter(Boolean));
  const descriptionRibEventIds = new Set(raw.facts.filter(fact => fact.source === 'description'
    && (isRibAlias(fact.field) || /肋骨|rib/i.test(`${fact.value} ${fact.evidence}`)))
    .map(fact => fact.eventId).filter(Boolean));
  let inferredDescriptionEventId = null;
  if (hasSingleExplicitCurrentRibEvent(sourceTexts.description)) {
    if (descriptionRibEventIds.size === 1) inferredDescriptionEventId = [...descriptionRibEventIds][0];
    else {
      let nextEventNumber = 1;
      while (usedEventIds.has(`E${nextEventNumber}`)) nextEventNumber += 1;
      inferredDescriptionEventId = `E${nextEventNumber}`;
    }
  }
  if (inferredDescriptionEventId) usedEventIds.add(inferredDescriptionEventId);
  const inferredEventIds = { description: inferredDescriptionEventId };
  const ribEventAnchorsById = new Map();
  for (const fact of raw.facts) {
    const evidence = normalizeInput(fact.evidence || '');
    const hasQuotedRibInjury = fact.source === 'description' && evidence
      && sourceTexts.description.includes(evidence)
      && normalizeRibFacts(evidence).some(item => item.field === 'injury_type' && item.value === 'rib_fracture');
    if (!hasQuotedRibInjury || !fact.eventId
      || !(isRibAlias(fact.field) || /肋骨|rib/i.test(`${fact.value} ${evidence}`))) continue;
    const anchors = eventDateAnchors(sourceTexts.description, fact.evidence);
    if (!anchors.length) continue;
    const existing = ribEventAnchorsById.get(fact.eventId) || new Set();
    anchors.forEach(anchor => existing.add(anchor));
    ribEventAnchorsById.set(fact.eventId, existing);
  }
  const conflictingRibEventIds = new Set([...ribEventAnchorsById]
    .filter(([, anchors]) => eventDateAnchorsConflict([...anchors])).map(([eventId]) => eventId));
  if (conflictingRibEventIds.size) invalidEventLink = true;
  const addFact = (fact, rawId = null) => {
    const key = stableFactKey(fact);
    const existing = factsByKey.get(key);
    const target = existing || fact;
    if (!existing) {
      facts.push(target);
      factsByKey.set(key, target);
    }
    target.sourceRefs = mergeSourceRefs(target.sourceRefs || [], fact.sourceRefs || []);
    if (!target.verification && typeof target.source === 'string' && typeof target.evidence === 'string'
      && target.sourceRefs.some(reference => reference.source === target.source
        && normalizeInput(reference.evidence).includes(normalizeInput(target.evidence)))) {
      target.verification = 'quoted';
    }
    if (rawId) {
      target.rawIds ||= [];
      target.rawIds.push(rawId);
    }
    return target;
  };
  const updateEventId = (fact, eventId) => {
    const previousKey = stableFactKey(fact);
    if (factsByKey.get(previousKey) === fact) factsByKey.delete(previousKey);
    fact.eventId = eventId;
    const nextKey = stableFactKey(fact);
    if (!factsByKey.has(nextKey)) factsByKey.set(nextKey, fact);
  };
  const mapRawIdToRelatedRibFacts = (rawId, source, evidence, certainty, eventId = null) => {
    if (!rawId && !eventId) return false;
    const targetClause = sourceClause(sourceTexts[source], evidence) || evidence;
    const related = facts.filter(item => item.source === source && item.certainty === certainty
      && (item.evidence === evidence || (sourceClause(sourceTexts[source], item.evidence) || item.evidence) === targetClause)
      && ribFields.has(item.field));
    if (!related.length || related.some(fact => fact.eventId && fact.eventId !== eventId
      || !eventId && fact.eventId)) {
      if (related.length) invalidEventLink = true;
      return false;
    }
    for (const fact of related) {
      if (eventId && fact.eventId !== eventId) updateEventId(fact, eventId);
      fact.rawIds ||= [];
      if (rawId && !fact.rawIds.includes(rawId)) fact.rawIds.push(rawId);
    }
    return true;
  };

  const deterministicFacts = [];
  const excludedDeterministicFacts = [];
  for (const [source, sourceText] of Object.entries(sourceTexts)) {
    if (source === 'description' && hasOpenSkullDuralReviewIssue(sourceText)) openSkullDuralReviewIssue = true;
    const explicitInjuryDates = normalizeExplicitInjuryDateFacts(sourceText);
    for (const fact of explicitInjuryDates) {
      deterministicFacts.push({ parserId: fact.id, field: fact.field, value: fact.value, certainty: fact.certainty,
        source, evidence: fact.source_excerpt, sourceRefs: sourceRefsForFact(source, fact.source_excerpt, sourceText) });
    }
    const ribFacts = normalizeRibFacts(sourceText);
    const woundLengthFacts = normalizeWoundLengthFacts(sourceText);
    const hairlineWoundSegmentFacts = normalizeHairlineWoundSegmentFacts(sourceText, woundLengthFacts);
    const ratioLengthFacts = [...woundLengthFacts, ...hairlineWoundSegmentFacts];
    const modelStrengthPositions = new Set();
    for (const sourceFact of raw.facts) {
      if (sourceFact.source !== source || canonicalField(sourceFact.field) !== 'clinical_finding'
        || typeof sourceFact.value !== 'string') continue;
      const quote = normalizeInput(sourceFact.evidence);
      const quoteStart = sourceText.indexOf(quote);
      const value = normalizeInput(sourceFact.value);
      if (quoteStart < 0 || !value) continue;
      let valueStart = sourceText.indexOf(value, quoteStart);
      while (valueStart >= 0 && valueStart < quoteStart + quote.length) {
        if (!modelStrengthPositions.has(valueStart)) {
          modelStrengthPositions.add(valueStart);
          break;
        }
        valueStart = sourceText.indexOf(value, valueStart + 1);
      }
    }
    const missingMuscleStrengthFacts = normalizeMuscleStrengthFacts(sourceText)
      .filter(fact => !modelStrengthPositions.has(fact.source_position));
    if (ribFacts.truncated) factCountExceeded = true;
    for (const fact of [...ribFacts, ...normalizeGenericNegativeFractureFacts(sourceText),
      ...normalizeReportedSkullFractureDiagnosisFacts(sourceText),
      ...normalizeVertebralFractureDiagnosisFacts(sourceText),
      ...normalizeNasalSeptumCombinationFacts(sourceText),
      ...normalizeNasalFrontalProcessCombinationFacts(sourceText),
      ...normalizeBodySurfaceContusionFacts(sourceText),
      ...normalizeBurnTbsaFacts(sourceText),
      ...normalizeLocalBurnAreaFacts(sourceText),
      ...normalizeScalpSurfaceAreaFacts(sourceText),
      ...normalizeSkinSurfaceAreaFacts(sourceText),
      ...normalizeOrganHematomaDiameterFacts(sourceText),
      ...normalizeCheekPenetratingWoundFacts(sourceText),
      ...normalizeSharedSuffixBoneFractureFacts(sourceText),
      ...normalizeBrainCompressionEvidenceFacts(sourceText),
      ...normalizeCardiacRuptureFacts(sourceText), ...normalizeClinicalFindingFacts(sourceText),
      ...normalizeSkinScratchClinicalFacts(sourceText),
      ...normalizeGcsScoreFacts(sourceText),
      ...normalizeLungLacerationFacts(sourceText), ...normalizeBowelBladderIncontinenceFacts(sourceText),
      ...normalizeCraniotomyProcedureFacts(sourceText),
      ...normalizeGastrointestinalNonFullThicknessRuptureFacts(sourceText),
      ...normalizeGastrointestinalFullThicknessRuptureFacts(sourceText),
      ...normalizeOpenSkullDuralRuptureFacts(sourceText),
      ...normalizeNeckAsphyxiaFacts(sourceText), ...missingMuscleStrengthFacts,
      ...(source === 'description' ? normalizeImplantedProsthesisDamageFacts(sourceText) : []),
      ...normalizeOrbitalWallFractureFacts(sourceText),
      ...normalizeOrbitalWallEnophthalmosFacts(sourceText),
      ...normalizeLimbLengthDifferenceFacts(sourceText),
      ...woundLengthFacts, ...normalizeScalpWoundAggregateFacts(sourceText, ratioLengthFacts),
      ...normalizeFacialWoundAggregateFacts(sourceText, ratioLengthFacts),
      ...normalizeAuricleWoundAggregateFacts(sourceText, woundLengthFacts),
      ...normalizeAggregateWoundLengthFacts(sourceText),
      ...normalizeBilateralIncisorLossFacts(sourceText),
      ...normalizeLipWoundLengthFacts(sourceText),
      ...normalizeLipThroughWoundFacts(sourceText),
      ...hairlineWoundSegmentFacts, ...normalizeCrossRegionWoundRatioFacts(sourceText, ratioLengthFacts),
      ...normalizeEarScalpWoundRatioFacts(sourceText),
      ...normalizeAuricleDefectRatioFacts(sourceText),
      ...normalizeFacialSkinAbnormalityAreaFacts(sourceText),
      ...normalizeSurfaceScarAreaFacts(sourceText)]) {
      if (['clinical_finding', 'contusion_tbsa_percent', 'diagnosis', 'injury_type', 'imaging_finding', 'symptom', 'functional_impairment',
        'treatment', 'anatomical_site', 'laterality', 'injury_cause', 'orbital_wall_enophthalmos',
        'orbital_enophthalmos_cm', 'limb_length_difference_cm'].includes(fact.field)
        || fact.field.startsWith('burn_tbsa_') || fact.field.startsWith('burn_area_')
        || fact.field.startsWith('scalp_')
        || fact.field === 'surface_scar_area_cm2'
        || fact.field === 'aggregate_surface_scar_area_cm2') {
        if (factIsOutsideAssessmentScope(sourceText, fact.source_excerpt, String(fact.value ?? ''))) {
          excludedDeterministicFacts.push({ parserId: fact.id || `P${excludedDeterministicFacts.length + 1}`,
            field: fact.field, value: fact.value, certainty: fact.certainty, source,
            evidence: String(fact.source_excerpt || '').slice(0, MAX_FACT_EVIDENCE_CHARS),
            sourceRefs: sourceRefsForFact(source, fact.source_excerpt, sourceText).slice(0, 200)
              .map(reference => ({ ...reference, evidence: reference.evidence.slice(0, MAX_FACT_EVIDENCE_CHARS) })) });
          continue;
        }
      }
      const excerpt = fact.field === 'clinical_finding' || fact.field === 'gcs_score' || fact.field === 'wound_length_cm'
        || fact.id?.startsWith('BF')
        || fact.field === 'distinct_orbital_wall_fracture_count'
        || fact.field === 'orbital_wall_enophthalmos'
        || fact.field === 'orbital_enophthalmos_cm'
        || fact.field === 'limb_length_difference_cm'
        || fact.field === 'facial_skin_abnormality_area_percent'
        || fact.field === 'aggregate_wound_length_cm'
        || fact.field === 'dental_loss_count'
        || fact.field === 'cross_region_wound_ratio'
        || fact.field === 'ear_scalp_wound_ratio'
        || fact.field === 'auricle_defect_ratio'
        || fact.field === 'lip_wound_length_cm'
        || fact.field === 'lip_through_wound_length_cm'
        || fact.field === 'facial_skin_abnormality_area_cm2'
        || fact.field === 'facial_skin_abnormality_area_percent'
        || fact.field === 'surface_scar_area_cm2'
        || fact.field === 'aggregate_surface_scar_area_cm2'
        || fact.field.startsWith('scalp_')
        || fact.field === 'prior_injury' && fact.source_excerpt.includes('\n')
        ? fact.source_excerpt
        : sourceClause(sourceText, fact.source_excerpt) || fact.source_excerpt;
      deterministicFacts.push({
        ...(fact.id ? { parserId: fact.id } : {}), field: fact.field, value: stableJson(fact.value),
        certainty: fact.certainty, source, evidence: excerpt, sourceRefs: sourceRefsForFact(source, excerpt, sourceText),
        ...(fact.regionEvidence ? { regionEvidence: fact.regionEvidence } : {}),
        ...(fact.aggregateRegion ? { aggregateRegion: fact.aggregateRegion } : {}),
        ...(fact.sharedFracturePredicate ? { sharedFracturePredicate: true } : {}),
        ...(fact.parserRibLaterality ? { parserRibLaterality: fact.parserRibLaterality } : {}),
        ...(fact.derived_from?.length ? {
          sourceRefs: fact.derived_from.flatMap(id => woundLengthFacts.filter(parent => parent.id === id)
            .flatMap(parent => sourceRefsForFact(source, parent.source_excerpt, sourceText))) } : {}),
        ...(fact.source_type === 'derived' && fact.derived_from ? { parserDerivedFrom: fact.derived_from } : {}),
      });
    }
  }
  const sameClauseBodySurfaceEventId = fact => {
    if (fact.field !== 'contusion_tbsa_percent' && !fact.field.startsWith('burn_tbsa_')
      && !fact.field.startsWith('burn_area_') && !fact.field.startsWith('scalp_')
      && !fact.field.startsWith('skin_')
      && !['wound_length_cm', 'aggregate_wound_length_cm'].includes(fact.field)
      && !['surface_scar_area_cm2', 'aggregate_surface_scar_area_cm2'].includes(fact.field)
      && fact.field !== 'facial_skin_abnormality_area_percent'
      || fact.source !== 'description' || fact.eventId) return null;
    const contextFor = text => fact.field.startsWith('burn_area_') || fact.field.startsWith('scalp_')
      || fact.field.startsWith('skin_')
      || ['wound_length_cm', 'aggregate_wound_length_cm', 'surface_scar_area_cm2',
        'aggregate_surface_scar_area_cm2'].includes(fact.field)
      ? sourceSentence(sourceTexts.description, text) : sourceClause(sourceTexts.description, text);
    const factClause = contextFor(fact.evidence) || fact.evidence;
    if ((fact.field.startsWith('skin_') || ['wound_length_cm', 'aggregate_wound_length_cm',
      'surface_scar_area_cm2', 'aggregate_surface_scar_area_cm2'].includes(fact.field))
      && !hasSingleExplicitInjuryEvent(factClause)) return null;
    const eventIds = new Set(raw.facts.filter(modelFact => modelFact.source === 'description' && modelFact.eventId
      && ['age_at_injury_years', 'injury_date'].includes(canonicalField(modelFact.field))
      && (contextFor(modelFact.evidence) || normalizeInput(modelFact.evidence)) === factClause)
      .map(modelFact => modelFact.eventId));
    if (eventIds.size === 1) return [...eventIds][0];
    if (eventIds.size > 1 || !hasSingleExplicitInjuryEvent(sourceTexts.description)) return null;
    const sourceEventIds = new Set(raw.facts.filter(modelFact => modelFact.source === 'description' && modelFact.eventId
      && ['age_at_injury_years', 'injury_date'].includes(canonicalField(modelFact.field))
      && sourceTexts.description.includes(normalizeInput(modelFact.evidence)))
      .map(modelFact => modelFact.eventId));
    return sourceEventIds.size === 1 ? [...sourceEventIds][0] : null;
  };
  for (const fact of deterministicFacts) {
    const explicitlyLinkedEquivalentFinding = fact.field === 'clinical_finding'
      && raw.facts.some(modelFact => {
        if (modelFact.source !== fact.source || canonicalField(modelFact.field) !== 'clinical_finding' || !modelFact.eventId) {
          return false;
        }
        const modelValue = normalizeInput(stableJson(modelFact.value));
        const factValue = normalizeInput(stableJson(fact.value));
        const modelEvidence = normalizeInput(modelFact.evidence || '');
        const factEvidence = normalizeInput(fact.evidence || '');
        const sourceEvidence = sourceTexts[modelFact.source] || '';
        return modelValue && factValue && modelEvidence && factEvidence && sourceEvidence.includes(modelEvidence)
          && (modelValue.includes(factValue) || factValue.includes(modelValue))
          && modelEvidence.includes(factEvidence);
      });
    if (explicitlyLinkedEquivalentFinding) continue;
    let evidence = fact.field === 'clinical_finding' || fact.field === 'wound_length_cm'
      || fact.field === 'distinct_orbital_wall_fracture_count'
      || fact.field === 'orbital_wall_enophthalmos'
      || fact.field === 'orbital_enophthalmos_cm'
      || fact.field === 'limb_length_difference_cm'
      || fact.field === 'aggregate_wound_length_cm'
      || fact.field === 'dental_loss_count'
      || fact.field === 'cross_region_wound_ratio'
      || fact.field === 'ear_scalp_wound_ratio'
      || fact.field === 'auricle_defect_ratio'
      || fact.field === 'lip_wound_length_cm'
      || fact.field === 'lip_through_wound_length_cm'
      || fact.field === 'facial_skin_abnormality_area_cm2'
      || fact.field === 'facial_skin_abnormality_area_percent'
      || fact.field === 'prior_injury' && fact.evidence.includes('\n')
      ? fact.evidence
      : sourceClause(sourceTexts[fact.source], fact.evidence) || fact.evidence;
    const derivedParents = (fact.parserDerivedFrom || []).map(id => deterministicFacts.find(item => item.parserId === id))
      .filter(Boolean);
    if (!evidence && derivedParents.length) evidence = derivedParents
      .map(parent => sourceClause(sourceTexts[parent.source], parent.evidence) || parent.evidence).join('；');
    const inheritedSourceRefs = derivedParents.flatMap(parent => parent.sourceRefs || []);
    const factSourceRefs = fact.field === 'lip_through_wound_length_cm'
      ? mergeSourceRefs([], inheritedSourceRefs)
      : mergeSourceRefs(sourceRefsForFact(fact.source, evidence, sourceTexts[fact.source]), inheritedSourceRefs);
    const bodySurfaceEventId = sameClauseBodySurfaceEventId(fact);
    addFact({ ...fact, ...(ribFields.has(fact.field) && inferredEventIds[fact.source]
      ? { eventId: inferredEventIds[fact.source] } : {}), ...(bodySurfaceEventId ? { eventId: bodySurfaceEventId } : {}), evidence,
    sourceRefs: factSourceRefs,
      finding: factFinding(fact.field, fact.value, fact.certainty) });
  }

  for (const sourceFact of raw.facts) {
    const providedEvidence = normalizeInput(sourceFact.evidence);
    const providedSource = sourceFact.source;
    if (sourceFact.value == null) continue;
    const source = sourceTexts[providedSource].includes(providedEvidence) ? providedSource
      : sourceTexts.description.includes(providedEvidence) ? 'description'
        : sourceTexts.image.includes(providedEvidence) ? 'image' : null;
    if (!source || !providedEvidence) { invalidEvidence = true; continue; }
    let fullEvidence = sourceFact.field === 'fracture_site_count' ? providedEvidence
      : sourceClause(sourceTexts[source], providedEvidence) || providedEvidence;
    let field = canonicalField(sourceFact.field);
    let value = stableJson(sourceFact.value);
    let treatmentEvidenceReanchored = false;
    if (field === 'treatment' && typeof value === 'string'
      && !normalizeInput(fullEvidence).includes(normalizeInput(value))) {
      const sourceEvidence = uniqueSourceClauseForExactValue(sourceTexts[source], value);
      if (sourceEvidence === null) { invalidEvidence = true; continue; }
      if (typeof sourceEvidence === 'string') {
        fullEvidence = sourceEvidence;
        treatmentEvidenceReanchored = true;
      }
    }
    if (['clinical_finding', 'contusion_tbsa_percent', 'diagnosis', 'injury_type', 'imaging_finding', 'symptom', 'functional_impairment',
      'treatment', 'anatomical_site', 'laterality', 'injury_cause', 'facial_skin_abnormality_area_percent'].includes(field)
      || field.startsWith('burn_tbsa_')
      || field === 'surface_scar_area_cm2' || field === 'aggregate_surface_scar_area_cm2') {
      if (factIsOutsideAssessmentScope(sourceTexts[source], providedEvidence, String(value ?? ''))) continue;
    }
    if (['injury_date', 'prior_injury', 'other'].includes(field) && isNonInjuryDateClaim(fullEvidence, value)) continue;
    const matchingInjuryDate = deterministicFacts.find(fact => fact.source === source && fact.field === 'injury_date'
      && normalizeInput(fullEvidence).includes(normalizeInput(fact.evidence)));
    const valueMatchesInjuryDate = matchingInjuryDate && normalizeInjuryDateValue(value) === matchingInjuryDate.value;
    if (valueMatchesInjuryDate && ['injury_date', 'prior_injury', 'other'].includes(field)) continue;
    if (field === 'imaging_finding') {
      const physicalExamContext = physicalExamEvidenceContext(sourceTexts[source], fullEvidence);
      if (physicalExamContext && isQuotedPhysicalExamObservation(physicalExamContext, value)) {
        fullEvidence = physicalExamContext;
        field = 'clinical_finding';
        if (typeof value === 'string' && !normalizeInput(fullEvidence).includes(normalizeInput(value))) {
          value = fullEvidence;
        }
      }
    }
    if (field === 'imaging_finding' && typeof value === 'string'
      && !normalizeInput(fullEvidence).includes(normalizeInput(value))
      && !diagnosisEvidenceSupportsValue(value, fullEvidence)) {
      invalidEvidence = true;
      continue;
    }
    if (field === 'injury_date') value = normalizeInjuryDateValue(value);
    const scopedCertaintyEvidence = certaintyEvidenceForFact(field, value, fullEvidence);
    let certainty = canonicalCertainty(scopedCertaintyEvidence, sourceFact.certainty);
    if (field === 'gcs_score' && hasConfoundedGcsMeasurementContext(sourceSentence(sourceTexts[source], providedEvidence) || fullEvidence)) {
      certainty = 'unknown';
      confoundedGcsMeasurement = true;
    }
    if (certainty === 'unknown' && hasUnresolvedOtherExperiencer(fullEvidence)) unresolvedOtherSubjectFact = true;
    if (sourceFact.certainty === 'uncertain' && typeof value === 'string' && fullEvidence.includes(value)
      && /不排除|不能排除|可疑|疑似|怀疑|疑问|存疑|待确认|待排|待查|考虑|可能|[?？]/u.test(fullEvidence)
      && !/不排除|不能排除|可疑|疑似|怀疑|疑问|存疑|待确认|待排|待查|考虑|可能|[?？]/u.test(scopedCertaintyEvidence)) {
      certainty = 'reported';
    }
    if (source === 'description' && field === 'clinical_finding'
      && value === '开放性颅骨骨折伴硬脑膜破裂' && hasOpenSkullDuralReviewIssue(sourceTexts.description)) {
      certainty = 'conflicted';
    }
    if (!negativeClaimIsQuoted(value, fullEvidence)) { invalidEvidence = true; continue; }
    if (field === 'diagnosis' && typeof value === 'string'
      && !normalizeInput(fullEvidence).includes(normalizeInput(value))) {
      const valueEvidence = sourceClause(sourceTexts[source], value);
      if (valueEvidence && normalizeInput(valueEvidence).includes(normalizeInput(value))) fullEvidence = valueEvidence;
      else if (!diagnosisEvidenceSupportsValue(value, fullEvidence)) { invalidEvidence = true; continue; }
    }
    if (field === 'cross_region_wound_ratio' || field === 'ear_scalp_wound_ratio'
      || field === 'auricle_defect_ratio' || field === 'aggregate_wound_length_cm') continue;
    if (field === 'dental_loss_count') {
      const deterministicDentalCount = deterministicFacts.some(item => item.source === source && item.field === field
        && item.value === value && normalizeInput(fullEvidence).includes(normalizeInput(item.evidence)));
      if (deterministicDentalCount) continue;
      if (quotedDentalDefectCount(fullEvidence, value) === null) { invalidEvidence = true; continue; }
    }
    if (field === 'lip_wound_length_cm') continue;
    if (field === 'lip_through_wound_length_cm') continue;
    if (field === 'distinct_orbital_wall_fracture_count' || field === 'orbital_wall_enophthalmos'
      || field === 'orbital_enophthalmos_cm' || field === 'limb_length_difference_cm') {
      if (!deterministicFacts.some(fact => fact.source === source && fact.field === field && fact.value === value)) {
        invalidEvidence = true;
      }
      continue;
    }
    if (['wound_length_cm', 'facial_skin_abnormality_area_cm2'].includes(field)) {
      const deterministicMatch = deterministicFacts.find(fact => fact.source === source && fact.field === field
        && fact.value === value && normalizeInput(fullEvidence).includes(normalizeInput(fact.evidence)));
      if (!deterministicMatch) { invalidEvidence = true; continue; }
    }
    if (['surface_scar_area_cm2', 'aggregate_surface_scar_area_cm2', 'skull_defect_area_cm2'].includes(field)) {
      const deterministicMatch = deterministicFacts.find(fact => fact.source === source && fact.field === field
        && fact.value === value && normalizeInput(fullEvidence).includes(normalizeInput(fact.evidence)));
      if (!deterministicMatch) { invalidEvidence = true; continue; }
    }
    if (field === 'organ_hematoma_diameter_cm') {
      const deterministicMatch = deterministicFacts.find(fact => fact.source === source && fact.field === field
        && fact.value === value && normalizeInput(fullEvidence).includes(normalizeInput(fact.evidence)));
      if (!deterministicMatch || typeof value !== 'number') { invalidEvidence = true; continue; }
    }
    if (['scalp_defect_area_cm2', 'scalp_avulsion_area_cm2'].includes(field)) {
      const deterministicMatch = deterministicFacts.find(fact => fact.source === source && fact.field === field
        && fact.value === value && normalizeInput(fullEvidence).includes(normalizeInput(fact.evidence)));
      const scalpSite = /头皮|头顶部|额顶部|颞顶部|颞枕部|顶枕部|枕顶部|枕部/u.test(fullEvidence);
      const injuryType = field === 'scalp_defect_area_cm2' ? /缺损/u.test(fullEvidence) : /撕脱(?:伤|创)?/u.test(fullEvidence);
      if (!deterministicMatch || typeof value !== 'number' || !scalpSite || !injuryType || !/面积/u.test(fullEvidence)
        || !evidenceHasMeasurement(fullEvidence, value, /(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:cm2|平方厘米)/gu)) {
        invalidEvidence = true;
        continue;
      }
    }
    if (field.startsWith('skin_') || field === 'scalp_abrasion_area_cm2') {
      const deterministicMatch = deterministicFacts.find(fact => fact.source === source && fact.field === field
        && fact.value === value && normalizeInput(fullEvidence).includes(normalizeInput(fact.evidence)));
      const descriptor = field.includes('avulsion') ? /撕脱(?:伤|创)?/u
        : field.includes('defect') ? /(?:皮肤(?:组织)?|头皮)缺损/u
          : field.includes('abrasion') ? /擦伤/u : /挫伤/u;
      if (!deterministicMatch || typeof value !== 'number' || !descriptor.test(fullEvidence)
        || !/面积/u.test(fullEvidence)
        || !evidenceHasMeasurement(fullEvidence, value,
          /(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:cm2|平方厘米)/gu)
        || field === 'scalp_abrasion_area_cm2'
          && !/(?:头皮|头顶部|额顶部|颞顶部|颞枕部|顶枕部|枕顶部|枕部)/u.test(fullEvidence)) {
        invalidEvidence = true;
        continue;
      }
    }
    if (field === 'wound_length_cm' && (typeof value !== 'number'
      || !/(?:创口|伤口|划伤|瘢痕|疤痕|切口|裂口|裂创|裂伤)/u.test(fullEvidence)
      || !evidenceHasMeasurement(fullEvidence, value, /(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:cm(?!2)|厘米(?!2))/gu))) {
      invalidEvidence = true;
      continue;
    }
    if (field === 'facial_skin_abnormality_area_cm2' && (typeof value !== 'number'
      || !/(?:面部|脸部|面颊)/u.test(fullEvidence) || !/(?:色素异常|色素沉着|片状细小瘢痕|细小瘢痕)/u.test(fullEvidence)
      || !/(?:面积|累计面积)/u.test(fullEvidence)
      || !evidenceHasMeasurement(fullEvidence, value, /(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:cm2|平方厘米)/gu))) {
      invalidEvidence = true;
      continue;
    }
    if (field === 'facial_skin_abnormality_area_percent' && (!deterministicFacts.some(fact => fact.source === source
      && fact.field === field && fact.value === value && normalizeInput(fullEvidence).includes(normalizeInput(fact.evidence)))
      || typeof value !== 'number' || value < 0 || value > 100
      || !/(?:面部|脸部|面颊)/u.test(fullEvidence)
      || !/(?:色素显著异常|色素异常|色素沉着|片状细小瘢痕|细小瘢痕)/u.test(fullEvidence)
      || !/(?:面部|脸部)面积/u.test(fullEvidence)
      || !evidenceHasPercentageMeasurement(fullEvidence, value))) {
      invalidEvidence = true;
      continue;
    }
    if (field === 'injury_cause' && typeof value === 'string'
      && !normalizeInput(fullEvidence).includes(normalizeInput(value))) {
      invalidEvidence = true;
      continue;
    }
    if (field === 'injury_type') {
      if (Array.isArray(value)) {
        const validAmbiguousTypes = value.length >= 2 && value.every(item => typeof item === 'string'
          && /(?:fractur|骨折|injur|损伤|创|伤|contusion|挫伤|abrasion|擦伤|wound|laceration|burn|烧伤|烫伤|dislocat|脱位|sprain|扭伤|rupture|断裂|hematoma|血肿|hemorrhag|出血|amputat|截肢|缺失)/iu.test(item));
        if (!validAmbiguousTypes) { invalidInjuryType = true; continue; }
        value = [...new Set(value.map(normalizeInput))];
        certainty = 'unknown';
      }
      const injuryLabel = typeof value === 'string' ? normalizeInput(value) : '';
      const descriptorOnly = /^(?:本次(?:事故|外伤)?后|此次(?:事故|外伤)?后|事故后|外伤后|骨折线|骨折征象|fracture[_ ]line)$/iu.test(injuryLabel);
      const hasMechanismCue = /(?:殴打|袭击|撞击|碰撞|打击|摔倒|跌倒|车祸|交通事故)/u.test(injuryLabel);
      const hasSpecificInjury = /(?:fractur|骨折|骨裂|挫伤|擦伤|伤口|创口|裂伤|烧伤|烫伤|脱位|扭伤|撕裂|破裂|断裂|血肿|出血|损伤|损害|injury)/iu.test(injuryLabel);
      const mechanismOnly = /^(?:被打伤|被殴打|被人殴打|殴打致伤|遭到?袭击)$/u.test(injuryLabel)
        || hasMechanismCue && /(?:受伤|致伤|伤后)/u.test(injuryLabel) && !hasSpecificInjury
        || hasMechanismCue && !hasSpecificInjury
        || /(?:受伤|受了伤)$/u.test(injuryLabel) && !hasSpecificInjury;
      const injuryConcept = /(?:fractur|骨折|injur|损伤|创|伤|contusion|挫伤|abrasion|擦伤|wound|laceration|burn|烧伤|烫伤|dislocat|脱位|sprain|扭伤|rupture|断裂|hematoma|血肿|hemorrhag|出血|amputat|截肢|缺失)/iu.test(injuryLabel);
      if (!Array.isArray(value) && (descriptorOnly || mechanismOnly || !injuryConcept)) { invalidInjuryType = true; continue; }
      if (!Array.isArray(value) && /^fracture$/iu.test(injuryLabel)
        && !/(?:骨折|骨裂|fracture)/iu.test(fullEvidence)) { invalidInjuryType = true; continue; }
    }
    if (field === 'clinical_finding' && isAdministrativeDispositionWithoutClinicalFinding(value)) continue;
    if (field === 'clinical_finding' && (typeof value !== 'string' || !value.trim()
      || !normalizeInput(fullEvidence).includes(normalizeInput(value)))) {
      invalidEvidence = true;
      continue;
    }
    if (field === 'clinical_finding' && ['reported', 'observed', 'derived'].includes(certainty)) {
      const evidenceStart = sourceTexts[source].indexOf(fullEvidence);
      const valueOffset = fullEvidence.indexOf(normalizeInput(value));
      const findingStart = evidenceStart < 0 || valueOffset < 0 ? -1 : evidenceStart + valueOffset;
      if (findingStart < 0 || hasNonCurrentClinicalContext(sourceTexts[source], findingStart,
        findingStart + normalizeInput(value).length)) {
        invalidClinicalTemporalContext = true;
        continue;
      }
    }
    const parsedForEvidence = normalizeRibFacts(fullEvidence);
    const claimsRibFracture = field === 'injury_type' && typeof value === 'string'
      && /^(?:rib_fracture|sixth_rib_fracture|肋骨骨折)$/i.test(value.trim());
    const claimsRibDiagnosis = field === 'diagnosis' && typeof value === 'string'
      && /(?:肋骨|rib).*(?:骨折|fracture)|(?:骨折|fracture).*(?:肋骨|rib)/i.test(value);

    const priorFact = facts.find(item => item.field === 'prior_injury' && item.source === source
      && normalizeInput(item.evidence).includes(providedEvidence));
    const ribRelatedRawFact = isRibAlias(sourceFact.field)
      || hasRibSpecificFractureStatement(fullEvidence)
      || field === 'anatomical_site' && /肋骨|rib/i.test(`${value} ${fullEvidence}`)
      || field === 'diagnosis' && hasRibSpecificFractureStatement(fullEvidence)
      || field === 'injury_type' && /肋骨|rib|fracture|骨折/i.test(`${value} ${fullEvidence}`);
    const eventId = treatmentEvidenceReanchored ? null : ribRelatedRawFact && conflictingRibEventIds.has(sourceFact.eventId) ? null
      : ribRelatedRawFact && inferredEventIds[source]
        ? inferredEventIds[source] : sourceFact.eventId || null;
    const historicalRibFact = field !== 'fracture_site_count' && ribRelatedRawFact && (Boolean(priorFact)
      || /(?:既往(?:史)?|曾经|曾有|陈旧性?|旧伤)/.test(fullEvidence) && /骨折|fracture/i.test(fullEvidence));
    if (historicalRibFact) {
      if (priorFact && sourceFact.id) {
        if (sourceFact.eventId && priorFact.eventId && sourceFact.eventId !== priorFact.eventId) invalidEventLink = true;
        else if (sourceFact.eventId && priorFact.eventId !== sourceFact.eventId) updateEventId(priorFact, sourceFact.eventId);
        priorFact.rawIds ||= [];
        if (!priorFact.rawIds.includes(sourceFact.id)) priorFact.rawIds.push(sourceFact.id);
      }
      continue;
    }
    if (field === 'fracture_site_count') {
      const quotedCountValues = [...providedEvidence.matchAll(/[0-9零〇一二两三四五六七八九十百]+\s*处/g)]
        .map(match => parseNumber(match[0].replace(/\s*处$/, '')));
      const siteCountCandidates = [...new Map(deterministicFacts.filter(item => item.source === source
        && item.field === field && quotedCountValues.includes(item.value)
        && (sourceClause(item.evidence, providedEvidence) || sourceClause(providedEvidence, item.evidence)))
        .map(item => [stableFactKey(item), item])).values()];
      if (eventId && siteCountCandidates.length > 1) {
        invalidEventLink = true;
        continue;
      }
      const matchingValue = siteCountCandidates.filter(item => item.value === value);
      const mappedSiteCount = matchingValue.length === 1 ? matchingValue[0]
        : matchingValue.length === 0 && siteCountCandidates.length === 1 ? siteCountCandidates[0] : null;
      if (mappedSiteCount) {
        mapRawIdToRelatedRibFacts(sourceFact.id, source, mappedSiteCount.evidence, certainty, eventId || null);
        continue;
      }
      if (siteCountCandidates.length) {
        unsupportedSiteCount = true;
        continue;
      }
    }
    const evidenceHasRibFracture = parsedForEvidence.some(item => item.field === 'injury_type' && item.value === 'rib_fracture');
    const unsupportedRibAlias = isRibAlias(sourceFact.field) && field !== 'fracture_site_count' && !evidenceHasRibFracture;
    const unsupportedRibType = claimsRibFracture && !evidenceHasRibFracture;
    const unsupportedRibDiagnosis = claimsRibDiagnosis && !hasRibSpecificFractureStatement(fullEvidence);
    if (unsupportedRibAlias || unsupportedRibType || unsupportedRibDiagnosis) {
      invalidEvidence = true;
      continue;
    }

    if (field === 'other') {
      const statement = typeof value === 'string' ? value
        : value && typeof value === 'object' && !Array.isArray(value) && typeof value.statement === 'string'
          ? value.statement : '';
      if (!statement.trim() || !normalizeInput(fullEvidence).includes(normalizeInput(statement))) {
        invalidEvidence = true;
        continue;
      }
      value = normalizeInput(statement);
    }

    if (field === 'other' && typeof value === 'string' && /(?:骨折|fracture)/i.test(value)
      && deterministicFacts.some(item => item.source === source && item.certainty === certainty
        && ribFields.has(item.field) && item.evidence === fullEvidence
        && normalizeInput(fullEvidence).includes(normalizeInput(value)))) continue;

    const repeatsSameClauseSymptomSite = field === 'anatomical_site' && typeof value === 'string'
      && raw.facts.some(candidate => {
        if (canonicalField(candidate.field) !== 'symptom' || candidate.source !== source) return false;
        const symptomQuote = normalizeInput(candidate.evidence);
        if (!symptomQuote || !sourceTexts[source].includes(symptomQuote)) return false;
        if (symptomQuote.includes(normalizeInput(value))) return true;
        const symptomClause = sourceClause(sourceTexts[source], symptomQuote).replace(/[，,。；;]+$/u, '');
        const siteClause = sourceClause(sourceTexts[source], providedEvidence).replace(/[，,。；;]+$/u, '');
        return Boolean(symptomClause && symptomClause === siteClause
          && normalizeInput(fullEvidence).includes(normalizeInput(value)));
      });
    if (repeatsSameClauseSymptomSite) continue;

    if (field === 'anatomical_site' && typeof value === 'string') {
      const site = normalizeInput(value);
      const dateLikeSite = /^(?:(?:19|20)\d{2}年\s*\d{1,2}月\s*\d{1,2}日(?:早晨|凌晨|上午|中午|下午|晚上|晚|晨|夜)?(?:\s*\d{1,2}(?:时|点)(?:\d{1,2}分?)?(?:许|左右)?)?|(?:19|20)\d{2}[-/.]\s*\d{1,2}[-/.]\s*\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?|\d{1,2}月\s*\d{1,2}日(?:早晨|凌晨|上午|中午|下午|晚上|晚|晨|夜)?(?:\s*\d{1,2}(?:时|点)(?:\d{1,2}分?)?(?:许|左右)?)?)$/u.test(site);
      const quotedSite = !dateLikeSite && (normalizeInput(fullEvidence).includes(site)
        || /^(?:rib|ribs)$/i.test(site) && /肋(?:骨)?|rib/i.test(fullEvidence));
      if (!quotedSite) {
        invalidEvidence = true;
        continue;
      }
    }

    const sameClauseHasSiteCount = field === 'fractured_rib_count' && deterministicFacts.some(item =>
      item.source === source && item.field === 'fracture_site_count'
        && sourceClause(sourceTexts[source], item.evidence) === sourceClause(sourceTexts[source], fullEvidence));
    const quotesRibRootCount = /(?:\d+|[零〇一二两三四五六七八九十百]+)\s*(?:根|条)(?:肋骨)?/.test(fullEvidence);
    if (sameClauseHasSiteCount && !quotesRibRootCount) continue;

    if (field === 'anatomical_site' && typeof value === 'string' && /^(?:rib|ribs|肋骨)$/i.test(value.trim())
      || field === 'anatomical_site' && typeof value === 'string' && /肋骨/.test(value)) value = '肋骨';
    if (field === 'laterality' && typeof value === 'string') {
      const side = value.trim().toLowerCase();
      const normalizedSide = /^(?:left|左|左侧|左边)$/.test(side) ? 'left'
        : /^(?:right|右|右侧|右边)$/.test(side) ? 'right'
          : /^(?:bilateral|both|双侧|两侧)$/.test(side) ? 'bilateral' : null;
      if (normalizedSide) value = normalizedSide;
      const quotedSides = [...new Set(deterministicFacts.filter(item => item.source === source
        && item.field === 'laterality' && ['reported', 'observed', 'derived'].includes(item.certainty)
        && (normalizeInput(fullEvidence).includes(normalizeInput(item.evidence))
          || normalizeInput(item.evidence).includes(normalizeInput(fullEvidence))))
        .map(item => item.value))];
      if (quotedSides.length === 1) value = quotedSides[0];
    }

    if (field === 'fracture_site_count') {
      const explicitSite = deterministicFacts.some(item => item.source === source && item.field === field
        && sourceClause(item.evidence, providedEvidence));
      if (!explicitSite && certainty === 'excluded' && value === 0) {
        field = 'injury_type'; value = 'rib_fracture';
      } else if (!explicitSite) {
        unsupportedSiteCount = true;
        continue;
      }
    }
    const explicitOrdinal = /(?:第\s*[0-9零〇一二两三四五六七八九十百]+\s*(?:根|条)?\s*肋骨|肋骨\s*第\s*[0-9零〇一二两三四五六七八九十百]+)/.test(fullEvidence);
    if (field === 'fractured_rib_numbers' && certainty === 'excluded' && !explicitOrdinal) {
      field = 'injury_type'; value = 'rib_fracture';
    }
    if (field === 'diagnosis' && typeof value === 'string'
      && hasRibSpecificFractureStatement(fullEvidence)) {
      field = 'injury_type'; value = 'rib_fracture';
    }
    if (field === 'fractured_rib_numbers' && Array.isArray(value) && value.length === 0 && certainty === 'excluded') {
      field = 'injury_type'; value = 'rib_fracture';
    }
    if (field === 'injury_type' && typeof value === 'string' && /^(?:骨折|肋骨骨折|fracture|rib_fracture)$/i.test(value.trim())) {
      value = hasRibSpecificFractureStatement(fullEvidence) ? 'rib_fracture' : 'fracture';
    }

    const isRibFinding = isRibAlias(field) && /骨折|肋骨/i.test(`${field} ${fullEvidence}`);
    if (isRibFinding && parsedForEvidence.length) {
      const matchField = /(?:number|序号)/i.test(field) ? 'fractured_rib_numbers'
        : /site|处数/i.test(field) ? 'fracture_site_count'
          : /count|根数/i.test(field) ? 'fractured_rib_count'
            : /laterality|side/i.test(field) ? 'laterality' : 'injury_type';
      const match = deterministicFacts.find(item => item.source === source && item.field === matchField
        && item.certainty === certainty && sourceClause(item.evidence, providedEvidence));
      const fallback = deterministicFacts.find(item => item.source === source && item.field === matchField && item.certainty === certainty);
      const mapped = match || fallback;
      if (mapped && mapRawIdToRelatedRibFacts(sourceFact.id, source, fullEvidence, certainty, eventId || null)) continue;
      // Keep only source-backed rib-root counts: 只保留有原文依据的肋骨根数。
      if (field === 'fractured_rib_count' && !quotesRibRootCount) continue;
    }

    if (field === 'injury_type' && typeof value === 'string' && /^(?:骨折|肋骨骨折|fracture|rib_fracture)$/i.test(value.trim())) {
      value = hasRibSpecificFractureStatement(fullEvidence) ? 'rib_fracture' : 'fracture';
    }
    if (certainty === 'excluded' && (
      ['diagnosis', 'injury_type'].includes(field) && typeof value === 'string' && /骨折|fracture/i.test(value)
      || field === 'fractured_rib_numbers' && Array.isArray(value) && value.length === 0
      || /^(?:rib_fracture|sixth_rib_fracture|fracture)$/.test(field)
    )) {
      field = 'injury_type'; value = hasRibSpecificFractureStatement(fullEvidence) ? 'rib_fracture' : 'fracture';
    }
    if (field === 'symptom') {
      let symptomValue = typeof value === 'string' ? normalizeInput(value) : '';
      const chestPainAlias = String(sourceFact.field || '').toLowerCase().match(/^(left|right|bilateral)_chest_pain$/u);
      if (!symptomValue && value === true && chestPainAlias) {
        const phrase = { left: '左侧胸部疼痛', right: '右侧胸部疼痛', bilateral: '双侧胸部疼痛' }[chestPainAlias[1]];
        if (normalizeInput(fullEvidence).includes(phrase)) symptomValue = phrase;
      }
      if (!symptomValue || !/(?:疼痛|痛感|耳鸣|听力(?:下降|减退|丧失)|耳聋|耳痛|头晕|眩晕|头痛|腰背痛|腰痛|背痛|恶心|呕吐|麻木|乏力|咳嗽|胸闷|气促|呼吸困难|视物模糊|视力下降|肢体无力|活动受限|肿胀|流泪|溢泪|不适)/u.test(symptomValue)
        || !normalizeInput(fullEvidence).includes(symptomValue)) {
        invalidSymptomFact = true;
        continue;
      }
      if (explicitNegationCoversTerm(fullEvidence, symptomValue)) {
        invalidSymptomFact = true;
        continue;
      }
      value = symptomValue;
    }
    const countToken = field === 'fracture_site_count'
      ? fullEvidence.match(/[0-9零〇一二两三四五六七八九十百]+\s*处/)?.[0] : null;
    const countEvidence = countToken ? sourceClause(sourceTexts[source], countToken) || countToken : null;
    const normalized = { ...(sourceFact.id ? { rawIds: [sourceFact.id] } : {}), ...(eventId ? { eventId } : {}), field, value, certainty,
      sourceRefs: sourceRefsForFact(source, countEvidence || fullEvidence, sourceTexts[source]),
      source, evidence: countEvidence || fullEvidence, finding: factFinding(field, value, certainty) };
    const target = addFact(normalized, sourceFact.id || null);
    if (sourceFact.id && !target.rawIds?.includes(sourceFact.id)) target.rawIds = [...(target.rawIds || []), sourceFact.id];
    mapRawIdToRelatedRibFacts(sourceFact.id, source, fullEvidence, certainty, eventId || null);
  }

  for (const fact of facts) {
    if (fact.field !== 'limb_length_difference_cm' || fact.source !== 'description' || fact.eventId) continue;
    const factClause = sourceClause(sourceTexts.description, fact.evidence) || fact.evidence;
    const causeAnchor = limbLengthDifferenceCauseAnchor(factClause);
    if (!causeAnchor) continue;
    const eventIds = new Set(facts.filter(anchor => {
      if (anchor === fact || anchor.source !== 'description' || !anchor.eventId
        || !['reported', 'observed', 'derived'].includes(anchor.certainty)
        || (sourceClause(sourceTexts.description, anchor.evidence) || anchor.evidence) !== factClause) return false;
      if (['age_at_injury_years', 'injury_date'].includes(anchor.field)) return true;
      if (['injury_type', 'diagnosis', 'imaging_finding'].includes(anchor.field)) {
        const anchorText = `${stableJson(anchor.value ?? '')} ${String(anchor.evidence || '')}`;
        return normalizeInput(anchorText).includes(normalizeInput(causeAnchor));
      }
      if (anchor.field !== 'clinical_finding' || typeof anchor.value !== 'string') return false;
      if (normalizeInput(anchor.value).includes(normalizeInput(causeAnchor))) return true;
      const measurements = [...normalizeInput(anchor.value).matchAll(/(?:双|两)(?:上|下)肢(?:相对)?(?:长度|长短)(?:相差|差值|差距|差异)\s*(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(cm|厘米|mm|毫米)/gu)];
      if (measurements.length !== 1) return false;
      const amount = /^\d/u.test(measurements[0][1]) ? Number(measurements[0][1]) : parseNumber(measurements[0][1]);
      const centimetres = /^(?:mm|毫米)$/u.test(measurements[0][2]) ? amount / 10 : amount;
      return centimetres === fact.value;
    }).map(anchor => anchor.eventId));
    if (eventIds.size === 1) fact.eventId = [...eventIds][0];
  }

  const deduplicatedFacts = new Map();
  for (const fact of facts) {
    const key = stableFactKey(fact);
    const overlappingRibNumbers = fact.field === 'fractured_rib_numbers'
      ? [...deduplicatedFacts.values()].find(existingFact => existingFact.field === fact.field
        && JSON.stringify(existingFact.value) === JSON.stringify(fact.value)
        && existingFact.certainty === fact.certainty && existingFact.source === fact.source
        && (existingFact.eventId || null) === (fact.eventId || null)
        && (!existingFact.parserRibLaterality || !fact.parserRibLaterality
          || existingFact.parserRibLaterality === fact.parserRibLaterality)
        && (normalizeInput(existingFact.evidence).includes(normalizeInput(fact.evidence))
          || normalizeInput(fact.evidence).includes(normalizeInput(existingFact.evidence)))) : null;
    const existing = deduplicatedFacts.get(key) || overlappingRibNumbers;
    if (!existing) {
      deduplicatedFacts.set(key, fact);
      continue;
    }
    existing.rawIds = [...new Set([...(existing.rawIds || []), ...(fact.rawIds || [])])];
    existing.sourceRefs = mergeSourceRefs(existing.sourceRefs || [], fact.sourceRefs || []);
    if (!existing.parserId && fact.parserId) existing.parserId = fact.parserId;
    if (!existing.parserDerivedFrom && fact.parserDerivedFrom) existing.parserDerivedFrom = fact.parserDerivedFrom;
  }
  const deduplicatedValues = deduplicateOverlappingWoundMeasurements([...deduplicatedFacts.values()], sourceTexts);
  if (deduplicatedValues.length > MAX_NORMALIZED_FACTS) factCountExceeded = true;
  facts.splice(0, facts.length, ...deduplicatedValues);
  if (boundNormalizedFacts(facts)) factCountExceeded = true;
  linkExplicitlyCausedProcedureToCurrentInjury(facts, sourceTexts.description);
  const scopedOtherRibExclusion = fact => ['injury_type', 'anatomical_site', 'laterality'].includes(fact.field)
    && fact.certainty === 'excluded' && /(?:其他|其余|剩余)(?:侧)?肋骨/.test(fact.evidence)
    && facts.some(candidate => candidate !== fact && candidate.field === 'injury_type'
      && ['reported', 'observed', 'derived'].includes(candidate.certainty)
      && (!fact.eventId || !candidate.eventId || fact.eventId === candidate.eventId)
      && /第\s*[0-9零〇一二两三四五六七八九十百]+\s*肋骨/.test(candidate.evidence));
  facts.splice(0, facts.length, ...facts.filter(fact => !scopedOtherRibExclusion(fact)));
  const symptomClause = fact => sourceClause(sourceTexts[fact.source], fact.evidence || '');
  facts.splice(0, facts.length, ...facts.filter(fact => !(fact.field === 'symptom' && fact.value === '疼痛'
    && facts.some(other => other !== fact && other.field === 'symptom' && other.source === fact.source
      && other.value !== '疼痛' && /(?:疼痛|痛感)$/u.test(String(other.value))
      && symptomClause(other) === symptomClause(fact)))));
  aggregateRibRootCounts(facts, sourceTexts);
  for (const fact of facts) delete fact.parserRibLaterality;
  if (boundNormalizedFacts(facts)) factCountExceeded = true;
  const nestedClinicalFacts = [];
  for (const fact of facts) {
    const normalizedEvidence = normalizeInput(fact.evidence || '');
    const mergeIndex = fact.field === 'clinical_finding' && fact.source === 'description'
      && typeof fact.value === 'string' && ['reported', 'observed'].includes(fact.certainty)
      ? nestedClinicalFacts.findIndex(existing => existing.field === fact.field && existing.source === fact.source
        && existing.value === fact.value && existing.eventId === fact.eventId
        && ['reported', 'observed'].includes(existing.certainty)
        && (normalizeInput(existing.evidence || '').includes(normalizedEvidence)
          || normalizedEvidence.includes(normalizeInput(existing.evidence || ''))))
      : -1;
    if (mergeIndex < 0) {
      nestedClinicalFacts.push(fact);
      continue;
    }
    const existing = nestedClinicalFacts[mergeIndex];
    const preferred = fact.certainty === 'observed' && existing.certainty !== 'observed' ? fact
      : existing.certainty === 'observed' && fact.certainty !== 'observed' ? existing
        : String(fact.evidence || '').length > String(existing.evidence || '').length ? fact : existing;
    nestedClinicalFacts[mergeIndex] = { ...preferred, certainty: fact.certainty === 'observed'
      || existing.certainty === 'observed' ? 'observed' : 'reported',
    sourceRefs: mergeSourceRefs(existing.sourceRefs || [], fact.sourceRefs || []),
    rawIds: [...new Set([...(existing.rawIds || []), ...(fact.rawIds || [])])],
    ...(existing.parserId || fact.parserId ? { parserId: preferred.parserId || existing.parserId || fact.parserId } : {}) };
  }
  facts.splice(0, facts.length, ...nestedClinicalFacts);
  facts.sort((a, b) => stableFactKey(a).localeCompare(stableFactKey(b), 'en'));
  const rawIdToFinalIds = new Map();
  const parserIdToFinalId = new Map();
  facts.forEach((fact, index) => {
    fact.id = `F${index + 1}`;
    if (fact.parserId) parserIdToFinalId.set(fact.parserId, fact.id);
    for (const rawId of fact.rawIds || []) rawIdToFinalIds.set(rawId, [...(rawIdToFinalIds.get(rawId) || []), fact.id]);
  });
  for (const fact of facts) {
    if (fact.parserDerivedFrom?.length) fact.derivedFrom = fact.parserDerivedFrom.map(id => parserIdToFinalId.get(id)).filter(Boolean);
    if (fact.field === 'aggregate_wound_length_cm' && fact.certainty === 'derived'
      && (fact.derivedFrom?.length || 0) < 2) {
      fact.finding = factFinding('wound_length_cm', fact.value, fact.certainty);
    }
  }
  const factAudit = raw.facts.map(rawFact => {
    const normalizedFactIds = [...new Set(rawIdToFinalIds.get(rawFact.id) || [])].sort(compareFactIds);
    const evidence = normalizeInput(rawFact.evidence || '');
    const sourceText = sourceTexts[rawFact.source] || '';
    let reasonCode = null;
    if (!normalizedFactIds.length) {
      if (Array.isArray(rawFact.sourceRefs) && rawFact.sourceRefs.length
        && !rawFact.sourceRefs.some(reference => sourceReferenceMatches(reference,
          { description: sourceTexts.description, recognizedText: sourceTexts.image }))) {
        reasonCode = 'source_reference_invalid';
      } else if (!evidence || !sourceText.includes(evidence)) {
        reasonCode = 'evidence_not_found';
      } else if (factIsOutsideAssessmentScope(sourceText, rawFact.evidence, String(rawFact.value ?? ''))) {
        reasonCode = 'out_of_scope';
      } else if (!['reported', 'observed', 'derived'].includes(rawFact.certainty)) {
        reasonCode = 'not_confirmed';
      } else {
        reasonCode = 'canonicalization_rejected';
      }
    }
    return {
      rawFactId: rawFact.id,
      proposedField: rawFact.field,
      field: canonicalField(rawFact.field),
      proposedValue: rawFact.value,
      certainty: rawFact.certainty,
      source: rawFact.source,
      evidence: rawFact.evidence,
      ...(rawFact.sourceRefs?.length ? { sourceRefs: rawFact.sourceRefs } : {}),
      status: normalizedFactIds.length ? 'normalized' : 'excluded',
      reasonCode,
      normalizedFactIds,
      gradeEligible: normalizedFactIds.some(id => {
        const normalized = facts.find(fact => fact.id === id);
        return normalized?.source === 'description' && ['reported', 'observed', 'derived'].includes(normalized.certainty)
          && Array.isArray(normalized.sourceRefs) && normalized.sourceRefs.length > 0
          && normalized.sourceRefs.every(reference => sourceReferenceMatches(reference,
            { description: sourceTexts.description, recognizedText: sourceTexts.image }));
      }),
    };
  });
  factAudit.push(...excludedDeterministicFacts.slice(0, 200).map(fact => ({
    rawFactId: fact.parserId,
    proposedField: fact.field,
    field: canonicalField(fact.field),
    proposedValue: fact.value,
    certainty: fact.certainty,
    source: fact.source,
    evidence: fact.evidence,
    ...(fact.sourceRefs?.length ? { sourceRefs: fact.sourceRefs } : {}),
    status: 'excluded',
    reasonCode: 'out_of_scope',
    normalizedFactIds: [],
    gradeEligible: false,
  })));
  const conflictsByIds = new Map();
  let unlinkedModelConflict = false;
  const conflictEvidenceSignature = ids => {
    const group = ids.map(id => facts.find(item => item.id === id));
    if (group.some(fact => !fact?.eventId)) return '';
    return JSON.stringify([...new Set(group.flatMap(fact => {
      const references = fact.sourceRefs?.length ? fact.sourceRefs : [{ source: fact.source, sourceId: fact.source, evidence: fact.evidence }];
      return references.map(reference => `${fact.eventId}\u001f${reference.source || fact.source || ''}\u001f${reference.sourceId || ''}\u001f${normalizeInput(reference.evidence || '')}`);
    }))].sort());
  };
  const addConflict = ids => {
    const merged = new Set([...new Set(ids)].filter(id => facts.some(fact => fact.id === id)));
    const signature = conflictEvidenceSignature([...merged]);
    let overlaps = true;
    while (overlaps) {
      overlaps = false;
      for (const [key, existing] of conflictsByIds) {
        if (existing.some(id => merged.has(id)) || signature && conflictEvidenceSignature(existing) === signature) {
          existing.forEach(id => merged.add(id));
          conflictsByIds.delete(key);
          overlaps = true;
        }
      }
    }
    const factIds = [...merged].sort(compareFactIds);
    if (factIds.length < 2) return;
    conflictsByIds.set(factIds.join('|'), factIds);
  };
  for (const conflict of raw.conflicts) {
    const referencedRawFacts = conflict.factIds.map(id => raw.facts.find(fact => fact.id === id)).filter(Boolean);
    if (onlyCrossLateralityRibCountDisagreement(referencedRawFacts)) continue;
    const mapped = conflict.factIds.flatMap(id => rawIdToFinalIds.get(id) || []);
    const uniqueMapped = [...new Set(mapped)];
    if (uniqueMapped.length < 2) {
      invalidModelConflict = true;
      continue;
    }
    const byEvent = new Map();
    for (const id of uniqueMapped) {
      const eventId = facts.find(fact => fact.id === id)?.eventId || '';
      byEvent.set(eventId, [...(byEvent.get(eventId) || []), id]);
    }
    let linkedConflict = false;
    for (const ids of byEvent.values()) {
      for (let leftIndex = 0; leftIndex < ids.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < ids.length; rightIndex += 1) {
          const left = facts.find(fact => fact.id === ids[leftIndex]);
          const right = facts.find(fact => fact.id === ids[rightIndex]);
          if (!conflictingFactPair(left, right)) continue;
          addConflict([left.id, right.id]);
          linkedConflict = true;
        }
      }
    }
    const hasUnknownEvent = byEvent.has('');
    const hasPotentialConflict = uniqueMapped.some((leftId, index) => uniqueMapped.slice(index + 1).some(rightId =>
      conflictingFactPair(facts.find(fact => fact.id === leftId), facts.find(fact => fact.id === rightId))));
    if (hasUnknownEvent && byEvent.size > 1 && !linkedConflict && hasPotentialConflict) unlinkedModelConflict = true;
  }
  for (const field of ['injury_type', 'diagnosis', 'anatomical_site', 'fractured_rib_numbers', 'fractured_rib_count', 'fracture_site_count', 'laterality']) {
    const group = facts.filter(fact => fact.field === field);
    for (let i = 0; i < group.length; i += 1) for (let j = i + 1; j < group.length; j += 1) {
      const left = group[i], right = group[j];
      if (left.eventId && right.eventId && left.eventId !== right.eventId) continue;
      if (conflictingFactPair(left, right)) addConflict([left.id, right.id]);
    }
  }
  if (unlinkedModelConflict) conflictsByIds.set('unlinked', []);
  const conflicts = [...conflictsByIds.values()].map(factIds => {
    for (const id of factIds) {
      const fact = facts.find(item => item.id === id);
      if (!fact) continue;
      if (fact.certainty !== 'conflicted') fact.assertedCertainty = fact.certainty;
      fact.certainty = 'conflicted';
      fact.finding = factFinding(fact.field, fact.value, fact.certainty);
    }
    return { factIds, reason: canonicalConflictReason(factIds.map(id => facts.find(item => item.id === id)).filter(Boolean)) };
  }).sort((a, b) => a.factIds.join('|').localeCompare(b.factIds.join('|'), 'en'));
  const hasExplicitLateralityDiscrepancy = Object.values(sourceTexts).some(explicitLateralityDiscrepancy);
  if (hasExplicitLateralityDiscrepancy) conflicts.push({ factIds: [],
    reason: '同一解剖部位的左右侧别记载不一致，需人工复核。' });

  const unlinkedFractureStatusDisagreement = facts.some((left, index) => facts.slice(index + 1).some(right => {
    const fractureValues = new Set(['fracture', 'rib_fracture']);
    if (fracturesAtClearlyDifferentSites(left, right)) return false;
    const scopedOtherRibExclusion = (negative, positive) => negative.field === 'injury_type'
      && negative.certainty === 'excluded' && positive.field === 'injury_type'
      && ['reported', 'observed', 'derived'].includes(positive.certainty)
      && /(?:其他|其余|剩余)(?:侧)?肋骨/.test(negative.evidence)
      && /第\s*[0-9零〇一二两三四五六七八九十百]+\s*肋骨/.test(positive.evidence);
    if (scopedOtherRibExclusion(left, right) || scopedOtherRibExclusion(right, left)) return false;
    return left.field === 'injury_type' && right.field === 'injury_type'
      && !(left.eventId && right.eventId && left.eventId !== right.eventId)
      && fractureValues.has(left.value) && fractureValues.has(right.value)
      && left.evidence !== right.evidence
      && (left.certainty === 'excluded' && ['reported', 'observed', 'derived'].includes(right.certainty)
        || right.certainty === 'excluded' && ['reported', 'observed', 'derived'].includes(left.certainty));
  }));

  const hasExplicitFractureSiteCount = facts.some(fact => fact.field === 'fracture_site_count'
    && ['reported', 'observed', 'derived'].includes(fact.certainty)
    && Number.isInteger(fact.value) && fact.value >= 0 && fact.sourceRefs?.length > 0);
  const missingMaterials = canonicalMissingMaterials(raw.missingMaterials).filter(item =>
    !hasExplicitFractureSiteCount || item !== '骨折处数未在原文中明确记载，需核实');
  const extractionWarnings = [
    ...(confoundedGcsMeasurement
      ? ['GCS评分记录在麻醉、镇静、肌松、插管或通气相关上下文中；原始记录已保留，但未作为神经系统体征依据。'] : []),
    ...(eyeContentEviscerationNeedsReview
      ? ['资料记载眼内容物剜除，但手术名称本身不能证实眼球整体缺失；系统不自动认定该条款，需核对术中所见及术后眼球/巩膜壳状态。'] : []),
    ...(invalidModelConflict ? ['模型冲突声明引用无效或无法映射到两个有效事实，已忽略；系统仍会根据可核验事实独立检查冲突。'] : []),
    ...unlinkedConflictWarnings.map(reason => `模型提供的未关联冲突提示已保留供核对，但未作为来源冲突依据：${reason}`),
    ...(invalidEvidence ? ['事实提取中有内容缺少可回查原文，已忽略，未作为评估依据。'] : []),
    ...(invalidInjuryType ? ['非损伤类型描述未作为损伤类型事实采用；保留的损伤事实仍须符合原文依据。'] : []),
    ...(invalidSymptomFact ? ['个别症状事实缺少肯定性原文依据或处于否定描述中，已忽略；可核对的症状表现仍予保留。'] : []),
    ...(invalidClinicalTemporalContext ? ['既往、未实施或计划中的临床事实未作为本次伤情依据。'] : []),
    ...(openSkullDuralReviewIssue ? ['开放性颅骨骨折与硬脑膜破裂记录存在相互矛盾或事件归属不清，需人工复核。'] : []),
    ...(hasExplicitLateralityDiscrepancy ? ['材料明确提示同一解剖部位的左右侧别记载不一致，需人工复核。'] : []),
  ];
  if (factCountExceeded) missingMaterials.push('事实数量超过单次安全处理上限，请分段提交并核对');
  const hasSourceRibFractureFinding = facts.some(fact => fact.source === 'description'
    && ['reported', 'observed', 'derived'].includes(fact.certainty)
    && (fact.field === 'injury_type' && fact.value === 'rib_fracture'
      || ['fractured_rib_count', 'fractured_rib_numbers', 'fracture_site_count'].includes(fact.field)));
  if (unsupportedSiteCount && hasSourceRibFractureFinding && !hasExplicitFractureSiteCount) {
    missingMaterials.push('骨折处数未在原文中明确记载，需核实');
  }
  const uniqueMissing = [...new Set(missingMaterials)].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const hasUncertain = facts.some(fact => ['uncertain', 'unknown', 'conflicted'].includes(fact.certainty));
  const hasConflictedFact = facts.some(fact => fact.certainty === 'conflicted');
  const reviewReasons = [
    ...(conflicts.length ? ['fact_conflict'] : []),
    ...(invalidEventLink ? ['invalid_event_link'] : []),
    ...(factCountExceeded ? ['fact_limit_exceeded'] : []),
    ...(openSkullDuralReviewIssue ? ['skull_dura_conflict'] : []),
    ...(unresolvedOtherSubjectFact ? ['unresolved_subject'] : []),
    ...(unlinkedFractureStatusDisagreement ? ['unlinked_fracture_status'] : []),
  ];
  const requiresReview = reviewReasons.length > 0;
  if (invalidEventLink) extractionWarnings.push('部分肋骨事实的受伤事件归属无法一致核验，需人工复核。');
  if (unlinkedFractureStatusDisagreement) extractionWarnings.push('骨折阳性与阴性记载无法可靠对应到同一事件，需人工复核。');
  if (conflicts.length || hasConflictedFact) extractionWarnings.push('存在冲突事实，已保留并按其对候选条款的影响范围复核。');
  else if (hasUncertain) extractionWarnings.push('存在疑似或待核实事实，未作为已确认依据；请核对其是否影响评估。');
  if (factCountExceeded) extractionWarnings.push('事实数量超过单次安全处理上限，已截断并要求分段核对。');
  return { facts: facts.map(({ rawIds, parserId, parserDerivedFrom, ...fact }) => ({ ...fact,
    ...(rawIds?.length ? { sourceFactIds: [...new Set(rawIds)].sort() } : {}) })),
    factAudit: factAudit.slice(0, 400), missingMaterials: uniqueMissing,
    conflicts, requiresReview, reviewReasons, warnings: extractionWarnings,
    scopeText: removeOutOfScopeAssessmentSegments(`${sourceTexts.description}\n${sourceTexts.image}`) };
}

function canonicalFacts(facts) {
  return facts.map((fact) => ({
    field: fact.field,
    value: fact.value,
    certainty: fact.certainty,
    source_type: fact.source_type
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
}

function canonicalFactsHash(facts) {
  const content = JSON.stringify(canonicalFacts(facts));
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function validateFactSnapshot(snapshot, { assessmentType, sourceText = '', hasImage = false } = {}) {
  const errors = [];
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return { ok: false, errors: ['snapshot must be an object'] };
  if (Object.keys(snapshot).some((key) => !['schema_version', 'assessment_type', 'facts', 'missing_information', 'conflicts', 'requires_review'].includes(key))) errors.push('fact snapshot contains unsupported fields');
  if (['grade', 'summary', 'logic', 'matches', 'assessment_status'].some((key) => Object.hasOwn(snapshot, key))) errors.push('fact extraction cannot contain assessment fields');
  if (snapshot.schema_version !== FACT_SCHEMA_VERSION) errors.push('unsupported fact schema version');
  if (snapshot.assessment_type !== assessmentType || !['injury', 'disability'].includes(snapshot.assessment_type)) errors.push('assessment type mismatch');
  if (!Array.isArray(snapshot.facts) || snapshot.facts.length > 200) errors.push('facts must be a bounded array');
  if (!Array.isArray(snapshot.missing_information) || !Array.isArray(snapshot.conflicts) || typeof snapshot.requires_review !== 'boolean') {
    errors.push('missing_information, conflicts, and requires_review are required');
  }
  const ids = new Set();
  const allFactIds = new Set((Array.isArray(snapshot.facts) ? snapshot.facts : []).map((fact) => fact?.id).filter((id) => typeof id === 'string'));
  for (const fact of Array.isArray(snapshot.facts) ? snapshot.facts : []) {
    if (!fact || typeof fact !== 'object' || Array.isArray(fact)) { errors.push('fact must be an object'); continue; }
    if (Object.keys(fact).some((key) => !['id', 'field', 'value', 'certainty', 'source_type', 'source_excerpt', 'derived_from'].includes(key))) errors.push('fact contains unsupported fields');
    if (typeof fact.id !== 'string' || !/^F\d+$/.test(fact.id) || ids.has(fact.id)) errors.push('fact ids must be unique F-number values');
    ids.add(fact.id);
    if (typeof fact.field !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(fact.field)) errors.push('fact field is invalid');
    if (!['reported', 'observed', 'derived', 'uncertain', 'excluded', 'conflicted', 'unknown'].includes(fact.certainty)) errors.push('fact certainty is invalid');
    if (!['user_text', 'medical_record', 'image_observation', 'derived'].includes(fact.source_type)) errors.push('fact source type is invalid');
    if (fact.source_type === 'user_text' || fact.source_type === 'medical_record') {
      if (typeof fact.source_excerpt !== 'string' || !fact.source_excerpt.trim() || fact.source_excerpt.length > 240) errors.push('text facts require a bounded source excerpt');
      else if (!normalizeInput(sourceText).includes(normalizeInput(fact.source_excerpt))) errors.push('source excerpt is not present in supplied text');
    }
    if (fact.source_type === 'image_observation' && (fact.source_excerpt != null || typeof fact.value === 'string' && fact.value.length > 1000)) {
      errors.push('image observations cannot claim exact source quotations');
    }
    if (fact.source_type === 'image_observation' && !hasImage) errors.push('image observations require an image input');
    if (fact.source_type === 'derived' && (!Array.isArray(fact.derived_from) || fact.derived_from.length === 0 || fact.derived_from.some((id) => !allFactIds.has(id) || id === fact.id))) {
      errors.push('derived facts require existing source fact ids');
    }
    if (fact.source_type !== 'derived' && Array.isArray(fact.derived_from) && fact.derived_from.length > 0) errors.push('only derived facts may reference derived_from ids');
    if (!Object.hasOwn(fact, 'value')) errors.push('fact value is required');
    try {
      if (JSON.stringify(fact.value).length > 8000) errors.push('fact value is too large');
    } catch {
      errors.push('fact value is not valid JSON data');
    }
  }
  const factsById = new Map((Array.isArray(snapshot.facts) ? snapshot.facts : []).map((fact) => [fact?.id, fact]));
  const visiting = new Set();
  const visited = new Set();
  function hasDerivedCycle(id) {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const fact = factsById.get(id);
    if (fact?.source_type === 'derived' && Array.isArray(fact.derived_from)) {
      for (const sourceId of fact.derived_from) if (factsById.has(sourceId) && hasDerivedCycle(sourceId)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }
  for (const id of factsById.keys()) if (hasDerivedCycle(id)) { errors.push('derived fact references must be acyclic'); break; }
  for (const field of ['missing_information', 'conflicts']) {
    if (Array.isArray(snapshot[field]) && (snapshot[field].length > 100 || snapshot[field].some((item) => typeof item !== 'string' || item.length > 300))) {
      errors.push(`${field} must contain bounded strings`);
    }
  }
  try {
    if (JSON.stringify(snapshot).length > MAX_FACT_SNAPSHOT_JSON_CHARS) errors.push('fact snapshot is too large');
  } catch {
    errors.push('fact snapshot is not valid JSON data');
  }
  return { ok: errors.length === 0, errors };
}

function validateAssessmentResult(result, { factSnapshot, standard } = {}) {
  const errors = [];
  if (!result || typeof result !== 'object' || Array.isArray(result)) return { ok: false, errors: ['assessment must be an object'] };
  if (Object.keys(result).some((key) => !['grade', 'summary', 'logic', 'matches', 'evidence_fact_ids', 'missing_information', 'assessment_status'].includes(key))) errors.push('assessment contains unsupported fields');
  if (typeof result.grade !== 'string' || !result.grade.trim() || result.grade.length > 80) errors.push('grade is required and bounded');
  for (const key of ['summary', 'logic']) {
    if (typeof result[key] !== 'string' || result[key].length > 6000) errors.push(`${key} is required and bounded`);
  }
  if (!Array.isArray(result.matches) || result.matches.length > 30) errors.push('matches must be a bounded array');
  if (!Array.isArray(result.evidence_fact_ids) || result.evidence_fact_ids.length > 200 || !Array.isArray(result.missing_information) || result.missing_information.length > 100) errors.push('evidence_fact_ids and missing_information are required bounded arrays');
  if (!['sufficient', 'insufficient', 'needs_review'].includes(result.assessment_status)) errors.push('assessment_status is invalid');

  const knownFacts = new Map((factSnapshot?.facts || []).map((fact) => [fact.id, fact]));
  for (const id of Array.isArray(result.evidence_fact_ids) ? result.evidence_fact_ids : []) {
    if (!knownFacts.has(id)) errors.push('assessment references an unknown fact id');
  }
  const standardEntries = new Map((standard?.entries || []).map((entry) => [entry.id, entry]));
  for (const match of Array.isArray(result.matches) ? result.matches : []) {
    if (!match || typeof match !== 'object' || typeof match.standard_id !== 'string' || typeof match.quote !== 'string') {
      errors.push('standard matches require standard_id and quote');
      continue;
    }
    if (Object.keys(match).some((key) => !['standard_id', 'quote'].includes(key))) errors.push('standard match contains unsupported fields');
    const entry = standardEntries.get(match.standard_id);
    if (!entry || !match.quote.trim() || !entry.text.includes(match.quote)) errors.push('standard quote is not verified by the supplied excerpt');
  }
  if (result.assessment_status === 'sufficient') {
    if (!result.evidence_fact_ids?.length) errors.push('sufficient assessments require evidence facts');
    if (!result.matches?.length) errors.push('sufficient assessments require a verified local standard match');
    if ((factSnapshot?.conflicts || []).length || factSnapshot?.requires_review) errors.push('conflicting facts cannot support a sufficient assessment');
    if ((result.evidence_fact_ids || []).some((id) => !['reported', 'observed', 'derived'].includes(knownFacts.get(id)?.certainty))) {
      errors.push('uncertain or excluded facts cannot support a sufficient assessment');
    }
    const assessmentType = factSnapshot?.assessment_type;
    const supportedGrade = assessmentType === 'injury'
      ? /^(?:重伤(?:一级|二级)|轻伤(?:一级|二级)|轻微伤|不构成损伤)$/
      : assessmentType === 'disability'
        ? /^(?:[一二三四五六七八九十]级伤残|不构成伤残)$/
        : null;
    if (!supportedGrade || !supportedGrade.test(result.grade)) errors.push('grade does not match the requested assessment type');
  }
  if (['insufficient', 'needs_review'].includes(result.assessment_status) && !/需补充材料|无法判断|需复核|资料不足/.test(result.grade)) {
    errors.push('insufficient assessments must not claim a grade');
  }
  if (Array.isArray(result.missing_information) && result.missing_information.some((item) => typeof item !== 'string' || item.length > 300)) errors.push('missing_information is invalid');
  return { ok: errors.length === 0, errors };
}

function sniffImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buffer.subarray(0, 2).toString('ascii') === 'BM') return 'image/bmp';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('ascii');
    if (['heic', 'heix', 'hevc', 'hevx'].includes(brand)) return 'image/heic';
    if (['mif1', 'msf1'].includes(brand)) return 'image/heif';
  }
  return null;
}

function hasRecognizableImageStructure(buffer, mimeType) {
  if (mimeType === 'image/jpeg') return buffer.length >= 12 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9;
  if (mimeType === 'image/png') {
    return buffer.length >= 45 && buffer.subarray(12, 16).toString('ascii') === 'IHDR' &&
      buffer.readUInt32BE(16) > 0 && buffer.readUInt32BE(20) > 0 && buffer.subarray(-8, -4).toString('ascii') === 'IEND';
  }
  if (mimeType === 'image/gif') return buffer.length >= 14 && /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('ascii')) && buffer.at(-1) === 0x3b;
  if (mimeType === 'image/webp') return buffer.length >= 20 && buffer.readUInt32LE(4) === buffer.length - 8;
  if (mimeType === 'image/bmp') return buffer.length >= 26 && buffer.readUInt32LE(2) <= buffer.length && buffer.readUInt32LE(18) > 0 && buffer.readUInt32LE(22) > 0;
  if (mimeType === 'image/heic' || mimeType === 'image/heif') return buffer.length >= 16 && buffer.subarray(4, 8).toString('ascii') === 'ftyp';
  return false;
}

function validateImage({ mimeType, data } = {}) {
  if (typeof data !== 'string' || data.length === 0) return { ok: false, error: '图片为空' };
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) return { ok: false, error: '图片格式不受支持' };
  if (data.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4) return { ok: false, error: '图片超过 6 MB 限制' };
  if (data.length % 4 !== 0) return { ok: false, error: '图片编码无效' };
  for (let offset = 0; offset < data.length; offset += 4096) {
    const chunk = data.slice(offset, offset + 4096);
    const isLastChunk = offset + 4096 >= data.length;
    const validChunk = isLastChunk
      ? /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})?$/.test(chunk)
      : /^[A-Za-z0-9+/]+$/.test(chunk);
    if (!validChunk) return { ok: false, error: '图片编码无效' };
  }
  const buffer = Buffer.from(data, 'base64');
  if (buffer.length === 0) return { ok: false, error: '图片为空' };
  if (buffer.length > MAX_IMAGE_BYTES) return { ok: false, error: '图片超过 6 MB 限制' };
  const actualMime = sniffImageMime(buffer);
  if (!actualMime || actualMime !== mimeType) return { ok: false, error: '图片内容与声明的格式不一致或无法识别' };
  if (!hasRecognizableImageStructure(buffer, actualMime)) return { ok: false, error: '图片内容不完整或无法识别' };
  return { ok: true, buffer, mimeType: actualMime, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
}

export {
  FACT_SCHEMA_VERSION,
  MAX_FACT_SNAPSHOT_JSON_CHARS,
  MAX_IMAGE_BYTES,
  SUPPORTED_IMAGE_MIME_TYPES,
  canonicalFacts,
  canonicalFactsHash,
  canonicalMissingMaterials,
  hasRecognizableImageStructure,
  normalizeExtractedFacts,
  normalizeFactExtractionResponse,
  normalizeInput,
  normalizeNeckAsphyxiaFacts,
  normalizeRibFacts,
  parseNumber,
  sourceReferenceMatches,
  sniffImageMime,
  validateAssessmentResult,
  validateFactSnapshot,
  validateImage
};
