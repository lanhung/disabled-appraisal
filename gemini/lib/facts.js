import crypto from 'node:crypto';
import { factExtractionSchema } from './contracts.js';

const FACT_SCHEMA_VERSION = '1.0';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_FACT_SNAPSHOT_JSON_CHARS = 250_000;
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

function certaintyFor(text, start, end) {
  const context = text.slice(start, Math.min(text.length, end));
  if (hasUnresolvedOtherExperiencer(context) || /若(?!干)|如果|假如|倘若|一旦|假设|如有|如出现|如发生|必要时/.test(context)) return 'unknown';
  if (/不排除|不能排除|疑似|怀疑|考虑|可能|待排|待查/.test(context)) return 'uncertain';
  if (/排除|未见|未发现|不存在|没有|阴性|否认|无(?=(?:第\s*[0-9零〇一二两三四五六七八九十百]+\s*)?肋骨|骨折)/.test(context)) return 'excluded';
  return 'reported';
}

function hasUnresolvedOtherExperiencer(text) {
  const otherSubject = /(?:患者的?父亲|患者的?母亲|其父|其母|家属|父亲|母亲|丈夫|妻子|他人|其他人|另一个人|同事)/g;
  const patient = /(?:患者|受检者|伤者|被鉴定人|本人)/;
  const condition = /(?:骨折|受伤|损伤|诊断|影像|症状|疼痛|腰痛|头痛|胸痛|腹痛|麻木|肿胀|障碍|咳嗽|呼吸困难|瘫痪)/;
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

function historicalSectionHeading(text, start) {
  const historicalTitles = new Set(['既往史', '既往病史', '既往疾病史', '既往损伤史', '既往外伤史']);
  const sectionTitles = [...historicalTitles, '现病史', '主诉', '病程记录', '诊断', '检查结果', '影像学检查',
    '体格检查', '查体', '治疗经过', '手术史', '出院记录', '入院记录'].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`(?:^|\\n)[ \\t]*(${sectionTitles.join('|')})[ \\t]*[:：]?[ \\t]*(?=\\n|$)`, 'g');
  const heading = [...text.slice(0, start).matchAll(pattern)].at(-1);
  if (!heading || !historicalTitles.has(heading[1])) return null;
  return { start: heading.index + heading[0].indexOf(heading[1]) };
}

