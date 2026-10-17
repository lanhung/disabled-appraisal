import { providerResultSchema, resultSchema } from './contracts.js';
import { catalogs } from './catalog.js';
import { canonicalMissingMaterials, parseNumber, sourceReferenceMatches } from './facts.js';

const grades = {
  injury: ['重伤一级', '重伤二级', '轻伤一级', '轻伤二级', '轻微伤'],
  disability: ['一级伤残', '二级伤残', '三级伤残', '四级伤残', '五级伤残', '六级伤残', '七级伤残', '八级伤残', '九级伤残', '十级伤残'],
};
const normalize = value => value.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
export const includesEvidence = (source, quote) => Boolean(quote?.trim()) && normalize(source).includes(normalize(quote));

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

const reliableCertainties = new Set(['reported', 'observed', 'derived']);
const sameValue = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function predicateEvidenceValue(predicate, fact) {
  if (!Number.isFinite(fact.value)) return null;
  const number = '(\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百]+)';
  const unit = predicate.unit ? predicate.unit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
  const match = fact.evidence.match(new RegExp(`${number}\\s*${unit}`));
  if (!match) return null;
  const sourceValue = parseNumber(match[1]);
  return Number.isFinite(sourceValue) && sourceValue === fact.value ? sourceValue : null;
}

function comparePredicate(predicate, value) {
  if (predicate.operator === 'eq') return value === predicate.value;
  if (predicate.operator === 'gt') return value > predicate.value;
  if (predicate.operator === 'gte') return value >= predicate.value;
  if (predicate.operator === 'lt') return value < predicate.value;
  if (predicate.operator === 'lte') return value <= predicate.value;
  return null;
}

function evaluateConditionLeaf(node, facts) {
  const candidates = facts.filter(fact => fact.field === (node.factMatch?.field || node.predicate?.field)
    && fact.source === 'description' && fact.verification === 'quoted');
  const relevant = candidates.filter(fact => {
    if (node.factMatch) {
      const valueMatches = node.factMatch.values.some(value => sameValue(value, fact.value));
      const exactEvidence = includesEvidence(fact.evidence, node.sourceText);
      const ribFractureEvidence = node.factMatch.field === 'injury_type'
        && node.factMatch.values.includes('rib_fracture') && normalize(node.sourceText) === normalize('肋骨骨折')
        && /肋骨/.test(fact.evidence) && /骨折/.test(fact.evidence);
      return valueMatches && (exactEvidence || ribFractureEvidence);
    }
    return predicateEvidenceValue(node.predicate, fact) !== null;
  });
  const positive = relevant.filter(fact => reliableCertainties.has(fact.certainty));
  const excluded = relevant.filter(fact => fact.certainty === 'excluded');
  const uncertain = relevant.some(fact => ['uncertain', 'unknown', 'conflicted'].includes(fact.certainty));
  if (positive.length && excluded.length || uncertain) return { met: null, evidence: '', factIds: [] };
  if (node.predicate && positive.length) {
    const states = positive.map(fact => comparePredicate(node.predicate, predicateEvidenceValue(node.predicate, fact)));
    if (states.some(state => state === null) || new Set(states).size > 1) return { met: null, evidence: '', factIds: [] };
    return { met: states[0], evidence: positive.map(fact => fact.evidence).join('；'), factIds: positive.map(fact => fact.id) };
  }
  if (positive.length) return { met: true, evidence: positive.map(fact => fact.evidence).join('；'), factIds: positive.map(fact => fact.id) };
  if (excluded.length) return { met: false, evidence: excluded.map(fact => fact.evidence).join('；'), factIds: excluded.map(fact => fact.id) };
  return { met: null, evidence: '', factIds: [] };
}

function combineLogicResults(op, results, eventId = null) {
  const states = results.map(result => result.met);
  let met = op === 'all'
    ? states.includes(false) ? false : states.every(state => state === true) ? true : null
    : states.includes(true) ? true : states.every(state => state === false) ? false : null;
  if (eventId === null && op === 'all' && met === true) met = null;
  const decisive = op === 'all' && met === false ? results.filter(result => result.met === false)
    : op === 'any' && met === true ? results.filter(result => result.met === true)
      : results;
  return { met, evidence: decisive.map(result => result.evidence).filter(Boolean).join('；'),
    factIds: [...new Set(decisive.flatMap(result => result.factIds))], eventId };
}

