import { providerResultSchema, resultSchema } from './contracts.js';
import { catalogs } from './catalog.js';
import { conditionFactFields, logicFactFields } from './condition-fields.js';
import { evaluateConditionTree, factDateKeys, uniqueEvidenceText } from './condition-logic.js';
import { reliableCertainties } from './fact-certainty.js';
import { quotedPredicateEvidenceValue } from './numeric-evidence.js';
import { includesNormalizedText, normalizeForMatching } from './text-normalization.js';
import { canonicalMissingMaterials, confirmsSixWeekUnhealedTympanicPerforation, normalizeNeckAsphyxiaFacts,
  explicitScalpScarCountTotal, findExplicitOpenSkullDuralDiagnoses, hasSupportedOpenSkullDuralRuptureEvidence,
  hasExplicitOrbitalFractureEnophthalmosLink, isCanonicalCardiacRuptureEvidence, normalizeMuscleStrengthFacts,
  hasExplicitLimbLengthDifferenceLink, hasVerifiedModerateShockEvidence, parseNumber, quotedDentalDefectCount,
  sourceReferenceMatches, hasSameEyeInjuryContext } from './facts.js';
import { eventDateAnchorsConflict, eventIdForSelectedInjuryDate, parseEventDateAnchors } from './event-date-logic.js';

export const gradeOrder = {
  injury: Object.freeze(['重伤一级', '重伤二级', '轻伤一级', '轻伤二级', '轻微伤']),
  disability: Object.freeze(['一级伤残', '二级伤残', '三级伤残', '四级伤残', '五级伤残', '六级伤残', '七级伤残', '八级伤残', '九级伤残', '十级伤残']),
};
Object.freeze(gradeOrder);
const grades = gradeOrder;

export function deduplicateClauseReferences(references) {
  const byId = new Map();
  const rank = reference => (reference.relation === 'supports' ? 3 : reference.relation === 'incomplete' ? 2 : 1)
    + (reference.conditions?.filter(condition => condition.met === true).length || 0) / 100
    + (reference.evidence ? 0.001 : 0);
  for (const reference of references) {
    const previous = byId.get(reference.id);
    if (!previous || rank(reference) > rank(previous)) byId.set(reference.id, reference);
  }
  return [...byId.values()];
}

const normalize = normalizeForMatching;
export const includesEvidence = includesNormalizedText;

function hasDistinctDatedInjuryEvents(text) {
  const anchors = parseEventDateAnchors(text);
  return anchors.some(anchor => anchor.explicitlySeparate)
    || eventDateAnchorsConflict(anchors.map(anchor => anchor.range));
}

function hasExplicitAndRelativeInjuryDate(text) {
  const normalized = String(text || '').normalize('NFKC');
  const explicitDate = /(?:19|20)\d{2}年\d{1,2}月\d{1,2}日[^。；;\n]{0,48}(?:受伤|外伤|遭殴打|被殴打)/u.test(normalized);
  const relativeDate = /(?:昨日|前日|前一天)受伤|(?:受伤|外伤)后[^。；;\n]{0,16}(?:疼痛)?\s*\d+\s*天/u.test(normalized);
  return explicitDate && relativeDate;
}

function officialCondition(condition, clauseText) {
  const modelText = normalize(condition.replace(/[（(][^）)]*[）)]/g, ''));
  const fullClause = clauseText.trim().replace(/[。]$/, '');
  if (modelText.includes(normalize(fullClause))) return fullClause;
  return clauseText.split(/[；;。]/).map(value => value.trim().replace(/[，,、：:]$/g, ''))
    .filter(Boolean).find(fragment => modelText.includes(normalize(fragment))
      || simpleAlternatives(fragment)?.alternatives.some(alternative => modelText.includes(normalize(alternative)))) || null;
}

function semicolonAlternatives(clauseText) {
  const alternatives = clauseText.split(/[；;]/).map(value => value.trim().replace(/[。]$/, '')).filter(Boolean);
  if (alternatives.length < 2 || alternatives.some(value => /[，,]|并|且|以及|同时|合并|伴|和|与/.test(value))) return null;
  return alternatives;
}

function simpleAlternatives(clauseText) {
  const text = clauseText.trim().replace(/[。；;]$/, '');
  if (/[，,；;]|并|且|以及|同时|合并|伴|和|与/.test(text)) return null;
  const parts = text.split(/或者|或/).map(value => value.trim()).filter(Boolean);
  return parts.length === 2 ? { text, alternatives: parts } : null;
}

function conditionsSatisfyClause(conditions, clauseText) {
  if (!conditions.length) return false;
  const semicolonGroups = semicolonAlternatives(clauseText);
  if (semicolonGroups) {
    const fullClause = clauseText.trim().replace(/[。]$/, '');
    if (conditions.some(condition => normalize(condition.condition) === normalize(fullClause) && condition.met === true)) return true;
    return semicolonGroups.some(branch => conditions.some(condition => normalize(condition.condition) === normalize(branch) && condition.met === true));
  }
  const alternatives = simpleAlternatives(clauseText);
  if (!alternatives) return conditions.every(condition => condition.met === true);
  const grouped = conditions.filter(condition => normalize(condition.condition) === normalize(alternatives.text));
  return grouped.some(condition => condition.met === true);
}

function compositeConditionSupported(conditionText, facts, certainties = ['reported', 'observed', 'derived']) {
  const evidence = facts.filter(fact => certainties.includes(fact.certainty)
    && fact.source === 'description' && fact.verification === 'quoted').map(fact => fact.evidence);
  const semicolonGroups = semicolonAlternatives(conditionText);
  if (semicolonGroups) return semicolonGroups.some(branch => compositeConditionSupported(branch, facts, certainties));
  const alternatives = simpleAlternatives(conditionText);
  if (alternatives) return alternatives.alternatives.some(alternative => evidence.some(quote => includesEvidence(quote, alternative)));
  const parts = conditionText.split(/[，,]|并且|并有|合并|同时|伴有|且|并/);
  const requiredParts = parts.map(value => value.trim()).filter(Boolean);
  if (requiredParts.length > 1) return requiredParts.every(part => compositeConditionSupported(part, facts, certainties));
  return evidence.some(quote => includesEvidence(quote, conditionText));
}

function explicitRibSiteCountStatus(conditionText, evidence) {
  const threshold = conditionText.match(/(\d+|[零〇一二两三四五六七八九十百]+)\s*处以上/);
  const count = evidence.match(/(?:共|累计)?\s*(\d+|[零〇一二两三四五六七八九十百]+)\s*处/);
  if (!threshold || !count) return undefined;
  const thresholdValue = parseNumber(threshold[1]);
  const countValue = parseNumber(count[1]);
  return Number.isInteger(thresholdValue) && Number.isInteger(countValue) ? countValue >= thresholdValue : undefined;
}

const INJURY_AGE_SCALED_MEASUREMENT_FIELDS = new Set(['contusion_tbsa_percent', 'burn_tbsa_ii_plus_percent',
  'burn_tbsa_deep_ii_plus_percent', 'burn_tbsa_iii_percent', 'burn_area_face_first_degree_cm2',
  'burn_area_neck_first_degree_cm2', 'burn_area_neck_superficial_second_degree_cm2',
  'burn_area_body_first_degree_cm2', 'burn_area_body_superficial_second_degree_cm2', 'facial_skin_abnormality_area_cm2',
  'aggregate_wound_length_cm', 'scalp_defect_area_cm2', 'scalp_avulsion_area_cm2',
  'skin_avulsion_area_cm2', 'skin_defect_area_cm2', 'skin_abrasion_area_cm2', 'skin_contusion_area_cm2',
  'scalp_abrasion_area_cm2', 'wound_length_cm', 'lip_through_wound_length_cm', 'surface_scar_area_cm2',
  'aggregate_surface_scar_area_cm2']);
const DISABILITY_AGE_SCALED_MEASUREMENT_FIELDS = new Set(['facial_scar_width_cm',
  'aggregate_facial_scar_length_cm', 'facial_center_scar_length_cm', 'surface_scar_area_cm2',
  'aggregate_surface_scar_area_cm2']);
const WOUND_SURFACE_SITE_ALIASES = new Set(['面部','脸部','额部','前额','额头','眉弓','眉部','面颊','颧部','鼻部','鼻背','鼻梁','鼻翼',
  '鼻唇沟','口唇','上唇','下唇','下颌','头部','头皮','额顶部','头顶部','颞顶部','顶枕部','后枕部','颞枕部','枕部','颞部',
  '耳廓','耳部','颈前部','颈前','颈部','颈','外阴','阴茎','阴囊','肢体','上肢','下肢','上臂','前臂','肘部','腕部','肩部','手部','手掌',
  '手背','手指','掌部','手','髋部','大腿','股部','膝部','小腿','踝部','足部','足背','趾部','胸部','腹部','背部','腰部']);
const sameValue = (left, right) => typeof left === 'string' && typeof right === 'string'
  ? left.normalize('NFKC') === right.normalize('NFKC')
  : JSON.stringify(left) === JSON.stringify(right);

function conflictCouldAffectGrade(conflicts, facts, assessmentType) {
  const clauses = catalogs[assessmentType].clauses.filter(clause => clause.grade
    && clause.conditionLogic?.annotation === 'explicit').map(clause => ({ clause,
    fields: logicFactFields(clause.conditionLogic.logic) }));
  for (const conflict of conflicts) {
    const ids = [...new Set(conflict.factIds || conflict.fact_ids || conflict.between || [])];
    if (!ids.length) return true;
    const conflictFacts = facts.filter(fact => ids.includes(fact.id));
    if (conflictFacts.length !== ids.length) return true;
    const disputedIds = new Set(conflictFacts.map(fact => fact.id));
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const fact of facts) {
        if (disputedIds.has(fact.id) || !fact.derivedFrom?.some(id => disputedIds.has(id))) continue;
        disputedIds.add(fact.id);
        expanded = true;
      }
    }
    const disputed = facts.filter(fact => disputedIds.has(fact.id));
    const affectedFields = new Set(facts.filter(fact => disputedIds.has(fact.id)).map(fact => fact.field));
    const independent = facts.filter(fact => !disputedIds.has(fact.id));
    const independentFields = new Set(independent.map(fact => fact.field));
    const bestIndependentRank = clauses.reduce((best, { clause, fields }) => {
      if (![...fields].some(field => independentFields.has(field))
        || evaluateConditionLogic(clause.conditionLogic, independent).met !== true) return best;
      return Math.min(best, grades[assessmentType].indexOf(clause.grade));
    }, Number.POSITIVE_INFINITY);
    const hypothetical = fact => ['uncertain', 'unknown', 'conflicted'].includes(fact.certainty)
      ? { ...fact, certainty: 'reported' } : fact;
    for (const { clause, fields } of clauses) {
      if (![...fields].some(field => affectedFields.has(field))) continue;
      const candidateRank = grades[assessmentType].indexOf(clause.grade);
      if (candidateRank >= bestIndependentRank) continue;
      if (evaluateConditionLogic(clause.conditionLogic, independent).met === true) continue;
      const scenarios = [disputed.map(hypothetical)];
      for (const fact of disputed) scenarios.push([hypothetical(fact)]);
      if (scenarios.some(scenario => evaluateConditionLogic(clause.conditionLogic,
        [...independent, ...scenario]).met === true)) return true;
    }
  }
  return false;
}

function isReducedMuscleStrengthEvidence(evidence) {
  const text = String(evidence || '').normalize('NFKC');
  if (/(?:既往史|既往|既有|陈旧|原有|此前|术前|曾经)/u.test(text)) return false;
  const match = /肌力(?:(?:检查|测定|记录)(?:结果)?)?\s*(?:为|约|达)?\s*(?<grade>[0-6]|[IVX]+)\s*级/iu.exec(text);
  if (!match) return false;
  const gradeText = match.groups.grade.toUpperCase();
  const romanGrades = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 };
  const grade = /^\d$/u.test(gradeText) ? Number(gradeText) : romanGrades[gradeText];
  return Number.isInteger(grade) && grade >= 0 && grade < 5;
}

function brainFindingProfile(fact) {
  const texts = [fact.value, fact.evidence].flatMap(value => Array.isArray(value) ? value : [value])
    .filter(Boolean).map(value => String(value).normalize('NFKC'));
  const patterns = [
    ['subarachnoid_hemorrhage', /蛛网膜下腔出血|蛛血/gu],
    ['subdural_hemorrhage', /硬膜下(?:血肿|出血)/gu],
    ['epidural_hemorrhage', /硬膜外(?:血肿|出血)/gu],
    ['intracerebral_hemorrhage', /(?:脑内|脑实质)(?:出血|血肿)/gu],
    ['brain_contusion', /脑挫(?:裂)?伤|挫裂伤/gu],
    ['skull_fracture', /(?:颅骨|额骨|顶骨|颞骨|枕骨)(?:凹陷性|粉碎性)?(?:骨折|骨裂)/gu],
    ['head_injury', /(?:头部|头颅|颅脑)(?:外伤|受伤|损伤)/gu],
    ['unspecified_intracranial_hemorrhage', /颅内出血/gu],
  ];
  const types = new Map();
  for (const text of texts) {
    for (const [type, pattern] of patterns) {
      for (const match of text.matchAll(pattern)) {
        const segmentStart = Math.max(text.lastIndexOf('，', match.index - 1), text.lastIndexOf(',', match.index - 1),
          text.lastIndexOf('、', match.index - 1),
          text.lastIndexOf('；', match.index - 1), text.lastIndexOf(';', match.index - 1),
          text.lastIndexOf('。', match.index - 1), text.lastIndexOf('\n', match.index - 1)) + 1;
        const segment = text.slice(segmentStart, match.index + match[0].length);
        const regions = types.get(type) || new Set();
        if (/额叶|额部|额顶部|额顶|额颞/u.test(segment)) regions.add('frontal');
        if (/顶叶|顶部|顶枕|枕顶|额顶|顶颞|颞顶/u.test(segment)) regions.add('parietal');
        if (/颞叶|颞部|额颞|顶颞|颞顶|颞枕/u.test(segment)) regions.add('temporal');
        if (/枕叶|枕部|顶枕|枕顶|颞枕/u.test(segment)) regions.add('occipital');
        types.set(type, regions);
      }
    }
  }
  return types;
}

function explicitlySeparateBrainFindings(positiveFact, excludedFact) {
  const positive = brainFindingProfile(positiveFact);
  const excluded = brainFindingProfile(excludedFact);
  if (!positive.size || !excluded.size) return false;
  const sharedTypes = [...positive.keys()].filter(type => excluded.has(type));
  if (!sharedTypes.length) return true;
  return sharedTypes.every(type => positive.get(type).size > 0 && excluded.get(type).size > 0
    && [...positive.get(type)].every(region => !excluded.get(type).has(region)));
}

function predicateEvidenceValue(predicate, fact, facts = []) {
  const quotedValue = quotedPredicateEvidenceValue(predicate, fact, facts);
  if (predicate.field === 'aggregate_wound_length_cm' && fact.field === 'wound_length_cm') return quotedValue;
  if (predicate.field === 'aggregate_wound_length_cm' && fact.certainty === 'reported'
    && fact.source === 'description' && /(?:多处|多个|[零〇一二两三四五六七八九十百0-9]+\\s*(?:处|道))/u.test(fact.evidence)
    && /(?:创口|创痕|裂伤|伤口|瘢痕|疤痕)/u.test(fact.evidence)
    && /(?:总长(?:度)?|累计长(?:度)?|长度合计|长度累计)/u.test(fact.evidence)) {
    return quotedValue;
  }
  if (predicate.field === 'aggregate_wound_length_cm' && fact.certainty === 'derived'
    && fact.source === 'description' && Array.isArray(fact.derivedFrom) && fact.derivedFrom.length >= 1) {
    const parents = fact.derivedFrom.map(id => facts.find(candidate => candidate.id === id));
    if (fact.aggregateRegion === 'auricle') {
      const earPattern = /(?:耳廓|耳屏|耳垂|耳背|耳前|耳后)/u;
      const scarPattern = /(?:创口|伤口|裂口|裂创|裂伤|瘢痕|疤痕)/u;
      const sideOf = evidence => {
        const sites = [...String(evidence || '').matchAll(/(?:(左侧|右侧|左|右|双侧|两侧))?(?:耳廓内|耳廓外|耳屏|耳垂|耳背|耳前|耳后|耳廓)/gu)];
        if (!sites.length) return null;
        const sides = new Set(sites.map(match => /^(?:双侧|两侧)/u.test(match[1] || '') ? 'bilateral'
          : /^(?:左侧|左)/u.test(match[1] || '') ? 'left'
            : /^(?:右侧|右)/u.test(match[1] || '') ? 'right' : 'unknown'));
        return sides.size === 1 ? [...sides][0] : null;
      };
      if (parents.some(parent => !parent || parent.field !== 'wound_length_cm' || parent.source !== fact.source
        || parent.verification !== 'quoted' || !reliableCertainties.has(parent.certainty)
        || !Number.isFinite(parent.value) || !aggregateEvidenceIncludesParent(fact, parent)
        || !earPattern.test(parent.evidence) || !scarPattern.test(parent.evidence) || !sideOf(parent.evidence))) return null;
      if (new Set(parents.map(parent => parent.eventId || '')).size !== 1
        || new Set(parents.map(parent => sideOf(parent.evidence))).size !== 1) return null;
      const total = Math.round(parents.reduce((sum, parent) => sum + parent.value, 0) * 100) / 100;
      return total === fact.value ? total : null;
    }
    const faceSitePattern = /(?:面部|脸部|额部|前额|额头|眉弓|眉部|眉|眼内眦|眼外侧|眼外眦|外眦|眼上方|眼下方|下睑|上睑|眼睑|面颊|颧部|鼻唇沟|鼻背|鼻梁|鼻部|鼻翼|唇上方|唇下方|上唇|下唇|口唇|唇部|下颌)/u;
    const isFacialAggregate = fact.aggregateRegion === 'face' || !fact.aggregateRegion && parents.every(parent => parent
      && parent.field === 'wound_length_cm' && faceSitePattern.test(parent.evidence)
      && !isUnsegmentedFaceScalpMeasurement(parent)
       && /(?:创口|伤口|创痕|裂口|裂创|裂伤|瘢痕|疤痕)/u.test(parent.evidence));
    if (isFacialAggregate) {
      if (parents.some(parent => parent && isUnsegmentedFaceScalpMeasurement(parent))) return null;
      if (parents.some(parent => !parent || parent.field !== 'wound_length_cm' || parent.source !== fact.source
        || parent.verification !== 'quoted' || !reliableCertainties.has(parent.certainty)
        || !Number.isFinite(parent.value) || !aggregateEvidenceIncludesParent(fact, parent)
        || !faceSitePattern.test(parent.evidence)
         || (!/(?:创口|伤口|创痕|裂口|裂创|裂伤|瘢痕|疤痕)/u.test(parent.evidence)
           && !/(?:创口|伤口|创痕|裂口|裂创|裂伤|瘢痕|疤痕)/u.test(parent.regionEvidence?.injuryType || '')))) return null;
      if (new Set(parents.map(parent => parent.eventId || '')).size !== 1) return null;
      const siteKeys = parents.map(parent => {
        const evidence = parent.evidence;
        if (/前额|额部|额头/u.test(evidence)) return 'forehead';
        if (/眉弓|眉部/u.test(evidence)) return 'brow';
        if (/下颌/u.test(evidence)) return 'jaw';
        if (/眼内眦|内眦|眼外侧|眼外眦|外眦|眼上方|眼下方|眼睑|上睑|下睑/u.test(evidence)) return 'eye';
        if (/面颊|颧部/u.test(evidence)) return 'cheek';
        if (/鼻背|鼻梁|鼻部|鼻翼/u.test(evidence)) return 'nose';
        if (/唇上方|唇下方|上唇|下唇|口唇|唇部/u.test(evidence)) return 'lip';
        return null;
      });
      const hasRepeatObservationCue = /(?:手术后|术后|再次|复查|复诊|复测|随访|后续)/u.test(fact.evidence);
      const explicitlySeparateWounds = /(?:另有|另见|两处|多处|分别|各有|两道|多道)/u.test(fact.evidence);
      if (hasRepeatObservationCue && !explicitlySeparateWounds && siteKeys.every(Boolean)
        && new Set(siteKeys).size === 1) return null;
      const total = Math.round(parents.reduce((sum, parent) => sum + parent.value, 0) * 100) / 100;
      return total === fact.value ? total : null;
    }
    const scalpMeasurementSites = parents.map(parent => quotedScalpMeasurementSite(parent, facts));
    if (parents.some((parent, index) => !parent || parent.field !== 'wound_length_cm' || parent.source !== fact.source
      || parent.verification !== 'quoted' || !reliableCertainties.has(parent.certainty)
      || !Number.isFinite(parent.value) || !aggregateEvidenceIncludesParent(fact, parent)
      || !scalpMeasurementSites[index])) return null;
    if (new Set(parents.map(parent => parent.eventId || '')).size !== 1) return null;
    const regions = scalpMeasurementSites.map(evidence => {
      const region = evidence.match(/枕骨隆突部|枕项部|后枕部|颞枕部|顶枕部|颞顶部|额顶部|头顶部|颞部|顶部|枕部|头皮/u)?.[0];
      return /顶部/u.test(region || '') ? 'top'
        : /颞枕|顶枕|后枕|枕骨隆突|枕项|枕部/u.test(region || '') ? 'occipital'
          : /颞部/u.test(region || '') ? 'temporal' : region || '';
    });
      const explicitScarCountTotal = explicitScalpScarCountTotal(fact.evidence);
      const explicitlySeparateWounds = /(?:另有|另见|两处|多处|[0-9零〇一二两三四五六七八九十百]+\s*(?:处|道)|分别|各有|两道|多道)/u.test(fact.evidence)
        || explicitScarCountTotal > 1 && explicitScarCountTotal === parents.length
      || /(?:\d+(?:\.\d+)?\s*(?:cm|厘米)\s*[、,，]\s*)+\d+(?:\.\d+)?\s*(?:cm|厘米)[^。；;]{0,8}(?:瘢痕|疤痕)/u.test(fact.evidence);
      const namedScalpSites = scalpMeasurementSites.map(evidence => {
        const match = /(?:(双侧|两侧|左侧|右侧|左|右))?(枕骨隆突部|颞枕部|顶枕部|后枕部|枕项部|颞顶部|额顶部|头顶部|颞部|顶部|枕部|头皮|发际内|发际线内)/u
          .exec(evidence);
        return match ? `${match[1] || ''}${match[2]}` : null;
      });
      const explicitlySeparateNamedSites = namedScalpSites.length >= 2 && namedScalpSites.every(Boolean)
        && new Set(namedScalpSites).size === namedScalpSites.length;
    if (new Set(regions).size !== parents.length && !explicitlySeparateWounds && !explicitlySeparateNamedSites) return null;
    const total = Math.round(parents.reduce((sum, parent) => sum + parent.value, 0) * 100) / 100;
    return total === fact.value ? total : null;
  }
  if (predicate.field === 'dental_loss_count' && fact.certainty === 'reported' && fact.source === 'description') {
    if (/1\s*[╋＋+┼]\s*1(?:上颌)?(?:(?:前|中切)牙)?(?:牙齿)?(?:新鲜)?(?:缺失|脱落)/u.test(fact.evidence)) {
      return fact.value === 2 ? fact.value : null;
    }
    return quotedDentalDefectCount(fact.evidence, fact.value);
  }
  if (quotedValue !== null) return quotedValue;
  if (predicate.field === 'lip_wound_length_cm' && fact.certainty === 'derived'
    && Array.isArray(fact.derivedFrom) && fact.derivedFrom.length === 1) {
    const parent = facts.find(candidate => candidate.id === fact.derivedFrom[0]);
    if (!parent || parent.field !== 'wound_length_cm' || parent.source !== fact.source
      || parent.verification !== 'quoted' || !reliableCertainties.has(parent.certainty)
      || !/(?:唇|口唇)/u.test(parent.evidence) || /(?:黏膜|粘膜)/u.test(parent.evidence)
      || !normalize(fact.evidence).includes(normalize(parent.evidence))) return null;
    const length = quotedPredicateEvidenceValue({ unit: 'cm' }, parent);
    return Number.isFinite(length) && length === fact.value ? length : null;
  }
  if (predicate.field === 'lip_through_wound_length_cm' && fact.certainty === 'derived'
    && Array.isArray(fact.derivedFrom) && fact.derivedFrom.length === 2) {
    const parents = fact.derivedFrom.map(id => facts.find(candidate => candidate.id === id));
    const diagnosis = parents.find(parent => parent?.field === 'clinical_finding'
      && /(?:下唇|上唇|口唇).{0,4}(?:贯通伤|全层裂创)/u.test(parent.value));
    const wound = parents.find(parent => parent?.field === 'wound_length_cm');
    const diagnosisSite = diagnosis?.value.includes('下唇') ? '下唇'
      : diagnosis?.value.includes('上唇') ? '上唇' : '口唇';
    if (!diagnosis || !wound || diagnosis.source !== fact.source || wound.source !== fact.source
      || ![diagnosis, wound].every(parent => parent.verification === 'quoted'
        && reliableCertainties.has(parent.certainty) && normalize(fact.evidence).includes(normalize(parent.evidence)))
      || !/(?:唇|口唇)/u.test(wound.evidence) || /(?:黏膜|粘膜|既往|旧伤|曾经|陈旧)/u.test(wound.evidence)
      || diagnosisSite !== '口唇' && !wound.evidence.includes(diagnosisSite)
      || diagnosis.eventId && wound.eventId && diagnosis.eventId !== wound.eventId) return null;
    const length = quotedPredicateEvidenceValue({ unit: 'cm' }, wound);
    return Number.isFinite(length) && length === fact.value ? length : null;
  }
  if (predicate.field === 'cross_region_wound_ratio' && fact.certainty === 'derived'
    && Array.isArray(fact.derivedFrom) && fact.derivedFrom.length === 2) {
    const parents = fact.derivedFrom.map(id => facts.find(candidate => candidate.id === id));
    const face = parents.find(parent => parent?.field === 'wound_length_cm'
      && (/面部创口长/.test(parent.evidence) || parent.regionEvidence?.site === '面部'));
    const head = parents.find(parent => parent?.field === 'wound_length_cm'
      && (/(?:头部|头皮)创口长/.test(parent.evidence) || parent.regionEvidence?.site === '头皮'));
    if (!face || !head || face.source !== fact.source || head.source !== fact.source
      || ![face, head].every(parent => parent.verification === 'quoted' && reliableCertainties.has(parent.certainty)
        && Number.isFinite(parent.value) && normalize(fact.evidence).includes(normalize(parent.evidence)))) return null;
    const faceLength = quotedPredicateEvidenceValue({ unit: 'cm' }, face);
    const headLength = quotedPredicateEvidenceValue({ unit: 'cm' }, head);
    if (!Number.isFinite(faceLength) || !Number.isFinite(headLength)) return null;
    const ratio = faceLength / 4.5 + headLength / 8;
    return Number.isFinite(ratio) && Math.abs(ratio - fact.value) < 1e-9 ? ratio : null;
  }
  if (predicate.field === 'ear_scalp_wound_ratio' && fact.certainty === 'derived'
    && Array.isArray(fact.derivedFrom) && [2, 3].includes(fact.derivedFrom.length)) {
    const parents = fact.derivedFrom.map(id => facts.find(candidate => candidate.id === id));
    const auricle = parents.find(parent => parent?.field === 'wound_length_cm'
      && (parent.regionEvidence?.site === '耳廓' || /耳廓(?:创口|裂伤)?长/.test(parent.evidence)));
    const scalp = parents.find(parent => parent?.field === 'wound_length_cm'
      && (parent.regionEvidence?.site === '头皮' || /头皮(?:创口|裂伤)?长/.test(parent.evidence)));
    const whole = parents.find(parent => parent?.field === 'wound_length_cm' && parent !== auricle && parent !== scalp);
    if (!auricle || !scalp || auricle.source !== fact.source || scalp.source !== fact.source
      || ![auricle, scalp].every(parent => parent.verification === 'quoted' && reliableCertainties.has(parent.certainty)
        && Number.isFinite(parent.value) && normalize(fact.evidence).includes(normalize(parent.evidence)))) return null;
    const auricleLength = quotedPredicateEvidenceValue({ unit: 'cm' }, auricle);
    const scalpLength = quotedPredicateEvidenceValue({ unit: 'cm' }, scalp);
    const totalLength = whole && whole.source === fact.source && whole.verification === 'quoted'
      && reliableCertainties.has(whole.certainty) && normalize(fact.evidence).includes(normalize(whole.evidence))
      ? quotedPredicateEvidenceValue({ unit: 'cm' }, whole)
      : Number(fact.evidence.match(/(?:创口)?总长\s*(\d+(?:\.\d+)?)\s*(?:cm|厘米)/u)?.[1]);
    if (!Number.isFinite(auricleLength) || !Number.isFinite(scalpLength) || !Number.isFinite(totalLength)
      || Math.abs(totalLength - auricleLength - scalpLength) > 0.1) return null;
    const ratio = auricleLength / 6 + scalpLength / 8;
    return Number.isFinite(ratio) && Math.abs(ratio - fact.value) < 1e-9 ? ratio : null;
  }
  if (predicate.field === 'auricle_defect_ratio' && fact.certainty === 'derived' && fact.source === 'description') {
    const amount = '(\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百]+)';
    const match = fact.evidence.match(new RegExp(`(左|右)耳廓缺损面积\\s*${amount}\\s*(?:cm2|平方厘米)[，,;；]\\s*(?:(对侧)|(左|右))耳面积\\s*${amount}\\s*(?:cm2|平方厘米)`, 'u'));
    if (!match || match[4] && match[4] === (match[1] === '左' ? '左' : '右')) return null;
    const measuredNumber = value => /^[\d.]+$/u.test(value) ? Number(value) : parseNumber(value);
    const defectArea = measuredNumber(match[2]);
    const referenceArea = measuredNumber(match[5]);
    if (!Number.isFinite(defectArea) || !Number.isFinite(referenceArea) || defectArea < 0 || referenceArea <= 0) return null;
    const ratio = defectArea / referenceArea;
    return Number.isFinite(ratio) && Math.abs(ratio - fact.value) < 1e-9 ? ratio : null;
  }
  if (predicate.field !== 'fractured_rib_count' || fact.certainty !== 'derived' || !fact.eventId
    || !Array.isArray(fact.derivedFrom) || !fact.derivedFrom.length) return null;
  const parents = fact.derivedFrom.map(id => facts.find(candidate => candidate.id === id));
  return parents.every(parent => parent?.field === 'fractured_rib_numbers' && parent.source === fact.source
    && parent.eventId === fact.eventId && parent.verification === 'quoted' && reliableCertainties.has(parent.certainty)
    && Array.isArray(parent.value) && parent.value.length > 0) ? fact.value : null;
}