function normalizeRibFacts(inputText) {
  const text = normalizeInput(inputText);
  const facts = [];
  let cachedRibClause = null;
  let cachedRibClauseHasFracture = false;
  const pattern = /肋骨/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
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
    const ordinal = prefix.match(/第\s*[0-9零〇一二两三四五六七八九十百]+(?:(?:\s*(?:根|条))?\s*(?:、|，|,|和|及|与)\s*(?:第\s*)?[0-9零〇一二两三四五六七八九十百]+(?:\s*(?:根|条))?)*\s*(?:根|条)?$/);
    const count = prefix.match(/(?:共|累计)?\s*([0-9零〇一二两三四五六七八九十百]+)\s*(根|条)$/);
    const sideMatch = [...prefix.matchAll(/(?:左侧|左边|右侧|右边|双侧)/g)].at(-1);
    const segment = `${sideMatch?.[0] || ''}${ordinal?.[0] || count?.[0] || ''}`;
    const fractureEnd = text.indexOf('骨折', pattern.lastIndex);
    const assertionEnd = fractureEnd >= 0 && fractureEnd < clauseEnd ? fractureEnd + 2 : clauseEnd;
    const assertionContext = text.slice(clauseStart, assertionEnd);
    const temporalCues = [...assertionContext.matchAll(/既往(?:史)?|曾经|曾有|陈旧性?|旧伤|本次(?:事故后)?|此次(?:事故后)?|当前|目前/g)];
    const latestTemporalCue = temporalCues.at(-1);
    const latestCueIsCurrent = latestTemporalCue && /^(?:本次|此次|当前|目前)/.test(latestTemporalCue[0]);
    const certaintyStart = latestCueIsCurrent ? clauseStart + latestTemporalCue.index + latestTemporalCue[0].length : clauseStart;
    const certainty = certaintyFor(text, certaintyStart, assertionEnd);
    const side = /左侧|左边/.test(sideMatch?.[0] || '') ? 'left' : /右侧|右边/.test(sideMatch?.[0] || '') ? 'right' : /双侧/.test(sideMatch?.[0] || '') ? 'bilateral' : null;
    const numberTokens = [...(ordinal?.[0] || count?.[0] || '').matchAll(/(?:第\s*)?([0-9零〇一二两三四五六七八九十百]+)/g)]
      .map((item) => parseNumber(item[1]))
      .filter((number) => Number.isInteger(number) && number > 0);
    const isRibCount = Boolean(count && !ordinal);
    const prefixStart = match.index - prefix.length;
    const sourceStarts = [sideMatch?.index, ordinal?.index, count?.index].filter((index) => Number.isInteger(index));
    let excerptStart = prefixStart + (sourceStarts.length ? Math.min(...sourceStarts) : prefix.length);
    const qualifierMatches = [...prefix.matchAll(/不排除|不能排除|疑似|怀疑|考虑|可能|待排|待查|若(?!干)|如果|假如|倘若|一旦|假设|如有|如出现|如发生|必要时|排除|未见|未发现|不存在|没有|无(?=(?:第\s*[0-9零〇一二两三四五六七八九十百]+\s*)?肋骨|骨折)/g)];
    if (qualifierMatches.length) excerptStart = Math.min(excerptStart, prefixStart + qualifierMatches.at(-1).index);
    const following = text.slice(pattern.lastIndex, Math.min(text.length, pattern.lastIndex + 36));
    const excerptEndOffset = following.search(/[。；;，,\n]/);
    const excerptEnd = excerptEndOffset < 0 ? pattern.lastIndex + Math.min(following.length, 20) : pattern.lastIndex + excerptEndOffset;
    const historicalExcerpt = historicalHeading ? text.slice(historicalHeading.start, excerptEnd).trim() : '';
    const historicalEvidenceTooLong = historicalExcerpt.length > 1000;
    const sourceExcerpt = historicalHeading && !historicalEvidenceTooLong ? historicalExcerpt
      : text.slice(excerptStart, excerptEnd).trim();
    const sentenceStart = Math.max(text.lastIndexOf('。', match.index), text.lastIndexOf('；', match.index),
      text.lastIndexOf(';', match.index), text.lastIndexOf('\n', match.index), text.lastIndexOf('!', match.index),
      text.lastIndexOf('！', match.index), text.lastIndexOf('?', match.index), text.lastIndexOf('？', match.index)) + 1;
    const sentenceTail = text.slice(pattern.lastIndex);
    const sentenceEndOffset = sentenceTail.search(/[。；;\n!?！？]/);
    const sentenceEnd = sentenceEndOffset < 0 ? text.length : pattern.lastIndex + sentenceEndOffset;
    const sentenceText = text.slice(sentenceStart, sentenceEnd);
    const sentenceFollowing = text.slice(pattern.lastIndex, sentenceEnd);
    // A sentence total can cover several rib mentions, but never infer its scope across another fracture site.
    const sentenceClauses = sentenceText.split(/[，,、]/);
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
      /(?:^|[，,、])\s*(?:共|累计)\s*([0-9零〇一二两三四五六七八九十百]+)\s*处(?=骨折)/g)];
    const ordinalPattern = /第\s*[0-9零〇一二两三四五六七八九十百]+(?:(?:\s*(?:根|条))?\s*(?:、|，|,|和|及|与)\s*(?:第\s*)?[0-9零〇一二两三四五六七八九十百]+(?:\s*(?:根|条))?)*\s*(?:根|条)?肋骨/g;
    const sentenceRibNumbers = new Set([...sentenceText.matchAll(ordinalPattern)].flatMap(item =>
      [...item[0].matchAll(/(?:第\s*)?([0-9零〇一二两三四五六七八九十百]+)/g)]
        .map(number => parseNumber(number[1])).filter(number => Number.isInteger(number) && number > 0)));
    const aggregateCountCoversMultipleRibs = aggregateSiteCounts.length === 1 && sentenceRibNumbers.size > 1;
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
      const derivedCertainty = ['reported', 'observed'].includes(certainty) ? 'derived' : certainty;
      if (!(aggregateCountCoversMultipleRibs && numberTokens.length === 1)) {
        add('fractured_rib_count', ribNumbersFact.value.length, derivedCertainty, 'derived', [ribNumbersFact.id]);
      }
    }

    const explicitSiteCount = aggregateSiteCounts.length === 1 ? aggregateSiteCounts[0]
      : following.match(/^\s*(?:骨折\s*[，,、]?\s*)?[，,、]?\s*(?:共|累计)?\s*([0-9零〇一二两三四五六七八九十百]+)\s*处/)
        || clauseText.match(/(?:共|累计)?\s*([0-9零〇一二两三四五六七八九十百]+)\s*处(?=\s*(?:肋骨\s*)?骨折)/);
    if (explicitSiteCount) {
      const siteCountFact = add('fracture_site_count', parseNumber(explicitSiteCount[1]));
      siteCountFact.source_excerpt = `${explicitSiteCount[1]}处`;
    }
  }
  return facts;
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
  if (/不排除|不能排除|疑似|怀疑|考虑|可能|待排|待查/.test(evidence)) return 'uncertain';
  if (/排除|未见|未发现|不存在|阴性|否认/.test(evidence)) return 'excluded';
  return ['reported', 'observed', 'derived', 'conflicted', 'unknown'].includes(proposed) ? proposed : 'reported';
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

