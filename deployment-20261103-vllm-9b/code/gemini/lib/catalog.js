import fs from 'node:fs';
import crypto from 'node:crypto';
import MiniSearch from 'minisearch';
import { normalizeImplantedProsthesisDamageFacts, normalizeNeckAsphyxiaFacts } from './facts.js';
import { conditionFactFields } from './condition-fields.js';
import { normalizeForMatching } from './text-normalization.js';

const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
const tokenize = value => [...segmenter.segment(value.normalize('NFKC'))]
  .filter(part => part.isWordLike).map(part => part.segment.toLowerCase());

const rawCatalogs = Object.fromEntries(['injury', 'disability'].map(type => {
  const catalog = JSON.parse(fs.readFileSync(new URL(`../data/${type}.json`, import.meta.url), 'utf8'));
  return [type, catalog];
}));

const clauseLogicMetadata = JSON.parse(fs.readFileSync(new URL('../data/clause-logic-v1.json', import.meta.url), 'utf8'));
const injuryShockDiagnosisPattern = /(?:失血性|低血容量性|创伤性)休克|(?:诊断|确诊|病历记载|出现|发生).{0,10}休克/u;
const facePetechiaeCue = /(?:额部|面部|颜面|眼周|眼睑).{0,20}针尖.{0,6}出血点/u;
const neckMarkCue = /颈部.{0,20}(?:条纹环绕|掐痕|勒痕|皮肤淤紫|出血点)/u;
const facialWoundCue = /(?:(?:面部|脸部|颜面|额部|眉弓|眉部|眼睑|上睑|下睑|面颊|颧部|鼻部|鼻翼|口唇|唇部|下颌)[^。；;\n]{0,36}(?:创口|伤口|裂口|裂创|裂伤|瘢痕)|(?:创口|伤口|裂口|裂创|裂伤|瘢痕)[^。；;\n]{0,36}(?:面部|脸部|颜面|额部|眉弓|眉部|眼睑|上睑|下睑|面颊|颧部|鼻部|鼻翼|口唇|唇部|下颌))/u;

const supplementalClauseMatchers = {
  injury: [
    { id: '5.2.2.d', pattern: /(?:(?:一侧|左|右)(?:侧)?眼(?:球)?(?:已|已经)摘除|(?:一侧|左|右)(?:侧)?眼球缺失|一侧眼球萎缩|(?:行|实施|接受)(?:了)?(?:一侧|单侧|左|右)(?:侧)?眼球摘除术)/u },
    { id: '5.6.2.b', pattern: /心包(?:膜)?[^，,。！？；;\n]{0,24}?(?:破裂|破口|裂口|裂伤|撕裂|裂开|破损|刺破|穿孔)/u },
    { id: '5.7.2.b', pattern: /(?:十二指肠|乙状结肠|小肠|大肠|结肠|直肠|胃壁|胃|胆囊|胆总管|胆管|胆道|肠)[^，,。！？；;\n]{0,24}?(?:全层[^，,。！？；;\n]{0,8}(?:破裂|裂口|裂伤|破口|撕裂)|(?:破裂|裂口|裂伤|破口|撕裂)[^，,。！？；;\n]{0,8}全层)/u },
    { id: '5.12.2.d', pattern: injuryShockDiagnosisPattern },
    { id: '5.12.4.f', pattern: injuryShockDiagnosisPattern },
  ],
};

const normalizeClauseText = normalizeForMatching;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const INJURY_AGE_ADJUSTMENT = 'injury_standard_6_18';
const DISABILITY_AGE_ADJUSTMENT = 'disability_standard_6_11';

function validAgeAdjustment(ageAdjustment, type, clauseText) {
  if (ageAdjustment === INJURY_AGE_ADJUSTMENT) return type === 'injury'
    && (clauseText.includes('体表面积') || /烧烫伤面积[^；。]*cm2/iu.test(clauseText)
      || /(?:瘢痕|疤痕|色素异常)[^；。]*面积[^；。]*cm2/iu.test(clauseText)
      || /头皮[^；。]*(?:创口|瘢痕|缺损|撕脱|擦伤)[^；。]*(?:cm|cm2)/iu.test(clauseText)
      || /(?:皮肤缺损[^；。]*|(?:撕脱伤|擦伤|挫伤)面积[^；。]*)cm2/iu.test(clauseText)
      || /(?:擦伤|挫伤)[^；。]*面积[^；。]*cm2/iu.test(clauseText)
      || /(?:创口|伤口|裂口|裂创|裂伤|划伤|划痕|瘢痕|疤痕)[^；。]{0,20}(?:长度|长)[^；。]*cm/iu.test(clauseText));
  if (ageAdjustment === DISABILITY_AGE_ADJUSTMENT) return type === 'disability'
    && /面部/u.test(clauseText) && /瘢痕|疤痕|色素/u.test(clauseText) && /(?:cm|％|%)/iu.test(clauseText);
  return false;
}