function aggregateWoundLengthSitesSupportPredicate(predicate, fact) {
  if (!['aggregate_wound_length_cm', 'aggregate_surface_scar_area_cm2'].includes(fact.field)) return true;
  const siteGroups = (predicate.evidenceGroups || []).filter(group => group.some(alias => WOUND_SURFACE_SITE_ALIASES.has(alias)));
  if (!siteGroups.length) return true;
  const mentionedSites = fact.regionEvidence?.sites || (fact.regionEvidence?.site ? [fact.regionEvidence.site] : []);
  if (!mentionedSites.length) return true;
  return mentionedSites.every(site => {
    const normalizedSite = normalize(site).replace(/^(?:双侧|两侧|左侧|右侧|左|右)/u, '');
    return siteGroups.some(group => group.some(alias => normalize(alias).includes(normalizedSite)
      || normalizedSite.includes(normalize(alias))));
  });
}

function comparePredicate(predicate, value) {
  if (predicate.operator === 'eq') return value === predicate.value;
  if (predicate.operator === 'gt') return value > predicate.value;
  if (predicate.operator === 'gte') return value >= predicate.value;
  if (predicate.operator === 'lt') return value < predicate.value;
  if (predicate.operator === 'lte') return value <= predicate.value;
  return null;
}

function woundLengthEvidenceSupportsPredicate(predicate, fact, facts = []) {
  const sourceRefs = Array.isArray(fact.sourceRefs) ? fact.sourceRefs
    .filter(reference => reference.source === fact.source && typeof reference.evidence === 'string'
      && reference.evidence.trim()) : [];
  const broadEvidence = normalize(String(fact.evidence || ''));
  const localQuotes = sourceRefs.map(reference => reference.evidence)
    .filter(evidence => normalize(evidence) !== broadEvidence);
  const candidates = localQuotes.length ? localQuotes : [fact.evidence];
  if (!localQuotes.length && sourceRefs.length === 0 && !fact.regionEvidence?.site) {
    const measurements = [...String(fact.evidence || '').matchAll(/(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:cm|厘米)(?!2)/gu)];
    if (measurements.length > 1) return false;
  }
  return candidates.some(evidence => {
    const exactLength = quotedPredicateEvidenceValue({ field: 'wound_length_cm', unit: predicate.unit || 'cm' },
      { ...fact, evidence }, facts);
    if (exactLength !== fact.value) return false;
    const siteCue = /头顶部|额顶部|颞顶部|顶枕部|后枕部|颞枕部|头皮|头部|枕部|颞部|面部|脸部|额部|前额|额头|眉弓|眉部|眼内眦|眼外侧|眼外眦|外眦|眼上方|眼下方|下睑|上睑|眼睑|面颊|颧部|鼻唇沟|鼻背|鼻梁|鼻部|鼻翼|口角|唇上方|唇下方|上唇|下唇|口唇|唇部|下颌|耳廓|颈前正中|颈前部|颈前|颈部|颈|外阴|阴茎|阴囊|胸部|胸|腹部|腹|背部|背|腰部|腰|左肩|右肩|肩部|肩|上肢|上臂|前臂|肘部|腕部|下肢|髋部|大腿|股部|膝部|小腿|踝部|足部|趾部|手部|手掌|手背|手指|掌部|手|足|踝|肋骨|骨盆/gu;
    const contextForMeasurement = (start, measurementEnd) => {
      const prefix = evidence.slice(0, start);
      const sentenceStart = Math.max(prefix.lastIndexOf('。'), prefix.lastIndexOf('；'), prefix.lastIndexOf(';'),
        prefix.lastIndexOf('\n')) + 1;
      siteCue.lastIndex = 0;
      const locations = [...prefix.slice(sentenceStart).matchAll(siteCue)];
      const latestLocation = locations.at(-1);
      const siteIndex = latestLocation ? sentenceStart + latestLocation.index : sentenceStart;
      const suffix = evidence.slice(measurementEnd);
      siteCue.lastIndex = 0;
      const nextLocation = siteCue.exec(suffix);
      const terminator = /[。；;\n]/u.exec(suffix);
      const relativeEnd = Math.min(nextLocation?.index ?? Infinity, terminator?.index ?? Infinity);
      const contextEnd = Number.isFinite(relativeEnd) ? measurementEnd + relativeEnd : evidence.length;
      return { text: evidence.slice(siteIndex, contextEnd), site: latestLocation?.[0] || fact.regionEvidence?.site || '' };
    };
    const numberPattern = '(?:\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百]+)';
    const lengthValue = value => /^\d/u.test(value) ? Number(value) : parseNumber(value);
    const measurementContexts = [
      ...[...evidence.matchAll(new RegExp(`(${numberPattern})\\s*(?:cm|厘米)`, 'gu'))]
        .filter(match => lengthValue(match[1]) === fact.value)
        .map(match => contextForMeasurement(match.index, match.index + match[0].length)),
      ...[...evidence.matchAll(new RegExp(`(${numberPattern})\\s*(?:(?:cm|厘米)\\s*)?[×xX*]\\s*(${numberPattern})\\s*(?:cm|厘米)`, 'gu'))]
        .filter(match => Math.max(lengthValue(match[1]), lengthValue(match[2])) === fact.value)
        .map(match => contextForMeasurement(match.index, match.index + match[0].length)),
    ];
    if (/(?:皮肤)?划痕/u.test(evidence)
      && !/(?:创口|伤口|裂口|裂创|裂伤|切口|瘢痕|疤痕)/u.test(evidence)) return false;
    const woundDescription = `${evidence} ${fact.regionEvidence?.injuryType || ''}`;
    if (!/(?:创口|伤口|裂口|裂创|裂伤|切口|瘢痕|疤痕|划伤)/u.test(woundDescription)) return false;
    return !predicate.evidenceGroups || predicate.evidenceGroups.every(group => {
      const requiresSite = group.some(alias => /头|额|枕|颞|面|脸|眉|眼|颊|颧|鼻|唇|颌|耳|颈|胸|腹|背|腰|肩|肢|腿|手|膝|足|踝|肋|骨盆/u.test(alias));
      return measurementContexts.some(context => group.some(alias => requiresSite
        ? includesEvidence(context.site, alias) || includesEvidence(fact.regionEvidence?.site || '', alias)
        : includesEvidence(context.text, alias) || includesEvidence(fact.regionEvidence?.injuryType || '', alias)));
    });
  });
}

function canonicalClinicalFindingEvidence(value, evidence, linkedToCurrentEvent = false) {
  if (/(?:既往史|既往|既有|陈旧|原有|此前|曾经|术前)/u.test(evidence)) return false;
  if (value === '各种损伤引起休克(中度)') return hasVerifiedModerateShockEvidence(evidence);
  if (value === '一侧肾切除术后') return /(?:左侧|右侧|左|右|单侧|一侧)?肾(?:脏)?切除术/u.test(evidence)
    && !/部分肾(?:脏)?切除术/u.test(evidence)
    && /(?:手术记录|手术中|行|施行|实施|接受|进行|已做|完成)/u.test(evidence)
    && !/(?:未行|未实施|拟行|计划|建议|考虑|拒绝|尚未)/u.test(evidence);
  if (value === '肾修补术后') return /(?:手术记录|手术中|行|施行|实施|接受|进行|已做|完成)[^。；;\n]{0,32}肾(?:脏)?修补术/u.test(evidence)
    && !/(?:未行|未实施|拟行|计划|建议|考虑|拒绝|尚未)/u.test(evidence);
  if (value === '心包破裂' || value === '心脏破裂') return isCanonicalCardiacRuptureEvidence(value, evidence);
  if (value === '开颅术后') {
    const completedCraniotomy = /(?:手术(?:名称|为|记录)?|行|接受|施行|实施|进行|术后)[^。！？；;\n]{0,32}开颅[^。！？；;\n]{0,72}(?:清除|探查|减压|切除|修补|整复|手术|术)/u;
    return linkedToCurrentEvent && completedCraniotomy.test(evidence)
      && !/(?:拟行|拟施行|计划|建议|考虑|未行|未施行|拒绝)/u.test(evidence);
  }
  if (value === '开放性颅骨骨折伴硬脑膜破裂') {
    const hardDura = '(?:硬脑膜|硬膜(?!下))';
    const explicitDuralDiagnosis = findExplicitOpenSkullDuralDiagnoses(evidence).length > 0;
    const normalizedOpenSkullEvidence = linkedToCurrentEvent && hasSupportedOpenSkullDuralRuptureEvidence(evidence);
    const quotedDuralPenetration = /头皮[^。！？\n]{0,32}(?:撕裂伤|撕裂|裂伤|裂创|裂口)/u.test(evidence)
      && /(?:颅骨[^。！？\n]{0,24}(?:骨折|骨裂)|(?:左|右|双侧)?(?:额顶|额颞|顶枕|枕顶|额|顶|枕|颞)骨[^。！？\n]{0,16}(?:骨折|骨裂))/u.test(evidence)
      && new RegExp(`(?:骨折[^。！？\\n]{0,24}(?:刺破|穿破|刺入)${hardDura}|${hardDura}[^。！？\\n]{0,24}(?:被|有)?(?:骨折|骨片)[^。！？\\n]{0,12}(?:刺破|穿破|刺入))`, 'u').test(evidence);
    const openFractureDiagnosis = /(?:开放性(?:颅骨|(?:额顶|额颞|顶枕|枕顶|额|顶|枕|颞)骨)|(?:颅骨|(?:额顶|额颞|顶枕|枕顶|额|顶|枕|颞)骨)[^。！？\n]{0,24}开放性)[^。！？\n]{0,12}骨(?:折|裂)/u.test(evidence)
      || /开放性颅脑损伤[^。！？\n]{0,180}(?:颅骨|(?:额顶|额颞|顶枕|枕顶|额|顶|枕|颞)骨)[^。！？\n]{0,24}(?:骨折|骨裂)|(?:颅骨|(?:额顶|额颞|顶枕|枕顶|额|顶|枕|颞)骨)[^。！？\n]{0,24}(?:骨折|骨裂)[^。！？\n]{0,180}开放性颅脑损伤/u.test(evidence);
    const operativeDuralDamage = new RegExp(`(?:术中|手术记录|探查|(?:取出|移除|清除|去除)[^。！？\\n]{0,24}后)[^。！？\\n]{0,100}${hardDura}[^。！？\\n]{0,28}(?:破口|开放|破损|破裂|撕裂|裂伤)`, 'u').test(evidence);
    const quotedOperativeDuralDamage = linkedToCurrentEvent && openFractureDiagnosis && operativeDuralDamage;
    const operativeMeningealRupture = /(?:术中|手术记录|探查)[^。！？\n]{0,180}脑膜沿(?:伤口|创口)[^。！？\n]{0,16}方向(?:破裂|破开|裂开)/u.test(evidence);
    const quotedOperativeMeningealRupture = linkedToCurrentEvent && openFractureDiagnosis && operativeMeningealRupture;
    const fractureCsfFlow = /(?:骨折中心|骨折处|骨折断端|骨折缝|骨折裂隙)[^。；;\n]{0,24}脑脊液[^。；;\n]{0,20}(?:流出|外流)|脑脊液[^。；;\n]{0,20}(?:由|从)(?:骨折中心|骨折处|骨折断端|骨折缝|骨折裂隙)[^。；;\n]{0,16}(?:流出|外流)/u.test(evidence);
    const quotedFractureCsfFlow = linkedToCurrentEvent && openFractureDiagnosis && fractureCsfFlow;
    return explicitDuralDiagnosis || normalizedOpenSkullEvidence || quotedDuralPenetration || quotedOperativeDuralDamage
      || quotedOperativeMeningealRupture || quotedFractureCsfFlow;
  }
  if (value === '胃非全层破裂') {
    return /胃[^。！？；;\n]{0,24}?(?:浆膜(?:层)?[^。！？；;\n]{0,12}(?:破裂|裂伤)|浆肌层[^。！？；;\n]{0,12}(?:破裂|裂伤)|肌层[^。！？；;\n]{0,12}(?:破裂|裂伤)|非全层破裂)/u.test(evidence)
      && !/全层破裂/u.test(evidence);
  }
  if (value === '肠非全层破裂') {
    return /(?:小肠|大肠|结肠|直肠|肠)[^。！？；;\n]{0,24}?(?:浆膜(?:层)?[^。！？；;\n]{0,12}(?:破裂|裂伤)|浆肌层[^。！？；;\n]{0,12}(?:破裂|裂伤)|肌层[^。！？；;\n]{0,12}(?:破裂|裂伤)|非全层破裂)/u.test(evidence)
      && !/全层破裂/u.test(evidence);
  }
  if (value === '胆囊非全层破裂' || value === '胆道非全层破裂') {
    const site = value === '胆囊非全层破裂' ? '胆囊' : '胆道';
    return new RegExp(`${site}[^。！？；;\\n]{0,24}?(?:浆膜(?:层)?[^。！？；;\\n]{0,12}(?:破裂|裂伤)|浆肌层[^。！？；;\\n]{0,12}(?:破裂|裂伤)|肌层[^。！？；;\\n]{0,12}(?:破裂|裂伤)|非全层破裂)`, 'u').test(evidence)
      && !/全层破裂/u.test(evidence);
  }
  if (typeof value === 'string' && normalize(value) === normalize('四肢瘫（三肢以上肌力3级以下）')) {
    return normalizeMuscleStrengthFacts(evidence, { eventScopedEvidence: linkedToCurrentEvent }).some(fact =>
      normalize(fact.value) === normalize('四肢瘫（三肢以上肌力3级以下）')
      && ['reported', 'observed', 'derived'].includes(fact.certainty));
  }
  if (value === '颈部损伤出现窒息征象') {
    return normalizeNeckAsphyxiaFacts(evidence).some(fact => fact.value === value);
  }
  if (value === '帽状腱膜下血肿范围50.0cm2以上') {
    const area = /帽状腱膜下血肿[^。；;\n]{0,120}?(?:血肿)?(?:范围|面积)[^。；;\n]{0,24}?(\d+(?:\.\d+)?)\s*(?:cm\s*2|平方厘米)(?:以上|及以上)?/u.exec(evidence);
    if (!area || Number(area[1]) < 50) return false;
    const areaMarker = Math.max(area[0].lastIndexOf('范围'), area[0].lastIndexOf('面积'));
    return !/约|大约|左右|接近|不超过|不足|未达|小于|低于/u.test(area[0].slice(Math.max(0, areaMarker)));
  }
  if (value === '一眼矫正视力减退至0.5以下') {
    const acuity = evidence.match(/(右|左)眼[^，,。；;\n]{0,8}?矫正视力\s*(?:为|[:：])?\s*(\d+(?:\.\d+)?)(?![\d.])/u);
    if (!acuity || Number(acuity[2]) > 0.5) return false;
    return hasSameEyeInjuryContext(acuity[1], evidence.slice(0, evidence.indexOf(acuity[0]) + acuity[0].length));
  }
  if (value === '外伤性鼓膜穿孔6周不能自行愈合') return confirmsSixWeekUnhealedTympanicPerforation(evidence);
  if (value === '置入式假体装置损坏' || value === '置入式假体装置需要手术修复') {
    const implantedDevice = /(?:颅骨修补材料|人工晶体|义眼座|固定义齿|种植牙|阴茎假体|人工关节|起搏器|支架)/u;
    const currentTrauma = /(?:本次|此次)(?:交通)?(?:事故|外伤|受伤|损伤)/u.test(evidence);
    const documentedDamage = /(?:损坏|破损|破裂|缺损|脱位|脱出)/u.test(evidence);
    const documentedRepair = /(?:(?:手术|术)[^。；;\n]{0,12}(?:更换|修补|修复)|(?:更换|修补|修复)[^。；;\n]{0,12}(?:手术|术))/u.test(evidence);
    if (value === '置入式假体装置损坏') return currentTrauma && implantedDevice.test(evidence) && documentedDamage;
    return currentTrauma && implantedDevice.test(evidence) && documentedDamage && documentedRepair;
  }
  const linkedToCurrentInjury = linkedToCurrentEvent || hasExplicitCurrentEventLink(evidence);
  if (!linkedToCurrentInjury) return false;
  if (value === '成年人脾切除术后') return /(?:成年人|成人|年满\s*18\s*周岁|18\s*岁以上)/.test(evidence)
    && /脾(?:脏)?(?:全|全部|完全)?切除术/.test(evidence) && !/脾.{0,4}部分切除/.test(evidence);
  if (value === '一侧肾切除术后') return /(?:一侧|单侧|左(?:侧)?|右(?:侧)?)\s*肾(?:脏)?(?:全)?切除术?/.test(evidence);
  if (value === '肾修补术后') return /肾(?:脏)?修补术?/.test(evidence);
  if (value === '胸壁穿透创') return /胸壁.{0,8}(?:穿透创|贯通伤)|(?:穿透创|贯通伤).{0,8}胸壁/.test(evidence);
  return false;
}

function hasExplicitCurrentEventLink(evidence) {
  const text = normalize(evidence);
  const cues = [...text.matchAll(/(?:本次|此次)(?:交通)?(?:事故|外伤|受伤|损伤)(?:后|中)?|因(?:本次|此次)(?:交通)?(?:事故|外伤)|(?:19|20)\d{2}年[^。；;\n]{0,32}被[^。；;\n]{0,8}(?:拳击|殴打|击打|打伤)/gu)];
  const historicalCue = /既往(?:史)?|既有|历史(?:病历|手术|病史|资料)|陈旧|原有|此前|术前|曾(?:经|于|在|行|接受|做过|做|切除|修补|施行)/u;
  for (const cue of cues) {
    const nearby = text.slice(cue.index + cue[0].length, cue.index + cue[0].length + 32);
    if (historicalCue.test(nearby)) continue;
    const action = nearby.search(/有|需要|需|须|接受|施行|实施|进行|行|导致|所致|记载|报告|发现|确诊|诊断为|提示|出现|检查见|查见|手术记录|手术治疗/u);
    const procedure = nearby.search(/手术|切除|修补|摘除|固定术|穿透创|贯通伤|骨折|损伤|出血|暴露|缺损|破损|损坏|破裂/u);
    if (action >= 0 && procedure >= 0 && procedure >= action && procedure <= 32) return true;
  }
  return false;
}

function hasExplicitCurrentEventCausalProcedureLink(evidence, expectedOrgan) {
  if (!expectedOrgan) return false;
  const text = normalize(String(evidence || ''));
  const procedure = /(?:接受|施行|实施|进行|行|手术|切除|修补|摘除|清除|引流|缝合|固定|修复)/u;
  const causalPhrases = [
    /因[^，,。；;\n]{0,24}(?:本次|此次)(?:交通)?(?:事故|外伤|受伤)[^，,。；;\n]{0,24}[，,]?\s*(?:接受|施行|实施|进行|行)[^。；;\n]{0,24}/u,
    /(?:本次|此次)(?:交通)?(?:事故|外伤|受伤)[^，,。；;\n]{0,20}(?:导致|造成|引起|所致)[^，,。；;\n]{0,20}[，,]?\s*(?:接受|施行|实施|进行|行)[^。；;\n]{0,24}/u,
  ];
  return causalPhrases.some(pattern => {
    const match = pattern.exec(text);
    if (!match) return false;
    const action = /(?:接受|施行|实施|进行|行)/u.exec(match[0]);
    if (!action) return false;
    const indication = match[0].slice(0, action.index);
    const operation = match[0].slice(action.index + action[0].length);
    const indicationOrgan = clinicalOrgan({ evidence: indication });
    return procedure.test(operation) && clinicalOrgan({ evidence: operation }) === expectedOrgan
      && (!indicationOrgan || indicationOrgan === expectedOrgan);
  });
}

function hasCurrentEventLinkForProcedure(fact, facts, node) {
  const procedureText = normalize(`${fact.value ?? ''} ${fact.evidence ?? ''}`);
  const operationTerms = [...new Set([...(node.factMatch?.values || []), ...(node.factMatch?.valueIncludes || []),
    ...(node.factMatch?.evidenceAliases || [])].filter(value => typeof value === 'string' && value))];
  const configuredOperationOrgans = new Set(operationTerms.map(term => clinicalOrgan({ value: term, evidence: '' }))
    .filter(Boolean));
  const requiresOrganAnchor = /(?:破裂|裂口|裂伤|挫裂伤|损伤|血肿)[^。；;]{0,24}(?:手术|切除|修补|缝合)/u
    .test(node.conditionText || '');
  const factOrgan = clinicalOrgan(fact);
  let explicitlyIndicatedSurgery = false;
  const explicitIndication = procedureText.match(/(?:因|由于|针对|为治疗|用于治疗)([^，,。；;\n]{1,28}?)(?=[，,]?\s*(?:行|接受|实施|进行|施行|予以))/u);
  if (explicitIndication) {
    const indication = { evidence: explicitIndication[1], value: '' };
    const indicationText = normalize(indication.evidence);
    const genericIndication = /^(?:(?:本次|此次|当前)?(?:交通)?(?:事故|外伤|受伤|损伤)(?:导致|造成|引起|所致|后)?|事故|外伤|受伤|损伤)$/u;
    const indicationIsLinked = facts.some(anchor => anchor.id !== fact.id && anchor.eventId === fact.eventId
      && ['diagnosis', 'imaging_finding', 'clinical_finding', 'injury_type', 'anatomical_site'].includes(anchor.field)
      && reliableCertainties.has(anchor.certainty) && anchor.source === 'description' && anchor.verification === 'quoted'
      && clinicalOrgan(anchor) === factOrgan && compatibleLaterality(anchor, fact)
      && (sharedClinicalInjuryPhrase(anchor, indication)
        || indicationText.length >= 4 && !genericIndication.test(indicationText)
          && normalize(`${anchor.value ?? ''} ${anchor.evidence ?? ''}`).includes(indicationText)));
    const operationAction = /(?:接受|施行|实施|进行|行|予以)([^，,。；;\n]{0,36})/u.exec(procedureText);
    const operationOrgan = clinicalOrgan({ value: fact.value, evidence: operationAction?.[1] || '' });
    const indicationOrgans = clinicalOrgans(indication);
    if (indicationOrgans.length && operationOrgan && !indicationOrgans.includes(operationOrgan)) return false;
    if (!indicationIsLinked && !hasExplicitCurrentEventCausalProcedureLink(fact.evidence, factOrgan)) return false;
    explicitlyIndicatedSurgery = indicationIsLinked && isPerformedSurgicalTreatmentFact(fact);
  }
  const sameEventOrganSideConflict = facts.some(anchor => anchor.id !== fact.id && anchor.eventId === fact.eventId
    && ['diagnosis', 'imaging_finding', 'clinical_finding', 'injury_type', 'anatomical_site'].includes(anchor.field)
    && reliableCertainties.has(anchor.certainty) && anchor.source === 'description' && anchor.verification === 'quoted'
    && factOrgan && clinicalOrgan(anchor) === factOrgan && !compatibleLaterality(anchor, fact));
  if (sameEventOrganSideConflict) return false;
  if (explicitlyIndicatedSurgery) return true;
  if (hasDirectPostoperativeOutcomeLink(fact, facts, node)) return true;
  if (hasExplicitCurrentEventLink(fact.evidence)
    && hasExplicitCurrentEventCausalProcedureLink(fact.evidence, factOrgan)
    && !requiresOrganAnchor
    && (!configuredOperationOrgans.size || configuredOperationOrgans.has(factOrgan))) return true;
  if (!fact.eventId || /既往(?:史)?|既有|历史(?:病历|手术|病史|资料)|陈旧|原有|此前|术前|曾(?:经|于|在|行|接受|做过|做|切除|修补|施行)/u
    .test(fact.evidence)) return false;
  const skullFractureAnchors = facts.filter(anchor => anchor.id !== fact.id && anchor.eventId === fact.eventId
      && ['diagnosis', 'imaging_finding', 'clinical_finding', 'injury_type'].includes(anchor.field)
      && reliableCertainties.has(anchor.certainty) && anchor.source === 'description'
      && anchor.verification === 'quoted'
      && /(?:颅骨|枕骨|顶骨|额骨|颞骨|顶枕|颞顶)/u.test(normalize(`${anchor.value ?? ''} ${anchor.evidence ?? ''}`))
      && /骨折/u.test(normalize(`${anchor.value ?? ''} ${anchor.evidence ?? ''}`)));
  if (/(?:颅骨骨折减压|凹陷骨折(?:减压|整复|复位))(?:术)?/u.test(procedureText)) {
    return skullFractureAnchors.length > 0;
  }
  if (/动脉瘤夹闭/u.test(procedureText)) {
    return facts.some(anchor => anchor.id !== fact.id && anchor.eventId === fact.eventId
      && ['diagnosis', 'imaging_finding', 'clinical_finding'].includes(anchor.field)
      && reliableCertainties.has(anchor.certainty) && anchor.source === 'description'
      && anchor.verification === 'quoted'
      && /(?:外伤性|创伤性)(?:颅内)?(?:脑)?动脉瘤/u.test(normalize(`${anchor.value ?? ''} ${anchor.evidence ?? ''}`)));
  }
  if (/去骨瓣减压(?:术)?/u.test(procedureText)) {
    const cranialRegions = [
      ['额骨', '额部', '额顶部', '额颞'],
      ['顶骨', '顶部', '顶颞', '颞顶', '颞顶部', '额顶部', '顶枕'],
      ['颞骨', '颞部', '额颞', '颞顶', '颞顶部'],
      ['枕骨', '枕部', '枕顶部', '枕顶', '顶枕'],
    ];
    const side = value => {
      const text = normalize(value);
      const left = /左(?:侧)?(?:额|顶|颞|枕|顶部|颞顶部)/u.test(text);
      const right = /右(?:侧)?(?:额|顶|颞|枕|顶部|颞顶部)/u.test(text);
      return left === right ? null : left ? 'left' : 'right';
    };
    const procedureSide = side(procedureText);
    return skullFractureAnchors.some(anchor => {
      const anchorText = normalize(`${anchor.value ?? ''} ${anchor.evidence ?? ''}`);
      const anchorSide = side(anchorText);
      if (procedureSide && anchorSide && procedureSide !== anchorSide) return false;
      return cranialRegions.some(region => region.some(site => procedureText.includes(site))
        && region.some(site => anchorText.includes(site)));
    });
  }
  if (!/(?:手术|切除|修补|摘除|清除|引流|缝合|修复)/u.test(procedureText)) return false;
  const matchedOperationOrgans = new Set(operationTerms.filter(term => procedureText.includes(normalize(term))
    || normalize(String(fact.evidence || '')).includes(normalize(term)))
    .map(term => clinicalOrgan({ value: term, evidence: '' })).filter(Boolean));
  const operationOrgans = matchedOperationOrgans.size ? matchedOperationOrgans : new Set(factOrgan ? [factOrgan] : []);
  if (!operationOrgans.size) return false;
  return facts.some(anchor => anchor.id !== fact.id && anchor.eventId === fact.eventId
    && ['diagnosis', 'imaging_finding', 'clinical_finding', 'injury_type', 'anatomical_site'].includes(anchor.field)
    && reliableCertainties.has(anchor.certainty) && anchor.source === 'description'
    && operationOrgans.has(clinicalOrgan(anchor)) && compatibleLaterality(anchor, fact));
}

function hasDirectPostoperativeOutcomeLink(fact, facts, node) {
  const conditionText = normalize(`${node.sourceText || ''} ${node.conditionText || ''}`);
  if (!/(?:术后|手术治疗后)/u.test(conditionText)) return false;
  const procedureQuote = node.conditionText || node.sourceText || '';
  return facts.some(anchor => anchor.id !== fact.id && anchor.eventId === fact.eventId
    && ['diagnosis', 'imaging_finding', 'clinical_finding', 'injury_type', 'functional_impairment'].includes(anchor.field)
    && reliableCertainties.has(anchor.certainty) && anchor.source === 'description' && anchor.verification === 'quoted'
    && includesEvidence(anchor.evidence, procedureQuote)
    && /(?:术后|后遗|遗留|形成|出现|导致|引起)/u.test(anchor.evidence)
    && !evidenceLabelsFindingAsHistorical(anchor.evidence, procedureQuote)
    && compatibleLaterality(anchor, fact));
}