function sourceClause(sourceText, evidence) {
  const text = normalizeInput(sourceText || '');
  const quote = normalizeInput(evidence || '');
  if (!quote) return '';
  const index = text.indexOf(quote);
  if (index < 0) return '';
  const left = Math.max(text.lastIndexOf('。', index), text.lastIndexOf('；', index), text.lastIndexOf(';', index), text.lastIndexOf('，', index), text.lastIndexOf(',', index), text.lastIndexOf('\n', index)) + 1;
  const tail = text.slice(index);
  const endOffset = tail.search(/[。；;，,\n]/);
  const right = endOffset < 0 ? text.length : index + endOffset;
  return text.slice(left, right).trim();
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
  if (source === 'description') return [{ source, sourceId: 'description', evidence: quote }];
  const matchingPages = imageTextSections(sourceText).filter(page => normalizeInput(page.text).includes(quote));
  if (matchingPages.length) return matchingPages.map(page => ({ source: 'image', sourceId: page.sourceId, evidence: quote }));
  return [{ source: 'image', sourceId: null, evidence: quote }];
}

function mergeSourceRefs(...referenceLists) {
  const references = new Map();
  for (const reference of referenceLists.flat()) {
    const key = JSON.stringify([reference.source, reference.sourceId, reference.evidence]);
    references.set(key, reference);
  }
  return [...references.values()];
}

function sourceReferenceMatches(reference, { description = '', recognizedText = '' } = {}) {
  const quote = normalizeInput(reference?.evidence);
  if (!quote) return false;
  if (reference.source === 'description') {
    return (reference.sourceId === 'description' || reference.sourceId === null)
      && normalizeInput(description).includes(quote);
  }
  if (reference.source !== 'image') return false;
  if (reference.sourceId === null) return normalizeInput(recognizedText).includes(quote);
  return imageTextSections(recognizedText).some(page => page.sourceId === reference.sourceId
    && normalizeInput(page.text).includes(quote));
}

function hasSingleExplicitCurrentRibEvent(text) {
  const normalized = normalizeInput(text || '');
  const currentCues = [...normalized.matchAll(/(?:本次|此次|当前)(?:事故|外伤|受伤|损伤)(?:后)?/g)];
  const eventMentions = [...normalized.matchAll(/事故|外伤|受伤/g)];
  if (currentCues.length !== 1 || eventMentions.length !== 1) return false;
  const affirmativePriorRibInjury = normalized.split(/[。；;\n]/).some(clause =>
    /(?:既往(?:史)?|曾经|曾有|陈旧性?|旧伤)/.test(clause)
      && /(?:肋骨|骨折|损伤)/.test(clause)
      && !/(?:没有|无|未见|未发现|排除|否认)/.test(clause));
  return !affirmativePriorRibInjury;
}