function validateLogicNode(node, clauseText, annotation) {
  if (!isRecord(node) || typeof node.op !== 'string') throw new TypeError('条款逻辑节点格式无效');
  if (node.allowSharedFact != null && (node.op !== 'all' || typeof node.allowSharedFact !== 'boolean')) {
    throw new TypeError('allowSharedFact 只能是 all 组中的布尔值');
  }
  if (node.confirmedBy != null) {
    const { field, valueIncludes, evidenceAliases } = node.confirmedBy;
    if (node.op !== 'not' || !isRecord(node.confirmedBy) || typeof field !== 'string'
      || !/^[a-z][a-z0-9_]{0,63}$/.test(field) || field !== 'diagnosis'
      || !Array.isArray(valueIncludes) || !valueIncludes.length
      || valueIncludes.some(value => typeof value !== 'string' || !value.trim())
      || !Array.isArray(evidenceAliases) || !evidenceAliases.length
      || evidenceAliases.some(alias => typeof alias !== 'string' || !alias.trim())) {
      throw new TypeError('confirmedBy 必须是 not 节点中带来源别名的诊断匹配');
    }
  }
  if (node.sourceText != null && (typeof node.sourceText !== 'string' || !node.sourceText.trim()
    || !normalizeClauseText(clauseText).includes(normalizeClauseText(node.sourceText)))) {
    throw new TypeError('条款逻辑 sourceText 不在官方原文中');
  }
  if (node.op === 'all' || node.op === 'any') {
    if (!Array.isArray(node.children) || node.children.length < 2) throw new TypeError('条款逻辑组至少需要两个子节点');
    for (const child of node.children) validateLogicNode(child, clauseText, annotation);
    return;
  }
  if (node.op === 'not') {
    if (!Array.isArray(node.children) || node.children.length !== 1) throw new TypeError('not 节点必须恰有一个子节点');
    for (const child of node.children) validateLogicNode(child, clauseText, annotation);
    return;
  }
  if (node.op !== 'condition' || typeof node.sourceText !== 'string' || typeof node.conditionText !== 'string'
    || !node.conditionText.trim()) throw new TypeError('条款 condition 节点格式无效');
  if (annotation === 'opaque') return;
  if (node.ageAdjustment != null && (!validAgeAdjustment(node.ageAdjustment,
    node.ageAdjustment === INJURY_AGE_ADJUSTMENT ? 'injury' : 'disability', clauseText)
    || !/%|％|cm/iu.test(`${node.sourceText} ${node.conditionText}`)
      && node.sourceText !== '面积低于上述程度'
    || !['clinical_finding', 'contusion_tbsa_percent', 'burn_tbsa_ii_plus_percent',
      'burn_tbsa_deep_ii_plus_percent', 'burn_tbsa_iii_percent', 'burn_area_face_first_degree_cm2',
      'burn_area_neck_first_degree_cm2', 'burn_area_neck_superficial_second_degree_cm2',
      'burn_area_body_first_degree_cm2', 'burn_area_body_superficial_second_degree_cm2',
      'facial_skin_abnormality_area_cm2', 'aggregate_wound_length_cm', 'scalp_defect_area_cm2',
      'facial_skin_abnormality_area_percent',
      'facial_scar_width_cm', 'aggregate_facial_scar_length_cm', 'facial_center_scar_length_cm',
      'scalp_avulsion_area_cm2', 'skin_avulsion_area_cm2', 'skin_defect_area_cm2',
      'skin_abrasion_area_cm2', 'skin_contusion_area_cm2', 'scalp_abrasion_area_cm2', 'wound_length_cm',
      'lip_through_wound_length_cm', 'surface_scar_area_cm2', 'aggregate_surface_scar_area_cm2']
      .includes(node.factMatch?.field || node.predicate?.field)
    || annotation !== 'explicit')) {
    throw new TypeError('年龄调整标记只能用于显式量化伤情或面部瘢痕条款');
  }
  const hasFactMatch = isRecord(node.factMatch);
  const hasPredicate = isRecord(node.predicate);
  if (hasFactMatch === hasPredicate) throw new TypeError('显式条件必须且只能配置 factMatch 或 predicate');
  if (hasFactMatch) {
    const exactValues = node.factMatch.values;
    const includedValues = node.factMatch.valueIncludes;
    const compatibleFields = node.factMatch.fields;
    const hasExactValues = Array.isArray(exactValues) && exactValues.length > 0;
    const hasIncludedValues = Array.isArray(includedValues) && includedValues.length > 0;
    if (typeof node.factMatch.field !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(node.factMatch.field)
      || compatibleFields != null && (!Array.isArray(compatibleFields) || compatibleFields.length === 0
        || compatibleFields.some(field => typeof field !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(field)
          || field === node.factMatch.field) || new Set(compatibleFields).size !== compatibleFields.length)
      || !hasExactValues && !hasIncludedValues
      || hasExactValues && exactValues.some(value => value === null || typeof value === 'object')
      || hasIncludedValues && includedValues.some(value => typeof value !== 'string' || !value.trim())
      || hasIncludedValues && !['diagnosis', 'symptom', 'treatment', 'imaging_finding', 'clinical_finding',
        'functional_impairment'].includes(node.factMatch.field)
      || node.factMatch.evidenceAliases != null && (!Array.isArray(node.factMatch.evidenceAliases)
        || node.factMatch.evidenceAliases.some(alias => typeof alias !== 'string' || !alias.trim()))) {
      throw new TypeError('条款 factMatch 字段或值无效');
    }
    if (node.factMatch.field === 'clinical_finding' && hasExactValues
      && exactValues.some(value => typeof value !== 'string'
        || !normalizeClauseText(value).includes(normalizeClauseText(node.sourceText)))) {
      throw new TypeError('clinical_finding matcher 必须包含官方 sourceText');
    }
  }
  if (hasPredicate) {
    const { field, operator, value, unit } = node.predicate;
    if (typeof field !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(field)
      || node.predicate.fields != null && (!Array.isArray(node.predicate.fields) || node.predicate.fields.length === 0
        || node.predicate.fields.some(candidate => typeof candidate !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(candidate)
          || candidate === field) || new Set(node.predicate.fields).size !== node.predicate.fields.length)
      || !['eq', 'gt', 'gte', 'lt', 'lte'].includes(operator)
      || typeof value !== 'number' || !Number.isFinite(value)
      || unit != null && typeof unit !== 'string'
      || node.predicate.evidenceGroups != null && (!Array.isArray(node.predicate.evidenceGroups)
        || node.predicate.evidenceGroups.length === 0
        || node.predicate.evidenceGroups.some(group => !Array.isArray(group) || group.length === 0
          || group.some(alias => typeof alias !== 'string' || !alias.trim())))) {
      throw new TypeError('条款 predicate 无效');
    }
  }
}