function clinicalOrgan(fact) {
  const text = normalize(`${fact?.value ?? ''} ${fact?.evidence ?? ''}`);
  if (/额叶/u.test(text)) return 'frontal_brain_lobe';
  if (/颞叶/u.test(text)) return 'temporal_brain_lobe';
  if (/顶叶/u.test(text)) return 'parietal_brain_lobe';
  if (/枕叶/u.test(text)) return 'occipital_brain_lobe';
  if (/脑叶/u.test(text)) return 'brain_lobe';
  if (/心包/u.test(text)) return 'pericardium';
  if (/(?:心脏|心肌|心房|心室)/u.test(text)) return 'heart';
  if (/(?:大血管|主动脉|肺动脉|腔静脉|冠状动脉|颈动脉|锁骨下动脉|髂动脉|股动脉|股静脉)/u.test(text)) {
    return 'great_vessel';
  }
  if (/肾/u.test(text)) return 'kidney';
  if (/肝/u.test(text)) return 'liver';
  if (/脾/u.test(text)) return 'spleen';
  if (/胰/u.test(text)) return 'pancreas';
  if (/肠代食管/u.test(text)) return 'esophagus';
  if (/肠代膀胱/u.test(text)) return 'bladder';
  if (/胃/u.test(text)) return 'stomach';
  if (/(?:小肠|大肠|结肠|直肠|十二指肠|肠)/u.test(text)) return 'intestine';
  if (/胆囊/u.test(text)) return 'gallbladder';
  if (/(?:胆道|胆总管|胆管)/u.test(text)) return 'bile_duct';
  if (/肺/u.test(text)) return 'lung';
  if (/(?:胸廓|胸壁|肋骨)/u.test(text)) return 'thoracic_cage';
  if (/子宫/u.test(text)) return 'uterus';
  if (/膀胱/u.test(text)) return 'bladder';
  if (/食管/u.test(text)) return 'esophagus';
  if (/膈肌/u.test(text)) return 'diaphragm';
  if (/睾丸/u.test(text)) return 'testicle';
  if (/尿道/u.test(text)) return 'urethra';
  if (/(?:眼球|眼睑|眼角膜|角膜|视网膜|视神经|眼)/u.test(text)) return 'eye';
  if (/髌骨/u.test(text)) return 'patella';
  return null;
}

function clinicalOrgans(fact) {
  const text = normalize(`${fact?.value ?? ''} ${fact?.evidence ?? ''}`);
  const matches = [
    ['frontal_brain_lobe', /额叶/u], ['temporal_brain_lobe', /颞叶/u], ['parietal_brain_lobe', /顶叶/u],
    ['occipital_brain_lobe', /枕叶/u], ['brain_lobe', /脑叶/u], ['pericardium', /心包/u],
    ['heart', /(?:心脏|心肌|心房|心室)/u],
    ['great_vessel', /(?:大血管|主动脉|肺动脉|腔静脉|冠状动脉|颈动脉|锁骨下动脉|髂动脉|股动脉|股静脉)/u],
    ['kidney', /肾/u], ['liver', /肝/u], ['spleen', /脾/u], ['pancreas', /胰/u], ['stomach', /胃/u],
    ['intestine', /(?:小肠|大肠|结肠|直肠|十二指肠|肠)/u], ['gallbladder', /胆囊/u],
    ['bile_duct', /(?:胆道|胆总管|胆管)/u], ['lung', /肺/u], ['thoracic_cage', /(?:胸廓|胸壁|肋骨)/u],
    ['uterus', /子宫/u], ['bladder', /膀胱/u], ['esophagus', /食管/u], ['diaphragm', /膈肌/u],
    ['testicle', /睾丸/u], ['urethra', /尿道/u], ['eye', /(?:眼球|眼睑|眼角膜|角膜|视网膜|视神经|眼)/u],
    ['patella', /髌骨/u],
  ];
  return matches.filter(([, pattern]) => pattern.test(text)).map(([organ]) => organ);
}

function compatibleLaterality(left, right) {
  const side = fact => {
    const text = normalize(`${fact?.value ?? ''} ${fact?.evidence ?? ''}`);
    const sitePattern = {
      kidney: /肾/u,
      lung: /肺/u,
      testicle: /睾丸/u,
      eye: /(?:眼球|眼睑|眼角膜|角膜|视网膜|视神经|眼)/u,
      patella: /髌骨/u,
      frontal_brain_lobe: /额叶/u,
      temporal_brain_lobe: /颞叶/u,
      parietal_brain_lobe: /顶叶/u,
      occipital_brain_lobe: /枕叶/u,
      thoracic_cage: /(?:胸廓|胸壁|肋骨)/u,
      great_vessel: /(?:主动脉|肺动脉|腔静脉|冠状动脉|颈动脉|锁骨下动脉|髂动脉|股动脉|股静脉|大血管)/u,
    }[clinicalOrgan(fact)];
    if (!sitePattern) return null;
    const sides = new Set();
    for (const site of text.matchAll(new RegExp(sitePattern.source, 'gu'))) {
      const before = text.slice(Math.max(0, site.index - 6), site.index);
      const after = text.slice(site.index + site[0].length, site.index + site[0].length + 6);
      const leftSide = /左(?:侧)?$/u.test(before) || /^左(?:侧)?/u.test(after);
      const rightSide = /右(?:侧)?$/u.test(before) || /^右(?:侧)?/u.test(after);
      if (leftSide && rightSide) return 'conflict';
      if (leftSide) sides.add('left');
      if (rightSide) sides.add('right');
    }
    return sides.size > 1 ? 'conflict' : sides.size === 1 ? [...sides][0] : null;
  };
  const leftSide = side(left), rightSide = side(right);
  if (leftSide === 'conflict' || rightSide === 'conflict') return false;
  return !leftSide || !rightSide || leftSide === rightSide;
}

function sharedClinicalInjuryPhrase(left, right) {
  const phrases = evidence => {
    const source = typeof evidence === 'string' ? evidence : `${evidence?.value ?? ''} ${evidence?.evidence ?? ''}`;
    const text = normalize(source).replace(/脾脏/gu, '脾').replace(/肝脏/gu, '肝')
      .replace(/胰腺/gu, '胰').replace(/肾脏/gu, '肾');
    const result = new Set();
    for (const match of text.matchAll(/[\u4e00-\u9fff]{1,4}(?:骨折|破裂|挫伤|损伤|创口|穿透创|贯通伤|出血|脱位|撕裂|断裂)/gu)) {
      for (let start = 0; start <= match[0].length - 3; start += 1) {
        const phrase = match[0].slice(start);
        if (phrase.length >= 4 || /^(?:肺|脾|肾|肝|胰)破裂$/u.test(phrase)) result.add(phrase);
      }
    }
    return result;
  };
  const leftPhrases = phrases(left);
  return [...phrases(right)].some(phrase => leftPhrases.has(phrase));
}

function isUnperformedProcedureEvidence(evidence) {
  const text = normalize(String(evidence || ''));
  const procedure = '(?:手术|切除|修补|摘除|清除|引流|缝合|修复|减压|复位|置入|植入|固定)';
  const proposed = new RegExp(`(?:拟|拟行|拟施行|计划|建议|考虑|不宜|不能|无法|难以|尚未|未行|未实施|未接受|未完成|拒绝)[^。！？；;\\n]{0,20}${procedure}`, 'u');
  const cancelled = new RegExp(`${procedure}[^。！？；;\\n]{0,16}(?:尚未|未行|未实施|未接受|未完成|拒绝|取消)`, 'u');
  return proposed.test(text) || cancelled.test(text);
}

function isPerformedSurgicalTreatmentFact(fact) {
  if (fact?.field !== 'treatment' || fact.source !== 'description' || fact.verification !== 'quoted'
    || !reliableCertainties.has(fact.certainty)) return false;
  const evidence = normalize(String(fact.evidence || ''));
  if (!evidence || isUnperformedProcedureEvidence(evidence)
    || /(?:手术计划|拟行|拟施行|拟手术|术前准备)/u.test(evidence)) return false;
  return /(?:行|接受|施行|实施|进行|完成|予以)[^。！？；;\n]{0,20}(?:手术|[\p{Script=Han}]{2,14}术(?!前|后))/u.test(evidence);
}

function requiresCurrentProcedureLink(node) {
  const conditionText = normalize(`${node.sourceText || ''} ${node.conditionText || ''}`);
  const procedurePattern = /手术|切除术?|修补术?|摘除术|清除|引流|缝合|修复术|修复手术/u;
  const nonPerformedProcedure = /(?:难以|难于|不能|无法|不宜|不适宜|不适合|未予|未行|未接受|尚未|拟|计划|建议)[^。；;]{0,12}(?:手术|切除|修补|摘除|清除|引流|缝合|修复)|(?:手术|切除|修补|摘除|清除|引流|缝合|修复)[^。；;]{0,12}(?:困难|难以|不能|无法|不宜|不适宜)/u;
  const surgeryNeedForReplacement = /(?:需要|需|须)[^。；;]{0,8}手术(?:更换|修复)/u.test(conditionText);
  if (nonPerformedProcedure.test(conditionText) || surgeryNeedForReplacement) return false;
  return procedurePattern.test(conditionText)
    || (node.factMatch?.values || []).some(value => typeof value === 'string' && procedurePattern.test(value));
}

function hasUnresolvedHandDigitSeparation(sourceText, assessmentType, references) {
  if (assessmentType !== 'injury'
    || references.some(reference => ['5.10.2.d', '5.10.2.e', '5.10.2.f'].includes(reference.id)
      && reference.relation === 'supports')) return false;
  return sourceText.split(/[。！？；;\n]/u).some(segment => {
    const namesDigit = /(?:拇指|示指|食指|中指|环指|无名指|小指|第\s*[一二三四五六七八九十\d]+\s*指)/u.test(segment);
    const describesSeparation = /(?:离断|离体|缺失|缺如|断离|仅[^，,；;]{0,16}(?:皮肤|皮下组织)(?:相连|连接)|(?:皮肤|皮下组织)(?:桥|相连|连接))/u.test(segment);
    const explicitlyNegative = /(?:未见|未发现|排除|否认|不伴)[^，,；;]{0,12}(?:离断|离体|缺失|缺如)/u.test(segment);
    const historicalOnly = /(?:既往|历史|陈旧|曾经|曾行|此前|术前)/u.test(segment)
      && !/(?:本次|此次|当前|受伤后|事故后)/u.test(segment);
    return namesDigit && describesSeparation && !explicitlyNegative && !historicalOnly;
  });
}

function evidenceLabelsFindingAsHistorical(evidence, sourceText) {
  const normalizedEvidence = normalize(evidence);
  const finding = normalize(sourceText);
  const index = normalizedEvidence.indexOf(finding);
  if (index < 0) return false;
  const segmentStart = Math.max(normalizedEvidence.lastIndexOf('。', index - 1),
    normalizedEvidence.lastIndexOf('；', index - 1), normalizedEvidence.lastIndexOf(';', index - 1),
    normalizedEvidence.lastIndexOf('\n', index - 1)) + 1;
  const context = normalizedEvidence.slice(segmentStart, index + finding.length);
  const historicalCues = [...context.matchAll(/既往(?:史)?|既有|历史(?:病历|手术|病史|资料)|陈旧|原有|此前|术前|曾(?:经|于|在|行|接受|做过|做|切除|修补|施行)/gu)];
  const currentCues = [...context.matchAll(/(?:本次|此次|当前)(?:交通)?(?:事故|外伤|受伤|损伤)/gu)];
  return historicalCues.length > 0 && (!currentCues.length
    || historicalCues.at(-1).index > currentCues.at(-1).index);
}

function evidenceOccursOnlyInMarkedContext(evidence, sourceText, contextMarker) {
  const quote = String(evidence || '').normalize('NFKC').replace(/\r\n?/gu, '\n').replace(/[\t \u00a0]+/gu, '').toLowerCase();
  const source = String(sourceText || '').normalize('NFKC').replace(/\r\n?/gu, '\n').replace(/[\t \u00a0]+/gu, '').toLowerCase();
  if (!quote || !source) return false;
  let occurrenceCount = 0;
  let allOccurrencesAreCitations = true;
  let offset = source.indexOf(quote);
  while (offset >= 0) {
    occurrenceCount += 1;
    const start = Math.max(source.lastIndexOf('。', offset - 1), source.lastIndexOf('！', offset - 1),
      source.lastIndexOf('？', offset - 1), source.lastIndexOf('；', offset - 1), source.lastIndexOf(';', offset - 1),
      source.lastIndexOf('\n', offset - 1)) + 1;
    const prefix = source.slice(start, offset);
    const previousLineEnd = source[start - 1] === '\n' ? start - 1 : -1;
    const previousLineStart = previousLineEnd >= 0
      ? Math.max(source.lastIndexOf('。', previousLineEnd - 1), source.lastIndexOf('！', previousLineEnd - 1),
        source.lastIndexOf('？', previousLineEnd - 1), source.lastIndexOf('；', previousLineEnd - 1),
        source.lastIndexOf(';', previousLineEnd - 1), source.lastIndexOf('\n', previousLineEnd - 1)) + 1 : -1;
    const previousLineIsCitationHeading = previousLineStart >= 0
      && contextMarker.test(source.slice(previousLineStart, previousLineEnd));
    if (!contextMarker.test(prefix) && !previousLineIsCitationHeading) allOccurrencesAreCitations = false;
    offset = source.indexOf(quote, offset + quote.length);
  }
  return occurrenceCount > 0 && allOccurrencesAreCitations;
}

const STANDARD_QUOTATION_MARKER = /(?:标准原文|标准条文|条文原文|条款原文|(?:引用|摘录|照录)(?:了)?(?:标准|条文|条款)|(?:引用|摘录|照录)(?:了)?《[^》]{1,64}(?:标准|分级)[^》]*》|《[^》]{1,64}(?:标准|分级)[^》]*》第[^。！？；;]{0,16}(?:条|款|项|附录|表)[:：]?)/u;
const PRIOR_APPRAISAL_CONCLUSION_MARKER = /(?:(?:原|既往|既有|此前|之前|上次|前次)(?:的)?(?:鉴定|评定)(?:意见|结论|结果)|(?:伤情|伤残)鉴定结论|鉴定结论|鉴定意见(?:记载|认为|认定|结论|为|[:：]))/u;

function aggregateEvidenceIncludesParent(aggregate, parent) {
  if (includesEvidence(aggregate.evidence, parent.evidence)) return true;
  return Array.isArray(aggregate.sourceRefs) && aggregate.sourceRefs.some(reference => reference.source === parent.source
    && includesEvidence(parent.evidence, reference.evidence));
}

function quotedScalpMeasurementSite(fact, facts = []) {
  if (!fact || typeof fact !== 'object') return null;
  if (fact.regionEvidence?.site === '头皮'
    && /创口|伤口|创痕|划痕|划伤|瘢痕|疤痕|切口|裂口|裂创|裂伤/u.test(fact.regionEvidence.injuryType || '')
    && Number.isFinite(fact.value)
    && [fact.evidence, ...(fact.sourceRefs || []).map(reference => reference.evidence)]
      .some(evidence => typeof evidence === 'string'
        && [...evidence.matchAll(/(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:cm|厘米)/gu)]
          .some(match => Number(match[1]) === fact.value || parseNumber(match[1]) === fact.value))) {
    return `${fact.regionEvidence.site}${fact.regionEvidence.injuryType}`;
  }
  const sitePattern = /枕骨隆突部|枕项部|后枕部|颞枕部|顶枕部|颞顶部|额顶部|头顶部|颞部|顶部|枕部|头皮/u;
  const injuryPattern = /创口|伤口|创痕|划伤|裂口|裂创|裂伤|瘢痕|疤痕/u;
  const facePattern = /面部|脸部|额部|前额|额头|眉弓|眉部|眉|眼睑|眼外侧|外眦|面颊|颧部|鼻唇沟|鼻部|鼻背|口唇|上唇|下唇|下颌/u;
  const sourceEvidence = [...new Set([
    ...(Array.isArray(fact.sourceRefs) ? fact.sourceRefs
      .filter(reference => reference.source === fact.source).map(reference => reference.evidence) : []),
    fact.evidence,
  ].filter(value => typeof value === 'string' && value))];
  for (const evidence of sourceEvidence) {
    for (const match of evidence.matchAll(/(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:cm|厘米)/gu)) {
      const amount = /^\d/u.test(match[1]) ? Number(match[1]) : parseNumber(match[1]);
      if (amount !== fact.value) continue;
      const preceding = evidence.slice(0, match.index);
      const start = Math.max(preceding.lastIndexOf('，'), preceding.lastIndexOf(','), preceding.lastIndexOf('、'),
        preceding.lastIndexOf('；'), preceding.lastIndexOf(';'), preceding.lastIndexOf('。')) + 1;
      const following = evidence.slice(match.index);
      const stops = ['，', ',', '、', '；', ';', '。'].map(delimiter => {
        const index = following.indexOf(delimiter);
        return index < 0 ? Infinity : match.index + index;
      });
      const end = Math.min(...stops);
      const localEvidence = evidence.slice(start, Number.isFinite(end) ? end : evidence.length).trim();
      if (sitePattern.test(localEvidence) && injuryPattern.test(evidence) && !facePattern.test(localEvidence)) {
        return localEvidence;
      }
    }
  }
  const measurementValue = Number.isFinite(fact.value) ? fact.value : null;
  if (measurementValue !== null) {
    const aggregateContexts = facts.filter(candidate => candidate.field === 'aggregate_wound_length_cm'
      && candidate.source === fact.source && candidate.certainty === 'derived'
      && candidate.derivedFrom?.includes(fact.id));
    for (const aggregate of aggregateContexts) {
      const evidenceTexts = [aggregate.evidence, ...(aggregate.sourceRefs || [])
        .filter(reference => reference.source === fact.source).map(reference => reference.evidence)]
        .filter(value => typeof value === 'string' && value);
      for (const evidence of evidenceTexts) {
        const sharedScalpScarHeading = /(?:头部|头皮|头顶部|额顶部|顶部|枕部|颞部)[^。；;]{0,18}(?:瘢痕|疤痕)\s*[:：]/u.test(evidence)
          && !/(?:未见|无|否认|排除|可能|考虑)[^。；;]{0,20}(?:头部|头皮)?(?:瘢痕|疤痕)/u.test(evidence);
        const groups = evidence.split(/[。！？；;\n]+/u).map(value => value.trim()).filter(Boolean);
        for (const group of groups) {
          const countMatches = [...group.matchAll(/([0-9零〇一二两三四五六七八九十百]+)\s*(?:处|道|条)/gu)];
          for (let index = 0; index < countMatches.length; index += 1) {
            const countMatch = countMatches[index];
            const count = parseNumber(countMatch[1]);
            const nextCount = countMatches[index + 1]?.index ?? group.length;
            const suffix = group.slice(countMatch.index, nextCount);
            const measurementMatches = [...suffix.matchAll(/(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:cm|厘米)/gu)];
            let values = measurementMatches.map(match => /^\d/u.test(match[1]) ? Number(match[1]) : parseNumber(match[1]));
            if (values.length !== count) {
              const listCue = /(?:分别|各)(?:\s*(?:为|长|长度))?\s*|(?:长|长度)(?:约|为|达)?\s*/u.exec(suffix);
              if (listCue) {
                const listStart = listCue.index + listCue[0].length;
                const listTail = suffix.slice(listStart);
                const lastUnit = /(?:cm|厘米)/u.exec(listTail);
                const listText = lastUnit ? listTail.slice(0, lastUnit.index) : listTail;
                const tokens = [...listText.matchAll(/\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+/gu)];
                values = tokens.map(match => /^\d/u.test(match[0]) ? Number(match[0]) : parseNumber(match[0]));
              }
            }
            const prefix = group.slice(Math.max(0, countMatch.index - 48), countMatch.index);
            const siteMatches = [...prefix.matchAll(new RegExp(sitePattern.source, 'gu'))];
            const site = siteMatches.at(-1)?.[0] || '';
            const siteEvidence = `${site}${suffix}`;
            if (count !== values.length || values.filter(value => value === measurementValue).length !== 1
              || !sitePattern.test(siteEvidence) || !(injuryPattern.test(suffix) || sharedScalpScarHeading)
              || facePattern.test(prefix)) continue;
            return siteEvidence;
          }
          const measurementMatches = [...group.matchAll(/(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:cm|厘米)/gu)];
          const values = measurementMatches.map(match => /^\d/u.test(match[1]) ? Number(match[1]) : parseNumber(match[1]));
          if (values.filter(value => value === measurementValue).length === 1
            && sitePattern.test(group) && injuryPattern.test(group) && !facePattern.test(group)) return group;
        }
      }
    }
  }
  return null;
}

function isUnsegmentedFaceScalpMeasurement(fact) {
  if (fact.regionEvidence?.site) return false;
  const evidence = normalize(fact.evidence || '');
  const faceSite = '(?:面部|脸部|额部|前额|额头|眉弓|眉部|眉|眼外侧|眼外眦|外眦|眼睑|上睑|下睑|内眦|颧部|鼻唇沟|鼻部|鼻背|鼻梁|口唇|上唇|下唇|下颌)';
  const scalpSite = '(?:额顶部|头顶部|颞顶部|顶枕部|后枕部|颞枕部|顶部|枕部|颞部|头皮|发际内|发际线)';
  const measurements = [...evidence.matchAll(/(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:cm|厘米)/gu)];
  const sites = [...evidence.matchAll(new RegExp(`${faceSite}|${scalpSite}`, 'gu'))];
  const woundCues = [...evidence.matchAll(/创口|伤口|裂口|裂创|裂伤|切口|瘢痕|疤痕/gu)];
  if (measurements.length >= 2 && sites.length >= 2 && woundCues.length >= 2
    && /(?:两处|多处|分别|各自|两道|多道)/u.test(evidence)) return false;
  return new RegExp(`${faceSite}.{0,14}${scalpSite}|${scalpSite}.{0,14}${faceSite}`, 'u').test(evidence);
}

function isWholeMeasurementWithRegionSegments(fact, facts) {
  if (fact.field !== 'wound_length_cm' || fact.regionEvidence?.site || !Number.isFinite(fact.value)) return false;
  const relatedSegments = facts.filter(candidate => candidate !== fact && candidate.source === fact.source
    && candidate.field === 'wound_length_cm' && candidate.regionEvidence?.site && Number.isFinite(candidate.value));
  const hasFace = relatedSegments.some(candidate => /^(?:面部|脸部)$/u.test(candidate.regionEvidence.site));
  const hasOutsideFace = relatedSegments.some(candidate => /^(?:颈部|颈前部|头部|头皮)$/u.test(candidate.regionEvidence.site));
  const hasAuricle = relatedSegments.some(candidate => candidate.regionEvidence.site === '耳廓');
  const hasScalp = relatedSegments.some(candidate => candidate.regionEvidence.site === '头皮');
  const segmentTotal = Math.round(relatedSegments.reduce((sum, candidate) => sum + candidate.value, 0) * 100) / 100;
  return (hasFace && hasOutsideFace || hasAuricle && hasScalp) && segmentTotal === fact.value;
}

function conditionFactIsExplicitlyNegated(node, fact) {
  if (!node.factMatch || typeof fact.evidence !== 'string') return false;
  if (largeJointLossRequirement(node)) {
    return Boolean(largeJointLossEvidence(node, fact.evidence, fact.value)?.negated);
  }
  if (visualFieldRequirement(node)) {
    return Boolean(visualFieldEvidence(node, fact.evidence, fact.value)?.observations.some(item => item.negated));
  }
  if (hearingThresholdRequirement(node)) {
    return Boolean(hearingThresholdEvidence(node, fact.evidence, fact.value)?.observations.some(item => item.negated));
  }
  if (unilateralEarFindingRequirement(node)) {
    return Boolean(unilateralEarFindingEvidence(node, fact.evidence, fact.value)?.findings.some(item => item.negated));
  }
  if (completeVisualFieldRequirement(node)) {
    return Boolean(completeVisualFieldEvidence(node, fact.evidence, fact.value)?.findings.some(item => item.negated));
  }
  if (vertebralCompressionRequirement(node)) {
    return Boolean(vertebralCompressionEvidence(node, fact.evidence, fact.value)?.negated);
  }
  const terms = [...new Set([...(node.factMatch.values || []), ...(node.factMatch.valueIncludes || []),
    ...(node.factMatch.evidenceAliases || [])].filter(value => typeof value === 'string' && value))];
  const clauses = normalize(fact.evidence).split(/[，,。！？；;、\n]/u);
  const negation = /(?:未见|未发现|未提示|未查见|未检查出|未提及|未记载|没有|不存在|否认|排除|无)[^，,。！？；;、\n]{0,18}$/u;
  return clauses.some(clause => terms.some(term => {
    const index = clause.indexOf(normalize(term));
    return index >= 0 && negation.test(clause.slice(0, index));
  }));
}

function isSpinalEpiduralHematomaFact(fact) {
  const spinalLocation = /(?:脊髓|椎体|椎管|颈椎|胸椎|腰椎|\b[CTLS]\s*\d)/iu;
  const value = normalize(String(fact.value || ''));
  if (/硬膜外(?:血肿|出血)/u.test(value) && spinalLocation.test(value)) return true;
  const evidenceSegments = String(fact.evidence || '').normalize('NFKC').split(/[，,。；;！？!?\n]/u);
  return evidenceSegments.some(segment => /硬膜外(?:血肿|出血)/u.test(segment) && spinalLocation.test(segment));
}

function largeJointLossRequirement(node) {
  if (node.factMatch?.field !== 'clinical_finding') return null;
  const condition = normalize(`${node.sourceText || ''} ${node.conditionText || ''}`);
  if (!condition.includes('大关节')) return null;
  const threshold = /功能丧失(?:率)?(\d+(?:\.\d+)?)%/u.exec(condition);
  const ankylosis = condition.includes('强直畸形');
  if (!threshold && !ankylosis) return null;
  return { threshold: threshold ? Number(threshold[1]) : null, ankylosis,
    excludeAnkle: condition.includes('踝关节除外') };
}