function factFinding(field, value, certainty) {
  const labels = {
    injury_type: '损伤类型', laterality: '侧别', fractured_rib_numbers: '骨折肋骨序号',
    fractured_rib_count: '骨折肋骨根数', fracture_site_count: '骨折处数', symptom: '症状',
    diagnosis: '诊断', imaging_finding: '影像检查结果', treatment: '治疗情况',
    functional_impairment: '功能情况', prior_injury: '既往损伤',
  };
  const displayValue = Array.isArray(value) ? value.join('、') : (typeof value === 'object' ? JSON.stringify(value) : String(value ?? ''));
  const qualifier = certainty === 'uncertain' ? '（疑似/待核实）' : certainty === 'excluded' ? '（已排除）' : certainty === 'conflicted' ? '（存在冲突）' : '';
  return `${labels[field] || field}：${displayValue}${qualifier}`.slice(0, 1000);
}

function isRibAlias(field) {
  return /rib|fractur|骨折|affected_side|laterality/i.test(field);
}

function canonicalField(field) {
  const value = String(field || '').trim().normalize('NFKC').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  if (/^(?:left_chest_pain|subjective_complaint|complaint|pain|symptom)$/.test(value) || /(?:_pain|_symptom)$/.test(value)) return 'symptom';
  if (/^(?:affected_side|body_side)$/.test(value)) return 'laterality';
  return /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : 'other';
}