export function applyClauseLogicMetadata(catalogs, metadata) {
  if (!isRecord(metadata) || metadata.version !== 1 || !isRecord(metadata.clauses)) {
    throw new TypeError('条款逻辑元数据版本或结构无效');
  }
  for (const type of Object.keys(metadata.clauses)) {
    if (!Object.hasOwn(catalogs, type) || !isRecord(metadata.clauses[type])) throw new TypeError(`未知条款元数据类型：${type}`);
    const knownIds = new Set(catalogs[type].clauses.map(clause => clause.id));
    for (const [id, entry] of Object.entries(metadata.clauses[type])) {
      if (!knownIds.has(id)) throw new TypeError(`未知条款 ID：${id}`);
      if (!isRecord(entry) || !['explicit', 'opaque'].includes(entry.annotation) || !entry.logic) throw new TypeError(`条款 ${id} 元数据标记无效`);
      const clause = catalogs[type].clauses.find(item => item.id === id);
      if (entry.ageAdjustment != null && !validAgeAdjustment(entry.ageAdjustment, type, clause.text)) {
        throw new TypeError(`条款 ${id} 的年龄调整标记无效`);
      }
      if (entry.annotation === 'opaque' && (typeof entry.reason !== 'string' || !entry.reason.trim())) {
        throw new TypeError(`条款 ${id} 的 opaque 标记必须记录具体原因`);
      }
      validateLogicNode(entry.logic, clause.text, entry.annotation);
      if (entry.annotation === 'opaque' && (entry.logic.op !== 'condition'
        || normalizeClauseText(entry.logic.sourceText) !== normalizeClauseText(clause.text))) {
        throw new TypeError(`条款 ${id} 的 opaque 原文锚点必须覆盖完整条文`);
      }
      const displayGroups = entry.logic.op === 'all' ? entry.logic.children : [entry.logic];
      if (displayGroups.some(group => ![group.conditionText, group.sourceText]
        .some(text => typeof text === 'string' && text.trim()))) {
        throw new TypeError(`条款 ${id} 的逻辑显示组缺少可读原文`);
      }
    }
  }
  return Object.fromEntries(Object.entries(catalogs).map(([type, catalog]) => [type, {
    ...catalog,
    clauses: catalog.clauses.map(clause => {
      const explicit = metadata.clauses[type]?.[clause.id];
      return { ...clause, conditionLogic: explicit || {
        annotation: 'opaque',
        reason: '当前目录未配置经校核的条件树或逐条保留原因。',
        logic: { op: 'condition', sourceText: clause.text, conditionText: clause.text },
      } };
    }),
  }]));
}

