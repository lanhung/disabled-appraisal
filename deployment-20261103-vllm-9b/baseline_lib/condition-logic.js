import { conditionFactFields } from './condition-fields.js';
import { normalizeForMatching } from './text-normalization.js';
import { reliableCertainties } from './fact-certainty.js';
import { explicitInjuryEventDateKeys, normalizeInjuryDateValue } from './event-date-logic.js';

export function uniqueEvidenceText(values) {
  const seen = new Set();
  const unique = [];
  for (const value of values) {
    for (const evidence of String(value || '').split('；').map(item => item.trim()).filter(Boolean)) {
      if (seen.has(evidence)) continue;
      seen.add(evidence);
      unique.push(evidence);
    }
  }
  return unique.join('；');
}

function combineLogicResults(op, results, eventId, allowSharedFact, reconcileGroup, collectDetails) {
  const states = results.map(result => result.met);
  const sharedFactIds = results.map(result => new Set(result.factIds || []))
    .reduce((shared, ids, index) => index === 0 ? ids : new Set([...shared].filter(id => ids.has(id))), new Set());
  const sharedQuotedEvidence = results.map(result => new Set(String(result.evidence || '').split('；')
    .map(normalizeForMatching).filter(Boolean)))
    .reduce((shared, evidence, index) => index === 0 ? evidence
      : new Set([...shared].filter(quote => evidence.has(quote))), new Set());
  let met = op === 'all'
    ? states.includes(false) ? false : states.every(state => state === true) ? true : null
    : states.includes(true) ? true : states.every(state => state === false) ? false : null;
  const reconciled = reconcileGroup?.(op, results, met);
  if (typeof reconciled === 'boolean' || reconciled === null) met = reconciled;
  if (eventId === null && op === 'all' && met === true && (!allowSharedFact || sharedFactIds.size === 0)
    && sharedQuotedEvidence.size === 0) met = null;
  const decisive = op === 'all' && met === false ? results.filter(result => result.met === false)
    : op === 'any' && met === true ? results.filter(result => result.met === true)
      : results;
  return { met, evidence: uniqueEvidenceText(decisive.map(result => result.evidence)),
    factIds: [...new Set(decisive.flatMap(result => result.factIds || []))], eventId,
    ...(collectDetails?.(decisive) || {}) };
}

export function factDateKeys(fact) {
  const text = [fact.value, fact.evidence].flatMap(value => Array.isArray(value) ? value : [value])
    .filter(Boolean).join(' ').normalize('NFKC');
  return [...text.matchAll(/(?:19|20)\d{2}(?:年\s*\d{1,2}月\s*\d{1,2}日|[-/.]\s*\d{1,2}[-/.]\s*\d{1,2})/gu)]
    .map(([date]) => {
      const [year, month, day] = date.match(/\d+/gu).map(Number);
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    });
}

function explicitInjuryDateKeys(fact) {
  const dates = new Set(explicitInjuryEventDateKeys(fact.evidence || ''));
  if (fact.field === 'injury_date') {
    const value = normalizeInjuryDateValue(fact.value);
    if (typeof value === 'string' && /^(?:19|20)\d{2}-\d{2}-\d{2}$/u.test(value)) dates.add(value);
  }
  return [...dates];
}