function stableFactKey(fact) {
  return JSON.stringify([fact.field, fact.value, fact.certainty, fact.source, fact.evidence, fact.eventId || null]);
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

function normalizeExtractedFacts(value, { description = '', recognizedText = '' } = {}) {
  const raw = factExtractionSchema.parse(normalizeFactExtractionResponse(value));
  const rawFactIds = new Set(raw.facts.map(fact => fact.id).filter(Boolean));
  for (const conflict of raw.conflicts) {
    if (conflict.factIds.length === 1 || conflict.factIds.some(id => !rawFactIds.has(id))) {
      throw new Error('冲突引用了不存在或不足两个的事实 ID');
    }
  }
  const sourceTexts = { description: normalizeInput(description), image: normalizeInput(recognizedText) };
  const facts = [];
  const rawIdToKeys = new Map();
  let invalidEvidence = false;
  let invalidEventLink = false;
  let unsupportedSiteCount = false;
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
  const inferredEventIds = { description: inferredDescriptionEventId };
  const addFact = (fact, rawId = null) => {
    const key = stableFactKey(fact);
    const existing = facts.find(item => stableFactKey(item) === key);
    const target = existing || fact;
    if (!existing) facts.push(target);
    target.sourceRefs = mergeSourceRefs(target.sourceRefs || [], fact.sourceRefs || []);
    if (rawId) {
      target.rawIds ||= [];
      target.rawIds.push(rawId);
      rawIdToKeys.set(rawId, new Set([...(rawIdToKeys.get(rawId) || []), key]));
    }
    return target;
  };
  const mapRawIdToRelatedRibFacts = (rawId, source, evidence, certainty, eventId = null) => {
    if (!rawId && !eventId) return false;
    const related = facts.filter(item => item.source === source && item.certainty === certainty
      && item.evidence === evidence && ribFields.has(item.field));
    if (!related.length || related.some(fact => fact.eventId && fact.eventId !== eventId
      || !eventId && fact.eventId)) {
      if (related.length) invalidEventLink = true;
      return false;
    }
    for (const fact of related) {
      if (eventId) fact.eventId = eventId;
      fact.rawIds ||= [];
      if (rawId && !fact.rawIds.includes(rawId)) fact.rawIds.push(rawId);
      if (rawId) rawIdToKeys.set(rawId, new Set([...(rawIdToKeys.get(rawId) || []), stableFactKey(fact)]));
    }
    return true;
  };

  const deterministicFacts = [];
  for (const [source, sourceText] of Object.entries(sourceTexts)) {
    for (const fact of [...normalizeRibFacts(sourceText), ...normalizeGenericNegativeFractureFacts(sourceText)]) {
      const excerpt = fact.field === 'prior_injury' && fact.source_excerpt.includes('\n') ? fact.source_excerpt
        : sourceClause(sourceText, fact.source_excerpt) || fact.source_excerpt;
      deterministicFacts.push({
        ...(fact.id ? { parserId: fact.id } : {}), field: fact.field, value: stableJson(fact.value),
        certainty: fact.certainty, source, evidence: excerpt, sourceRefs: sourceRefsForFact(source, excerpt, sourceText),
        ...(fact.source_type === 'derived' && fact.derived_from ? { parserDerivedFrom: fact.derived_from } : {}),
      });
    }
  }
  for (const fact of deterministicFacts) {
    let evidence = fact.field === 'prior_injury' && fact.evidence.includes('\n') ? fact.evidence
      : sourceClause(sourceTexts[fact.source], fact.evidence) || fact.evidence;
    if (!evidence && fact.parserDerivedFrom?.length) {
      const parent = deterministicFacts.find(item => item.parserId === fact.parserDerivedFrom[0]);
      evidence = parent ? sourceClause(sourceTexts[parent.source], parent.evidence) || parent.evidence : '';
    }
    addFact({ ...fact, ...(ribFields.has(fact.field) && inferredEventIds[fact.source]
      ? { eventId: inferredEventIds[fact.source] } : {}), evidence,
    sourceRefs: sourceRefsForFact(fact.source, evidence, sourceTexts[fact.source]),
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
    const fullEvidence = sourceFact.field === 'fracture_site_count' ? providedEvidence
      : sourceClause(sourceTexts[source], providedEvidence) || providedEvidence;
    let certainty = canonicalCertainty(fullEvidence, sourceFact.certainty);
    let field = canonicalField(sourceFact.field);
    let value = stableJson(sourceFact.value);
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
    const eventId = ribRelatedRawFact && inferredEventIds[source]
      ? inferredEventIds[source] : sourceFact.eventId || null;
    const historicalRibFact = field !== 'fracture_site_count' && ribRelatedRawFact && (Boolean(priorFact)
      || /(?:既往(?:史)?|曾经|曾有|陈旧性?|旧伤)/.test(fullEvidence) && /骨折|fracture/i.test(fullEvidence));
    if (historicalRibFact) {
      if (priorFact && sourceFact.id) {
        if (sourceFact.eventId && priorFact.eventId && sourceFact.eventId !== priorFact.eventId) invalidEventLink = true;
        else if (sourceFact.eventId) priorFact.eventId = sourceFact.eventId;
        priorFact.rawIds ||= [];
        if (!priorFact.rawIds.includes(sourceFact.id)) priorFact.rawIds.push(sourceFact.id);
        rawIdToKeys.set(sourceFact.id, new Set([...(rawIdToKeys.get(sourceFact.id) || []), stableFactKey(priorFact)]));
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

    if (field === 'other' && value && typeof value === 'object' && !Array.isArray(value)
      && typeof value.statement === 'string'
      && normalizeInput(fullEvidence).includes(normalizeInput(value.statement))) {
      value = normalizeInput(value.statement);
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
        const symptomClause = sourceClause(sourceTexts[source], symptomQuote);
        const siteClause = sourceClause(sourceTexts[source], providedEvidence);
        return Boolean(symptomClause && symptomClause === siteClause
          && normalizeInput(fullEvidence).includes(normalizeInput(value)));
      });
    if (repeatsSameClauseSymptomSite) continue;

    if (field === 'anatomical_site' && typeof value === 'string' && /肋骨/.test(value) && !/肋骨/.test(fullEvidence)) {
      invalidEvidence = true;
      continue;
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
      if (/^(?:left|左|左侧|左边)$/.test(side)) value = 'left';
      else if (/^(?:right|右|右侧|右边)$/.test(side)) value = 'right';
      else if (/^(?:bilateral|both|双侧)$/.test(side)) value = 'bilateral';
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
    if (field === 'symptom') value = fullEvidence;
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

  const deduplicatedFacts = new Map();
  for (const fact of facts) {
    const key = stableFactKey(fact);
    const existing = deduplicatedFacts.get(key);
    if (!existing) {
      deduplicatedFacts.set(key, fact);
      continue;
    }
    existing.rawIds = [...new Set([...(existing.rawIds || []), ...(fact.rawIds || [])])];
    existing.sourceRefs = mergeSourceRefs(existing.sourceRefs || [], fact.sourceRefs || []);
    if (!existing.parserId && fact.parserId) existing.parserId = fact.parserId;
    if (!existing.parserDerivedFrom && fact.parserDerivedFrom) existing.parserDerivedFrom = fact.parserDerivedFrom;
  }
  facts.splice(0, facts.length, ...deduplicatedFacts.values());
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
  }
  const conflictsByIds = new Map();
  let unlinkedModelConflict = false;
  const addConflict = ids => {
    const merged = new Set([...new Set(ids)].filter(id => facts.some(fact => fact.id === id)));
    let overlaps = true;
    while (overlaps) {
      overlaps = false;
      for (const [key, existing] of conflictsByIds) {
        if (existing.some(id => merged.has(id))) {
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
    const mapped = conflict.factIds.flatMap(id => rawIdToFinalIds.get(id) || []);
    const uniqueMapped = [...new Set(mapped)];
    const byEvent = new Map();
    for (const id of uniqueMapped) {
      const eventId = facts.find(fact => fact.id === id)?.eventId || '';
      byEvent.set(eventId, [...(byEvent.get(eventId) || []), id]);
    }
    let linkedConflict = false;
    for (const ids of byEvent.values()) {
      if (ids.length >= 2) { addConflict(ids); linkedConflict = true; }
    }
    const hasUnknownEvent = byEvent.has('');
    if (uniqueMapped.length < 2 && conflict.reason
      || hasUnknownEvent && byEvent.size > 1 && !linkedConflict) unlinkedModelConflict = true;
  }
  for (const field of ['injury_type', 'diagnosis', 'fractured_rib_count', 'fracture_site_count', 'laterality']) {
    const group = facts.filter(fact => fact.field === field);
    for (let i = 0; i < group.length; i += 1) for (let j = i + 1; j < group.length; j += 1) {
      const left = group[i], right = group[j];
      if (left.eventId && right.eventId && left.eventId !== right.eventId) continue;
      const sameValue = JSON.stringify(left.value) === JSON.stringify(right.value);
      const certaintyConflict = sameValue && new Set([left.certainty, right.certainty]).has('uncertain')
        && new Set([left.certainty, right.certainty]).has('excluded');
      const fractureSpecificityConflict = field === 'injury_type' && !sameValue
        && new Set([left.certainty, right.certainty]).has('uncertain')
        && new Set([left.certainty, right.certainty]).has('excluded')
        && new Set([left.value, right.value]).has('fracture')
        && new Set([left.value, right.value]).has('rib_fracture');
      const conflictingCount = ['fractured_rib_count', 'fracture_site_count'].includes(field)
        && !sameValue && /报告|病历|复查|检查/.test(left.evidence) && /报告|病历|复查|检查/.test(right.evidence);
      if (certaintyConflict || fractureSpecificityConflict || conflictingCount) addConflict([left.id, right.id]);
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

  const unlinkedFractureStatusDisagreement = facts.some((left, index) => facts.slice(index + 1).some(right => {
    const fractureValues = new Set(['fracture', 'rib_fracture']);
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
  const extractionWarnings = invalidEvidence
    ? ['事实提取中有内容缺少可回查原文，已忽略，未作为评估依据。'] : [];
  if (unsupportedSiteCount && !hasExplicitFractureSiteCount) missingMaterials.push('骨折处数未在原文中明确记载，需核实');
  const uniqueMissing = [...new Set(missingMaterials)].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const hasUncertain = facts.some(fact => ['uncertain', 'unknown', 'conflicted'].includes(fact.certainty));
  const ambiguousInjuryTypeShape = facts.some(fact => fact.field === 'injury_type' && typeof fact.value !== 'string');
  const requiresReview = conflicts.length > 0 || hasUncertain || invalidEventLink
    || unlinkedFractureStatusDisagreement || ambiguousInjuryTypeShape;
  return { facts: facts.map(({ rawIds, parserId, parserDerivedFrom, ...fact }) => fact), missingMaterials: uniqueMissing,
    conflicts, requiresReview, warnings: extractionWarnings };
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
  if (data.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4) return { ok: false, error: '图片超过 8 MB 限制' };
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
  if (buffer.length > MAX_IMAGE_BYTES) return { ok: false, error: '图片超过 8 MB 限制' };
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
  normalizeRibFacts,
  parseNumber,
  sourceReferenceMatches,
  sniffImageMime,
  validateAssessmentResult,
  validateFactSnapshot,
  validateImage
};