function largeJointLossEvidence(node, evidence, factValue) {
  const requirement = largeJointLossRequirement(node);
  if (!requirement || typeof evidence !== 'string' || typeof factValue !== 'string'
    || !includesEvidence(evidence, factValue)) return null;
  const sitePattern = /(?:肩|肘|腕|髋|膝|踝)关节/gu;
  const text = evidence.normalize('NFKC');
  for (const segmentMatch of text.matchAll(/[^。！？；;\n]+/gu)) {
    const segment = segmentMatch[0];
    const jointMatches = [...segment.matchAll(sitePattern)].filter(match =>
      !(requirement.excludeAnkle && match[0].startsWith('踝')));
    if (jointMatches.length !== 1) continue;
    const joint = jointMatches[0];
    const lateralityContext = segment.slice(Math.max(0, joint.index - 3), joint.index);
    const side = /左/u.test(lateralityContext) ? 'left' : /右/u.test(lateralityContext) ? 'right' : null;
    const valueJointMatches = [...factValue.normalize('NFKC').matchAll(sitePattern)];
    if (valueJointMatches.length !== 1
      || valueJointMatches[0][0].replace(/关节/u, '') !== joint[0].replace(/关节/u, '')) continue;
    const valueSideContext = factValue.normalize('NFKC').slice(Math.max(0, valueJointMatches[0].index - 3), valueJointMatches[0].index);
    const valueSide = /左/u.test(valueSideContext) ? 'left' : /右/u.test(valueSideContext) ? 'right' : null;
    if (side && valueSide && side !== valueSide) continue;
    if (requirement.ankylosis && /强直畸形/u.test(segment)) {
      const findingIndex = segment.indexOf('强直畸形');
      const nearby = segment.slice(Math.max(0, findingIndex - 24), findingIndex + 6);
      const negated = /(?:未见|未发现|否认|排除|没有|无|不伴)[^，,。！？；;\n]{0,16}$/u.test(nearby);
      const uncertain = /(?:疑似|可能|考虑|待排|待查|待核|待明确|不确定)/u.test(nearby);
      if (joint.index <= findingIndex && findingIndex - joint.index <= 24 && /强直畸形/u.test(factValue)) {
        return { matched: true, joint: joint[0], side, negated, uncertain,
          supports: !negated && !uncertain && requirement.threshold === null };
      }
    }
    if (requirement.threshold === null) continue;
    const lossPattern = /功能丧失(?:率)?\s*(?:(?:为|达|≥|不少于|不低于)\s*)?(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*%/gu;
    const lossMatches = [...segment.matchAll(lossPattern)];
    if (lossMatches.length !== 1) continue;
    const loss = lossMatches[0];
    if (joint.index > loss.index || loss.index - joint.index > 24) continue;
    const parsedPercent = /^\d/u.test(loss[1]) ? Number(loss[1]) : parseNumber(loss[1]);
    if (!Number.isFinite(parsedPercent) || parsedPercent < 0 || parsedPercent > 100) continue;
    const quotedLoss = /功能丧失(?:率)?\s*(?:(?:为|达|≥|不少于|不低于)\s*)?(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*%/u.exec(factValue.normalize('NFKC'));
    const quotedPercent = quotedLoss && (/^\d/u.test(quotedLoss[1]) ? Number(quotedLoss[1]) : parseNumber(quotedLoss[1]));
    if (quotedPercent !== parsedPercent) continue;
    const context = segment.slice(Math.max(0, joint.index - 20), Math.min(segment.length, loss.index + loss[0].length + 8));
    const negated = /(?:未见|未发现|否认|排除|没有|无|未达|不超过|小于|低于|不足|少于)[^，,。！？；;\n]{0,16}(?:功能丧失|功能丧失率)/u.test(context)
      || /功能丧失(?:率)?\s*(?:低于|小于|不足|不超过|未达)/u.test(context)
      || /功能丧失(?:率)?[^，,。！？；;\n]{0,12}(?:以下|以内)/u.test(context);
    const uncertain = /(?:约|大约|左右|接近|估计|疑似|可能|考虑|待排|待查|待核|待明确|不确定|不能确定)/u.test(context);
    return { matched: true, joint: joint[0], side, percent: parsedPercent, negated, uncertain,
      supports: !negated && !uncertain && parsedPercent >= requirement.threshold };
  }
  return null;
}

function vertebralCompressionRequirement(node) {
  if (node.factMatch?.field !== 'clinical_finding') return null;
  const condition = normalize(`${node.sourceText || ''} ${node.conditionText || ''}`);
  if (!condition.includes('椎体') || !/压缩/u.test(condition) || !/1\s*\/\s*3/u.test(condition)) return null;
  return { strict: /超过\s*1\s*\/\s*3/u.test(condition),
    includesComminution: /粉碎性骨折/u.test(condition) };
}

function vertebralCompressionEvidence(node, evidence, factValue) {
  const requirement = vertebralCompressionRequirement(node);
  if (!requirement || typeof evidence !== 'string' || typeof factValue !== 'string'
    || !includesEvidence(evidence, factValue)) return null;
  const text = evidence.normalize('NFKC');
  const valueText = factValue.normalize('NFKC');
  const levelPattern = /(?:\b[CTLS]\s*\d{1,2}(?:椎体|椎|节)?|第?[一二两三四五六七八九十百\d]+(?:颈椎|胸椎|腰椎|骶椎))/giu;
  for (const segmentMatch of text.matchAll(/[^。！？；;\n]+/gu)) {
    const segment = segmentMatch[0];
    const levels = [...segment.matchAll(levelPattern)];
    const valueLevels = [...valueText.matchAll(levelPattern)];
    if (valueLevels.length !== 1) continue;
    const matchingLevels = levels.filter(item => normalize(item[0]) === normalize(valueLevels[0][0]));
    if (matchingLevels.length !== 1) continue;
    const level = matchingLevels[0];
    const compressionDiagnosis = /压缩(?:性)?骨折/u.exec(segment);
    if (compressionDiagnosis && level.index <= compressionDiagnosis.index
      && compressionDiagnosis.index - level.index <= 32
      && /压缩(?:性)?骨折/u.test(valueText)) {
      const diagnosisContext = segment.slice(Math.max(0, level.index - 16), compressionDiagnosis.index + compressionDiagnosis[0].length);
      const negatedDiagnosis = /(?:未见|未发现|否认|排除|没有|无)[^，,。！？；;\n]{0,18}压缩(?:性)?骨折/u.test(diagnosisContext)
        || /压缩(?:性)?骨折[^，,。！？；;\n]{0,12}(?:未见|未发现|否认|排除)/u.test(diagnosisContext);
      const uncertainDiagnosis = /(?:疑似|可能|考虑|待排|待查|待核|待明确|不确定)/u.test(diagnosisContext);
      if (negatedDiagnosis || uncertainDiagnosis) {
        return { matched: true, level: level[0], negated: negatedDiagnosis, uncertain: uncertainDiagnosis,
          supports: false };
      }
    }
    if (requirement.includesComminution && /粉碎性骨折/u.test(segment)
      && /粉碎性骨折/u.test(valueText)) {
      const findingIndex = segment.indexOf('粉碎性骨折');
      const context = segment.slice(Math.max(0, level.index - 16), findingIndex + 6);
      const negated = /(?:未见|未发现|否认|排除|没有|无|不伴)[^，,。！？；;\n]{0,20}$/u.test(context);
      const uncertain = /(?:疑似|可能|考虑|待排|待查|待核|待明确|不确定)/u.test(context);
      if (level.index <= findingIndex && findingIndex - level.index <= 32) {
        return { matched: true, level: level[0], negated, uncertain,
          supports: !negated && !uncertain };
      }
    }
    const ratioPattern = /压缩(?:程度|比|率)\s*(?:(?:为|达|达到|≥|不低于|至少|超过|大于等于|大于)\s*)?(1\s*\/\s*\d+|[零〇一二三四五六七八九十百]+分之[零〇一二三四五六七八九十百]+|\d+(?:\.\d+)?\s*%)/gu;
    const ratios = [...segment.matchAll(ratioPattern)];
    const matchingRatios = ratios.filter(candidate => {
      const priorLevels = levels.filter(item => item.index <= candidate.index);
      const nearestLevel = priorLevels.at(-1);
      return nearestLevel && normalize(nearestLevel[0]) === normalize(level[0])
        && candidate.index - nearestLevel.index <= 48;
    });
    if (matchingRatios.length !== 1 || !/压缩(?:性)?骨折/u.test(segment)) continue;
    const ratio = matchingRatios[0];
    if (level.index > ratio.index || ratio.index - level.index > 48) continue;
    const token = normalize(ratio[1]);
    let compression;
    if (token.includes('/')) {
      const [numerator, denominator] = token.split('/').map(Number);
      if (!denominator) continue;
      compression = numerator / denominator;
    } else if (token.includes('分之')) {
      const [denominatorText, numeratorText] = token.split('分之');
      const denominator = parseNumber(denominatorText), numerator = parseNumber(numeratorText);
      if (!denominator) continue;
      compression = numerator / denominator;
    } else if (token.endsWith('%')) {
      compression = Number(token.slice(0, -1)) / 100;
    }
    if (!Number.isFinite(compression) || compression < 0 || compression > 1) continue;
    const quotedRatios = [...valueText.matchAll(ratioPattern)];
    ratioPattern.lastIndex = 0;
    if (quotedRatios.length !== 1 || normalize(quotedRatios[0][1]) !== token) continue;
    const ratioPrefix = ratio[0].slice(0, ratio[0].lastIndexOf(ratio[1]));
    const strictEvidence = /(?:超过|大于)\s*$/u.test(ratioPrefix);
    const context = segment.slice(Math.max(0, level.index - 16), ratio.index + ratio[0].length + 8);
    const negated = /(?:未见|未发现|否认|排除|没有|无|未达|不超过|小于|低于|不足|少于)/u.test(context)
      || /压缩(?:程度|比|率)[^，,。！？；;\n]{0,12}(?:以下|以内)/u.test(context);
    const uncertain = /(?:约|大约|左右|接近|估计|疑似|可能|考虑|待排|待查|待核|待明确|不确定|不能确定)/u.test(context);
    const atLeastOneThird = compression > 1 / 3
      || compression === 1 / 3 && (!requirement.strict || strictEvidence);
    return { matched: true, level: level[0], compression, negated, uncertain,
      supports: !negated && !uncertain && atLeastOneThird };
  }
  return null;
}

function visualFieldRequirement(node) {
  if (node.factMatch?.field !== 'clinical_finding') return null;
  const condition = `${node.sourceText || ''} ${node.conditionText || ''}`.normalize('NFKC');
  if (!condition.includes('视野')) return null;
  const thresholds = {};
  const radius = /视野半径\s*(\d+(?:\.\d+)?)\s*(?:o|°|度)?\s*(?:以下|以内)/iu.exec(condition);
  const effectiveValue = /视野有效值\s*(?:≤|<=)?\s*(\d+(?:\.\d+)?)\s*%/iu.exec(condition);
  const diameter = /直径\s*(?:≤|<=)?\s*(\d+(?:\.\d+)?)\s*(?:o|°|度)/iu.exec(condition);
  if (radius) thresholds.radius = Number(radius[1]);
  if (effectiveValue) thresholds.effective = Number(effectiveValue[1]);
  if (diameter) thresholds.diameter = Number(diameter[1]);
  if (!Object.keys(thresholds).length) return null;
  return { thresholds, requiredSides: /双眼/u.test(condition) ? ['left', 'right'] : null };
}

function completeVisualFieldRequirement(node) {
  if (node.factMatch?.field !== 'clinical_finding') return false;
  return /一眼视野完全缺损/u.test(`${node.sourceText || ''} ${node.conditionText || ''}`.normalize('NFKC'));
}

function completeVisualFieldEvidence(node, evidence, factValue) {
  if (!completeVisualFieldRequirement(node) || typeof evidence !== 'string' || typeof factValue !== 'string'
    || !includesEvidence(evidence, factValue)) return null;
  const findings = [];
  for (const sentence of evidence.normalize('NFKC').split(/[。！？；;\n]/u)) {
    for (const match of sentence.matchAll(/(左|右)眼[^，,、]{0,12}视野完全缺损/gu)) {
      const context = sentence.slice(Math.max(0, match.index - 12), match.index + match[0].length + 8);
      findings.push({ side: match[1] === '左' ? 'left' : 'right',
        negated: /(?:未见|未发现|否认|排除|没有|无)[^，,、]{0,12}$/u.test(context),
        uncertain: /(?:疑似|可能|考虑|待排|待查|待核|待明确|不确定)/u.test(context) });
    }
  }
  return findings.length ? { matched: true, findings } : null;
}

function visualFieldEvidence(node, evidence, factValue) {
  const requirement = visualFieldRequirement(node);
  if (!requirement || typeof evidence !== 'string' || typeof factValue !== 'string'
    || !includesEvidence(evidence, factValue)) return null;
  const observations = [];
  const text = evidence.normalize('NFKC');
  for (const sentence of text.split(/[。！？；;\n]/u)) {
    const eyes = [...sentence.matchAll(/(左|右)眼/gu)];
    for (let index = 0; index < eyes.length; index += 1) {
      const eye = eyes[index];
      const block = sentence.slice(eye.index, eyes[index + 1]?.index ?? sentence.length);
      const side = eye[1] === '左' ? 'left' : 'right';
      const measurements = [
        ...[...block.matchAll(/视野半径\s*(?:(?:为|是|[:：=])\s*)?(\d+(?:\.\d+)?)\s*(o|°|度)/giu)]
          .map(match => ({ side, metric: 'radius', value: Number(match[1]), match })),
        ...[...block.matchAll(/视野有效值\s*(?:(?:为|是|[:：=])\s*)?(\d+(?:\.\d+)?)\s*[%％]/gu)]
          .map(match => ({ side, metric: 'effective', value: Number(match[1]), match })),
        ...[...block.matchAll(/视野直径\s*(?:(?:为|是|[:：=])\s*)?(\d+(?:\.\d+)?)\s*(o|°|度)/giu)]
          .map(match => ({ side, metric: 'diameter', value: Number(match[1]), match })),
      ].filter(item => Object.hasOwn(requirement.thresholds, item.metric));
      for (const measurement of measurements) {
        const eyePrefix = sentence.slice(Math.max(0, eye.index - 18), eye.index);
        const before = block.slice(Math.max(0, measurement.match.index - 8), measurement.match.index);
        const after = block.slice(measurement.match.index + measurement.match[0].length,
          measurement.match.index + measurement.match[0].length + 8);
        const negated = /(?:未见|未发现|否认|排除|没有|无|未查)/u.test(eyePrefix + before)
          || /(?:未见|未发现|否认|排除|阴性)/u.test(after);
        const uncertain = /(?:疑似|可能|考虑|待排|待查|待核|待明确|不确定|约|大约|左右|接近|估计)/u
          .test(eyePrefix + block.slice(Math.max(0, measurement.match.index - 18),
            measurement.match.index + measurement.match[0].length + 12));
        observations.push({ ...measurement, negated, uncertain,
          supports: !negated && !uncertain && measurement.value <= requirement.thresholds[measurement.metric] });
      }
    }
  }
  return observations.length ? { matched: true, observations } : null;
}

function sameVisualFieldEye(left, right) {
  return Boolean(left?.matched && right?.matched
    && left.observations.some(a => right.observations.some(b => a.side === b.side)));
}

function hearingThresholdRequirement(node) {
  if (node.factMatch?.field !== 'clinical_finding') return null;
  const condition = String(node.conditionText || node.sourceText || '').normalize('NFKC');
  if (!condition.includes('听力障碍')) return null;
  const requirements = [];
  const pattern = /(双耳|另一耳|一耳)\s*听力障碍\s*\(?\s*(?:≥|>=)\s*(\d+(?:\.\d+)?)\s*dB\s*HL\s*\)?/giu;
  for (const match of condition.matchAll(pattern)) {
    const role = match[1] === '双耳' ? 'both' : match[1] === '另一耳' ? 'other' : 'one';
    requirements.push({ role, threshold: Number(match[2]) });
  }
  return requirements.length ? { requirements } : null;
}

function hearingThresholdEvidence(node, evidence, factValue) {
  if (!hearingThresholdRequirement(node) || typeof evidence !== 'string' || typeof factValue !== 'string'
    || !includesEvidence(evidence, factValue)) return null;
  const observations = [];
  const text = evidence.normalize('NFKC');
  // The standards require the age-corrected 0.5/1/2/4 kHz air-conduction mean; accept a source-reported mean only.
  const number = '(\\d+(?:\\.\\d+)?)';
  const frequencyCue = '(?:四频|四个频率|0\\.5\\s*[、,/／和及]+\\s*1\\s*[、,/／和及]+\\s*2\\s*[、,/／和及]+\\s*4\\s*k?Hz|500\\s*[、,/／和及]+\\s*1000\\s*[、,/／和及]+\\s*2000\\s*[、,/／和及]+\\s*4000\\s*Hz)';
  for (const sentence of text.split(/[。！？\n]/u)) {
    const ears = [...sentence.matchAll(/(左|右)耳/gu)];
    for (let index = 0; index < ears.length; index += 1) {
      const ear = ears[index];
      const block = sentence.slice(ear.index, ears[index + 1]?.index ?? sentence.length);
      if (!/纯音/u.test(block) || !/气导/u.test(block) || !new RegExp(frequencyCue, 'iu').test(block)) continue;
      const average = new RegExp(`${frequencyCue}[^。！？；;，,]{0,24}(?:平均(?:值|听阈)?|均值)[^。！？；;，,]{0,18}(?:年龄修正后|年龄校正后|经年龄(?:修正|校正))[^0-9]{0,6}${number}\\s*dB\\s*HL`, 'iu').exec(block);
      if (!average) continue;
      const value = Number(average[1]);
      if (!Number.isFinite(value) || value < 0 || value > 150) continue;
      const before = block.slice(Math.max(0, average.index - 18), average.index);
      const after = block.slice(average.index + average[0].length, average.index + average[0].length + 8);
      const negated = /(?:未见|未测得|未检测出|否认|排除|没有|无)[^，,。！？；;\n]{0,16}$/u.test(before)
        || /(?:未见|未测得|未检测出|阴性)/u.test(after);
      const uncertain = /(?:疑似|可能|考虑|待排|待查|待核|待明确|不确定|约|大约|左右|接近|估计)/u
        .test(block.slice(Math.max(0, average.index - 24), average.index + average[0].length + 12));
      observations.push({ side: ear[1] === '左' ? 'left' : 'right', value, negated, uncertain });
    }
  }
  return observations.length ? { matched: true, observations } : null;
}

function hasExplicitCurrentHearingCausality(evidence) {
  const text = normalize(String(evidence || ''));
  const claims = [
    /(?:本次|此次)(?:交通)?(?:事故|外伤|受伤|损伤)[^。！？；;\n]{0,24}(?:导致|造成|引起|所致)[^。！？；;\n]{0,20}(?:听力障碍|听力损伤|听力下降|听力减退|耳聋|听神经损伤)/u,
    /(?:听力障碍|听力损伤|听力下降|听力减退|耳聋)[^。！？；;\n]{0,20}(?:系|由)(?:本次|此次)(?:交通)?(?:事故|外伤|受伤)(?:所致|引起|造成)/u,
  ];
  const claim = claims.map(pattern => pattern.exec(text)).find(Boolean);
  if (!claim) return false;
  const context = text.slice(Math.max(0, claim.index - 20), claim.index + claim[0].length + 20);
  return !/(?:既往史|既往|既有|陈旧|原有|此前|术前|曾经|未能|不能|无法|并非|不因|非由|未证实|未明确|是否|可能|疑似|考虑|待排|待查|待核|不排除|否认|排除|无关|无因果关系)/u.test(context);
}

function hearingThresholdCausallyLinked(fact, facts) {
  const linkedFacts = [fact, ...facts.filter(candidate => candidate.id !== fact.id
    && candidate.eventId && candidate.eventId === fact.eventId
    && ['diagnosis', 'imaging_finding', 'clinical_finding', 'injury_type'].includes(candidate.field)
    && candidate.source === 'description' && candidate.verification === 'quoted'
    && reliableCertainties.has(candidate.certainty))];
  return linkedFacts.some(candidate => hasExplicitCurrentHearingCausality(candidate.evidence));
}

function unilateralEarFindingRequirement(node) {
  if (node.factMatch?.field !== 'clinical_finding') return null;
  const condition = String(node.conditionText || node.sourceText || '').normalize('NFKC');
  if (!/前庭|听力/u.test(condition)) return null;
  const sameSide = /同侧/u.test(condition);
  const unilateral = /一侧/u.test(condition) && /前庭/u.test(condition);
  if (!sameSide && !unilateral) return null;
  return { role: sameSide ? 'same-side' : 'unilateral', system: /前庭/u.test(condition) ? 'vestibular' : 'hearing' };
}

function unilateralEarFindingEvidence(node, evidence, factValue) {
  const requirement = unilateralEarFindingRequirement(node);
  if (!requirement || typeof evidence !== 'string' || typeof factValue !== 'string'
    || !includesEvidence(evidence, factValue)) return null;
  const pattern = requirement.system === 'vestibular'
    ? /(左|右)(?:侧)?前庭(?:平衡)?功能障碍/gu
    : /(左|右)(?:侧|耳)[^。！？；;\n]{0,12}听力(?:减退|下降|障碍|损失)/gu;
  const findings = [];
  for (const match of evidence.normalize('NFKC').matchAll(pattern)) {
    const start = Math.max(0, match.index - 12);
    const context = evidence.normalize('NFKC').slice(start, match.index + match[0].length + 8);
    findings.push({ side: match[1] === '左' ? 'left' : 'right',
      negated: /(?:未见|未发现|否认|排除|没有|无)[^，,。！？；;\n]{0,16}$/u.test(context),
      uncertain: /(?:疑似|可能|考虑|待排|待查|待核|待明确|不确定)/u.test(context) });
  }
  return findings.length ? { ...requirement, matched: true, findings } : null;
}

function carotidConditionRequirement(node) {
  if (node.factMatch?.field !== 'clinical_finding') return null;
  const condition = String(node.conditionText || node.sourceText || '').normalize('NFKC');
  if (/颈内动脉血栓形成/u.test(condition)) return { kind: 'thrombosis', artery: 'internal' };
  if (/颈总动脉血栓形成/u.test(condition)) return { kind: 'thrombosis', artery: 'common' };
  const stenosis = /血管腔狭窄\s*[（(]\s*(\d+(?:\.\d+)?)\s*%\s*以上/u.exec(condition);
  return stenosis ? { kind: 'stenosis', threshold: Number(stenosis[1]) } : null;
}

function carotidObservations(fact, kind) {
  if (typeof fact.evidence !== 'string') return [];
  const observations = [];
  for (const sentence of fact.evidence.normalize('NFKC').split(/[。！？；;\n]/u)) {
    if (/(?:条款引用|条文引用|标准条文|鉴定标准|标准规定)/u.test(sentence)) continue;
    const arteryPattern = /(?:(左|右)(?:侧)?\s*)?颈(内|总)动脉([^，,。！？；;\n]{0,32})/gu;
    for (const match of sentence.matchAll(arteryPattern)) {
      const side = match[1] === '左' ? 'left' : match[1] === '右' ? 'right' : null;
      const artery = match[2] === '内' ? 'internal' : 'common';
      const tail = match[3];
      if (kind === 'thrombosis' && !/血栓形成|血栓/u.test(tail)
        || kind === 'stenosis' && !/狭窄/u.test(tail)) continue;
      const context = sentence.slice(Math.max(0, match.index - 18), match.index + match[0].length + tail.length + 16);
      let negated = /(?:未见|未发现|未查见|未提示|没有|不存在|排除|阴性)[^，,。！？；;\n]{0,16}$/u
        .test(sentence.slice(Math.max(0, match.index - 18), match.index));
      let uncertain = /(?:疑似|可能|考虑|待排|待查|待核|待明确|不确定|约|大约|左右|接近|估计)/u.test(context);
      let value = null;
      if (kind === 'stenosis') {
        const percent = /狭窄[^，,。！？；;\n]{0,12}?([\d.]+|[零〇一二两三四五六七八九十百]+)\s*%/u.exec(tail);
        if (!percent) continue;
        const valueOffset = percent.index + percent[0].lastIndexOf(percent[1]);
        const beforeValue = tail.slice(percent.index, valueOffset);
        const afterValue = tail.slice(percent.index + percent[0].length);
        if (/(?:未达到|未达|低于|小于|不足|少于|<|＜)\s*$/u.test(beforeValue)) negated = true;
        if (/(?:不超过|不高于|不大于|至多|上限|≤|<=)\s*$/u.test(beforeValue)
          || /^(?:以下|以内|及以下|不超过|至多|≤|<=)/u.test(afterValue)) uncertain = true;
        value = /^[\d.]+$/u.test(percent[1]) ? Number(percent[1]) : parseNumber(percent[1]);
        if (!Number.isFinite(value) || value < 0 || value > 100) continue;
      }
      observations.push({ kind, artery, side, value, negated, uncertain, fact });
    }
  }
  return observations;
}

function carotidFactValueMatches(fact, requirement) {
  const values = Array.isArray(fact.value) ? fact.value : [fact.value];
  return values.some(value => {
    const text = String(value || '').normalize('NFKC');
    if (requirement.kind === 'stenosis') return /(?:颈(?:内|总)动脉)?[^。！？；;]{0,12}狭窄/u.test(text);
    return text.includes(requirement.artery === 'internal' ? '颈内动脉' : '颈总动脉')
      && /血栓/u.test(text);
  });
}

function evaluateCarotidCondition(node, facts, requirement) {
  const acceptedFields = conditionFactFields(node.factMatch);
  const matchingFacts = facts.filter(fact => acceptedFields.has(fact.field)
    && fact.source === 'description' && fact.verification === 'quoted'
    && Boolean(fact.eventId) && carotidFactValueMatches(fact, requirement));
  const observations = matchingFacts.flatMap(fact => carotidObservations(fact, requirement.kind)
    .filter(item => requirement.kind !== 'thrombosis' || item.artery === requirement.artery)
    .map(item => ({ ...item, certainty: fact.certainty,
      threshold: requirement.kind === 'stenosis' ? requirement.threshold : null })));
  const positive = observations.filter(item => reliableCertainties.has(item.certainty) && !item.negated && !item.uncertain
    && (requirement.kind !== 'stenosis' || item.value >= requirement.threshold));
  const explicitBelowThreshold = requirement.kind === 'stenosis' && observations.some(item =>
    reliableCertainties.has(item.certainty) && !item.negated && !item.uncertain && item.value < requirement.threshold);
  const uncertain = observations.some(item => ['uncertain', 'unknown', 'conflicted'].includes(item.certainty)
    || item.uncertain);
  const sameVessel = (left, right) => left.artery === right.artery
    && (!left.side || !right.side || left.side === right.side);
  const contradictory = observations.some(item => item.negated || item.certainty === 'excluded')
    && positive.some(affirmative => observations.some(negative => sameVessel(negative, affirmative)
      && (negative.negated || negative.certainty === 'excluded')));
  const conflictingMeasurements = requirement.kind === 'stenosis' && observations.some(item =>
    reliableCertainties.has(item.certainty) && !item.negated && !item.uncertain && item.value >= requirement.threshold
    && observations.some(other => sameVessel(other, item)
      && reliableCertainties.has(other.certainty) && !other.negated && !other.uncertain
      && other.value < requirement.threshold));
  const uncertainSameVessel = positive.some(item => observations.some(other => sameVessel(other, item)
    && (other.uncertain || ['uncertain', 'unknown', 'conflicted'].includes(other.certainty))));
  if (contradictory || conflictingMeasurements || uncertainSameVessel) {
    return { met: null, evidence: '', factIds: [], carotidAssertions: observations };
  }
  if (positive.length) return { met: true, evidence: uniqueEvidenceText(positive.map(item => item.fact.evidence)),
    factIds: [...new Set(positive.map(item => item.fact.id))], carotidAssertions: observations };
  if (uncertain) return { met: null, evidence: '', factIds: [], carotidAssertions: observations };
  if (explicitBelowThreshold || observations.some(item => item.negated || item.certainty === 'excluded')) {
    return { met: false, evidence: uniqueEvidenceText(observations.map(item => item.fact.evidence)),
      factIds: [...new Set(observations.map(item => item.fact.id))], carotidAssertions: observations };
  }
  return { met: null, evidence: '', factIds: [], carotidAssertions: observations };
}

function isIntracranialCondition(node) {
  return /(?:颅内|脑内|脑挫|脑实质)/u.test(normalize(`${node.sourceText || ''} ${node.conditionText || ''}`));
}

function verifiedAgeAtPoint(facts, eventId, field, agePattern) {
  if (!eventId) return null;
  const ageFacts = facts.filter(fact => fact.field === field && fact.eventId === eventId
    && fact.source === 'description' && fact.verification === 'quoted');
  if (!ageFacts.length) return null;
  const values = new Set();
  for (const fact of ageFacts) {
    if (!reliableCertainties.has(fact.certainty) || !Number.isInteger(fact.value) || fact.value < 0 || fact.value > 130) {
      return null;
    }
    if (/(?:患者的?父亲|患者的?母亲|其父|其母|家属|丈夫|妻子|他人|其他人|另一个人|同事)/u.test(fact.evidence || '')) {
      return null;
    }
    const match = agePattern.exec(fact.evidence || '');
    if (!match || Number(match[1]) !== fact.value) return null;
    values.add(fact.value);
  }
  return values.size === 1 ? [...values][0] : null;
}

function ageAtInjury(facts, eventId) {
  return verifiedAgeAtPoint(facts, eventId, 'age_at_injury_years',
    /(?:受伤|事故|损伤)时(?:年龄)?\s*(?:为|是|[:：])?\s*(\d{1,3})\s*(?:周岁|岁)/u);
}

function verifiedAdultAgeAtPoint(facts, eventId, field, pattern) {
  const age = verifiedAgeAtPoint(facts, eventId, field, pattern);
  return age !== null && age >= 15;
}

function verifiedAdultAgeAtInjury(facts, eventId) {
  return ageAtInjury(facts, eventId) >= 15;
}

function verifiedAdultAgeAtAssessment(facts, eventId) {
  return verifiedAdultAgeAtPoint(facts, eventId, 'age_at_assessment_years',
    /(?:评残|伤残评定|残疾评定|鉴定|评估)时(?:年龄)?\s*(?:为|是|[:：])?\s*(\d{1,3})\s*(?:周岁|岁)/u);
}

function verifiedAdultAgeForAdjustment(facts, eventId, ageAdjustment) {
  if (ageAdjustment === 'injury_standard_6_18') return verifiedAdultAgeAtInjury(facts, eventId);
  if (ageAdjustment === 'disability_standard_6_11') {
    return verifiedAdultAgeAtInjury(facts, eventId) && verifiedAdultAgeAtAssessment(facts, eventId);
  }
  return false;
}

function disabilityAgeFactor(facts, eventId) {
  const injuryAge = ageAtInjury(facts, eventId);
  const assessmentAge = verifiedAgeAtPoint(facts, eventId, 'age_at_assessment_years',
    /(?:评残|伤残评定|残疾评定|鉴定|评估)时(?:年龄)?\s*(?:为|是|[:：])?\s*(\d{1,3})\s*(?:周岁|岁)/u);
  if (injuryAge === null || assessmentAge === null) return null;
  const factorForAge = age => age <= 6 ? 0.5 : age <= 14 ? 0.8 : 1;
  const injuryFactor = factorForAge(injuryAge);
  return injuryFactor === factorForAge(assessmentAge) ? injuryFactor : null;
}

function adjustedDisabilityAgePredicate(node, facts, eventId) {
  const predicate = node.predicate;
  if (node.ageAdjustment !== 'disability_standard_6_11'
    || !DISABILITY_AGE_SCALED_MEASUREMENT_FIELDS.has(predicate?.field)
    || predicate.operator !== 'gte') return null;
  const factor = disabilityAgeFactor(facts, eventId);
  if (factor !== null && predicate.field === 'facial_scar_width_cm' && factor < 1) {
    return facts.some(fact => fact.field === predicate.field && Number.isFinite(predicateEvidenceValue(predicate, fact, facts))
      && predicateEvidenceValue(predicate, fact, facts) >= predicate.value) ? predicate : null;
  }
  return factor === null ? null
    : { ...predicate, value: Math.round(predicate.value * factor * 1_000_000) / 1_000_000 };
}

function adjustedAgePredicate(node, facts, eventId) {
  const predicate = node.predicate;
  if (node.ageAdjustment !== 'injury_standard_6_18' || !INJURY_AGE_SCALED_MEASUREMENT_FIELDS.has(predicate?.field)
    || predicate.operator !== 'gte') return null;
  const age = ageAtInjury(facts, eventId);
  const measurementFacts = facts.filter(fact => fact.field === predicate.field
    && (eventId === null ? !fact.eventId : fact.eventId === eventId)
    && Number.isFinite(predicateEvidenceValue(predicate, fact, facts)));
  if (age === null) {
    if (measurementFacts.some(fact => predicateEvidenceValue(predicate, fact, facts) >= predicate.value)) return predicate;
    const minimumThreshold = predicate.value * 0.5;
    const completeAggregate = predicate.field === 'contusion_tbsa_percent' && measurementFacts.length === 1
      && /(?:累计|总面积|合计|共计)/u.test(measurementFacts[0].evidence);
    const completeScalpLengthAggregate = predicate.field === 'aggregate_wound_length_cm' && measurementFacts.length === 1
      && measurementFacts[0].certainty === 'derived' && Array.isArray(measurementFacts[0].derivedFrom)
      && measurementFacts[0].derivedFrom.length > 0
      && predicate.evidenceGroups?.some(group => group.includes('头皮'))
      && /(?:两处|多处|分别|总长|累计|合计|共计)/u.test(measurementFacts[0].evidence);
    const completeScalpAreaAggregate = predicate.field.startsWith('scalp_') && measurementFacts.length === 1
      && /(?:累计|总面积|合计|共计)/u.test(measurementFacts[0].evidence);
    const completeSkinAreaAggregate = (predicate.field.startsWith('skin_')
      || predicate.field === 'scalp_abrasion_area_cm2') && measurementFacts.length === 1
      && /(?:累计|总面积|合计|共计)/u.test(measurementFacts[0].evidence);
    const completeSurfaceWoundLengthAggregate = predicate.field === 'aggregate_wound_length_cm'
      && measurementFacts.length === 1 && measurementFacts[0].certainty === 'reported'
      && /(?:多处|多个|[零〇一二两三四五六七八九十百0-9]+\s*(?:处|道))/u.test(measurementFacts[0].evidence)
      && /(?:创口|创痕|裂伤|伤口|瘢痕|疤痕)/u.test(measurementFacts[0].evidence)
      && /(?:总长(?:度)?|累计长(?:度)?|长度合计|长度累计)/u.test(measurementFacts[0].evidence);
    const completeSurfaceScarAreaAggregate = predicate.field === 'aggregate_surface_scar_area_cm2'
      && measurementFacts.length === 1 && measurementFacts[0].certainty === 'reported'
      && /(?:累计|总面积|合计)/u.test(measurementFacts[0].evidence);
    const localSkinMeasurementsBelowEveryAgeThreshold = (predicate.field.startsWith('burn_area_')
      || predicate.field === 'facial_skin_abnormality_area_cm2' || predicate.field === 'surface_scar_area_cm2')
      && measurementFacts.length > 0 && measurementFacts.every(fact => predicateEvidenceValue(predicate, fact, facts) < minimumThreshold);
    return (completeAggregate || completeScalpLengthAggregate || completeScalpAreaAggregate || completeSkinAreaAggregate
      || completeSurfaceWoundLengthAggregate || completeSurfaceScarAreaAggregate
      || localSkinMeasurementsBelowEveryAgeThreshold)
      && measurementFacts.every(fact => predicateEvidenceValue(predicate, fact, facts) < minimumThreshold)
      ? { ...predicate, value: minimumThreshold } : null;
  }
  const factor = age <= 6 ? 0.5 : age <= 10 ? 0.6 : age <= 14 ? 0.8 : 1;
  return { ...predicate, value: Math.round(predicate.value * factor * 1_000_000) / 1_000_000 };
}

function ageAdjustmentFollowUp(logic, facts) {
  for (const { node } of collectLogicNodes(logic).filter(({ node }) =>
    ['injury_standard_6_18', 'disability_standard_6_11'].includes(node.ageAdjustment))) {
    const observed = evaluateConditionLogic({ annotation: 'explicit', logic: node }, facts);
    let needsAgeReview = observed.met === true;
    let disabilityChildAgeRecorded = false;
    if (node.ageAdjustment === 'disability_standard_6_11'
      && ['facial_skin_abnormality_area_cm2', 'facial_skin_abnormality_area_percent'].includes(node.predicate?.field)) {
      const measurementPattern = node.predicate.field === 'facial_skin_abnormality_area_percent'
        ? /(?:\d+(?:\.\d+)?\s*(?:%|％)|百分之(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+))/u
        : /\d+(?:\.\d+)?\s*(?:cm2|cm²|平方厘米)/iu;
      const quotedAreaConclusions = facts.filter(fact => fact.field === 'clinical_finding'
        && fact.source === 'description' && fact.verification === 'quoted' && reliableCertainties.has(fact.certainty)
        && node.predicate.evidenceGroups?.every(group => group.some(alias => includesEvidence(fact.evidence, alias)))
        && measurementPattern.test(fact.evidence));
      const hasMeasuredArea = quotedAreaConclusions.some(conclusion => Boolean(conclusion.eventId)
        && facts.some(fact => fact.field === node.predicate.field && fact.eventId === conclusion.eventId
          && fact.source === 'description' && fact.verification === 'quoted' && reliableCertainties.has(fact.certainty)
          && node.predicate.evidenceGroups?.every(group => group.some(alias => includesEvidence(fact.evidence, alias)))));
      if (quotedAreaConclusions.length && !hasMeasuredArea) {
        return '原文只有面部瘢痕或色素异常的面积结论，需核对原始面积/比例测量记录，并按伤残分级标准6.11人工核对适用年龄范围；该结论短语不作为数值条件依据。';
      }
    }
    if (node.ageAdjustment === 'disability_standard_6_11'
      && DISABILITY_AGE_SCALED_MEASUREMENT_FIELDS.has(node.predicate?.field)) {
      needsAgeReview = false;
      const measurements = facts.filter(fact => fact.field === node.predicate.field && fact.source === 'description'
        && fact.verification === 'quoted' && reliableCertainties.has(fact.certainty)
        && Number.isFinite(predicateEvidenceValue(node.predicate, fact, facts))
        && predicateEvidenceValue(node.predicate, fact, facts) >= node.predicate.value * 0.5);
      for (const fact of measurements) {
        if (!fact.eventId) { needsAgeReview = true; continue; }
        const adjustedPredicate = adjustedDisabilityAgePredicate(node, facts, fact.eventId);
        if (!adjustedPredicate) {
          needsAgeReview = true;
          const injuryAge = ageAtInjury(facts, fact.eventId);
          const assessmentAge = verifiedAgeAtPoint(facts, fact.eventId, 'age_at_assessment_years',
            /(?:评残|伤残评定|残疾评定|鉴定|评估)时(?:年龄)?\s*(?:为|是|[:：])?\s*(\d{1,3})\s*(?:周岁|岁)/u);
          disabilityChildAgeRecorded ||= injuryAge !== null && assessmentAge !== null;
          continue;
        }
        const adjustedState = evaluateConditionLogic({ annotation: 'explicit',
          logic: { ...node, predicate: adjustedPredicate } }, facts.filter(candidate => candidate.eventId === fact.eventId));
        if (adjustedState.met === null) needsAgeReview = true;
      }
    } else if (node.ageAdjustment === 'disability_standard_6_11' && needsAgeReview) {
      const acceptedFields = conditionFactFields(node.factMatch, node.predicate);
      const sourceFacts = facts.filter(fact => acceptedFields.has(fact.field) && fact.source === 'description'
        && fact.verification === 'quoted' && reliableCertainties.has(fact.certainty));
      const supportingEvents = [...new Set(sourceFacts.map(fact => fact.eventId).filter(Boolean))]
        .filter(eventId => evaluateConditionLogic({ annotation: 'explicit', logic: node },
          sourceFacts.filter(fact => fact.eventId === eventId)).met === true);
      if (supportingEvents.length && supportingEvents.every(eventId =>
        verifiedAdultAgeAtInjury(facts, eventId) && verifiedAdultAgeAtAssessment(facts, eventId))) {
        needsAgeReview = false;
      } else {
        disabilityChildAgeRecorded = supportingEvents.some(eventId => {
          const injuryAge = ageAtInjury(facts, eventId);
          const assessmentAge = verifiedAgeAtPoint(facts, eventId, 'age_at_assessment_years',
            /(?:评残|伤残评定|残疾评定|鉴定|评估)时(?:年龄)?\s*(?:为|是|[:：])?\s*(\d{1,3})\s*(?:周岁|岁)/u);
          return injuryAge !== null && assessmentAge !== null && (injuryAge < 15 || assessmentAge < 15);
        });
      }
    }
    if (node.ageAdjustment === 'injury_standard_6_18'
      && INJURY_AGE_SCALED_MEASUREMENT_FIELDS.has(node.predicate?.field)) {
      const minimumThreshold = node.predicate.value * 0.5;
      const measurements = facts.filter(fact => fact.field === node.predicate.field && fact.source === 'description'
        && fact.verification === 'quoted' && Number.isFinite(predicateEvidenceValue(node.predicate, fact, facts))
        && predicateEvidenceValue(node.predicate, fact, facts) >= minimumThreshold
        && predicateEvidenceValue(node.predicate, fact, facts) < node.predicate.value);
      needsAgeReview = measurements.some(fact => ageAtInjury(facts, fact.eventId) === null);
    }
    if (needsAgeReview) {
      return node.ageAdjustment === 'injury_standard_6_18'
        ? '补充受伤时年龄资料，并按标准6.18核对体表损伤阈值（0–6岁按50%、7–10岁按60%、11–14岁按80%计算）；当前不能按成人阈值自动判断。'
        : disabilityChildAgeRecorded
          ? '材料已记载未满15周岁的年龄；面部瘢痕阈值需按伤残分级标准6.11及年龄时点人工核对，系统未自动换算。'
          : '补充受伤时及评残时年龄资料，并按伤残分级标准6.11核对面部瘢痕长度或面积阈值（0–6周岁按50%、7–14周岁按80%计算）；标准未明确年龄时点时需人工核实，当前不能按成人阈值自动判断。';
    }
  }
  return null;
}

function hearingThresholdFollowUp(logic, facts, sourceText) {
  const hearingNodes = collectLogicNodes(logic).filter(({ node }) => hearingThresholdRequirement(node));
  if (!hearingNodes.length || !/(?:听力|听阈|耳鸣|耳聋)/u.test(sourceText)) return null;
  const state = evaluateConditionLogic({ annotation: 'explicit', logic }, facts).met;
  if (state !== null) return null;
  return '当前无法自动核实听力阈值及其与本次损伤的因果关系：请核对相关耳别0.5、1、2、4kHz纯音气导听阈四频均值、年龄修正及dB HL单位；双耳或“另一耳”条件须分别对应左右耳。';
}

function evaluateConditionLeaf(node, facts, eventId = null, ageAdjustmentEnabled = false) {
  let predicate = node.predicate;
  if (ageAdjustmentEnabled && ['injury_standard_6_18', 'disability_standard_6_11'].includes(node.ageAdjustment)) {
    if (node.ageAdjustment === 'injury_standard_6_18' && INJURY_AGE_SCALED_MEASUREMENT_FIELDS.has(predicate?.field)) {
      predicate = adjustedAgePredicate(node, facts, eventId);
      if (!predicate) return { met: null, evidence: '', factIds: [] };
    } else if (node.ageAdjustment === 'disability_standard_6_11'
      && DISABILITY_AGE_SCALED_MEASUREMENT_FIELDS.has(predicate?.field)) {
      predicate = adjustedDisabilityAgePredicate(node, facts, eventId);
      if (!predicate) return { met: null, evidence: '', factIds: [] };
    } else if (!verifiedAdultAgeForAdjustment(facts, eventId, node.ageAdjustment)) {
      return { met: null, evidence: '', factIds: [] };
    }
  }
  const carotidRequirement = carotidConditionRequirement(node);
  if (carotidRequirement) return evaluateCarotidCondition(node, facts, carotidRequirement);
  const jointLossRequirement = largeJointLossRequirement(node);
  const vertebralRequirement = vertebralCompressionRequirement(node);
  const visualFieldRule = visualFieldRequirement(node);
  const completeVisionRule = completeVisualFieldRequirement(node);
  const hearingRule = hearingThresholdRequirement(node);
  const earSideRule = unilateralEarFindingRequirement(node);
  const acceptedFields = conditionFactFields(node.factMatch, predicate);
  const cardiacRuptureCondition = node.factMatch?.field === 'clinical_finding'
    && node.factMatch.values?.some(value => ['心脏破裂', '心包破裂'].includes(value));
  const cardiacRuptureValue = cardiacRuptureCondition
    ? node.factMatch.values.find(value => ['心脏破裂', '心包破裂'].includes(value)) : null;
  const parserQuotedCardiacFact = fact => Boolean(cardiacRuptureValue && fact.source === 'description'
    && fact.sourceRefs?.some(reference => reference.source === fact.source
      && includesEvidence(reference.evidence, fact.evidence))
    && isCanonicalCardiacRuptureEvidence(cardiacRuptureValue, fact.evidence));
  const candidates = facts.filter(fact => acceptedFields.has(fact.field)
    && fact.source === 'description'
    && (fact.verification === 'quoted' || parserQuotedCardiacFact(fact)));
  const relevant = candidates.filter(fact => {
    if (isIntracranialCondition(node) && isSpinalEpiduralHematomaFact(fact)) return false;
    const jointLossEvidence = jointLossRequirement ? largeJointLossEvidence(node, fact.evidence, fact.value) : null;
    const vertebralEvidence = vertebralRequirement
      ? vertebralCompressionEvidence(node, fact.evidence, fact.value) : null;
    const visualEvidence = visualFieldRule ? visualFieldEvidence(node, fact.evidence, fact.value) : null;
    const completeVisionEvidence = completeVisionRule
      ? completeVisualFieldEvidence(node, fact.evidence, fact.value) : null;
    const hearingEvidence = hearingRule ? hearingThresholdEvidence(node, fact.evidence, fact.value) : null;
    const hearingCausality = Boolean(hearingEvidence?.matched && hearingThresholdCausallyLinked(fact, facts));
    const earSideEvidence = earSideRule ? unilateralEarFindingEvidence(node, fact.evidence, fact.value) : null;
    if (predicate?.field === 'aggregate_wound_length_cm'
      && !aggregateWoundLengthSitesSupportPredicate(predicate, fact)) return false;
    if (predicate && ['wound_length_cm', 'aggregate_wound_length_cm'].includes(predicate.field)
      && fact.field === 'wound_length_cm' && !woundLengthEvidenceSupportsPredicate(predicate, fact, facts)) return false;
    if (predicate?.field === 'wound_length_cm' && predicate.evidenceGroups
      && isWholeMeasurementWithRegionSegments(fact, facts)) return false;
    if (predicate?.field === 'wound_length_cm' && predicate.evidenceGroups
      && isUnsegmentedFaceScalpMeasurement(fact)) return false;
    if (node.factMatch) {
      const factValues = Array.isArray(fact.value) ? fact.value : [fact.value];
      const exactValueMatches = node.factMatch.values?.some(value => factValues.some(factValue => sameValue(value, factValue))) || false;
      const includedValues = node.factMatch.valueIncludes || [];
      const includedValueMatches = includedValues.some(value => typeof value === 'string'
        && factValues.some(factValue => typeof factValue === 'string'
          && normalize(factValue).includes(normalize(value))));
      const historicalEvidence = evidenceLabelsFindingAsHistorical(fact.evidence, node.sourceText);
      const exactEvidence = includesEvidence(fact.evidence, node.sourceText) && !historicalEvidence;
      const evidenceAliasMatch = node.factMatch.evidenceAliases?.find(alias => includesEvidence(fact.evidence, alias));
      const evidenceAliasHistorical = evidenceAliasMatch
        ? evidenceLabelsFindingAsHistorical(fact.evidence, evidenceAliasMatch) : false;
      const genericBrainContusionValue = normalize(node.sourceText || '') === normalize('脑挫(裂)伤')
        && factValues.some(value => typeof value === 'string' && normalize(value) === normalize('挫伤'))
        && Boolean(evidenceAliasMatch);
      const surgicalConditionText = normalize(node.conditionText || node.sourceText || '');
      const genericSurgicalRequirement = /(?:须|需)手术治疗|经手术治疗(?:后)?|手术治疗/u.test(surgicalConditionText)
        && !/(?:开颅|减压|切除|修补|摘除|清除|吻合|固定|移植|置换|复位|缝合|重建|成形|植入|引流|取出)/u
          .test(surgicalConditionText);
      const performedSurgicalTreatment = genericSurgicalRequirement && acceptedFields.has('treatment')
        && requiresCurrentProcedureLink(node) && isPerformedSurgicalTreatmentFact(fact);
      const valueMatches = exactValueMatches || includedValueMatches || genericBrainContusionValue
        || performedSurgicalTreatment || Boolean(jointLossEvidence?.matched) || Boolean(vertebralEvidence?.matched)
        || Boolean(visualEvidence?.matched) || Boolean(completeVisionEvidence?.matched)
        || hearingCausality || Boolean(earSideEvidence?.matched);
      const reducedStrengthSign = normalize(node.conditionText || '') === normalize('神经系统症状和体征')
        && isReducedMuscleStrengthEvidence(fact.evidence);
      const sharedSuffixEvidence = fact.sharedFracturePredicate === true && fact.field === 'imaging_finding'
        && valueMatches && /骨折/u.test(fact.evidence);
      const evidenceAlias = (Boolean(evidenceAliasMatch) || sharedSuffixEvidence)
        && !historicalEvidence && !evidenceAliasHistorical;
      const ribFractureEvidence = node.factMatch.field === 'injury_type'
        && node.factMatch.values.includes('rib_fracture') && normalize(node.sourceText) === normalize('肋骨骨折')
        && /肋骨/.test(fact.evidence) && /骨折/.test(fact.evidence) && !historicalEvidence;
      const canonicalEvidence = node.factMatch.field === 'clinical_finding'
        && fact.source === 'description'
        && (fact.verification === 'quoted'
          && canonicalClinicalFindingEvidence(fact.value, fact.evidence, Boolean(fact.eventId))
          || parserQuotedCardiacFact(fact)
          || fact.verification === 'quoted' && cardiacRuptureValue
            && isCanonicalCardiacRuptureEvidence(cardiacRuptureValue, fact.evidence));
      const moderateShockCondition = node.factMatch.field === 'clinical_finding'
        && node.factMatch.values?.some(value => normalize(value) === normalize('各种损伤引起休克（中度）'));
      const evidenceMatches = jointLossRequirement ? Boolean(jointLossEvidence?.matched)
        : vertebralRequirement ? Boolean(vertebralEvidence?.matched)
          : visualFieldRule ? Boolean(visualEvidence?.matched)
          : completeVisionRule ? Boolean(completeVisionEvidence?.matched)
          : hearingRule ? hearingCausality
          : earSideRule ? Boolean(earSideEvidence?.matched)
          : performedSurgicalTreatment || (cardiacRuptureCondition || moderateShockCondition
            ? canonicalEvidence : exactEvidence || evidenceAlias || ribFractureEvidence || canonicalEvidence);
      const currentProcedureLink = !requiresCurrentProcedureLink(node)
        || !isUnperformedProcedureEvidence(fact.evidence) && hasCurrentEventLinkForProcedure(fact, facts, node);
      return (valueMatches && !historicalEvidence && !evidenceAliasHistorical && currentProcedureLink
        && evidenceMatches)
        || reducedStrengthSign && !historicalEvidence && !evidenceAliasHistorical;
    }
    const evidenceGroups = predicate.evidenceGroups;
    return predicateEvidenceValue(predicate, fact, facts) !== null
      && (!evidenceGroups || evidenceGroups.every(group => group.some(alias => includesEvidence(fact.evidence, alias)
        || fact.field === 'wound_length_cm' && [fact.regionEvidence?.site, fact.regionEvidence?.injuryType]
          .some(value => includesEvidence(value || '', alias)))));
  });
  const positive = relevant.filter(fact => reliableCertainties.has(fact.certainty));
  const excluded = relevant.filter(fact => fact.certainty === 'excluded'
    && conditionFactIsExplicitlyNegated(node, fact));
  const uncertain = relevant.some(fact => ['uncertain', 'unknown', 'conflicted'].includes(fact.certainty));
  const conflictingExclusions = excluded.filter(negative => positive.some(affirmative => jointLossRequirement
    ? sameLargeJointSide(largeJointLossEvidence(node, affirmative.evidence, affirmative.value),
      largeJointLossEvidence(node, negative.evidence, negative.value))
    : visualFieldRule
      ? sameVisualFieldEye(visualFieldEvidence(node, affirmative.evidence, affirmative.value),
        visualFieldEvidence(node, negative.evidence, negative.value))
    : completeVisionRule
      ? completeVisualFieldEvidence(node, affirmative.evidence, affirmative.value)?.findings.some(left =>
        completeVisualFieldEvidence(node, negative.evidence, negative.value)?.findings
          .some(right => right.side === left.side))
    : hearingRule
      ? hearingThresholdEvidence(node, affirmative.evidence, affirmative.value)?.observations.some(left =>
        hearingThresholdEvidence(node, negative.evidence, negative.value)?.observations
          .some(right => right.side === left.side))
    : earSideRule
      ? unilateralEarFindingEvidence(node, affirmative.evidence, affirmative.value)?.findings.some(left =>
        unilateralEarFindingEvidence(node, negative.evidence, negative.value)?.findings
          .some(right => right.side === left.side))
    : vertebralRequirement
      ? sameVertebralLevel(vertebralCompressionEvidence(node, affirmative.evidence, affirmative.value),
        vertebralCompressionEvidence(node, negative.evidence, negative.value))
      : !explicitlySeparateBrainFindings(affirmative, negative)));
  if (positive.length && conflictingExclusions.length || !positive.length && uncertain) {
    return { met: null, evidence: '', factIds: [] };
  }
  if (completeVisionRule && positive.length) {
    const assertions = positive.map(fact => ({ fact,
      assessment: completeVisualFieldEvidence(node, fact.evidence, fact.value) })).filter(item => item.assessment?.matched);
    const findings = assertions.flatMap(item => item.assessment.findings);
    const sides = new Set(findings.filter(item => !item.negated && !item.uncertain).map(item => item.side));
    const uncertainSameEye = relevant.some(fact => ['uncertain', 'unknown', 'conflicted'].includes(fact.certainty)
      && completeVisualFieldEvidence(node, fact.evidence, fact.value)?.findings
        .some(item => sides.has(item.side)));
    if (!sides.size || uncertainSameEye) return { met: null, evidence: '', factIds: [] };
    return { met: true, evidence: uniqueEvidenceText(assertions.map(item => item.fact.evidence)),
      factIds: assertions.map(item => item.fact.id),
      eyeAssertions: [...sides].map(side => ({ side, kind: 'complete-loss' })) };
  }
  if (visualFieldRule && positive.length) {
    const assertions = positive.map(fact => ({ fact,
      assessment: visualFieldEvidence(node, fact.evidence, fact.value) })).filter(item => item.assessment?.matched);
    const observations = assertions.flatMap(item => item.assessment.observations);
    const bySideAndMetric = new Map();
    for (const item of observations) {
      const key = `${item.side}:${item.metric}`;
      const previous = bySideAndMetric.get(key);
      if (previous && previous.value !== item.value) return { met: null, evidence: '', factIds: [] };
      if (!previous) bySideAndMetric.set(key, item);
    }
    const bySide = new Map();
    for (const item of bySideAndMetric.values()) {
      const values = bySide.get(item.side) || [];
      values.push(item);
      bySide.set(item.side, values);
    }
    const sides = visualFieldRule.requiredSides || [...bySide.keys()];
    const sideStates = sides.map(side => {
      const values = bySide.get(side) || [];
      if (!values.length || values.some(item => item.uncertain || item.negated)) return false;
      const supportStates = new Set(values.map(item => item.supports));
      return supportStates.size === 1 ? [...supportStates][0] : false;
    });
    const uncertainSameEye = relevant.some(fact => ['uncertain', 'unknown', 'conflicted'].includes(fact.certainty)
      && visualFieldEvidence(node, fact.evidence, fact.value)?.observations.some(item => sides.includes(item.side)));
    const met = visualFieldRule.requiredSides
      ? sideStates.length === 2 && sideStates.every(Boolean)
      : sideStates.some(Boolean);
    if (!met || uncertainSameEye) return { met: null, evidence: '', factIds: [] };
    const supportingFacts = assertions.filter(item => item.assessment.observations.some(observation => observation.supports));
    return { met: true, evidence: uniqueEvidenceText(supportingFacts.map(item => item.fact.evidence)),
      factIds: [...new Set(supportingFacts.map(item => item.fact.id))],
      eyeAssertions: [...new Set(sides)].map(side => ({ side, kind: 'numeric',
        requiresOppositeEye: /另一眼/u.test(`${node.sourceText || ''} ${node.conditionText || ''}`) })) };
  }
  if (hearingRule && positive.length) {
    const assertions = positive.map(fact => ({ fact,
      assessment: hearingThresholdEvidence(node, fact.evidence, fact.value) })).filter(item => item.assessment?.matched);
    const observations = assertions.flatMap(item => item.assessment.observations);
    const bySide = new Map();
    for (const item of observations) {
      const values = bySide.get(item.side) || [];
      values.push(item);
      bySide.set(item.side, values);
    }
    const sideValues = new Map();
    for (const [side, values] of bySide) {
      const numericValues = new Set(values.map(item => item.value));
      if (numericValues.size > 1) return { met: null, evidence: '', factIds: [] };
      sideValues.set(side, values[0].value);
    }
    const uncertainSides = new Set(relevant.filter(fact => ['uncertain', 'unknown', 'conflicted'].includes(fact.certainty)
      || hearingThresholdEvidence(node, fact.evidence, fact.value)?.observations.some(item => item.uncertain))
      .flatMap(fact => hearingThresholdEvidence(node, fact.evidence, fact.value)?.observations.map(item => item.side) || []));
    if (observations.some(item => item.negated) || [...uncertainSides].some(side => sideValues.has(side))) {
      return { met: null, evidence: '', factIds: [] };
    }
    const measuredBothEars = sideValues.has('left') && sideValues.has('right');
    const supports = (side, threshold) => sideValues.has(side) && sideValues.get(side) >= threshold;
    const oneEar = hearingRule.requirements.filter(item => item.role === 'one');
    const otherEar = hearingRule.requirements.filter(item => item.role === 'other');
    const selected = [];
    let met;
    if (oneEar.length && otherEar.length) {
      if (!measuredBothEars) return { met: null, evidence: '', factIds: [] };
      const assignment = oneEar.map(one => otherEar.map(other =>
        supports('left', one.threshold) && supports('right', other.threshold) ? { one: 'left', other: 'right' }
          : supports('right', one.threshold) && supports('left', other.threshold) ? { one: 'right', other: 'left' } : null)
        .find(Boolean)).find(Boolean);
      met = Boolean(assignment);
      if (assignment) selected.push(...oneEar.map(item => ({ requirement: item, sides: [assignment.one] })),
        ...otherEar.map(item => ({ requirement: item, sides: [assignment.other] })));
      else if (met) return { met: null, evidence: '', factIds: [] };
      else return { met: false, evidence: '', factIds: [] };
    } else {
      const evaluated = hearingRule.requirements.map(requirement => {
        if (requirement.role === 'both') {
          if (!measuredBothEars) return { requirement, met: null, sides: [] };
          const sides = ['left', 'right'].filter(side => supports(side, requirement.threshold));
          return { requirement, met: sides.length === 2, sides };
        }
        const sides = ['left', 'right'].filter(side => supports(side, requirement.threshold));
        if (sides.length) return { requirement, met: true, sides };
        return { requirement, met: measuredBothEars ? false : null, sides: [] };
      });
      if (evaluated.some(item => item.met === false)) return { met: false, evidence: '', factIds: [] };
      if (evaluated.some(item => item.met !== true)) return { met: null, evidence: '', factIds: [] };
      selected.push(...evaluated);
      met = true;
    }
    if (!met) return { met: false, evidence: '', factIds: [] };
    const requiredSides = new Set(selected.flatMap(item => item.sides));
    const supportingFacts = assertions.filter(item => item.assessment.observations.some(observation =>
      requiredSides.has(observation.side) && !observation.negated && !observation.uncertain));
    return { met: true, evidence: uniqueEvidenceText(supportingFacts.map(item => item.fact.evidence)),
      factIds: [...new Set(supportingFacts.map(item => item.fact.id))],
      hearingAssertions: selected.map(item => ({ role: item.requirement.role, sides: item.sides })) };
  }
  if (earSideRule && positive.length) {
    const assertions = positive.map(fact => ({ fact,
      assessment: unilateralEarFindingEvidence(node, fact.evidence, fact.value) })).filter(item => item.assessment?.matched);
    const sides = new Set(assertions.flatMap(item => item.assessment.findings
      .filter(finding => !finding.negated && !finding.uncertain).map(finding => finding.side)));
    const uncertainSameSide = relevant.some(fact => ['uncertain', 'unknown', 'conflicted'].includes(fact.certainty)
      && unilateralEarFindingEvidence(node, fact.evidence, fact.value)?.findings
        .some(finding => sides.has(finding.side)));
    if (!sides.size || uncertainSameSide) return { met: null, evidence: '', factIds: [] };
    const supportingFacts = assertions.filter(item => item.assessment.findings.some(finding => sides.has(finding.side)
      && !finding.negated && !finding.uncertain));
    return { met: true, evidence: uniqueEvidenceText(supportingFacts.map(item => item.fact.evidence)),
      factIds: [...new Set(supportingFacts.map(item => item.fact.id))],
      earSideAssertions: [{ role: earSideRule.role, system: earSideRule.system, sides: [...sides] }] };
  }
  if (jointLossRequirement && positive.length) {
    const assertions = positive.map(fact => ({ fact, assessment: largeJointLossEvidence(node, fact.evidence, fact.value) }))
      .filter(item => item.assessment?.matched);
    for (let left = 0; left < assertions.length; left += 1) {
      for (let right = left + 1; right < assertions.length; right += 1) {
        if (sameLargeJointSide(assertions[left].assessment, assertions[right].assessment)
          && assertions[left].assessment.percent !== assertions[right].assessment.percent) {
          return { met: null, evidence: '', factIds: [] };
        }
      }
    }
    const supporting = assertions.filter(item => item.assessment.supports);
    if (!supporting.length) return { met: null, evidence: '', factIds: [] };
    const uncertainSameJoint = relevant.some(fact => ['uncertain', 'unknown', 'conflicted'].includes(fact.certainty)
      && assertions.some(item => sameLargeJointSide(item.assessment,
        largeJointLossEvidence(node, fact.evidence, fact.value))));
    if (uncertainSameJoint) return { met: null, evidence: '', factIds: [] };
    return { met: true, evidence: uniqueEvidenceText(supporting.map(item => item.fact.evidence)),
      factIds: supporting.map(item => item.fact.id) };
  }
  if (vertebralRequirement && positive.length) {
    const assertions = positive.map(fact => ({ fact, assessment: vertebralCompressionEvidence(node, fact.evidence, fact.value) }))
      .filter(item => item.assessment?.matched);
    for (let left = 0; left < assertions.length; left += 1) {
      for (let right = left + 1; right < assertions.length; right += 1) {
        const first = assertions[left].assessment, second = assertions[right].assessment;
        if (sameVertebralLevel(first, second) && Number.isFinite(first.compression)
          && Number.isFinite(second.compression) && first.compression !== second.compression) {
          return { met: null, evidence: '', factIds: [] };
        }
      }
    }
    const supporting = assertions.filter(item => item.assessment.supports);
    if (!supporting.length) return { met: null, evidence: '', factIds: [] };
    const uncertainSameLevel = relevant.some(fact => ['uncertain', 'unknown', 'conflicted'].includes(fact.certainty)
      && assertions.some(item => sameVertebralLevel(item.assessment,
        vertebralCompressionEvidence(node, fact.evidence, fact.value))));
    if (uncertainSameLevel) return { met: null, evidence: '', factIds: [] };
    return { met: true, evidence: uniqueEvidenceText(supporting.map(item => item.fact.evidence)),
      factIds: supporting.map(item => item.fact.id) };
  }
  if (predicate && positive.length) {
    if (['bone_shortening_cm', 'bone_angulation_degrees', 'joint_function_loss_percent'].includes(predicate.field)) {
      for (let left = 0; left < relevant.length; left += 1) for (let right = left + 1; right < relevant.length; right += 1) {
        const first = relevant[left], second = relevant[right];
        if (!sameTypedMeasurementEntity(predicate, first, second)) continue;
        if (['uncertain', 'unknown', 'conflicted', 'excluded'].includes(first.certainty)
          || ['uncertain', 'unknown', 'conflicted', 'excluded'].includes(second.certainty)
          || predicateEvidenceValue(predicate, first, facts) !== predicateEvidenceValue(predicate, second, facts)) {
          return { met: null, evidence: '', factIds: [] };
        }
      }
      const supporting = positive.filter(fact => comparePredicate(predicate,
        predicateEvidenceValue(predicate, fact, facts)) === true);
      return supporting.length ? { met: true, evidence: uniqueEvidenceText(supporting.map(fact => fact.evidence)),
        factIds: [...new Set(supporting.map(fact => fact.id))] } : { met: null, evidence: '', factIds: [] };
    }
    const states = positive.map(fact => comparePredicate(predicate, predicateEvidenceValue(predicate, fact, facts)));
    if (states.some(state => state === null)) return { met: null, evidence: '', factIds: [] };
    if (predicate.field === 'gcs_score') {
      const statesByEvidence = new Map();
      for (const [index, fact] of positive.entries()) {
        const evidence = normalize(String(fact.evidence || ''));
        if (statesByEvidence.has(evidence) && statesByEvidence.get(evidence) !== states[index]) {
          return { met: null, evidence: '', factIds: [] };
        }
        statesByEvidence.set(evidence, states[index]);
      }
      if (states.includes(true)) {
        const qualifyingFacts = positive.filter((fact, index) => states[index] === true);
        return { met: true, evidence: uniqueEvidenceText(qualifyingFacts.map(fact => fact.evidence)),
          factIds: qualifyingFacts.map(fact => fact.id) };
      }
    }
    if (predicate.field === 'ear_scalp_wound_ratio' && states.every(state => state === false)) {
      return { met: null, evidence: '', factIds: [] };
    }
    if (['wound_length_cm', 'aggregate_wound_length_cm', 'dental_loss_count'].includes(predicate.field)
      && predicate.operator === 'gte') {
      return { met: states.some(state => state === true), evidence: uniqueEvidenceText(positive.map(fact => fact.evidence)),
        factIds: positive.map(fact => fact.id) };
    }
    if (INJURY_AGE_SCALED_MEASUREMENT_FIELDS.has(predicate.field) && positive.length > 1
      && states.every(state => state === false)) {
      return { met: null, evidence: '', factIds: [] };
    }
    if (new Set(states).size > 1) return { met: null, evidence: '', factIds: [] };
    return { met: states[0], evidence: uniqueEvidenceText(positive.map(fact => fact.evidence)),
      factIds: positive.map(fact => fact.id) };
  }
  if (positive.length) return { met: true, evidence: uniqueEvidenceText(positive.map(fact => fact.evidence)),
    factIds: positive.map(fact => fact.id) };
  if ((jointLossRequirement || vertebralRequirement) && excluded.length) return { met: null, evidence: '', factIds: [] };
  if (excluded.length) return { met: false, evidence: uniqueEvidenceText(excluded.map(fact => fact.evidence)),
    factIds: excluded.map(fact => fact.id) };
  return { met: null, evidence: '', factIds: [] };
}

function sameLargeJointSide(left, right) {
  if (!left?.matched || !right?.matched) return false;
  const jointName = value => value.replace(/关节/u, '');
  return jointName(left.joint) === jointName(right.joint)
    && (!left.side || !right.side || left.side === right.side);
}

function sameTypedMeasurementEntity(predicate, left, right) {
  const entityAliases = predicate.evidenceGroups?.[0] || [];
  const entityFor = fact => {
    const evidence = normalize(String(fact.evidence || ''));
    const alias = entityAliases.map(normalize).filter(value => value && evidence.includes(value))
      .sort((a, b) => b.length - a.length)[0];
    if (!alias) return null;
    const position = evidence.indexOf(alias);
    const before = evidence.slice(Math.max(0, position - 6), position);
    const side = /(?:左侧|左)$/u.test(before) ? 'left' : /(?:右侧|右)$/u.test(before) ? 'right' : null;
    return { alias, side };
  };
  const first = entityFor(left), second = entityFor(right);
  return Boolean(first && second && first.alias === second.alias
    && (!first.side || !second.side || first.side === second.side));
}

function sameVertebralLevel(left, right) {
  return Boolean(left?.matched && right?.matched && vertebralLevelKey(left.level) === vertebralLevelKey(right.level));
}

function vertebralLevelKey(value) {
  const text = String(value || '').normalize('NFKC').replace(/\s+/gu, '').toUpperCase();
  const latin = /\b([CTLS])\s*(\d{1,2})/u.exec(text);
  if (latin) return `${latin[1]}${Number(latin[2])}`;
  const chinese = /第?([一二两三四五六七八九十百\d]+)(颈|胸|腰|骶)椎/u.exec(text);
  if (!chinese) return normalize(text);
  const number = /^\d/u.test(chinese[1]) ? Number(chinese[1]) : parseNumber(chinese[1]);
  const region = { 颈: 'C', 胸: 'T', 腰: 'L', 骶: 'S' }[chinese[2]];
  return Number.isInteger(number) && number > 0 ? `${region}${number}` : normalize(text);
}

function reconcileMedicalConditionGroup(op, results, met) {
  if (op !== 'all' || met !== true) return met;
  const eyeAssertions = results.flatMap(result => result.eyeAssertions || []);
  const hearingAssertions = results.flatMap(result => result.hearingAssertions || []);
  const earSideAssertions = results.flatMap(result => result.earSideAssertions || []);
  const carotidAssertions = results.flatMap(result => result.carotidAssertions || []);
  const completeSides = eyeAssertions.filter(item => item.kind === 'complete-loss').map(item => item.side);
  const oppositeEyeMeasurements = eyeAssertions.filter(item => item.kind === 'numeric' && item.requiresOppositeEye);
  if (oppositeEyeMeasurements.some(measurement => !completeSides.some(side => side !== measurement.side))) met = null;
  const oneEarSides = hearingAssertions.filter(item => item.role === 'one').flatMap(item => item.sides);
  const otherEarRequirements = hearingAssertions.filter(item => item.role === 'other');
  if (otherEarRequirements.some(requirement => !oneEarSides.some(side =>
    requirement.sides.some(otherSide => side !== otherSide)))) met = null;
  const sameSideRequirements = earSideAssertions.filter(item => item.role === 'same-side');
  for (const requirement of sameSideRequirements) {
    const hearingSides = hearingAssertions.filter(item => item.role === 'one').flatMap(item => item.sides);
    const otherFindingSides = earSideAssertions.filter(item => item.role === 'unilateral'
      && item.system !== requirement.system).flatMap(item => item.sides);
    const matchingSides = requirement.system === 'vestibular' ? hearingSides : otherFindingSides;
    if (!requirement.sides.some(side => matchingSides.includes(side))) met = null;
  }
  const thrombosis = carotidAssertions.filter(item => item.kind === 'thrombosis'
    && reliableCertainties.has(item.certainty) && !item.negated && !item.uncertain);
  const stenosis = carotidAssertions.filter(item => item.kind === 'stenosis'
    && reliableCertainties.has(item.certainty) && !item.negated && !item.uncertain
    && item.value >= item.threshold);
  if (thrombosis.length && stenosis.length) {
    const sameVessel = thrombosis.some(clot => stenosis.some(narrowing =>
      narrowing.artery === clot.artery && narrowing.side === clot.side));
    const conflictedVessel = thrombosis.some(clot => carotidAssertions.some(assertion =>
      assertion.artery === clot.artery && assertion.side === clot.side
      && (assertion.negated || assertion.uncertain
        || ['uncertain', 'unknown', 'conflicted', 'excluded'].includes(assertion.certainty))));
    if (!sameVessel || conflictedVessel) met = null;
  }
  return met;
}

function collectMedicalConditionAssertions(results) {
  return {
    eyeAssertions: results.flatMap(result => result.eyeAssertions || []),
    hearingAssertions: results.flatMap(result => result.hearingAssertions || []),
    earSideAssertions: results.flatMap(result => result.earSideAssertions || []),
    carotidAssertions: results.flatMap(result => result.carotidAssertions || []),
  };
}

export function evaluateConditionLogic(conditionLogic, facts) {
  return evaluateConditionTree(conditionLogic, facts,
    (node, scopedFacts, eventId, ageAdjustmentEnabled) =>
      evaluateConditionLeaf(node, scopedFacts, eventId, ageAdjustmentEnabled),
    { reconcileGroup: reconcileMedicalConditionGroup, collectDetails: collectMedicalConditionAssertions });
}
function logicGroups(logic) {
  return logic.op === 'all' ? logic.children : [logic];
}

function logicGroupText(node) {
  return node.conditionText || node.sourceText;
}

function logicNodeTexts(node) {
  return [node.conditionText, node.sourceText].filter(value => typeof value === 'string').map(normalizeLogicLabel);
}

function normalizeLogicLabel(value) {
  return normalize(value.replace(/[。；;，,]+$/g, ''));
}

function collectLogicNodes(node, ancestors = [], output = []) {
  const nextAncestors = node.op === 'all' || node.op === 'any' ? [...ancestors, node] : ancestors;
  if (node.op === 'condition') output.push({ node, ancestors: nextAncestors });
  else for (const child of node.children || []) collectLogicNodes(child, nextAncestors, output);
  return output;
}

function evaluateLogicNode(node, facts, ageAdjustment = null) {
  return evaluateConditionLogic({ annotation: 'explicit', logic: node,
    ...(ageAdjustment ? { ageAdjustment } : {}) }, facts);
}

function contradictsVerifiedRibFacts(text, facts) {
  const reliable = fact => fact.source === 'description' && fact.verification === 'quoted'
    && reliableCertainties.has(fact.certainty);
  const ribFacts = facts.filter(fact => ['injury_type', 'anatomical_site', 'laterality',
    'fractured_rib_numbers', 'fractured_rib_count', 'fracture_site_count'].includes(fact.field) && reliable(fact));
  const ribEventIds = new Set(ribFacts.map(fact => fact.eventId).filter(Boolean));
  const lateralityByEvidence = new Map();
  for (const fact of facts) {
    if (fact.field !== 'laterality' || !['left', 'right'].includes(fact.value) || !reliable(fact)) continue;
    const key = JSON.stringify([fact.source, fact.eventId, normalize(fact.evidence)]);
    lateralityByEvidence.set(key, fact.value);
  }
  const ordinalsBySide = new Map([['left', new Set()], ['right', new Set()]]);
  for (const fact of facts) {
    if (fact.field !== 'fractured_rib_numbers' || !Array.isArray(fact.value) || !reliable(fact)) continue;
    const key = JSON.stringify([fact.source, fact.eventId, normalize(fact.evidence)]);
    const side = lateralityByEvidence.get(key);
    if (!side) continue;
    for (const ordinal of fact.value) ordinalsBySide.get(side)?.add(ordinal);
  }
  const leftOrdinals = ordinalsBySide.get('left');
  const rightOrdinals = ordinalsBySide.get('right');
  const unambiguousEventScope = ribEventIds.size <= 1
    && ribFacts.every(fact => !fact.eventId || fact.eventId === [...ribEventIds][0]);
  const hasDisjointOppositeSideOrdinals = leftOrdinals.size > 0 && rightOrdinals.size > 0
    && [...leftOrdinals].every(ordinal => !rightOrdinals.has(ordinal));
  const claimsOppositeSideOrdinalConflict = /(?:侧别.{0,32}(?:重叠|矛盾|冲突)|(?:重叠|矛盾|冲突).{0,32}侧别)/u.test(text)
    && /(?:左侧|左边)/u.test(text) && /(?:右侧|右边)/u.test(text);
  if (unambiguousEventScope && hasDisjointOppositeSideOrdinals && claimsOppositeSideOrdinalConflict) return true;
  if (ribEventIds.size !== 1 || ribFacts.some(fact => !fact.eventId)) return false;
  const hasSiteCount = facts.some(fact => fact.field === 'fracture_site_count' && reliable(fact));
  const hasRootCount = facts.some(fact => fact.field === 'fractured_rib_count' && reliable(fact));
  const mentionsSiteCount = /骨折处数|肋骨骨折处数|骨折数量|骨折总数|具体数量/u.test(text);
  const mentionsRootCount = /骨折肋骨根数|肋骨根数|骨折根数/u.test(text);
  const statesCountUnknown = /缺失|未(?:明确|提供|记载|确定)|不明确|尚未(?:明确|提供|确认|确定)|无法确定|待核实|需核实|需要核实|待确认|需确认|需要确认|确认(?:是|为|是否)\s*(?:[0-9一二两三四五六七八九十]+\s*处)/u.test(text);
  if (statesCountUnknown && (hasSiteCount && mentionsSiteCount || hasRootCount && mentionsRootCount)) return true;
  const hasExplicitNoPriorRibInjury = facts.some(fact => fact.field === 'prior_injury'
    && fact.source === 'description' && fact.verification === 'quoted'
    && ['reported', 'observed', 'derived', 'excluded'].includes(fact.certainty)
    && /(?:既往|陈旧性?|旧伤).{0,20}(?:无|没有|未见|未发现|否认)|(?:无|没有|未见|未发现|否认).{0,20}(?:既往|陈旧性?|旧伤)/u.test(fact.evidence)
    && /肋骨|骨折/u.test(fact.evidence));
  const questionsPriorRibCount = /(?:数量|处数).{0,12}(?:是否包含|是否计入).{0,12}(?:陈旧|既往|旧伤)|(?:是否包含|是否计入).{0,12}(?:陈旧|既往|旧伤).{0,12}(?:数量|处数)/u.test(text);
  if (hasExplicitNoPriorRibInjury && questionsPriorRibCount) return true;

  const sidesByOrdinal = new Map();
  for (const fact of facts) {
    if (fact.field !== 'fractured_rib_numbers' || !fact.eventId || !Array.isArray(fact.value) || !reliable(fact)) continue;
    const key = JSON.stringify([fact.source, fact.eventId, normalize(fact.evidence)]);
    const side = lateralityByEvidence.get(key);
    if (!side) continue;
    for (const ordinal of fact.value) {
      const ordinalKey = JSON.stringify([fact.eventId, ordinal]);
      sidesByOrdinal.set(ordinalKey, new Set([...(sidesByOrdinal.get(ordinalKey) || []), side]));
    }
  }
  const hasVerifiedBilateralSameOrdinal = [...sidesByOrdinal.values()].some(sides => sides.has('left') && sides.has('right'));
  const questionsVerifiedBilateralOrdinal = /(?:明确|确认|核实|是否|待确认|需确认).{0,24}(?:双侧|两侧|左右).{0,16}第\s*(?:[0-9零〇一二两三四五六七八九十]+)\s*肋骨/u.test(text);
  const questionsSameRib = /(?:侧别不同|同一(?:根|条)?肋骨|同根肋骨).{0,24}(?:需|待|是否|确认|核实)|(?:确认|核实).{0,24}(?:是否为)?同一(?:根|条)?肋骨/u.test(text);
  return hasVerifiedBilateralSameOrdinal && (questionsSameRib || questionsVerifiedBilateralOrdinal);
}

function bindExplicitGroups(clause, proposedConditions, facts) {
  const logic = clause.conditionLogic.logic;
  const groups = logicGroups(logic);
  const bindings = groups.map(() => []);
  const nodes = collectLogicNodes(logic);
  const normalizedClause = normalizeLogicLabel(clause.text);
  let invalid = false;
  for (const condition of proposedConditions) {
    const modelText = normalizeLogicLabel(condition.condition || '');
    const exactGroups = groups.map((group, index) => logicNodeTexts(group).includes(modelText) ? index : -1).filter(index => index >= 0);
    const exactNodes = nodes.filter(({ node }) => logicNodeTexts(node).includes(modelText));
    const factIds = Array.isArray(condition.factIds) ? [...new Set(condition.factIds)] : [];
    if (factIds.some(id => !facts.some(fact => fact.id === id))) invalid = true;
    const linkedFacts = factIds.map(id => facts.find(fact => fact.id === id)).filter(Boolean)
      .filter(fact => fact.field !== 'prior_injury');
    if (modelText === normalizedClause) {
      for (const bucket of bindings) bucket.push({ condition, linkedFacts });
    } else if (exactGroups.length > 1) {
      invalid = true;
    } else if (exactGroups.length === 1) {
      bindings[exactGroups[0]].push({ condition, linkedFacts });
    } else if (exactNodes.length) {
      const mapped = new Set();
      for (const { node, ancestors } of exactNodes) {
        const owner = [...ancestors].reverse().find(candidate => groups.includes(candidate)) || node;
        const index = groups.indexOf(owner);
        if (index >= 0) mapped.add(index);
      }
      if (mapped.size === 1) bindings[[...mapped][0]].push({ condition, linkedFacts });
      else invalid = true;
    } else invalid = true;
  }

  const groupResults = groups.map((group, index) => {
    const entries = bindings[index];
    const uniqueTexts = new Set(entries.map(entry => normalize(entry.condition.condition || '')));
    if (!entries.length || uniqueTexts.size !== entries.length) {
      if (entries.length && uniqueTexts.size !== entries.length) invalid = true;
      return { met: null, evidence: '', factIds: [] };
    }
    const groupFacts = [...new Map(entries.flatMap(entry => entry.linkedFacts).map(fact => [fact.id, fact])).values()];
    const result = evaluateLogicNode(group, includeLinkedEventFacts(facts, groupFacts.map(fact => fact.id)),
      clause.conditionLogic.ageAdjustment);
    return result;
  });
  const rootFacts = [...new Map(bindings.flat().flatMap(entry => entry.linkedFacts).map(fact => [fact.id, fact])).values()];
  const root = evaluateConditionLogic(clause.conditionLogic,
    includeLinkedEventFacts(facts, rootFacts.map(fact => fact.id)));
  const allGroupsBound = bindings.every(entries => entries.length > 0);
  const met = allGroupsBound && !invalid ? root.met : null;
  const displayGroups = groups.length <= 12 ? groups : [logic];
  const displayResults = groups.length <= 12 ? groupResults : [met === null ? { met: null, evidence: '', factIds: [] } : root];
  const conditions = displayGroups.map((group, index) => ({ condition: logicGroupText(group),
    evidence: displayResults[index].evidence, factIds: displayResults[index].factIds, met: displayResults[index].met }));
  return {
    invalid,
    met,
    evidence: root.evidence,
    factIds: root.factIds,
    conditions,
  };
}

function evaluateRibCondition(condition, facts) {
  if (!/肋骨骨折/.test(condition)) return undefined;
  const thresholdMatch = condition.match(/(\d+|[零〇一二两三四五六七八九十百]+)\s*处以上/);
  const reliable = fact => ['reported', 'observed', 'derived'].includes(fact.certainty)
    && fact.source === 'description' && fact.verification === 'quoted';
  if (thresholdMatch) {
    const threshold = parseNumber(thresholdMatch[1]);
    const siteCounts = facts.filter(fact => fact.field === 'fracture_site_count' && reliable(fact)
      && Number.isInteger(fact.value) && fact.value >= 0);
    if (!siteCounts.length) return null;
    return siteCounts.every(fact => fact.value >= threshold);
  }
  const injuryFacts = facts.filter(fact => fact.field === 'injury_type' && fact.value === 'rib_fracture');
  if (injuryFacts.some(reliable)) return true;
  if (injuryFacts.some(fact => fact.certainty === 'excluded' && fact.source === 'description' && fact.verification === 'quoted')) return false;
  return null;
}

function deterministicRibReferences(clauses, facts, sourceUrl) {
  const candidates = clauses.flatMap(clause => {
    if (!/肋骨骨折/.test(clause.text)) return [];
    if (clause.conditionLogic) {
      const evaluated = evaluateConditionLogic(clause.conditionLogic, facts);
      const groups = logicGroups(clause.conditionLogic.logic);
      const conditions = groups.map(group => {
        const result = evaluateLogicNode(group, facts);
        return { condition: logicGroupText(group), evidence: result.evidence, factIds: result.factIds, met: result.met };
      });
      return [{ clause, condition: clause.text, met: evaluated.met, relevantFacts: facts, conditions, evidence: evaluated.evidence }];
    }
    const condition = clause.text.split(/[；;。]/).map(value => value.trim()).find(value => /肋骨骨折/.test(value));
    if (!condition) return [];
    const met = evaluateRibCondition(condition, facts);
    const relevantFields = /(?:处数|\d+\s*处|[一二两三四五六七八九十]+\s*处)/.test(condition)
      ? ['fracture_site_count'] : ['injury_type'];
    const relevantFacts = facts.filter(fact => fact.source === 'description' && fact.verification === 'quoted'
      && relevantFields.includes(fact.field));
    return [{ clause, condition, met, relevantFacts }];
  });
  return candidates.map(({ clause, condition, met, relevantFacts, conditions: evaluatedConditions, evidence: evaluatedEvidence }) => {
    const gradeRank = grades.injury.indexOf(clause.grade);
    const hasHigherIncompleteClause = candidates.some(candidate => grades.injury.indexOf(candidate.clause.grade) < gradeRank
      && candidate.met === null);
    const relation = met === true ? (hasHigherIncompleteClause ? 'differential' : 'supports') : 'incomplete';
    const evidence = evaluatedEvidence || relevantFacts[0]?.evidence || '';
    return { ...clause, sourceUrl, evidence,
      reasoning: relation === 'differential' ? '较重条款所需条件尚未确认，本条仅作对照。'
        : met === true ? '可回查事实与本地条文条件相符。' : '材料原文尚不能完整支持本条条件，需补充或核对。',
      relation, conditions: evaluatedConditions || [{ condition, evidence, factIds: relevantFacts.map(fact => fact.id), met }] };
  }).sort((a, b) => a.id.localeCompare(b.id, 'en'));
}

function deterministicExplicitReferences(clauses, facts, sourceUrl) {
  return clauses.flatMap(clause => {
    if (clause.conditionLogic?.annotation !== 'explicit') return [];
    const evaluated = evaluateConditionLogic(clause.conditionLogic, facts);
    if (evaluated.met !== true) return [];
    const groups = logicGroups(clause.conditionLogic.logic);
    const conditions = groups.map(group => {
      const result = evaluateLogicNode(group, facts, clause.conditionLogic.ageAdjustment);
      return { condition: logicGroupText(group), evidence: result.evidence, factIds: result.factIds, met: result.met };
    });
    if (conditions.some(condition => condition.met !== true)) return [];
    return [{ ...clause, sourceUrl, evidence: evaluated.evidence,
      reasoning: '经来源核验的材料事实满足本地明确标注的条款逻辑条件。', relation: 'supports', conditions }];
  });
}

function ungradedShockDiagnosis(facts, sourceText) {
  return facts.find(fact => fact.field === 'diagnosis'
    && ['reported', 'observed', 'derived'].includes(fact.certainty)
    && fact.source === 'description' && fact.verification === 'quoted'
    && /休克/u.test(`${fact.value} ${fact.evidence}`)
    && !/(?:既往|曾因|既往史|历史|未见|否认|排除)/u.test(fact.evidence)
    && /(?:受伤|损伤|外伤|刀伤|刺伤|砍伤|殴打|车祸|交通事故|创伤|伤口)/u.test(sourceText)
    && !/(?:轻度|中度|重度|代偿期|失代偿期)/u.test(`${fact.value} ${fact.evidence}`));
}

function deterministicUnresolvedShockReferences(clauses, facts, sourceText, sourceUrl) {
  const shockFact = ungradedShockDiagnosis(facts, sourceText);
  if (!shockFact) return [];
  const severityClauseIds = new Set(['5.12.2.d', '5.12.4.f']);
  return clauses.filter(clause => severityClauseIds.has(clause.id)).map(clause => ({
    ...clause,
    sourceUrl,
    evidence: shockFact.evidence,
    reasoning: '材料记载休克诊断，但未明确休克程度；本条暂不用于等级判断。',
    relation: 'incomplete',
    conditions: [{ condition: clause.text, evidence: shockFact.evidence, factIds: [shockFact.id], met: null }],
  }));
}

function partialAsphyxiaCueFacts(facts, sourceText) {
  const sourceCue = /(?:额部|面部|颜面|眼周|眼睑).{0,20}针尖.{0,6}出血点/u.test(sourceText)
    && /颈部.{0,20}(?:条纹环绕|掐痕|勒痕|皮肤淤紫|出血点)/u.test(sourceText);
  if (!sourceCue) return null;
  const reliable = fact => ['reported', 'observed', 'derived'].includes(fact.certainty)
    && fact.source === 'description' && fact.verification === 'quoted'
    && !/(?:既往|曾因|未见|否认|排除)/u.test(fact.evidence);
  const petechiae = facts.find(fact => reliable(fact)
    && /(?:额部|面部|颜面|眼周|眼睑)/u.test(`${fact.value} ${fact.evidence}`)
    && /针尖.{0,6}出血点/u.test(`${fact.value} ${fact.evidence}`));
  const neckMark = facts.find(fact => reliable(fact)
    && /颈部/u.test(`${fact.value} ${fact.evidence}`)
    && /(?:条纹环绕|掐痕|勒痕|皮肤淤紫|出血点)/u.test(`${fact.value} ${fact.evidence}`));
  const sourceFact = pattern => {
    const match = pattern.exec(sourceText);
    if (!match) return null;
    const delimiters = ['。', '；', ';', '\n'];
    const segmentStart = Math.max(...delimiters.map(delimiter => sourceText.lastIndexOf(delimiter, match.index - 1))) + 1;
    const segmentEnd = Math.min(...delimiters.map(delimiter => {
      const index = sourceText.indexOf(delimiter, match.index + match[0].length);
      return index < 0 ? sourceText.length : index;
    }));
    const segment = sourceText.slice(segmentStart, segmentEnd);
    if (/(?:既往|曾因|未见|否认|排除)/u.test(segment)) return null;
    return { id: '', value: match[0], evidence: match[0] };
  };
  const sourcePetechiae = petechiae || sourceFact(/(?:额部|面部|颜面|眼周|眼睑)[^。；;\n]{0,32}?针尖样出血点/u);
  const sourceNeckMark = neckMark || sourceFact(/颈部[^。；;\n]{0,32}?(?:条纹环绕|掐痕|勒痕|皮肤淤紫|出血点)/u);
  return sourcePetechiae && sourceNeckMark ? { petechiae: sourcePetechiae, neckMark: sourceNeckMark } : null;
}

function deterministicUnresolvedAsphyxiaReferences(clauses, facts, sourceText, sourceUrl, references) {
  if (references.some(reference => reference.id === '5.5.4.h' && reference.relation === 'supports')) return [];
  const cues = partialAsphyxiaCueFacts(facts, sourceText);
  if (!cues) return [];
  const byId = new Map(clauses.map(clause => [clause.id, clause]));
  const neckClause = byId.get('5.5.4.h');
  const otherClause = byId.get('5.12.4.g');
  return [
    ...(neckClause ? [{ ...neckClause, sourceUrl, evidence: cues.neckMark.evidence,
      reasoning: '原文记录颈部标记及面/眼部针尖样出血点；是否符合标准所称窒息征象仍需专业核实。',
      relation: 'incomplete', conditions: [
        { condition: '颈部损伤', evidence: cues.neckMark.evidence, factIds: cues.neckMark.id ? [cues.neckMark.id] : [], met: true },
        { condition: '出现窒息征象', evidence: cues.petechiae.evidence, factIds: cues.petechiae.id ? [cues.petechiae.id] : [], met: null },
      ] }] : []),
    ...(otherClause ? [{ ...otherClause, sourceUrl, evidence: cues.petechiae.evidence,
      reasoning: '条款还要求呼吸功能障碍；现有材料不足以确认该条件或窒息征象。',
      relation: 'incomplete', conditions: [
        { condition: '呼吸功能障碍', evidence: '', factIds: [], met: null },
        { condition: '出现窒息征象', evidence: cues.petechiae.evidence, factIds: cues.petechiae.id ? [cues.petechiae.id] : [], met: null },
      ] }] : []),
  ].filter(reference => {
    const existing = references.find(item => item.id === reference.id);
    return !existing || existing.relation === 'incomplete';
  });
}

function includeDerivedParents(facts, factIds) {
  const factsById = new Map(facts.map(fact => [fact.id, fact]));
  const selected = new Map();
  const visit = id => {
    if (selected.has(id)) return;
    const fact = factsById.get(id);
    if (!fact) return;
    selected.set(id, fact);
    for (const parentId of fact.derivedFrom || []) visit(parentId);
  };
  for (const id of factIds) visit(id);
  return [...selected.values()];
}

function includeLinkedEventFacts(facts, factIds) {
  const selected = includeDerivedParents(facts, factIds);
  const eventIds = new Set(selected.map(fact => fact.eventId).filter(Boolean));
  if (!eventIds.size) {
    if (!facts.some(fact => fact.eventId)) return selected;
    if (!selected.length || selected.some(fact => !factDateKeys(fact).length)) return [];
    const owners = new Set();
    for (const fact of selected) {
      const eventIdsForFact = new Set(factDateKeys(fact).flatMap(date => facts
        .filter(candidate => candidate.eventId && candidate.source === fact.source && candidate.verification === 'quoted'
          && reliableCertainties.has(candidate.certainty) && factDateKeys(candidate).includes(date))
        .map(candidate => candidate.eventId)));
      if (eventIdsForFact.size !== 1) return [];
      owners.add([...eventIdsForFact][0]);
    }
    if (owners.size !== 1) return [];
    const [eventId] = owners;
    const linked = [...new Map([...selected, ...facts.filter(fact => fact.eventId === eventId)]
      .map(fact => [fact.id, fact])).values()];
    return includeDerivedParents(linked, linked.map(fact => fact.id));
  }
  const expanded = [...new Map([...selected, ...facts.filter(fact => eventIds.has(fact.eventId))]
    .map(fact => [fact.id, fact])).values()];
  return includeDerivedParents(expanded, expanded.map(fact => fact.id));
}

export function normalizeResult(raw, input, context) {
  const generated = providerResultSchema.parse(raw);
  const sanitizeModelText = text => {
    const value = typeof text === 'string' ? text : '';
    if (/\bF\d+\b/u.test(value)) return '';
    if (!/(?:\beventId\b|\bfactIds?\b|\bconditionLogic\b|\bschema\b|规范事实数据|映射到条款条件)/iu.test(value)) return value;
    if (/(?:\beventId\b|事件归属)/iu.test(value)) return '补充原始病历以确认相关事实是否属于同一次外伤事件。';
    return '补充原始病历以核实相关事实依据。';
  };
  const { standard } = catalogs[input.assessmentType];
  const allowedClauses = new Map(context.clauses.map(clause => [clause.id, clause]));
  const principles = new Map(catalogs[input.assessmentType].principles.map(item => [item.id,
    { ...item, grade: '', category: '总则与附则' }]));
  const recognizedText = context.recognizedText || '';
  const sourceText = `${input.description}\n${recognizedText}`;
  const sourceSentences = sourceText.split(/[。！？；;\n]/u);
  const woundTerm = /创口|伤口|瘢痕|疤痕|裂伤|裂创/u;
  const sourceHasScalpLocation = sourceSentences.some(sentence => woundTerm.test(sentence)
    && /头皮|头顶部|额顶部|顶枕部|额颞部|枕部|颞部|发际/u.test(sentence));
  const sourceHasFaceLocation = sourceSentences.some(sentence => woundTerm.test(sentence)
    && /面部|颜面|脸部|面颊|颊部|颧部|鼻部|鼻梁|鼻翼|眼睑|眉部|口唇|唇部|下颌/u.test(sentence));
  const unsupportedHeadFaceWoundAdvice = text => {
    if (!/(?:创口|伤口|瘢痕|疤痕|裂伤|裂创)/u.test(text)) return false;
    const adviceHasFace = /面部|颜面|脸部|面颊|颊部|颧部|鼻部|鼻梁|鼻翼|眼睑|眉部|口唇|唇部|下颌/u.test(text);
    const adviceHasScalp = /头皮|头顶部|额顶部|顶枕部|额颞部|枕部|颞部|发际/u.test(text);
    return adviceHasFace && sourceHasScalpLocation && !sourceHasFaceLocation
      || adviceHasScalp && sourceHasFaceLocation && !sourceHasScalpLocation;
  };
  const allowedIds = new Set([...allowedClauses.keys()].flatMap(id => [id, id.split('.').slice(0, 3).join('.')])
    .concat(catalogs[input.assessmentType].principles.map(item => item.id)));
  const inlineIds = generated.reasoning.normalize('NFKC').match(/[456]\.\d+\.\d+(?:\.[a-z]|\.\d+|[a-z])?\b/g) || [];
  const unknownInlineCitation = inlineIds.some(id => !allowedIds.has(id) && !allowedIds.has(id.replace(/(\d)([a-z])$/, '$1.$2')));
  const warnings = [];
  const unmappedConditionClauseIds = new Set();
  let conflicts = Array.isArray(context.conflicts) ? context.conflicts : [];
  const unsupportedDiscrepancyLanguage = /(?:冲突|矛盾|不一致|两种(?:测量|数据)|数据.{0,12}(?:存在差异|不一致))/u;
  const multipleDatedEvents = hasDistinctDatedInjuryEvents(input.description);
  const assessmentEventId = eventIdForSelectedInjuryDate(context.extractedFacts, input.injuryDate);
  const reviewReasons = Array.isArray(context.reviewReasons) ? context.reviewReasons : [];
  let requiresReview = reviewReasons.some(reason => reason !== 'fact_conflict')
    || context.requiresReview === true && conflicts.length === 0 && reviewReasons.length === 0;
  if (hasExplicitAndRelativeInjuryDate(input.description)) {
    warnings.push('材料同时记载具体受伤日期与相对时间，请结合原始病历核实时间线及骨折与本次事件的关联；该提示本身不等同于骨折证据冲突。');
  }
  const hasValidatedFacts = Array.isArray(context.extractedFacts);
  const ageAdjustmentMissingMaterials = [];
  const hearingThresholdMissingMaterials = [];
  const missingMaterials = canonicalMissingMaterials([
    ...(hasValidatedFacts ? [] : generated.missingMaterials),
    ...(Array.isArray(context.factMissingMaterials) ? context.factMissingMaterials : []),
  ]);
  let facts = [];
  const sourceFacts = Array.isArray(context.extractedFacts) ? context.extractedFacts : generated.facts.map((fact, index) => ({
    id: `F${index + 1}`, field: 'other', value: fact.finding, certainty: 'reported',
    source: fact.source, evidence: fact.evidence, finding: fact.finding,
  }));
  for (const fact of sourceFacts) {
    const source = fact.source === 'image' ? recognizedText : input.description;
    const sourceRefs = Array.isArray(fact.sourceRefs)
      ? fact.sourceRefs.filter(reference => sourceReferenceMatches(reference, { description: input.description, recognizedText }))
      : undefined;
    const quotedSourceRefs = Boolean(sourceRefs?.length);
    const allDerivedSourcesTraceable = fact.field !== 'lip_through_wound_length_cm'
      || quotedSourceRefs && sourceRefs.length === fact.sourceRefs.length;
    if (!includesEvidence(source, fact.evidence) && !quotedSourceRefs || !allDerivedSourcesTraceable) {
      warnings.push('部分事实无法在提交材料中回查，已移除，不能作为等级依据。');
      continue;
    }
    if (Array.isArray(fact.sourceRefs) && !sourceRefs.length) {
      warnings.push('事实来源无法对应到原始文本或图片页，已移除，不能作为等级依据。');
      continue;
    }
    if (evidenceOccursOnlyInMarkedContext(fact.evidence, source, STANDARD_QUOTATION_MARKER)) {
      warnings.push('引用的标准或条款原文不是受检者的检查事实，已移除；请补充病例本身的诊疗或检查记录。');
      continue;
    }
    if (evidenceOccursOnlyInMarkedContext(fact.evidence, source, PRIOR_APPRAISAL_CONCLUSION_MARKER)) {
      warnings.push('原鉴定意见或结论不能替代受检者的原始检查事实，已移除；请补充相关诊疗、影像或查体记录。');
      continue;
    }
    if (sourceRefs && sourceRefs.length !== fact.sourceRefs.length) warnings.push('部分事实来源无法对应到原始页面，已移除无效来源链接。');
    facts.push({ ...fact, ...(sourceRefs ? { sourceRefs } : {}), finding: fact.finding || `${fact.field}：${Array.isArray(fact.value) ? fact.value.join('、') : String(fact.value ?? '')}`,
      verification: fact.source === 'image' ? 'image_pending' : 'quoted' });
  }
  const allFacts = facts;
  const allConflicts = conflicts;
  if (assessmentEventId) {
    facts = allFacts.filter(fact => !fact.eventId || fact.eventId === assessmentEventId);
    const scopedFactIds = new Set(facts.map(fact => fact.id));
    conflicts = allConflicts.filter(conflict => {
      const ids = [...new Set(conflict.factIds || conflict.fact_ids || conflict.between || [])];
      return !ids.length || ids.some(id => scopedFactIds.has(id));
    });
    if (conflicts.length < allConflicts.length) {
      warnings.push('其他日期事件的冲突事实未用于本次定级；本次评估已按原文可核验的受伤日期限定范围。');
    }
  }
  if (multipleDatedEvents && !assessmentEventId) {
    requiresReview = true;
    warnings.push('材料涉及多个日期不同的受伤事件，当前事实未能可靠确定本次评估对象，需先核实事件归属。');
  } else if (multipleDatedEvents) {
    warnings.push('已按用户所选受伤日期对应的原文事件限定本次评估；其他事件事实未用于定级。');
  }
  if (!requiresReview && conflicts.length && conflictCouldAffectGrade(conflicts, facts, input.assessmentType)) {
    requiresReview = true;
  }
  const contradictedAdvice = text => !requiresReview && contradictsVerifiedRibFacts(text, facts);
  const hasSourceFractureMention = /骨折|fracture/iu.test(`${input.description} ${recognizedText}`)
    || facts.some(fact => /骨折|fracture/iu.test(`${fact.value} ${fact.evidence}`));
  const fractureAdviceSiteGroups = [
    ['肋骨'], ['鼻骨', '鼻'], ['上颌骨', '下颌骨', '颌骨'], ['骨盆', '耻骨', '髋臼'],
    ['椎体', '脊柱'], ['锁骨'], ['肩胛骨'], ['胸骨'], ['股骨'], ['胫骨'], ['腓骨'],
    ['髌骨'], ['肱骨'], ['尺骨'], ['桡骨'], ['掌骨', '手部', '手指'], ['跖骨', '趾骨', '足部'],
    ['颅骨', '枕骨', '额骨', '顶骨', '颞骨'],
  ];
  const sourceFractureText = normalize(facts.filter(fact => fact.source === 'description' && fact.verification === 'quoted'
    && ['reported', 'observed', 'derived'].includes(fact.certainty)
    && /骨折|fracture/iu.test(`${fact.value} ${fact.evidence}`))
    .map(fact => `${fact.value} ${fact.evidence}`).join(' '));
  const sourceHasFractureSite = group => {
    if (group.some(site => sourceFractureText.includes(normalize(site)))) return true;
    const sourceFragments = `${input.description}\n${recognizedText}`.split(/[。！？；;\n]/u).map(normalize);
    return sourceFragments.some(fragment => {
      const fractureIndexes = [...fragment.matchAll(/骨折|fracture/giu)].map(match => match.index);
      return group.some(site => {
        const normalizedSite = normalize(site);
        let siteIndex = fragment.indexOf(normalizedSite);
        while (siteIndex >= 0) {
          if (fractureIndexes.some(fractureIndex => {
            if (Math.abs(fractureIndex - siteIndex) > 24) return false;
            const nearby = fragment.slice(Math.max(0, Math.min(fractureIndex, siteIndex) - 12),
              Math.min(fragment.length, Math.max(fractureIndex, siteIndex) + 12));
            return !/(?:未见|未发现|未提示|无|否认|排除|不支持|不考虑|非)/u.test(nearby);
          })) return true;
          siteIndex = fragment.indexOf(normalizedSite, siteIndex + normalizedSite.length);
        }
        return false;
      });
    });
  };
  const unsupportedFractureAdvice = text => {
    if (!/骨折|fracture|影像|X线|CT|MRI/iu.test(text)) return false;
    const advice = normalize(text);
    const adviceSiteGroups = fractureAdviceSiteGroups.filter(group => group.some(site => advice.includes(normalize(site))));
    if (adviceSiteGroups.some(group => !sourceHasFractureSite(group))) return true;
    return /骨折|fracture/iu.test(text) && !hasSourceFractureMention;
  };
  const jawFunctionTerms = /张口|咬合|咀嚼|颞颌|颞下颌/u;
  const sourceJawEvidence = normalize(`${input.description} ${recognizedText} ${facts.map(fact => `${fact.value} ${fact.evidence}`).join(' ')}`);
  const hasSourceJawEvidence = /(?:上颌骨|下颌骨|颌骨|颞颌|颞下颌|牙齿|口腔|张口|咬合|咀嚼)/u.test(sourceJawEvidence);
  const unsupportedJawFunctionAdvice = text => jawFunctionTerms.test(text) && !hasSourceJawEvidence;
  const modelNarrativeEvidence = normalize(`${sourceText} ${facts.map(fact => `${fact.value} ${fact.evidence}`).join(' ')}`)
    .replace(/左侧/gu, '左').replace(/右侧/gu, '右').replace(/双侧/gu, '双')
    .replace(/(?:额骨|顶骨|枕骨|颞骨|蝶骨|筛骨)骨折/gu, match => `${match}颅骨骨折`);
  const sideSpecificSites = ['耳道', '耳', '眼', '鼻', '肋骨', '肺', '额部', '额叶', '颞部', '颞叶',
    '顶骨', '枕骨', '上肢', '下肢', '肢体', '手背', '手部', '足部', '肩', '膝', '脊柱', '肾', '脾'];
  const unsupportedLateralityClaim = text => {
    const narrative = normalize(text).replace(/左侧/gu, '左').replace(/右侧/gu, '右').replace(/双侧/gu, '双');
    for (const site of sideSpecificSites) {
      for (const side of ['左', '右', '双']) {
        if (narrative.includes(`${side}${site}`) && !modelNarrativeEvidence.includes(`${side}${site}`)) return true;
      }
    }
    return false;
  };
  const unsupportedMedicalClaim = text => {
    const claims = text.match(/(?:脑|颅|神经|血管|肺|胸|腹|肾|脾|肝|心|眼|耳|鼻|颈|脊髓|肢体|骨|硬膜|内脏|外伤)[\p{Script=Han}]{0,10}(?:疾病|病史|病|症|损伤|漏|癫痫|梗死|疝|气胸|血胸|出血|血肿|挫伤|挫裂伤|骨折|断裂|破裂|脱位|积液|撕裂|瘫痪|失语|软化灶|水肿|动脉瘤|积血|受压)/gu) || [];
    return claims.some(claim => !modelNarrativeEvidence.includes(normalize(claim)));
  };
  const unsupportedOmissionClaim = text => {
    const clinicalEvidenceTerms = ['GCS', '格拉斯哥', '瞳孔', '对光反射', 'Babinski', '巴彬斯基',
      '浅昏迷', '昏迷', '肌力', '肌张力', '蛛网膜下腔出血', '脑挫裂伤', '硬膜下出血', '耳道出血'];
    const omissions = text.match(/(?:未提供|未记载|未提及|缺乏|没有提供|未明确)[^，,。；;]{0,20}/gu) || [];
    return omissions.some(omission => clinicalEvidenceTerms.some(term =>
      normalize(omission).includes(normalize(term)) && modelNarrativeEvidence.includes(normalize(term))));
  };
  const unsupportedMechanismScopeClaim = text => {
    const narrative = normalize(text);
    return /(?:化学中毒|毒物中毒|中毒性脑病|氟乙酸盐|氟乙酰胺)/u.test(narrative)
      && /(?:不属于|不在|超出|不适用|不纳入)/u.test(narrative)
      && /(?:人体损伤程度鉴定标准|本标准)/u.test(narrative)
      && /(?:适用范围|适用情形|适用|范围|致伤因素)/u.test(narrative);
  };
  const unsupportedModelNarrative = text => unsupportedLateralityClaim(text)
    || unsupportedMedicalClaim(text) || unsupportedOmissionClaim(text) || unsupportedMechanismScopeClaim(text);
  warnings.push(...generated.warnings.map(sanitizeModelText).filter(Boolean)
    .filter(warning => !/^条款\s+\S+\s+的条件组存在重复或未映射文本，未用于等级判断。$/u.test(warning))
    .filter(warning => !unsupportedModelNarrative(warning))
    .filter(warning => conflicts.length > 0 || !unsupportedDiscrepancyLanguage.test(warning))
    .filter(warning => !contradictedAdvice(warning))
    .filter(warning => !unsupportedFractureAdvice(warning))
    .filter(warning => !unsupportedJawFunctionAdvice(warning)), ...(context.extractionWarnings || []));
  const nextSteps = generated.nextSteps.map(sanitizeModelText).filter(Boolean)
    .filter(step => !unsupportedModelNarrative(step))
    .filter(step => !contradictedAdvice(step))
    .filter(step => !unsupportedFractureAdvice(step))
    .filter(step => !unsupportedJawFunctionAdvice(step));
  for (let index = missingMaterials.length - 1; index >= 0; index -= 1) {
    if (contradictedAdvice(missingMaterials[index]) || unsupportedFractureAdvice(missingMaterials[index])
      || unsupportedJawFunctionAdvice(missingMaterials[index]) || unsupportedMechanismScopeClaim(missingMaterials[index])) {
      missingMaterials.splice(index, 1);
    }
  }
  let invalidRibConditionMapping = false;
  if (unknownInlineCitation) warnings.push('部分自由文本引用不在本次原文依据中，已不采纳其结论。');
  const references = [];
  const hasSourceLinkedQuote = (quote, factIds = []) => Boolean(quote && includesEvidence(sourceText, quote)
    && facts.some(fact => fact.evidence && includesEvidence(sourceText, fact.evidence)
      && (factIds.includes(fact.id) || includesEvidence(quote, fact.evidence) || includesEvidence(fact.evidence, quote))));
  const hasSourceLinkedConditionFact = conditions => conditions.some(condition =>
    (condition.factIds || []).some(id => facts.some(fact => fact.id === id && fact.evidence
      && includesEvidence(sourceText, fact.evidence)))
    || hasSourceLinkedQuote(condition.evidence, condition.factIds || []));
  const hasSourceLinkedReference = (conditions, evidence) => hasSourceLinkedConditionFact(conditions)
    || hasSourceLinkedQuote(evidence);
  const handSiteTerms = ['一手', '双手', '手一处', '手部', '手掌', '手背', '手指', '小指', '拇指', '食指', '中指', '无名指', '掌骨', '指骨'];
  const footSiteTerms = ['一足', '双足', '足部', '足背', '足底', '足趾', '趾骨', '拇趾', '跖骨', '跖趾', '5趾', '4趾', '趾'];
  const anatomicalSiteTerms = ['上颌骨', '下颌骨', '颌骨', '骨盆', '椎体', '脊柱', '锁骨', '肩胛骨', '肋骨',
    '胸骨', '髋臼', '股骨', '胫骨', '腓骨', '髌骨', '肱骨', '尺骨', '桡骨', '胰头', '胰腺', '十二指肠', '小肠',
    '睾丸', '阴囊', '阴茎', '尿道', '额部', '额头', '前额', '额顶部', '头额部', '颞部', '颞侧', '颧部', '面颊',
    ...handSiteTerms, ...footSiteTerms, '下肢', '上肢', '踝关节', '膝关节', '髋关节', '肩关节', '腕关节', '肘关节',
    '头面部', '面部', '鼻唇沟', '鼻骨', '口唇', '唇部', '上唇', '下唇', '唇红', '唇黏膜', '颅骨', '眼球', '眼', '耳廓', '耳', '鼻', '颈部', '胸部',
    '腹部', '肺', '脾', '肾', '肝', '心脏', '脑'];
  const containsSite = (text, terms) => terms.some(term => normalize(text).includes(normalize(term)));
  const clauseHasVerifiedSiteMismatch = clause => {
    const clauseText = normalize(clause.text);
    const factText = facts.map(fact => `${fact.value} ${fact.evidence}`).join(' ');
    const auricleMorphologyPattern = /(?:耳廓.{0,12}(?:缺损|缺如|缺失|畸形|变形|部分切除)|(?:缺损|缺如|缺失|畸形|变形|部分切除).{0,12}耳廓)/u;
    if (/耳廓.{0,12}(?:缺损|畸形)|(?:缺损|畸形).{0,12}耳廓/u.test(clauseText)) {
      const sourceSegments = normalize(`${sourceText} ${factText}`).split(/[，,；;。！？\n]+/u);
      const hasConfirmedAuricleMorphology = sourceSegments.some(segment => {
        const morphologyMatch = auricleMorphologyPattern.exec(segment);
        auricleMorphologyPattern.lastIndex = 0;
        if (!morphologyMatch) return false;
        const morphologyIndex = morphologyMatch.index + morphologyMatch[0].search(/缺损|缺如|缺失|畸形|变形|部分切除/u);
        const prefix = segment.slice(Math.max(0, morphologyIndex - 8), morphologyIndex);
        return !/(?:无|没有|没见|未见|未发现|未发生|否认|排除|不伴).{0,8}$/u.test(prefix);
      });
      if (!hasConfirmedAuricleMorphology) return true;
    }
    const clauseHand = containsSite(clauseText, handSiteTerms);
    const clauseFoot = containsSite(clauseText, footSiteTerms);
    const factHand = containsSite(factText, handSiteTerms);
    const factFoot = containsSite(factText, footSiteTerms);
    if (clauseHand && factFoot && !clauseFoot && !factHand) return true;
    if (clauseFoot && factHand && !clauseHand && !factFoot) return true;
    const clauseSites = anatomicalSiteTerms.filter(site => clauseText.includes(normalize(site)));
    if (!clauseSites.length) return false;
    const normalizedFactText = normalize(factText);
    const noseRegion = term => ['鼻梁', '鼻背'].includes(term) ? 'nasal_bridge' : term;
    const noseTerms = ['鼻尖', '鼻翼', '鼻梁', '鼻背'];
    const clauseNoseRegions = noseTerms.filter(site => clauseText.includes(normalize(site))).map(noseRegion);
    const factNoseRegions = noseTerms.filter(site => normalizedFactText.includes(normalize(site))).map(noseRegion);
    if (clauseNoseRegions.length && factNoseRegions.length
      && !clauseNoseRegions.some(site => factNoseRegions.includes(site))) return true;
    const factSites = anatomicalSiteTerms.filter(site => normalizedFactText.includes(normalize(site)));
    if (factSites.includes('鼻唇沟') && !factSites.includes('面部')) factSites.push('面部');
    if (factSites.some(site => ['额部', '额头', '前额', '额顶部', '头额部', '颞部', '颞侧', '颧部', '面颊'].includes(site))
      && !factSites.includes('面部')) factSites.push('面部');
    if (!factSites.length) return false;
    return !clauseSites.some(clauseSite => factSites.some(factSite =>
      clauseSite === factSite || clauseSite.includes(factSite) || factSite.includes(clauseSite)));
  };
  const mentionsOnlyOffSiteHandOrFoot = text => {
    const mentionsHand = containsSite(text, handSiteTerms);
    const mentionsFoot = containsSite(text, footSiteTerms);
    const factText = facts.map(fact => `${fact.value} ${fact.evidence}`).join(' ');
    const factsHaveHand = containsSite(factText, handSiteTerms);
    const factsHaveFoot = containsSite(factText, footSiteTerms);
    return mentionsHand && factsHaveFoot && !mentionsFoot && !factsHaveHand
      || mentionsFoot && factsHaveHand && !mentionsHand && !factsHaveFoot;
  };
  for (const proposed of generated.references) {
    const clause = allowedClauses.get(proposed.clauseId) || principles.get(proposed.clauseId);
    if (!clause) {
      warnings.push(`条款 ${proposed.clauseId} 不在本次官方原文依据中，已移除。`);
      continue;
    }
    if (clause.grade && clauseHasVerifiedSiteMismatch(clause)) {
      warnings.push('与已核验事实的部位或损伤性质不符的候选条款已移除。');
      continue;
    }
    if (clause.grade && clause.conditionLogic?.annotation === 'opaque') {
      references.push({ ...clause, sourceUrl: standard.sourceUrl,
        evidence: '',
        reasoning: clause.conditionLogic.reason
          ? `${clause.conditionLogic.reason} 状态保持未知，不用于当前定级。`
          : '本条款的条件逻辑尚未完成安全标注，状态保持未知，不用于当前定级。', relation: 'incomplete',
        conditions: [{ condition: clause.text, evidence: '', factIds: [], met: null }] });
      continue;
    }
    if (clause.grade && clause.conditionLogic?.annotation === 'explicit') {
      const bound = bindExplicitGroups(clause, proposed.conditions, facts);
      const ageFollowUp = clause.conditionLogic.ageAdjustment
        ? ageAdjustmentFollowUp(clause.conditionLogic.logic, facts) : null;
      if (ageFollowUp && !ageAdjustmentMissingMaterials.includes(ageFollowUp)) ageAdjustmentMissingMaterials.push(ageFollowUp);
      const hearingFollowUp = hearingThresholdFollowUp(clause.conditionLogic.logic, facts,
        `${input.description} ${recognizedText}`);
      if (hearingFollowUp && !hearingThresholdMissingMaterials.includes(hearingFollowUp)) {
        hearingThresholdMissingMaterials.push(hearingFollowUp);
      }
      if (bound.invalid && /肋骨骨折/.test(clause.text)) invalidRibConditionMapping = true;
      if (clause.grade && proposed.relation === 'differential'
        && !hasSourceLinkedReference(bound.conditions, proposed.evidence)) {
        warnings.push(`条款 ${clause.id} 没有关联到可回查事实，已移除。`);
        continue;
      }
      if (bound.invalid && !/肋骨骨折/.test(clause.text)) {
        warnings.push(`条款 ${clause.id} 的条件组存在重复或未映射文本，未用于等级判断。`);
        if (proposed.relation !== 'differential') unmappedConditionClauseIds.add(clause.id);
      }
      const confirmed = bound.met === true;
      references.push({ ...clause, sourceUrl: standard.sourceUrl,
        evidence: bound.evidence,
        reasoning: confirmed ? '来源可回查事实满足本地条款的显式逻辑条件。' : '材料原文尚不能完整支持本条逻辑条件，需补充或核对。',
        relation: proposed.relation === 'differential' ? 'differential' : confirmed ? 'supports' : 'incomplete',
        conditions: bound.conditions });
      continue;
    }
    const conditions = proposed.conditions.map(condition => {
      const canonicalCondition = officialCondition(condition.condition, clause.text);
      if (!canonicalCondition && clause.grade) {
        warnings.push(`条款 ${clause.id} 的条件描述不在本地条文中，未用于等级判断。`);
      }
      const conditionText = canonicalCondition || condition.condition;
      const factIds = Array.isArray(condition.factIds) ? [...new Set(condition.factIds)] : [];
      const referencedFacts = factIds.map(id => facts.find(fact => fact.id === id)).filter(Boolean);
      const matchedFacts = [...new Map([...referencedFacts, ...facts.filter(fact => fact.source === 'description'
        && (includesEvidence(fact.evidence, condition.evidence) || includesEvidence(condition.evidence, fact.evidence)))]
        .map(fact => [fact.id, fact])).values()].filter(fact => fact.field !== 'prior_injury');
      const boundEvidence = referencedFacts.find(fact => fact.field !== 'prior_injury' && fact.source === 'description' && includesEvidence(sourceText, fact.evidence))?.evidence
        || condition.evidence;
      const traceable = includesEvidence(sourceText, boundEvidence);
      const requiresSiteCount = /处数|\d+\s*处|[一二两三四五六七八九十]+\s*处/.test(conditionText);
      const relevantFacts = requiresSiteCount ? matchedFacts.filter(fact => fact.field === 'fracture_site_count') : matchedFacts;
      const historicalEvidence = referencedFacts.some(fact => fact.field === 'prior_injury')
        || /(?:既往(?:史)?|曾经|曾有|陈旧性?|旧伤)/.test(boundEvidence);
      const explicitSiteStatus = requiresSiteCount && !historicalEvidence
        ? explicitRibSiteCountStatus(conditionText, boundEvidence) : undefined;
      const explicitSiteEvidence = requiresSiteCount && matchedFacts.length > 0 && explicitSiteStatus === true;
      const reliableFact = relevantFacts.some(fact => ['reported', 'observed', 'derived'].includes(fact.certainty)
        && fact.source === 'description' && fact.verification === 'quoted');
      const explicitlyExcludedFact = relevantFacts.some(fact => fact.certainty === 'excluded'
        && fact.source === 'description' && fact.verification === 'quoted');
      const factBacked = condition.met === true ? (reliableFact || explicitSiteEvidence && traceable)
        : condition.met === false ? explicitlyExcludedFact && compositeConditionSupported(conditionText, matchedFacts, ['excluded'])
          : relevantFacts.length > 0;
      const evaluatedRibCondition = evaluateRibCondition(conditionText, matchedFacts);
      const ribCondition = evaluatedRibCondition === null && explicitSiteStatus !== undefined
        ? explicitSiteStatus : evaluatedRibCondition;
      const met = canonicalCondition
        ? (ribCondition !== undefined && ribCondition !== null ? ribCondition
          : traceable && factBacked && !(condition.met === true
            && !compositeConditionSupported(conditionText, matchedFacts))
            ? condition.met : null)
        : null;
      return { ...condition, condition: canonicalCondition || condition.condition,
        evidence: traceable && matchedFacts.length ? boundEvidence : '',
        ...(factIds.length ? { factIds: factIds.filter(id => facts.some(fact => fact.id === id && fact.field !== 'prior_injury')) } : {}),
        met };
    });
    const alternatives = semicolonAlternatives(clause.text) || simpleAlternatives(clause.text)?.alternatives;
    if (alternatives) {
      const citedFactIds = new Set(conditions.flatMap(condition => condition.factIds || []));
      const allAlternativesExcluded = alternatives.every(alternative => facts.some(fact => citedFactIds.has(fact.id)
        && fact.certainty === 'excluded' && fact.source === 'description' && fact.verification === 'quoted'
        && includesEvidence(fact.evidence, alternative)));
      if (!allAlternativesExcluded) {
        for (const condition of conditions) if (condition.met === false) condition.met = null;
      }
    }
    if (clause.grade && proposed.relation === 'differential'
      && !hasSourceLinkedReference(conditions, proposed.evidence)) {
      warnings.push(`条款 ${clause.id} 没有关联到可回查事实，已移除。`);
      continue;
    }
    const aggregateTraceable = includesEvidence(sourceText, proposed.evidence);
    const confirmed = conditionsSatisfyClause(conditions, clause.text);
    if (!aggregateTraceable && proposed.relation === 'supports' && confirmed) {
      warnings.push('部分条款汇总引用未能逐字回查，已用逐项核对的材料原文替代。');
    }
    const relation = proposed.relation === 'differential' ? 'differential' : confirmed ? 'supports' : 'incomplete';
    references.push({ ...clause, sourceUrl: standard.sourceUrl,
      evidence: conditions.map(condition => condition.evidence).filter(Boolean).join('；'),
      reasoning: confirmed ? '可回查事实与本地条文列出的适用条件相符。'
        : '材料原文尚不能完整支持本条条件，需补充或核对，不用于当前定级。',
      relation, conditions });
  }
  const stableExplicitReferences = !requiresReview
    ? deterministicExplicitReferences(catalogs[input.assessmentType].clauses, facts, standard.sourceUrl) : [];
  for (const reference of stableExplicitReferences) {
    const existingIndex = references.findIndex(item => item.id === reference.id);
    if (existingIndex >= 0) references.splice(existingIndex, 1, reference);
    else references.push(reference);
  }
  const supportsScalpClause = references.some(reference => reference.id === '5.1.4.a'
    && reference.relation === 'supports');
  const measuredWounds = facts.filter(fact => fact.field === 'wound_length_cm'
    && fact.source === 'description' && fact.verification === 'quoted'
    && reliableCertainties.has(fact.certainty));
  const usesDedicatedHeadFaceAuricleSites = measuredWounds.length > 0 && measuredWounds.every(fact =>
    /(?:头皮|头顶部|额顶部|后枕部|颞枕部|顶枕部|枕骨隆突部|枕项部|顶部|枕部|颞部|发际内|发际线|面部|脸部|额部|前额|额头|眉弓|眉部|颊部|面颊|颧部|鼻部|鼻背|鼻梁|唇部|口唇|上唇|下颌|耳廓)/u.test(fact.evidence));
  if (supportsScalpClause && usesDedicatedHeadFaceAuricleSites) {
    for (let index = references.length - 1; index >= 0; index -= 1) {
      if (references[index].id !== '5.11.3.b' || references[index].relation !== 'supports') continue;
      const referencedFacts = [...new Set((references[index].conditions || []).flatMap(condition => condition.factIds || []))]
        .map(id => facts.find(fact => fact.id === id)).filter(Boolean);
      const lengthFacts = referencedFacts.filter(fact => fact.field === 'wound_length_cm');
      if (lengthFacts.length && lengthFacts.every(fact =>
        /(?:头皮|头顶部|额顶部|后枕部|颞枕部|顶枕部|枕骨隆突部|枕项部|顶部|枕部|颞部|发际内|发际线|面部|脸部|额部|前额|额头|眉弓|眉部|颊部|面颊|颧部|鼻部|鼻背|鼻梁|唇部|口唇|上唇|下颌|耳廓)/u.test(fact.evidence))) {
        references.splice(index, 1);
      }
    }
  }
  if (input.assessmentType === 'injury' && !requiresReview) {
    for (const reference of deterministicUnresolvedShockReferences(context.clauses, facts, sourceText, standard.sourceUrl)) {
      if (!references.some(item => item.id === reference.id)) references.push(reference);
    }
    for (const reference of deterministicUnresolvedAsphyxiaReferences(context.clauses, facts, sourceText, standard.sourceUrl, references)) {
      const existingIndex = references.findIndex(item => item.id === reference.id);
      if (existingIndex >= 0) references.splice(existingIndex, 1, reference);
      else references.push(reference);
    }
  }
  const hasReliableRibFact = facts.some(fact => fact.field === 'injury_type' && fact.value === 'rib_fracture'
    && ['reported', 'observed', 'derived'].includes(fact.certainty)
    && fact.source === 'description' && fact.verification === 'quoted');
  const stableRibReferences = input.assessmentType === 'injury' && !requiresReview && hasReliableRibFact
    ? deterministicRibReferences(context.clauses, facts, standard.sourceUrl) : [];
  if (invalidRibConditionMapping && !requiresReview && !stableRibReferences.length) {
    warnings.push('肋骨条款条件组存在重复或未映射文本，且无法由已核验事实重新评估。');
  }
  if (stableRibReferences.length) {
    references.splice(0, references.length, ...references.filter(reference => !/肋骨骨折/.test(reference.text)), ...stableRibReferences);
  }
  if (requiresReview) references.splice(0, references.length);
  let status = generated.status;
  let grade = generated.grade;
  if (requiresReview) status = 'needs_review';
  const blockingMissingMaterials = !hasValidatedFacts && missingMaterials.length > 0;
  let supportedReference = references.filter(reference => grades[input.assessmentType].includes(reference.grade)
    && reference.relation === 'supports' && reference.conditions.length > 0
    && (reference.conditionLogic?.annotation === 'explicit'
      ? evaluateConditionLogic(reference.conditionLogic, includeLinkedEventFacts(facts,
        reference.conditions.flatMap(condition => condition.factIds || []))).met === true
      : conditionsSatisfyClause(reference.conditions, reference.text)))
    .sort((left, right) => grades[input.assessmentType].indexOf(left.grade) - grades[input.assessmentType].indexOf(right.grade)
      || left.id.localeCompare(right.id, 'en'))[0];
  if (!supportedReference && input.assessmentType === 'injury'
    && facts.some(fact => fact.field === 'fractured_rib_numbers' && fact.source === 'description'
      && fact.verification === 'quoted' && reliableCertainties.has(fact.certainty))) {
    const lowerRibThresholdReference = references.filter(reference => grades.injury.includes(reference.grade)
      && reference.relation === 'differential' && reference.conditions.length > 0
      && reference.conditions.every(condition => condition.met === true)
      && reference.conditions.some(condition => /骨折处数\s*2处以上/u.test(condition.condition)))
      .sort((left, right) => grades.injury.indexOf(left.grade) - grades.injury.indexOf(right.grade)
        || left.id.localeCompare(right.id, 'en'))[0] || null;
    if (lowerRibThresholdReference) {
      lowerRibThresholdReference.relation = 'supports';
      supportedReference = lowerRibThresholdReference;
      warnings.push('现有肋骨骨折事实满足较低处数条款；是否达到更高处数阈值仍需核对。');
    }
  }
  if (supportedReference?.id === '5.11.3.b'
    && facts.some(fact => fact.field === 'wound_length_cm' && fact.source === 'description' && fact.verification === 'quoted')) {
    const staleWoundGradeAdvice = text => /(?:若|如果|如).{0,24}(?:创口|伤口|瘢痕).{0,32}(?:长度|符合标准|达到标准).{0,32}(?:出具|评定|鉴定|等级)/u.test(text);
    const staleLimbSiteAdvice = text => /(?:创口|伤口|瘢痕).{0,32}(?:肢体|四肢).{0,16}(?:部位|归类|条款)/u.test(text)
      || /(?:背部|躯干).{0,48}(?:肢体|四肢).{0,40}(?:条款|归类|适用)/u.test(text)
      || /(?:肢体|四肢).{0,48}(?:背部|躯干).{0,40}(?:条款|归类|适用)/u.test(text);
    for (let index = nextSteps.length - 1; index >= 0; index -= 1) {
      if (staleWoundGradeAdvice(nextSteps[index]) || staleLimbSiteAdvice(nextSteps[index])) nextSteps.splice(index, 1);
    }
    for (let index = warnings.length - 1; index >= 0; index -= 1) {
      if (staleWoundGradeAdvice(warnings[index]) || staleLimbSiteAdvice(warnings[index])) warnings.splice(index, 1);
    }
  }
  if (supportedReference?.id === '5.1.4.a') {
    const staleScalpMeasurementAdvice = text => /(?:核实是否存在多处(?:头皮)?(?:创口|瘢痕)|收集并核实所有头皮部位|根据最终确认的累计长度与标准阈值进行比对|(?:累计长度|长度累计).{0,20}(?:尚未确认|待核实|未明确))/u.test(text);
    for (let index = nextSteps.length - 1; index >= 0; index -= 1) {
      if (staleScalpMeasurementAdvice(nextSteps[index])) nextSteps.splice(index, 1);
    }
    for (let index = warnings.length - 1; index >= 0; index -= 1) {
      if (staleScalpMeasurementAdvice(warnings[index])) warnings.splice(index, 1);
    }
  }
  const verifiedTympanicDuration = supportedReference?.id === '5.3.4.a'
    && facts.some(fact => fact.field === 'clinical_finding'
      && fact.value === '外伤性鼓膜穿孔6周不能自行愈合'
      && confirmsSixWeekUnhealedTympanicPerforation(fact.evidence));
  if (verifiedTympanicDuration) {
    const staleDurationReview = text => /若.{0,16}时间线.{0,16}(?:成立|正确)|(?:确认|核实).{0,48}(?:时间线|天数|6周|六周|42天)|(?:时间线|6周|六周|42天).{0,40}(?:待核实|尚未确认|是否|需(?:要)?核实|取决于)/u.test(text);
    for (let index = nextSteps.length - 1; index >= 0; index -= 1) {
      if (staleDurationReview(nextSteps[index])) nextSteps.splice(index, 1);
    }
    for (let index = warnings.length - 1; index >= 0; index -= 1) {
      if (staleDurationReview(warnings[index])) warnings.splice(index, 1);
    }
  }
  const explicitAlternativeStandard = /工伤|劳动能力鉴定|保险合同|保险条款/.test(input.description);
  if (!requiresReview && !supportedReference) {
    if (status === 'needs_review') status = 'insufficient';
    if (status === 'not_applicable' && !explicitAlternativeStandard) status = 'insufficient';
  }
  if (!requiresReview && !blockingMissingMaterials && facts.length > 0 && supportedReference) {
    status = 'preliminary';
    grade = supportedReference.grade;
    for (let index = references.length - 1; index >= 0; index -= 1) {
      if (references[index].grade && (references[index].relation !== 'supports' || references[index].grade !== grade)) references.splice(index, 1);
    }
  } else if (status === 'preliminary') {
    if (!supportedReference || !grades[input.assessmentType].includes(grade) || blockingMissingMaterials) {
      status = 'insufficient';
      missingMaterials.push('补充能够支持所涉标准完整条件的材料，由专业人员核对后再评估。');
      warnings.push('当前材料或条款依据不足，未保留模型给出的等级。');
    }
  }
  const supportedGradeRank = supportedReference ? grades[input.assessmentType].indexOf(supportedReference.grade) : -1;
  const unresolvedHigherReviewClauses = supportedGradeRank < 0 ? [] : (context.reviewClauseIds || [])
    .map(id => catalogs[input.assessmentType].clauses.find(clause => clause.id === id))
    .filter(clause => clause?.grade && grades[input.assessmentType].indexOf(clause.grade) < supportedGradeRank
      && clause.conditionLogic?.annotation === 'explicit'
      && evaluateConditionLogic(clause.conditionLogic, facts).met === null);
  if (status === 'preliminary' && unresolvedHigherReviewClauses.length) {
    status = 'insufficient';
    grade = null;
    missingMaterials.push('核实可能影响等级比较的较高等级条款所需事实后再评估。');
    warnings.push('较高等级候选条款仍有必要条件未核实，暂不输出较低等级。');
    for (const reference of references) {
      if (reference.grade === supportedReference.grade && reference.relation === 'supports') {
        reference.relation = 'differential';
        reference.reasoning = '该条款条件有来源支持，但有可能影响等级比较的较高条款尚未核实。';
      }
    }
    for (const clause of unresolvedHigherReviewClauses) {
      if (references.some(reference => reference.id === clause.id)) continue;
      const conditions = logicGroups(clause.conditionLogic.logic).map(group => {
        const evaluated = evaluateLogicNode(group, facts, clause.conditionLogic.ageAdjustment);
        return { condition: logicGroupText(group), evidence: evaluated.evidence, factIds: evaluated.factIds,
          met: evaluated.met };
      });
      references.push({ ...clause, sourceUrl: standard.sourceUrl, evidence: conditions.map(item => item.evidence)
        .filter(Boolean).join('；'), reasoning: '该较高等级候选条款仍有必要条件未核实，不用于当前定级。',
      relation: 'incomplete', conditions });
    }
  }
  if (input.assessmentType === 'disability' && input.treatmentStatus !== 'stable' && status === 'preliminary') {
    status = 'insufficient';
    warnings.push('鉴定时机尚未确认原发损伤及相关并发症治疗终结或临床效果稳定；依据该标准第4.2条，暂不输出伤残等级。');
  }
  if (status !== 'preliminary') grade = null;
  if (status === 'needs_review') {
    warnings.push('关键事实存在矛盾或待核实内容，当前结果不用于等级判断。');
    for (const reference of references) {
      if (reference.relation === 'supports') {
        reference.relation = 'incomplete';
        reference.reasoning = '关键事实存在冲突或待核实内容，本条不用于等级判断。';
      }
    }
  }
  const verifiedSupportedClauseIds = new Set(references
    .filter(reference => reference.relation === 'supports' && reference.grade)
    .map(reference => reference.id));
  const verifiedSupportedConditions = references
    .filter(reference => reference.relation === 'supports' && reference.grade)
    .flatMap(reference => (reference.conditions || [])
      .filter(condition => condition.met === true)
      .map(condition => condition.condition))
    .filter(condition => typeof condition === 'string' && condition.length > 1);
  const unavailableClauseWarning = /(?:条款|标准|定级|分级).{0,24}(?:未包含|未涵盖|未收录|未映射|没有)|(?:无法匹配|无法适用).{0,24}(?:条款|标准|定级|分级)/u;
  for (let index = warnings.length - 1; index >= 0; index -= 1) {
    const warning = warnings[index];
    const warningClauseId = warning.match(/条款\s+(\S+?)\s+的条件组存在重复或未映射文本/)?.[1];
    const warningClauseRetained = warningClauseId && references.some(reference => reference.id === warningClauseId);
    const warningClauseGrade = catalogs[input.assessmentType].clauses.find(clause => clause.id === warningClauseId)?.grade;
    const warningClauseRank = grades[input.assessmentType].indexOf(warningClauseGrade);
    const supersededBySupportedGrade = warningClauseRank >= 0 && references.some(reference =>
      reference.id !== warningClauseId && reference.relation === 'supports'
      && grades[input.assessmentType].indexOf(reference.grade) >= 0
      && grades[input.assessmentType].indexOf(reference.grade) < warningClauseRank);
    const retainUnmappedWarning = warningClauseId && unmappedConditionClauseIds.has(warningClauseId)
      && !supersededBySupportedGrade;
    const contradictsSupportedCondition = unavailableClauseWarning.test(warning)
      && verifiedSupportedConditions.some(condition => warning.includes(condition));
    const contradictsSupportedClauseId = unavailableClauseWarning.test(warning)
      && [...verifiedSupportedClauseIds].some(id => warning.includes(id));
    if (warningClauseId && ((!warningClauseRetained || verifiedSupportedClauseIds.has(warningClauseId))
      && !retainUnmappedWarning)
      || contradictsSupportedCondition || contradictsSupportedClauseId) {
      warnings.splice(index, 1);
    }
  }
  if (hasValidatedFacts) {
    if (status === 'needs_review') {
      missingMaterials.splice(0, missingMaterials.length,
        conflicts.length ? '核对冲突事实所涉及的原始资料。' : '核实关键事实的原始资料。');
    } else if (status === 'preliminary') {
      missingMaterials.splice(0, missingMaterials.length,
        ...canonicalMissingMaterials([...ageAdjustmentMissingMaterials, ...hearingThresholdMissingMaterials]));
    } else if (status === 'insufficient') {
      missingMaterials.splice(0, missingMaterials.length,
        ...canonicalMissingMaterials([...(context.factMissingMaterials || []), ...ageAdjustmentMissingMaterials,
          ...hearingThresholdMissingMaterials]));
      const excludedOnlyFacts = facts.length > 0 && facts.every(fact => fact.certainty === 'excluded');
      const hasReliableRibFact = facts.some(fact => fact.field === 'injury_type' && fact.value === 'rib_fracture'
        && ['reported', 'observed', 'derived'].includes(fact.certainty)
        && fact.source === 'description' && fact.verification === 'quoted');
      const hasExplicitSiteCount = facts.some(fact => fact.field === 'fracture_site_count'
        && ['reported', 'observed', 'derived'].includes(fact.certainty)
        && fact.source === 'description' && fact.verification === 'quoted');
      const hasUnresolvedRibSiteThreshold = references.some(reference => /肋骨骨折/.test(reference.text)
        && /(?:\d+|[零〇一二两三四五六七八九十百]+)\s*处以上/.test(reference.text));
      if (hasReliableRibFact && hasUnresolvedRibSiteThreshold && !hasExplicitSiteCount) {
        missingMaterials.push('骨折处数未在原文中明确记载，需核实');
      }
      if (excludedOnlyFacts) missingMaterials.splice(0, missingMaterials.length);
      if (missingMaterials.length === 0) missingMaterials.push('补充与适用条款相关的客观材料。');
    }
  }
  if (!hasValidatedFacts && hearingThresholdMissingMaterials.length && status === 'insufficient') {
    missingMaterials.splice(0, missingMaterials.length,
      ...canonicalMissingMaterials([...missingMaterials, ...hearingThresholdMissingMaterials]));
  }
  const unresolvedShock = input.assessmentType === 'injury' && status === 'insufficient'
    && Boolean(ungradedShockDiagnosis(facts, sourceText))
    && references.some(reference => ['5.12.2.d', '5.12.4.f'].includes(reference.id));
  const unresolvedAsphyxia = input.assessmentType === 'injury' && status === 'insufficient'
    && Boolean(partialAsphyxiaCueFacts(facts, sourceText))
    && references.some(reference => ['5.5.4.h', '5.12.4.g'].includes(reference.id)
      && reference.relation === 'incomplete');
  if (unresolvedShock) {
    missingMaterials.splice(0, missingMaterials.length,
      '休克严重程度未明确；需结合连续血压、脉搏、失血量及补液或输血等救治记录综合核实。');
    if (!nextSteps.some(step => /休克.{0,20}(?:严重程度|分度)/u.test(step))) {
      nextSteps.push('补充休克分度相关的连续血压、脉搏、失血量及补液或输血记录，由专业人员综合核定。');
    }
  }
  if (unresolvedAsphyxia) {
    missingMaterials.splice(0, missingMaterials.length,
      '核实附录B.6.3所述窒息征象是否成立，并补充呼吸功能是否受损的检查或诊疗记录。');
    if (!nextSteps.some(step => /窒息征象|呼吸功能/u.test(step))) {
      nextSteps.push('补充颈部、面眼部体征及呼吸功能评估记录，由专业人员核对窒息征象和呼吸功能条件。');
    }
  }
  if (input.assessmentType === 'disability' && input.treatmentStatus !== 'stable' && status !== 'preliminary') {
    const timingMaterial = '确认原发损伤及相关并发症已治疗终结或临床效果稳定，并提供相应记录。';
    if (!missingMaterials.some(item => /治疗终结|临床效果稳定/.test(item))) missingMaterials.push(timingMaterial);
    if (!warnings.some(item => item.includes('第4.2条'))) {
      warnings.push('鉴定时机尚未确认原发损伤及相关并发症治疗终结或临床效果稳定；依据该标准第4.2条，暂不输出伤残等级。');
    }
  }
  for (const list of [warnings, nextSteps, missingMaterials]) {
    for (let index = list.length - 1; index >= 0; index -= 1) {
      if (unsupportedFractureAdvice(list[index]) || unsupportedJawFunctionAdvice(list[index])
        || unsupportedHeadFaceWoundAdvice(list[index])) list.splice(index, 1);
    }
  }
  const hasRibFacts = facts.some(fact => fact.field === 'injury_type' && fact.value === 'rib_fracture');
  const hasOnlySourceBackedRibFacts = facts.length > 0 && facts.every(fact =>
    ['injury_type', 'anatomical_site', 'laterality', 'fractured_rib_numbers', 'fractured_rib_count', 'fracture_site_count'].includes(fact.field)
      && /肋骨/.test(fact.evidence));
  const hasRibReferences = references.some(reference => /肋骨骨折/.test(reference.text));
  if (input.assessmentType === 'injury' && status === 'insufficient' && !requiresReview && hasRibFacts && hasRibReferences) {
    const stableReferences = deterministicRibReferences(context.clauses, facts, standard.sourceUrl);
    if (stableReferences.length) references.splice(0, references.length,
      ...(hasOnlySourceBackedRibFacts ? [] : references.filter(reference => !/肋骨骨折/.test(reference.text))),
      ...stableReferences);
  }
  references.splice(0, references.length, ...deduplicateClauseReferences(references));
  references.sort((a, b) => Number(!a.grade) - Number(!b.grade) || a.id.localeCompare(b.id, 'en'));
  for (const reference of references) {
    if (reference.conditionLogic?.annotation !== 'explicit') {
      reference.conditions.sort((a, b) => a.condition.localeCompare(b.condition, 'zh-CN'));
    }
  }
  if (recognizedText) warnings.push('图片识别内容可能存在遗漏或误读，请核对原报告后使用。');
  if (hasUnresolvedHandDigitSeparation(sourceText, input.assessmentType, references)) {
    warnings.push('材料描述了手指离断或仅有皮肤、软组织相连，但系统未能可靠归一每指的离断状态和关节平面；请人工对照原始影像与手术记录核验，系统不会据此自动满足手指离断条件。');
  }
  for (const list of [nextSteps, warnings, missingMaterials]) {
    for (let index = list.length - 1; index >= 0; index -= 1) {
      if (mentionsOnlyOffSiteHandOrFoot(list[index])) list.splice(index, 1);
    }
  }
  const supportedClauseIds = new Set(references.filter(reference => reference.relation === 'supports'
    && reference.grade && reference.grade === grade).map(reference => reference.id));
  const unsupportedFreeTextConclusion = text => {
    if (/身份标识|身份资料|身份证(?:号)?|个人身份信息|个人身份资料|(?:受检者|被鉴定人|患者|受伤人|受伤者|伤者)(?:姓名|身份信息|身份标识)/u.test(text)) return true;
    if (/未映射|不在本次官方原文依据/u.test(text)) return false;
    const citedClauses = text.match(/[456]\.\d+\.\d+(?:\.[a-z]|\.\d+|[a-z])?\b/giu) || [];
    if (citedClauses.some(id => !supportedClauseIds.has(id.toLowerCase()))) return true;
    const claimedGrades = text.match(/轻微伤|轻伤[一二三]级|重伤[一二三]级|[一二三四五六七八九十]+级伤残/gu) || [];
    if (grade) return claimedGrades.some(claim => claim !== grade);
    return claimedGrades.length > 0
      && !/(?:未|不能|无法|暂无法|不应|未能|不支持).{0,24}(?:满足|认定|定级|匹配|评估|成立|适用|结论)/u.test(text);
  };
  for (const list of [nextSteps, warnings, missingMaterials]) {
    for (let index = list.length - 1; index >= 0; index -= 1) {
      if (unsupportedFreeTextConclusion(list[index])) list.splice(index, 1);
    }
  }
  for (let index = missingMaterials.length - 1; index >= 0; index -= 1) {
    if (contradictedAdvice(missingMaterials[index]) || unsupportedFractureAdvice(missingMaterials[index])
      || unsupportedJawFunctionAdvice(missingMaterials[index])
      || unsupportedMechanismScopeClaim(missingMaterials[index])) missingMaterials.splice(index, 1);
  }
  const stableSummary = status === 'needs_review'
    ? '材料中存在需要复核的冲突或不确定事实，暂不输出等级。'
    : status === 'insufficient' ? '现有材料不足以形成可靠的等级评估。'
      : status === 'preliminary' && supportedReference
        ? `可回查事实与本地条款 ${supportedReference.id} 的条件初步相符，辅助评估为${supportedReference.grade}。`
        : generated.summary;
  const stableReasoning = status === 'needs_review'
    ? `事实分析识别到以下复核事项：${conflicts.map(item => item.reason).sort().join('；') || '关键事实仍待核实'}。在复核完成前不输出等级。`
    : status === 'insufficient'
      ? `当前资料不足以完成可靠评估。${missingMaterials.length ? `需补充或核实：${missingMaterials.join('；')}。` : '请补充与适用条款相关的客观材料。'}`
      : status === 'preliminary' && supportedReference
        ? `经来源核验的材料事实与本地条款 ${supportedReference.id}（${supportedReference.text}）列出的适用条件相符。此结果仅为辅助评估，仍需专业人员结合完整材料复核。`
        : generated.reasoning;
  const serializedFacts = allFacts.map(fact => fact.eventId && /^U[1-9]\d{0,2}$/u.test(fact.eventId)
    ? { ...fact, eventId: null } : fact);
  return resultSchema.parse({
    ...generated, schemaVersion: 2, assessmentType: input.assessmentType, status, grade,
    nextSteps,
    summary: stableSummary,
    reasoning: status === 'insufficient' || status !== generated.status || unknownInlineCitation || requiresReview || status === 'preliminary' && Boolean(supportedReference)
      ? stableReasoning : generated.reasoning,
    facts: serializedFacts, factAudit: context.factAudit || [], conflicts, requiresReview, references,
    warnings: [...new Set(warnings)].slice(-20), missingMaterials: [...new Set(missingMaterials)].slice(-20),
    ...(context.analysisSnapshot ? { analysisSnapshot: context.analysisSnapshot } : {}),
    standard, recognizedText, createdAt: new Date().toISOString(), requestId: context.requestId, model: context.model,
  });
}

export function legacyResponse(result) {
  return { grade: result.grade || (result.status === 'not_applicable' ? '不适用当前标准' : '需补充材料'),
    summary: result.summary, logic: result.reasoning, matches: result.references.map(reference => `${reference.id} ${reference.text}`),
    explanation: [...result.warnings, ...result.missingMaterials].join('\n') };
}