export function evaluateConditionTree(conditionLogic, facts, evaluateLeaf, { reconcileGroup, collectDetails } = {}) {
  if (conditionLogic?.annotation !== 'explicit' || !conditionLogic.logic || !Array.isArray(facts)
    || typeof evaluateLeaf !== 'function') return { met: null, evidence: '', factIds: [] };
  const ageAdjustmentEnabled = ['injury_standard_6_18', 'disability_standard_6_11']
    .includes(conditionLogic.ageAdjustment);
  const evaluate = (node, scopedFacts, eventId) => {
    if (node.op === 'condition') return evaluateLeaf(node, scopedFacts, eventId, ageAdjustmentEnabled);
    if (node.op === 'not') {
      if (node.confirmedBy) {
        const confirmed = evaluateLeaf({ op: 'condition', sourceText: node.sourceText,
          conditionText: node.conditionText, factMatch: node.confirmedBy }, scopedFacts);
        if (confirmed.met === true) return confirmed;
      }
      const result = evaluate(node.children[0], scopedFacts, eventId);
      return { ...result, met: result.met === true ? false : result.met === false ? true : null };
    }
    if (node.op === 'all' || node.op === 'any') {
      return combineLogicResults(node.op, node.children.map(child => evaluate(child, scopedFacts, eventId)),
        eventId, node.allowSharedFact === true, reconcileGroup, collectDetails);
    }
    return { met: null, evidence: '', factIds: [] };
  };
  const eventIds = [...new Set(facts.map(fact => fact.eventId).filter(Boolean))].sort();
  const unscopedFacts = facts.filter(fact => !fact.eventId);
  const eventIdsByDate = new Map();
  const hasQuotedSource = fact => fact.source === 'description' && fact.verification === 'quoted'
    && reliableCertainties.has(fact.certainty);
  for (const fact of facts.filter(item => item.eventId && hasQuotedSource(item))) {
    for (const date of factDateKeys(fact)) {
      const owners = eventIdsByDate.get(date) || new Set();
      owners.add(fact.eventId);
      eventIdsByDate.set(date, owners);
    }
  }
  const linkedUnscopedFacts = new Map(eventIds.map(eventId => [eventId, []]));
  const linkedFacts = new Set();
  for (const fact of unscopedFacts.filter(hasQuotedSource)) {
    const owners = new Set();
    let ambiguousDate = false;
    for (const date of explicitInjuryDateKeys(fact)) {
      const matchingEvents = eventIdsByDate.get(date);
      if (!matchingEvents) continue;
      if (matchingEvents.size !== 1) ambiguousDate = true;
      else owners.add([...matchingEvents][0]);
    }
    if (!ambiguousDate && owners.size === 1) {
      const [eventId] = owners;
      linkedUnscopedFacts.get(eventId)?.push(fact);
      linkedFacts.add(fact);
    }
  }
  const remainingUnscopedFacts = unscopedFacts.filter(fact => !linkedFacts.has(fact));
  const scopes = [...eventIds.map(eventId => ({ eventId, facts: facts.filter(fact => fact.eventId === eventId) }))];
  const conditionFields = new Set();
  const collectFields = node => {
    if (node.op === 'condition') {
      for (const field of conditionFactFields(node.factMatch, node.predicate)) conditionFields.add(field);
    }
    if (node.confirmedBy) {
      for (const field of conditionFactFields(node.confirmedBy)) conditionFields.add(field);
    }
    for (const child of node.children || []) collectFields(child);
  };
  collectFields(conditionLogic.logic);
  const supportingFactIds = new Set(facts.filter(fact => conditionFields.has(fact.field))
    .flatMap(fact => fact.derivedFrom || []));
  const relevantUnscopedFacts = unscopedFacts.filter(fact => conditionFields.has(fact.field)
    || supportingFactIds.has(fact.id));
  for (const scope of scopes) scope.facts.push(...(linkedUnscopedFacts.get(scope.eventId) || [])
    .filter(fact => conditionFields.has(fact.field) || supportingFactIds.has(fact.id)));
  const remainingRelevantFacts = relevantUnscopedFacts.filter(fact => remainingUnscopedFacts.includes(fact));
  if (eventIds.length === 0) scopes.push({ eventId: null, facts: remainingRelevantFacts });
  const results = scopes.map(scope => evaluate(conditionLogic.logic, scope.facts, scope.eventId));
  return results.find(result => result.met === true)
    || results.every(result => result.met === false) && results[0]
    || { met: null, evidence: '', factIds: [] };
}