export const catalogs = applyClauseLogicMetadata(rawCatalogs, clauseLogicMetadata);
export const RULES_VERSION = crypto.createHash('sha256').update(JSON.stringify(catalogs), 'utf8').digest('hex');

const indexes = Object.fromEntries(Object.entries(catalogs).map(([type, catalog]) => {
  const index = new MiniSearch({ fields: ['text', 'category'], storeFields: ['id'], tokenize });
  index.addAll(catalog.clauses);
  return [type, index];
}));

function clauseMatchesFacts(clause, facts) {
  const matchesFactMatch = (factMatch, predicate) => {
    const fields = conditionFactFields(factMatch, predicate);
    if (!fields.size) return false;
    const values = [...(factMatch?.values || []), ...(factMatch?.valueIncludes || [])];
    const aliases = factMatch?.evidenceAliases || [];
    return facts.some(fact => {
      if (!fields.has(fact.field)) return false;
      if (predicate && !factMatch) return true;
      const factValues = Array.isArray(fact.value) ? fact.value : [fact.value];
      const normalizedValues = factValues.filter(value => typeof value === 'string').map(normalizeClauseText);
      const exact = values.some(value => factValues.some(item => JSON.stringify(item) === JSON.stringify(value)));
      const included = (factMatch?.valueIncludes || []).some(alias => normalizedValues.some(value => value.includes(normalizeClauseText(alias))));
      const quotedAlias = aliases.some(alias => normalizeClauseText(String(fact.evidence || '')).includes(normalizeClauseText(alias)));
      return exact || included || quotedAlias;
    });
  };
  const matchesNode = node => {
    if (matchesFactMatch(node.factMatch, node.predicate) || matchesFactMatch(node.confirmedBy)) return true;
    return (node.children || []).some(matchesNode);
  };
  return clause.conditionLogic.annotation === 'opaque'
    ? false
    : matchesNode(clause.conditionLogic.logic);
}

export function retrieveClauses(type, description, limit = 40, facts = []) {
  const catalog = catalogs[type];
  const matches = indexes[type].search(description, { combineWith: 'OR', boost: { text: 2 } });
  const ids = new Set(matches.slice(0, limit).map(match => match.id));
  if (Array.isArray(facts) && facts.length) {
    for (const clause of catalog.clauses) if (clauseMatchesFacts(clause, facts)) ids.add(clause.id);
  }
  for (const matcher of supplementalClauseMatchers[type] || []) {
    if (matcher.pattern.test(description)) ids.add(matcher.id);
  }
  if (type === 'injury' && facialWoundCue.test(description)) {
    ids.add('5.2.3.a');
    ids.add('5.2.4.a');
  }
  if (type === 'injury' && normalizeNeckAsphyxiaFacts(description).length) ids.add('5.5.4.h');
  if (type === 'injury' && facePetechiaeCue.test(description) && neckMarkCue.test(description)) {
    ids.add('5.5.4.h');
    ids.add('5.12.4.g');
  }
  if (type === 'injury' && normalizeImplantedProsthesisDamageFacts(description).length) ids.add('5.12.4.l');
  return catalog.clauses.filter(clause => ids.has(clause.id));
}

export function catalogContext(type, clauses) {
  const { standard, principles } = catalogs[type];
  return JSON.stringify({ standard, principles, clauses });
}