export function evaluateConditionLogic(conditionLogic, facts) {
  if (conditionLogic?.annotation !== 'explicit' || !conditionLogic.logic || !Array.isArray(facts)) {
    return { met: null, evidence: '', factIds: [] };
  }
  const evaluate = (node, scopedFacts, eventId) => {
    if (node.op === 'condition') return evaluateConditionLeaf(node, scopedFacts);
    if (node.op === 'all' || node.op === 'any') {
      return combineLogicResults(node.op, node.children.map(child => evaluate(child, scopedFacts, eventId)), eventId);
    }
    return { met: null, evidence: '', factIds: [] };
  };
  const eventIds = [...new Set(facts.map(fact => fact.eventId).filter(Boolean))].sort();
  const unscopedFacts = facts.filter(fact => !fact.eventId);
  const scopes = [...eventIds.map(eventId => ({ eventId, facts: facts.filter(fact => fact.eventId === eventId) }))];
  const conditionFields = new Set();
  const collectFields = node => {
    if (node.op === 'condition') conditionFields.add(node.factMatch?.field || node.predicate?.field);
    else for (const child of node.children || []) collectFields(child);
  };
  collectFields(conditionLogic.logic);
  const relevantUnscopedFacts = unscopedFacts.filter(fact => conditionFields.has(fact.field));
  if (relevantUnscopedFacts.length || scopes.length === 0) scopes.push({ eventId: null, facts: relevantUnscopedFacts });
  const results = scopes.map(scope => evaluate(conditionLogic.logic, scope.facts, scope.eventId));
  return results.find(result => result.met === true)
    || results.every(result => result.met === false) && results[0]
    || { met: null, evidence: '', factIds: [] };
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

function evaluateLogicNode(node, facts) {
  return evaluateConditionLogic({ annotation: 'explicit', logic: node }, facts);
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
    const result = evaluateLogicNode(group, groupFacts);
    return result;
  });
  const rootFacts = [...new Map(bindings.flat().flatMap(entry => entry.linkedFacts).map(fact => [fact.id, fact])).values()];
  const root = evaluateConditionLogic(clause.conditionLogic, rootFacts);
  const allGroupsBound = bindings.every(entries => entries.length > 0);
  const met = allGroupsBound && !invalid ? root.met : null;
  const displayGroups = groups.length <= 12 ? groups : [logic];
  const displayResults = groups.length <= 12 ? groupResults : [met === null ? { met: null, evidence: '', factIds: [] } : root];
  return {
    invalid,
    met,
    evidence: root.evidence,
    factIds: root.factIds,
    conditions: displayGroups.map((group, index) => ({ condition: logicGroupText(group),
      evidence: displayResults[index].evidence, factIds: displayResults[index].factIds, met: displayResults[index].met })),
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

export function normalizeResult(raw, input, context) {
  const generated = providerResultSchema.parse(raw);
  const { standard } = catalogs[input.assessmentType];
  const allowedClauses = new Map(context.clauses.map(clause => [clause.id, clause]));
  const principles = new Map(catalogs[input.assessmentType].principles.map(item => [item.id,
    { ...item, grade: '', category: '总则与附则' }]));
  const recognizedText = context.recognizedText || '';
  const sourceText = `${input.description}\n${recognizedText}`;
  const allowedIds = new Set([...allowedClauses.keys()].flatMap(id => [id, id.split('.').slice(0, 3).join('.')])
    .concat(catalogs[input.assessmentType].principles.map(item => item.id)));
  const inlineIds = generated.reasoning.normalize('NFKC').match(/[456]\.\d+\.\d+(?:\.[a-z]|\.\d+|[a-z])?\b/g) || [];
  const unknownInlineCitation = inlineIds.some(id => !allowedIds.has(id) && !allowedIds.has(id.replace(/(\d)([a-z])$/, '$1.$2')));
  const warnings = [...generated.warnings, ...(context.extractionWarnings || [])];
  const conflicts = Array.isArray(context.conflicts) ? context.conflicts : [];
  const requiresReview = context.requiresReview === true || conflicts.length > 0;
  const hasValidatedFacts = Array.isArray(context.extractedFacts);
  const missingMaterials = canonicalMissingMaterials([
    ...(hasValidatedFacts ? [] : generated.missingMaterials),
    ...(Array.isArray(context.factMissingMaterials) ? context.factMissingMaterials : []),
  ]);
  const facts = [];
  const sourceFacts = Array.isArray(context.extractedFacts) ? context.extractedFacts : generated.facts.map((fact, index) => ({
    id: `F${index + 1}`, field: 'other', value: fact.finding, certainty: 'reported',
    source: fact.source, evidence: fact.evidence, finding: fact.finding,
  }));
  for (const fact of sourceFacts) {
    const source = fact.source === 'image' ? recognizedText : input.description;
    if (!includesEvidence(source, fact.evidence)) {
      warnings.push('部分事实无法在提交材料中回查，已移除，不能作为等级依据。');
      continue;
    }
    const sourceRefs = Array.isArray(fact.sourceRefs)
      ? fact.sourceRefs.filter(reference => sourceReferenceMatches(reference, { description: input.description, recognizedText }))
      : undefined;
    if (Array.isArray(fact.sourceRefs) && !sourceRefs.length) {
      warnings.push('事实来源无法对应到原始文本或图片页，已移除，不能作为等级依据。');
      continue;
    }
    if (sourceRefs && sourceRefs.length !== fact.sourceRefs.length) warnings.push('部分事实来源无法对应到原始页面，已移除无效来源链接。');
    facts.push({ ...fact, ...(sourceRefs ? { sourceRefs } : {}), finding: fact.finding || `${fact.field}：${Array.isArray(fact.value) ? fact.value.join('、') : String(fact.value ?? '')}`,
      verification: fact.source === 'image' ? 'image_pending' : 'quoted' });
  }
  let invalidReference = unknownInlineCitation;
  let invalidRibConditionMapping = false;
  if (unknownInlineCitation) warnings.push('部分自由文本引用不在本次原文依据中，已不采纳其结论。');
  const references = [];
  for (const proposed of generated.references) {
    const clause = allowedClauses.get(proposed.clauseId) || principles.get(proposed.clauseId);
    if (!clause) {
      invalidReference = true;
      warnings.push(`条款 ${proposed.clauseId} 不在本次官方原文依据中，已移除。`);
      continue;
    }
    if (clause.grade && clause.conditionLogic?.annotation === 'opaque') {
      references.push({ ...clause, sourceUrl: standard.sourceUrl,
        evidence: includesEvidence(sourceText, proposed.evidence) ? proposed.evidence : '',
        reasoning: '本条款的条件逻辑尚未完成安全标注，状态保持未知，不用于当前定级。', relation: 'incomplete',
        conditions: [{ condition: clause.text, evidence: '', factIds: [], met: null }] });
      continue;
    }
    if (clause.grade && clause.conditionLogic?.annotation === 'explicit') {
      const bound = bindExplicitGroups(clause, proposed.conditions, facts);
      if (bound.invalid) {
        if (/肋骨骨折/.test(clause.text)) invalidRibConditionMapping = true;
        else {
          invalidReference = true;
          warnings.push(`条款 ${clause.id} 的条件组存在重复或未映射文本，未用于等级判断。`);
        }
      }
      const confirmed = bound.met === true;
      references.push({ ...clause, sourceUrl: standard.sourceUrl,
        evidence: includesEvidence(sourceText, proposed.evidence) ? proposed.evidence : bound.evidence,
        reasoning: confirmed ? '来源可回查事实满足本地条款的显式逻辑条件。' : '材料原文尚不能完整支持本条逻辑条件，需补充或核对。',
        relation: proposed.relation === 'differential' ? 'differential' : confirmed ? 'supports' : 'incomplete',
        conditions: bound.conditions });
      continue;
    }
    const conditions = proposed.conditions.map(condition => {
      const canonicalCondition = officialCondition(condition.condition, clause.text);
      if (!canonicalCondition && clause.grade) {
        invalidReference = true;
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
    const aggregateTraceable = includesEvidence(sourceText, proposed.evidence);
    const confirmed = conditionsSatisfyClause(conditions, clause.text);
    if (!aggregateTraceable && proposed.relation === 'supports' && confirmed) {
      warnings.push('部分条款汇总引用未能逐字回查，已用逐项核对的材料原文替代。');
    }
    const relation = proposed.relation === 'differential' ? 'differential' : confirmed ? 'supports' : 'incomplete';
    references.push({ ...clause, sourceUrl: standard.sourceUrl, evidence: aggregateTraceable ? proposed.evidence : conditions.find(condition => condition.evidence)?.evidence || '',
      reasoning: confirmed ? '可回查事实与本地条文列出的适用条件相符。'
        : '材料原文尚不能完整支持本条条件，需补充或核对，不用于当前定级。',
      relation, conditions });
  }
  const hasReliableRibFact = facts.some(fact => fact.field === 'injury_type' && fact.value === 'rib_fracture'
    && ['reported', 'observed', 'derived'].includes(fact.certainty)
    && fact.source === 'description' && fact.verification === 'quoted');
  const stableRibReferences = !requiresReview && hasReliableRibFact
    ? deterministicRibReferences(context.clauses, facts, standard.sourceUrl) : [];
  if (invalidRibConditionMapping && !requiresReview && !stableRibReferences.length) {
    invalidReference = true;
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
  const supportedReference = references.find(reference => grades[input.assessmentType].includes(reference.grade)
    && (stableRibReferences.length > 0 || generated.grade == null || generated.grade === reference.grade)
    && reference.relation === 'supports' && reference.conditions.length > 0
    && (reference.conditionLogic?.annotation === 'explicit'
      ? evaluateConditionLogic(reference.conditionLogic, facts.filter(fact => reference.conditions.some(condition => condition.factIds?.includes(fact.id)))).met === true
      : conditionsSatisfyClause(reference.conditions, reference.text)));
  const explicitAlternativeStandard = /工伤|劳动能力鉴定|保险合同|保险条款/.test(input.description);
  if (!requiresReview && !supportedReference) {
    if (status === 'needs_review') status = 'insufficient';
    if (status === 'not_applicable' && !explicitAlternativeStandard) status = 'insufficient';
  }
  if (!requiresReview && !invalidReference && !blockingMissingMaterials && facts.length > 0 && supportedReference) {
    status = 'preliminary';
    grade = supportedReference.grade;
    for (let index = references.length - 1; index >= 0; index -= 1) {
      if (references[index].grade && (references[index].relation !== 'supports' || references[index].grade !== grade)) references.splice(index, 1);
    }
  } else if (status === 'preliminary') {
    if (!supportedReference || !grades[input.assessmentType].includes(grade) || invalidReference || blockingMissingMaterials) {
      status = 'insufficient';
      missingMaterials.push('补充能够支持所涉标准完整条件的材料，由专业人员核对后再评估。');
      warnings.push('当前材料或条款依据不足，未保留模型给出的等级。');
    }
  }
  if (input.assessmentType === 'disability' && input.treatmentStatus === 'ongoing' && status === 'preliminary') {
    status = 'insufficient';
    missingMaterials.push('原发损伤及相关并发症治疗终结或临床效果稳定后的复查与功能评定资料。');
    warnings.push('治疗尚未终结，依据该标准第4.2条，暂不输出伤残等级。');
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
  if (hasValidatedFacts) {
    if (status === 'needs_review') {
      missingMaterials.splice(0, missingMaterials.length,
        conflicts.length ? '核对冲突事实所涉及的原始资料。' : '核实关键事实的原始资料。');
    } else if (status === 'preliminary') {
      missingMaterials.length = 0;
    } else if (status === 'insufficient') {
      missingMaterials.splice(0, missingMaterials.length,
        ...canonicalMissingMaterials(context.factMissingMaterials || []));
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
      if (input.assessmentType === 'disability' && input.treatmentStatus === 'ongoing') {
        missingMaterials.push('原发损伤及相关并发症治疗终结或临床效果稳定后的复查与功能评定资料。');
      }
      if (missingMaterials.length === 0) missingMaterials.push('补充与适用条款相关的客观材料。');
    }
  }
  const hasRibFacts = facts.some(fact => fact.field === 'injury_type' && fact.value === 'rib_fracture');
  const hasOnlySourceBackedRibFacts = facts.length > 0 && facts.every(fact =>
    ['injury_type', 'anatomical_site', 'laterality', 'fractured_rib_numbers', 'fractured_rib_count', 'fracture_site_count'].includes(fact.field)
      && /肋骨/.test(fact.evidence));
  const hasRibReferences = references.some(reference => /肋骨骨折/.test(reference.text));
  if (status === 'insufficient' && !requiresReview && hasRibFacts && hasRibReferences) {
    const stableReferences = deterministicRibReferences(context.clauses, facts, standard.sourceUrl);
    if (stableReferences.length) references.splice(0, references.length,
      ...(hasOnlySourceBackedRibFacts ? [] : references.filter(reference => !/肋骨骨折/.test(reference.text))),
      ...stableReferences);
  }
  references.sort((a, b) => Number(!a.grade) - Number(!b.grade) || a.id.localeCompare(b.id, 'en'));
  for (const reference of references) {
    if (reference.conditionLogic?.annotation !== 'explicit') {
      reference.conditions.sort((a, b) => a.condition.localeCompare(b.condition, 'zh-CN'));
    }
  }
  if (recognizedText) warnings.push('图片识别内容可能存在遗漏或误读，请核对原报告后使用。');
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
  return resultSchema.parse({
    ...generated, schemaVersion: 2, assessmentType: input.assessmentType, status, grade,
    summary: stableSummary,
    reasoning: status !== generated.status || unknownInlineCitation || requiresReview || status === 'preliminary' && Boolean(supportedReference)
      ? stableReasoning : generated.reasoning,
    facts, conflicts, requiresReview, references, warnings: [...new Set(warnings)].slice(-20), missingMaterials: [...new Set(missingMaterials)].slice(-20),
    standard, recognizedText, createdAt: new Date().toISOString(), requestId: context.requestId, model: context.model,
  });
}

export function legacyResponse(result) {
  return { grade: result.grade || (result.status === 'not_applicable' ? '不适用当前标准' : '需补充材料'),
    summary: result.summary, logic: result.reasoning, matches: result.references.map(reference => `${reference.id} ${reference.text}`),
    explanation: [...result.warnings, ...result.missingMaterials].join('\n') };
}
