import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogs, retrieveClauses } from '../gemini/lib/catalog.js';
import { normalizeResult } from '../gemini/lib/results.js';
import { requestSchema, resultSchema } from '../gemini/lib/contracts.js';
import { inputs, providerFixture, resultFixture } from './fixtures.js';
import { readHistory, saveHistory } from '../client/history.js';
import { reportText } from '../client/report.js';

function normalize(raw, type = 'injury', override = {}) {
  const input = { ...inputs[type], ...override };
  const clauses = retrieveClauses(type, input.description);
  const evidence = raw.facts?.[0]?.evidence || '';
  const extractedFacts = type === 'injury' && /肋骨骨折/.test(evidence)
    ? [
      { id: 'F1', field: 'injury_type', value: 'rib_fracture', certainty: 'reported', source: 'description', evidence, finding: evidence },
      ...(evidence.match(/(\d+)\s*处/) ? [{ id: 'F2', field: 'fracture_site_count', value: Number(evidence.match(/(\d+)\s*处/)[1]),
        certainty: 'reported', source: 'description', evidence, finding: evidence }] : []),
    ] : [];
  return normalizeResult(raw, input, { clauses, requestId: 'case-test', model: 'test-model', extractedFacts,
    conflicts: [], requiresReview: false, factMissingMaterials: [] });
}

const logicFact = ({ id, field = 'diagnosis', value, certainty = 'reported', evidence = '报告记载甲损伤', source = 'description', verification = 'quoted', eventId = 'E1' }) => ({
  id, field, value, certainty, evidence, source, verification, eventId,
});

const explicitCondition = ({ sourceText = '甲损伤', field = 'diagnosis', values = ['甲'], predicate } = {}) => ({
  op: 'condition', sourceText, conditionText: sourceText,
  ...(predicate ? { predicate } : { factMatch: { field, values } }),
});

test('official catalogs retain complete grading clauses and distinguish partial spleen removal', () => {
  assert.equal(catalogs.injury.clauses.length, 390);
  assert.equal(catalogs.disability.clauses.length, 457);
  const byId = Object.fromEntries(catalogs.disability.clauses.map(item => [item.id, item]));
  assert.equal(byId['5.9.4.2'].grade, '九级伤残');
  assert.equal(byId['5.9.4.2'].text, '脾部分切除术后；');
  assert.equal(byId['5.8.4.2'].text, '成年人脾切除术后；');
  assert.match(byId['5.10.3.7'].text, /肋骨骨折6根以上/);
  assert.ok(catalogs.disability.principles.some(item => item.id === '6.12' && item.text.includes('包含本数')));
});

test('condition logic uses three-valued all/any evaluation and exact source-backed field values', async () => {
  const { evaluateConditionLogic } = await import('../gemini/lib/results.js');
  assert.equal(typeof evaluateConditionLogic, 'function');

  const a = explicitCondition({ sourceText: '甲损伤', values: ['甲'] });
  const b = explicitCondition({ sourceText: '乙损伤', field: 'injury_type', values: ['乙'] });
  const facts = [
    logicFact({ id: 'F1', value: '甲', evidence: '报告记载甲损伤' }),
    logicFact({ id: 'F2', field: 'injury_type', value: '乙', evidence: '报告记载乙损伤' }),
  ];
  const unknown = { ...logicFact({ id: 'F3', value: '丙', evidence: '报告记载丙损伤' }), certainty: 'unknown' };
  const excludedA = logicFact({ id: 'F4', value: '甲', certainty: 'excluded', evidence: '报告未见甲损伤' });
  const evalNode = (logic, evidenceFacts) => evaluateConditionLogic({ annotation: 'explicit', logic }, evidenceFacts);

  assert.equal(evalNode({ op: 'all', children: [a, b] }, facts).met, true);
  assert.equal(evalNode({ op: 'all', children: [a, b] }, [facts[0], unknown]).met, null);
  assert.equal(evalNode({ op: 'all', children: [a, b] }, [excludedA, facts[1]]).met, false);
  assert.equal(evalNode({ op: 'any', children: [a, b] }, [facts[0], unknown]).met, true);
  assert.equal(evalNode({ op: 'any', children: [a, b] }, [excludedA, unknown]).met, null);
  assert.equal(evalNode({ op: 'any', children: [a, b] }, [excludedA, { ...facts[1], certainty: 'excluded' }]).met, false);
  assert.deepEqual(evalNode({ op: 'any', children: [a, b] }, facts).factIds, ['F1', 'F2']);
});

test('condition logic rejects quote-only, wrong-field, wrong-value, and opaque support', async () => {
  const { evaluateConditionLogic } = await import('../gemini/lib/results.js');
  const condition = explicitCondition({ sourceText: '甲损伤', field: 'injury_type', values: ['rib_fracture'] });
  const evalLogic = (annotation, facts) => evaluateConditionLogic({ annotation, logic: condition }, facts);

  assert.equal(evalLogic('explicit', [logicFact({ id: 'F1', value: 'rib_fracture', evidence: '报告记载甲损伤' })]).met, null);
  assert.equal(evalLogic('explicit', [logicFact({ id: 'F2', field: 'injury_type', value: 'fracture', evidence: '报告记载甲损伤' })]).met, null);
  assert.equal(evalLogic('explicit', [{ ...logicFact({ id: 'F3', field: 'injury_type', value: 'rib_fracture', evidence: '报告记载甲损伤' }), source: 'image', verification: 'image_pending' }]).met, null);
  assert.equal(evalLogic('opaque', [logicFact({ id: 'F4', field: 'injury_type', value: 'rib_fracture', evidence: '甲损伤' })]).met, null);
});

test('condition logic applies numeric predicates only to typed source-backed counts', async () => {
  const { evaluateConditionLogic } = await import('../gemini/lib/results.js');
  const logic = { op: 'condition', sourceText: '骨折处数2处以上', conditionText: '骨折处数2处以上',
    predicate: { field: 'fracture_site_count', operator: 'gte', value: 2, unit: '处' } };
  const evaluate = facts => evaluateConditionLogic({ annotation: 'explicit', logic }, facts);
  const count = (id, value) => logicFact({ id, field: 'fracture_site_count', value, evidence: `报告记载骨折处数${value}处` });

  assert.equal(evaluate([count('F1', 2)]).met, true);
  assert.equal(evaluate([count('F2', 1)]).met, false);
  assert.equal(evaluate([]).met, null);
  assert.equal(evaluate([{ ...count('F3', 2), certainty: 'uncertain' }]).met, null);
});

test('quoted partial splenectomy supports the explicit ninth-grade clause', () => {
  const clause = catalogs.disability.clauses.find(item => item.id === '5.9.4.2');
  const evidence = '成年人因本次事故接受脾部分切除术';
  const input = { ...inputs.disability, description: evidence };
  const fact = { id: 'F1', field: 'treatment', value: '脾部分切除术', certainty: 'reported',
    source: 'description', evidence, finding: '治疗情况：脾部分切除术', verification: 'quoted' };
  const raw = { ...providerFixture('disability'), status: 'preliminary', grade: clause.grade, facts: [],
    references: [{ clauseId: clause.id, evidence,
      reasoning: '', relation: 'supports', conditions: [{ condition: '脾部分切除术后', evidence,
        factIds: ['F1'], met: false }] }] };
  const result = normalizeResult(raw, input, { clauses: [clause], requestId: 'splenectomy-explicit-clause-test', model: 'test-model',
    extractedFacts: [fact], conflicts: [], requiresReview: false, factMissingMaterials: [] });

  assert.equal(result.status, 'preliminary');
  assert.equal(result.grade, '九级伤残');
  assert.equal(result.references[0].relation, 'supports');
  assert.equal(result.references[0].conditions[0].met, true);
});

test('mixed OR and AND metadata materializes required groups and does not trust model met values', () => {
  const clause = catalogs.injury.clauses.find(item => item.id === '5.1.2.c');
  const quotes = ['颅骨凹陷性骨折', '出现脑受压症状和体征', '须手术治疗'];
  const input = { ...inputs.injury, description: `${quotes.join('，')}。` };
  const facts = [
    { id: 'F1', field: 'injury_type', value: 'skull_depressed_fracture', certainty: 'reported', source: 'description', evidence: quotes[0], finding: quotes[0], verification: 'quoted', eventId: 'E1' },
    { id: 'F2', field: 'diagnosis', value: quotes[1], certainty: 'reported', source: 'description', evidence: quotes[1], finding: quotes[1], verification: 'quoted', eventId: 'E1' },
    { id: 'F3', field: 'treatment', value: quotes[2], certainty: 'reported', source: 'description', evidence: quotes[2], finding: quotes[2], verification: 'quoted', eventId: 'E1' },
  ];
  const raw = { ...providerFixture(), grade: clause.grade, facts: [], references: [{ clauseId: clause.id,
    evidence: input.description, reasoning: '', relation: 'supports', conditions: [{ condition: clause.text.replace(/[；;。]$/, ''),
      evidence: input.description, factIds: facts.map(fact => fact.id), met: false }] }] };
  const normalizeWith = extractedFacts => normalizeResult(raw, input, { clauses: [clause], requestId: 'mixed-logic-groups-test',
    model: 'test-model', extractedFacts, conflicts: [], requiresReview: false, factMissingMaterials: [] });

  const complete = normalizeWith(facts);
  assert.equal(complete.status, 'preliminary');
  assert.equal(complete.grade, clause.grade);
  assert.deepEqual(complete.references[0].conditions.map(condition => condition.met), [true, true, true]);

  const missingTreatment = normalizeWith(facts.slice(0, 2));
  assert.equal(missingTreatment.status, 'insufficient');
  assert.equal(missingTreatment.grade, null);
  assert.deepEqual(missingTreatment.references[0].conditions.map(condition => condition.met), [true, true, null]);
});

test('an AND clause cannot combine source facts from different or unknown injury episodes', () => {
  const clause = catalogs.injury.clauses.find(item => item.id === '5.1.2.c');
  const description = '2021年事故记载颅骨凹陷性骨折。2025年事故出现脑受压症状和体征，并须手术治疗。';
  const quotes = ['2021年事故记载颅骨凹陷性骨折', '出现脑受压症状和体征', '须手术治疗'];
  const facts = quotes.map((evidence, index) => ({ id: `F${index + 1}`,
    field: ['injury_type', 'diagnosis', 'treatment'][index],
    value: ['skull_depressed_fracture', '出现脑受压症状和体征', '须手术治疗'][index],
    certainty: 'reported', source: 'description', evidence, finding: evidence, verification: 'quoted',
    eventId: index === 0 ? 'E1' : 'E2' }));
  const raw = { ...providerFixture(), grade: clause.grade, facts: [], references: [{ clauseId: clause.id,
    evidence: description, reasoning: '', relation: 'supports', conditions: [{ condition: clause.text,
      evidence: description, factIds: ['F1', 'F2', 'F3'], met: true }] }] };
  const normalizeEvents = eventFacts => normalizeResult(raw, { ...inputs.injury, description }, { clauses: [clause],
    requestId: 'episode-scope-test', model: 'test-model', extractedFacts: eventFacts, conflicts: [],
    requiresReview: false, factMissingMaterials: [] });

  const separateEpisodes = normalizeEvents(facts);
  assert.equal(separateEpisodes.status, 'insufficient');
  assert.equal(separateEpisodes.grade, null);

  const unknownEpisode = normalizeEvents(facts.map(fact => fact.id === 'F3' ? { ...fact, eventId: undefined } : { ...fact, eventId: 'E1' }));
  assert.equal(unknownEpisode.status, 'insufficient');
  assert.equal(unknownEpisode.grade, null);

  const sameEpisode = normalizeEvents(facts.map(fact => ({ ...fact, eventId: 'E1' })));
  assert.equal(sameEpisode.status, 'preliminary');
  assert.equal(sameEpisode.grade, clause.grade);
});

test('an excluded OR branch and an unreported branch remain unknown in final normalization', () => {
  const clause = catalogs.injury.clauses.find(item => item.id === '5.1.3.c');
  const quote = 'CT未见颅骨凹陷性骨折';
  const input = { ...inputs.injury, description: `${quote}。` };
  const fact = { id: 'F1', field: 'injury_type', value: 'skull_depressed_fracture', certainty: 'excluded',
    source: 'description', evidence: quote, finding: quote, verification: 'quoted' };
  const raw = { ...providerFixture(), grade: clause.grade, facts: [], references: [{ clauseId: clause.id,
    evidence: quote, reasoning: '', relation: 'incomplete', conditions: [{ condition: '颅骨凹陷性骨折',
      evidence: quote, factIds: ['F1'], met: false }] }] };
  const result = normalizeResult(raw, input, { clauses: [clause], requestId: 'or-final-unknown', model: 'test-model',
    extractedFacts: [fact], conflicts: [], requiresReview: false, factMissingMaterials: [] });

  assert.equal(result.status, 'insufficient');
  assert.equal(result.references[0].conditions[0].met, null);
});

test('an omitted required group and a fabricated group cannot be rescued by model booleans', () => {
  const clause = catalogs.injury.clauses.find(item => item.id === '5.1.2.c');
  const quote = '报告明确记载颅骨凹陷性骨折';
  const input = { ...inputs.injury, description: `${quote}。` };
  const fact = { id: 'F1', field: 'injury_type', value: 'skull_depressed_fracture', certainty: 'reported',
    source: 'description', evidence: quote, finding: quote, verification: 'quoted' };
  const raw = { ...providerFixture(), grade: clause.grade, facts: [], references: [{ clauseId: clause.id,
    evidence: quote, reasoning: '', relation: 'supports', conditions: [{ condition: '颅骨凹陷性骨折',
      evidence: quote, factIds: ['F1'], met: true }] }] };
  const result = normalizeResult(raw, input, { clauses: [clause], requestId: 'missing-required-group', model: 'test-model',
    extractedFacts: [fact], conflicts: [], requiresReview: false, factMissingMaterials: [] });
  assert.equal(result.status, 'insufficient');
  assert.deepEqual(result.references[0].conditions.map(condition => condition.met), [true, null, null]);

  raw.references[0].conditions[0].condition = '模型虚构的组';
  const fabricated = normalizeResult(raw, input, { clauses: [clause], requestId: 'fabricated-condition-group', model: 'test-model',
    extractedFacts: [fact], conflicts: [], requiresReview: false, factMissingMaterials: [] });
  assert.equal(fabricated.status, 'insufficient');
  assert.equal(fabricated.grade, null);
  assert.ok(fabricated.warnings.some(warning => warning.includes('未映射')));
});

test('valid results use official text rather than model-invented clause wording', () => {
  for (const type of ['injury', 'disability']) {
    const result = resultFixture(type);
    assert.equal(result.status, 'preliminary');
    assert.ok(resultSchema.safeParse(result).success);
    assert.equal(result.references[0].text, catalogs[type].clauses.find(item => item.id === result.references[0].id).text);
  }
});

test('opaque clauses stay unknown even when the model paraphrases the summary evidence', () => {
  const raw = providerFixture('disability');
  raw.references[0].evidence = '已接受部分脾脏切除';
  const result = normalize(raw, 'disability');
  assert.equal(result.status, 'insufficient');
  assert.equal(result.grade, null);
  assert.equal(result.references[0].conditions[0].met, null);
  raw.references[0].conditions[0].evidence = '已接受部分脾脏切除';
  assert.equal(normalize(raw, 'disability').grade, null);
});

test('invented clause IDs remove the grade and definitive model reasoning', () => {
  const raw = providerFixture(); raw.references[0].clauseId = '5.999.999'; raw.reasoning = '确定是轻伤二级。';
  const result = normalize(raw);
  assert.equal(result.grade, null); assert.equal(result.status, 'insufficient');
  assert.ok(result.references.every(reference => reference.id !== '5.999.999'));
  assert.doesNotMatch(result.reasoning, /确定是轻伤二级/);
});

test('different grading systems cannot share the same grade by accident', () => {
  const raw = providerFixture('disability'); raw.grade = '轻伤二级';
  assert.equal(normalize(raw, 'disability').grade, null);
});

test('official principles are valid background references but cannot by themselves support a grade', () => {
  const raw = providerFixture();
  raw.facts = [];
  raw.references = [{ ...raw.references[0], clauseId: '4.1.1' }];
  const result = normalize(raw);
  assert.equal(result.grade, null);
  assert.equal(result.references[0].category, '总则与附则');
  assert.equal(result.references[0].grade, '');
});

test('unsupported inline grading citations are not allowed to override a valid structured reference', () => {
  const raw = providerFixture(); raw.reasoning = '确定适用5.999.999，因此构成轻伤二级。';
  const result = normalize(raw);
  assert.equal(result.grade, null); assert.doesNotMatch(result.reasoning, /5.999.999/);
});

test('facts and condition evidence not present in the submitted material cannot support a grade', () => {
  const raw = providerFixture(); raw.facts[0].evidence = '左侧12根肋骨骨折';
  raw.references[0].conditions[0].evidence = '左侧12根肋骨骨折';
  const result = normalize(raw);
  assert.equal(result.status, 'insufficient'); assert.equal(result.facts.length, 0);
  assert.equal(result.references[0].conditions[0].met, null); assert.equal(result.grade, null);
  assert.equal(result.references[0].conditions[0].evidence, '');
});

test('an absent counterexample cannot be displayed as a confirmed negative condition', () => {
  const raw = providerFixture(); raw.facts = [];
  raw.references[0].conditions[0] = { condition: '未满足条件', evidence: '', met: false };
  const result = normalize(raw);
  assert.equal(result.references[0].conditions[0].met, null); assert.equal(result.grade, null);
});

test('an unrelated verified fact cannot satisfy an atomic official clause condition', () => {
  const clause = catalogs.injury.clauses.find(item => item.id === '5.1.1.a');
  const quote = '影像报告明确记载左侧肋骨骨折';
  const input = { ...inputs.injury, description: `${quote}。` };
  const fact = { id: 'F1', field: 'injury_type', value: 'rib_fracture', certainty: 'reported',
    source: 'description', evidence: quote, finding: '肋骨骨折', verification: 'quoted' };
  const raw = { ...providerFixture(), grade: clause.grade, facts: [], references: [{ clauseId: clause.id,
    evidence: quote, reasoning: '', relation: 'supports', conditions: [{ condition: clause.text.replace(/[；;。]$/, ''),
      evidence: quote, factIds: ['F1'], met: true }] }] };
  const result = normalizeResult(raw, input, { clauses: [clause], requestId: 'unrelated-atomic-fact-test', model: 'test-model',
    extractedFacts: [fact], conflicts: [], requiresReview: false, factMissingMaterials: [] });

  assert.equal(result.status, 'insufficient');
  assert.equal(result.grade, null);
  assert.equal(result.references[0].conditions[0].met, null);
});

test('an unrelated excluded fact cannot mark an atomic official clause condition false', () => {
  const clause = catalogs.injury.clauses.find(item => item.id === '5.1.1.a');
  const quote = '影像报告未见左侧肋骨骨折';
  const input = { ...inputs.injury, description: `${quote}。` };
  const fact = { id: 'F1', field: 'injury_type', value: 'rib_fracture', certainty: 'excluded',
    source: 'description', evidence: quote, finding: '未见肋骨骨折', verification: 'quoted' };
  const raw = { ...providerFixture(), status: 'insufficient', grade: null, facts: [], references: [{ clauseId: clause.id,
    evidence: quote, reasoning: '', relation: 'incomplete', conditions: [{ condition: clause.text.replace(/[；;。]$/, ''),
      evidence: quote, factIds: ['F1'], met: false }] }] };
  const result = normalizeResult(raw, input, { clauses: [clause], requestId: 'unrelated-excluded-fact-test', model: 'test-model',
    extractedFacts: [fact], conflicts: [], requiresReview: false, factMissingMaterials: [] });

  assert.equal(result.references[0].conditions[0].met, null);
});

test('an explicitly cited fracture-site count below threshold cannot retain a model true value', () => {
  const clause = catalogs.injury.clauses.find(item => item.id === '5.6.4.b');
  const quote = 'CT报告明确记载左侧第六肋骨骨折，共1处骨折';
  const input = { ...inputs.injury, description: `${quote}。` };
  const raw = { ...providerFixture(), grade: clause.grade, facts: [{ finding: quote, source: 'description', evidence: quote }],
    references: [{ clauseId: clause.id, evidence: quote, reasoning: '', relation: 'supports', conditions: [{
      condition: clause.text.replace(/[；;。]$/, ''), evidence: quote, met: true,
    }] }] };
  const result = normalizeResult(raw, input, { clauses: [clause], requestId: 'explicit-low-site-count-test', model: 'test-model',
    extractedFacts: [
      { id: 'F1', field: 'injury_type', value: 'rib_fracture', certainty: 'reported', source: 'description', evidence: quote },
      { id: 'F2', field: 'fracture_site_count', value: 1, certainty: 'reported', source: 'description', evidence: quote },
    ], conflicts: [], requiresReview: false, factMissingMaterials: [] });

  assert.equal(result.status, 'insufficient');
  assert.equal(result.grade, null);
  assert.equal(result.references[0].conditions.find(condition => condition.condition.includes('处数')).met, false);
});

test('historical rib facts cannot satisfy a current fracture-site grading threshold', () => {
  const quote = '既往史：第六肋骨骨折2处。';
  const clause = catalogs.injury.clauses.find(item => item.id === '5.6.4.b');
  const fact = { id: 'F1', field: 'prior_injury', value: 'rib_fracture', certainty: 'reported',
    source: 'description', evidence: quote, finding: '既往损伤：肋骨骨折', verification: 'quoted' };
  const raw = { ...providerFixture(), grade: clause.grade, facts: [], references: [{
    clauseId: clause.id, evidence: quote, reasoning: '', relation: 'supports', conditions: [{
      condition: clause.text.replace(/[；;。]$/, ''), evidence: quote, factIds: ['F1'], met: true,
    }],
  }] };
  const input = { ...inputs.injury, description: quote };
  const result = normalizeResult(raw, input, { clauses: [clause], requestId: 'historical-threshold-test', model: 'test-model',
    extractedFacts: [fact], conflicts: [], requiresReview: false, factMissingMaterials: [] });

  assert.equal(result.status, 'insufficient');
  assert.equal(result.grade, null);
  assert.equal(result.references[0].conditions[0].met, null);
  assert.deepEqual(result.references[0].conditions[0].factIds, []);
});

test('one supported alternative satisfies a simple official OR clause', () => {
  const clause = catalogs.injury.clauses.find(item => item.id === '5.1.3.c');
  const negativeQuote = 'CT未见颅骨凹陷性骨折';
  const positiveQuote = 'CT明确记载颅骨粉碎性骨折';
  const input = { ...inputs.injury, description: `${negativeQuote}，${positiveQuote}。` };
  const facts = [
    { id: 'F1', field: 'injury_type', value: 'skull_depressed_fracture', certainty: 'excluded', source: 'description',
      evidence: negativeQuote, finding: '凹陷性骨折未见', verification: 'quoted' },
    { id: 'F2', field: 'injury_type', value: 'skull_comminuted_fracture', certainty: 'reported', source: 'description',
      evidence: positiveQuote, finding: '粉碎性骨折', verification: 'quoted' },
  ];
  const raw = { ...providerFixture(), grade: clause.grade, facts: [], references: [{ clauseId: clause.id,
    evidence: positiveQuote, reasoning: '', relation: 'supports', conditions: [
      { condition: '颅骨凹陷性骨折', evidence: negativeQuote, factIds: ['F1'], met: false },
      { condition: '粉碎性骨折', evidence: positiveQuote, factIds: ['F2'], met: true },
    ] }] };
  const result = normalizeResult(raw, input, { clauses: [clause], requestId: 'simple-or-test', model: 'test-model',
    extractedFacts: facts, conflicts: [], requiresReview: false, factMissingMaterials: [] });

  assert.equal(result.status, 'preliminary');
  assert.equal(result.grade, clause.grade);
  assert.ok(result.references[0].conditions.some(condition => condition.met === true));
});

test('a source-backed branch cannot promote an unannotated semicolon-separated injury clause', () => {
  const clause = catalogs.injury.clauses.find(item => item.id === '5.1.3.e');
  const negativeQuote = 'CT未见颅内出血';
  const positiveQuote = 'CT明确记载慢性颅内血肿';
  const input = { ...inputs.injury, description: `${negativeQuote}，${positiveQuote}。` };
  const facts = [
    { id: 'F1', field: 'diagnosis', value: 'intracranial_hemorrhage', certainty: 'excluded', source: 'description',
      evidence: negativeQuote, finding: '颅内出血未见', verification: 'quoted' },
    { id: 'F2', field: 'diagnosis', value: 'chronic_intracranial_hematoma', certainty: 'reported', source: 'description',
      evidence: positiveQuote, finding: '慢性颅内血肿', verification: 'quoted' },
  ];
  const raw = { ...providerFixture(), grade: clause.grade, facts: [], references: [{ clauseId: clause.id,
    evidence: positiveQuote, reasoning: '', relation: 'supports', conditions: [
      { condition: '颅内出血', evidence: negativeQuote, factIds: ['F1'], met: false },
      { condition: '慢性颅内血肿', evidence: positiveQuote, factIds: ['F2'], met: true },
    ] }] };
  const result = normalizeResult(raw, input, { clauses: [clause], requestId: 'semicolon-list-or-test', model: 'test-model',
    extractedFacts: facts, conflicts: [], requiresReview: false, factMissingMaterials: [] });

  assert.equal(result.status, 'insufficient');
  assert.equal(result.grade, null);
  assert.equal(result.references[0].conditions[0].met, null);
});

test('a source-backed branch cannot promote an unannotated semicolon-listed clause', () => {
  const clause = catalogs.injury.clauses.find(item => item.id === '5.1.5.b');
  const negativeQuote = 'CT未见头皮擦伤面积5.0cm2以上';
  const positiveQuote = '诊断记载头皮挫伤';
  const input = { ...inputs.injury, description: `${negativeQuote}，${positiveQuote}。` };
  const facts = [
    { id: 'F1', field: 'injury_type', value: 'scalp_abrasion', certainty: 'excluded', source: 'description',
      evidence: negativeQuote, finding: '头皮擦伤排除', verification: 'quoted' },
    { id: 'F2', field: 'injury_type', value: 'scalp_contusion', certainty: 'reported', source: 'description',
      evidence: positiveQuote, finding: '头皮挫伤', verification: 'quoted' },
  ];
  const raw = { ...providerFixture(), grade: clause.grade, facts: [], references: [{ clauseId: clause.id,
    evidence: positiveQuote, reasoning: '', relation: 'supports', conditions: [
      { condition: '头皮擦伤面积5.0cm2以上', evidence: negativeQuote, factIds: ['F1'], met: false },
      { condition: '头皮挫伤', evidence: positiveQuote, factIds: ['F2'], met: true },
    ] }] };
  const result = normalizeResult(raw, input, { clauses: [clause], requestId: 'semicolon-or-test', model: 'test-model',
    extractedFacts: facts, conflicts: [], requiresReview: false, factMissingMaterials: [] });

  assert.equal(result.status, 'insufficient');
  assert.equal(result.grade, null);
  assert.equal(result.references[0].conditions[0].met, null);
});

test('one excluded semicolon branch remains unknown while the other branches are unreported', () => {
  const clause = catalogs.injury.clauses.find(item => item.id === '5.1.3.e');
  const quote = 'CT未见颅内出血';
  const input = { ...inputs.injury, description: `${quote}。` };
  const fact = { id: 'F1', field: 'diagnosis', value: 'intracranial_hemorrhage', certainty: 'excluded',
    source: 'description', evidence: quote, finding: '颅内出血未见', verification: 'quoted' };
  const raw = { ...providerFixture(), grade: clause.grade, facts: [], references: [{ clauseId: clause.id,
    evidence: quote, reasoning: '', relation: 'incomplete', conditions: [{ condition: '颅内出血', evidence: quote,
      factIds: ['F1'], met: false }] }] };
  const result = normalizeResult(raw, input, { clauses: [clause], requestId: 'semicolon-or-unknown-test', model: 'test-model',
    extractedFacts: [fact], conflicts: [], requiresReview: false, factMissingMaterials: [] });

  assert.equal(result.status, 'insufficient');
  assert.equal(result.references[0].conditions[0].met, null);
  assert.equal(result.references[0].relation, 'incomplete');
});

test('one excluded branch does not mark an OR clause false while another branch is unknown', () => {
  const clause = catalogs.injury.clauses.find(item => item.id === '5.1.3.c');
  const quote = 'CT未见颅骨凹陷性骨折';
  const input = { ...inputs.injury, description: `${quote}。` };
  const fact = { id: 'F1', field: 'injury_type', value: 'skull_depressed_fracture', certainty: 'excluded',
    source: 'description', evidence: quote, finding: '凹陷性骨折未见', verification: 'quoted' };
  const raw = { ...providerFixture(), grade: clause.grade, facts: [], references: [{ clauseId: clause.id,
    evidence: quote, reasoning: '', relation: 'incomplete', conditions: [{ condition: '颅骨凹陷性骨折',
      evidence: quote, factIds: ['F1'], met: false }] }] };
  const result = normalizeResult(raw, input, { clauses: [clause], requestId: 'or-unknown-test', model: 'test-model',
    extractedFacts: [fact], conflicts: [], requiresReview: false, factMissingMaterials: [] });

  assert.equal(result.status, 'insufficient');
  assert.equal(result.references[0].conditions[0].met, null);
  assert.equal(result.references[0].relation, 'incomplete');
});

test('an OR clause is false only when every alternative has a linked exclusion', () => {
  const clause = catalogs.injury.clauses.find(item => item.id === '5.1.3.c');
  const quotes = ['CT未见颅骨凹陷性骨折', 'CT未见颅骨粉碎性骨折'];
  const input = { ...inputs.injury, description: `${quotes.join('，')}。` };
  const facts = quotes.map((evidence, index) => ({ id: `F${index + 1}`, field: 'injury_type',
    value: index === 0 ? 'skull_depressed_fracture' : 'skull_comminuted_fracture', certainty: 'excluded',
    source: 'description', evidence, finding: '骨折未见', verification: 'quoted', eventId: 'E1' }));
  const raw = { ...providerFixture(), grade: clause.grade, facts: [], references: [{ clauseId: clause.id,
    evidence: input.description, reasoning: '', relation: 'incomplete', conditions: [
      { condition: '颅骨凹陷性骨折', evidence: quotes[0], factIds: ['F1'], met: false },
      { condition: '粉碎性骨折', evidence: quotes[1], factIds: ['F2'], met: false },
    ] }] };
  const result = normalizeResult(raw, input, { clauses: [clause], requestId: 'or-all-excluded-test', model: 'test-model',
    extractedFacts: facts, conflicts: [], requiresReview: false, factMissingMaterials: [] });

  assert.equal(result.status, 'insufficient');
  assert.equal(result.references[0].conditions.length, 1);
  assert.equal(result.references[0].conditions[0].met, false);
  assert.equal(result.references[0].relation, 'incomplete');
});

test('an unsupported additional clause condition cannot pass on one matching quote', () => {
  const clause = catalogs.injury.clauses.find(item => item.id === '5.1.2.c');
  const quote = 'CT明确记载颅骨凹陷性骨折';
  const input = { ...inputs.injury, description: `${quote}。` };
  const fact = { id: 'F1', field: 'injury_type', value: 'skull_depressed_fracture', certainty: 'reported',
    source: 'description', evidence: quote, finding: '颅骨凹陷性骨折', verification: 'quoted' };
  const raw = { ...providerFixture(), grade: clause.grade, facts: [], references: [{ clauseId: clause.id,
    evidence: quote, reasoning: '', relation: 'supports', conditions: [{ condition: clause.text.replace(/[；;。]$/, ''),
      evidence: quote, factIds: ['F1'], met: true }] }] };
  const result = normalizeResult(raw, input, { clauses: [clause], requestId: 'additional-condition-test', model: 'test-model',
    extractedFacts: [fact], conflicts: [], requiresReview: false, factMissingMaterials: [] });

  assert.equal(result.status, 'insufficient');
  assert.equal(result.grade, null);
  assert.ok(result.references[0].conditions.slice(1).some(condition => condition.met === null));
});

test('a source quote with an unmatched field value cannot satisfy explicit AND clauses', () => {
  const clause = catalogs.injury.clauses.find(item => item.id === '5.1.2.c');
  const quote = clause.text.replace(/[；;。]$/, '');
  const input = { ...inputs.injury, description: `${quote}。` };
  const fact = { id: 'F1', field: 'injury_type', value: 'skull_fracture', certainty: 'reported',
    source: 'description', evidence: quote, finding: quote, verification: 'quoted' };
  const raw = { ...providerFixture(), grade: clause.grade, facts: [], references: [{ clauseId: clause.id,
    evidence: quote, reasoning: '', relation: 'supports', conditions: [{ condition: quote, evidence: quote,
      factIds: ['F1'], met: true }] }] };
  const result = normalizeResult(raw, input, { clauses: [clause], requestId: 'complete-and-test', model: 'test-model',
    extractedFacts: [fact], conflicts: [], requiresReview: false, factMissingMaterials: [] });

  assert.equal(result.status, 'insufficient');
  assert.equal(result.grade, null);
  assert.ok(result.references[0].conditions.every(condition => condition.met === null));
});

test('separate source-backed facts can jointly satisfy every part of a mixed OR and AND clause', () => {
  const clause = catalogs.injury.clauses.find(item => item.id === '5.1.2.c');
  const quotes = ['颅骨凹陷性骨折', '出现脑受压症状和体征', '须手术治疗'];
  const input = { ...inputs.injury, description: `${quotes.join('，')}。` };
  const facts = quotes.map((evidence, index) => ({ id: `F${index + 1}`,
    field: ['injury_type', 'diagnosis', 'treatment'][index], value: index === 0 ? 'skull_depressed_fracture' : evidence,
    certainty: 'reported', source: 'description', evidence, finding: evidence, verification: 'quoted', eventId: 'E1' }));
  const condition = clause.text;
  const raw = { ...providerFixture(), grade: clause.grade, facts: [], references: [{ clauseId: clause.id,
    evidence: quotes[0], reasoning: '', relation: 'supports', conditions: [{ condition, evidence: quotes[0],
      factIds: facts.map(fact => fact.id), met: true }] }] };
  const result = normalizeResult(raw, input, { clauses: [clause], requestId: 'mixed-or-and-test', model: 'test-model',
    extractedFacts: facts, conflicts: [], requiresReview: false, factMissingMaterials: [] });

  assert.equal(result.status, 'preliminary');
  assert.equal(result.grade, clause.grade);
  assert.equal(result.references[0].conditions[0].met, true);
});

test('ongoing treatment and opaque disability clauses never produce a grade', () => {
  const ongoing = normalize(providerFixture('disability'), 'disability', { treatmentStatus: 'ongoing' });
  assert.equal(ongoing.grade, null);
  assert.ok(ongoing.missingMaterials.some(item => item.includes('治疗终结') || item.includes('稳定')));
});

test('bad arrays are rejected instead of crashing a result view', () => {
  assert.throws(() => normalize({ ...providerFixture(), references: 'not-an-array' }));
  assert.throws(() => normalize({ ...providerFixture(), facts: null }));
});

test('empty input, false image formats and future dates do not pass request validation', () => {
  assert.equal(requestSchema.safeParse({ assessmentType: 'injury' }).success, false);
  assert.equal(requestSchema.safeParse({ ...inputs.injury, images: [{ mimeType: 'image/svg+xml', data: 'eA==' }] }).success, false);
  assert.equal(requestSchema.safeParse({ ...inputs.injury, injuryDate: '2099-01-01' }).success, false);
});

test('damaged history and unavailable storage remain recoverable', () => {
  assert.deepEqual(readHistory('injury', { getItem: () => '{invalid' }), []);
  assert.deepEqual(readHistory('injury', { getItem: () => '{"items":[]}' }), []);
  assert.deepEqual(readHistory('injury', { getItem: () => { throw new Error('denied'); } }), []);
  assert.throws(() => saveHistory('injury', { id: 'id', title: 'title', result: resultFixture() }, {
    getItem: () => '[]', setItem: () => { throw new Error('quota'); },
  }), /记录未保存/);
});

test('history is explicit, deduplicated, bounded and excludes results from the other assessment type', () => {
  let value = '[]';
  const storage = { getItem: () => value, setItem: (key, raw) => { value = raw; } };
  for (let i = 0; i < 55; i++) saveHistory('injury', { id: String(i), title: 'title', result: resultFixture() }, storage);
  assert.equal(readHistory('injury', storage).length, 50);
  saveHistory('injury', { id: '54', title: 'latest', result: resultFixture() }, storage);
  assert.equal(readHistory('injury', storage).length, 50);
  assert.deepEqual(readHistory('disability', storage), []);
});

test('exported report preserves insufficiency, missing materials and official provenance', () => {
  const result = resultFixture('injury', { status: 'insufficient', grade: null, references: [], missingMaterials: ['补充CT报告'] });
  const text = reportText(result);
  assert.match(text, /暂不输出等级/); assert.match(text, /补充CT报告/); assert.match(text, /2013年公布版/);
  assert.match(text, /不是正式司法鉴定意见/);
});

test('exported reports retain conflict status, source facts, and review references', () => {
  const result = resultFixture('injury');
  Object.assign(result, { status: 'needs_review', grade: null, requiresReview: true,
    conflicts: [{ factIds: ['F1', 'F2'], reason: '骨折记载互相矛盾，需复核。' }],
    facts: [
      { id: 'F1', field: 'injury_type', value: 'rib_fracture', certainty: 'conflicted', assertedCertainty: 'uncertain', source: 'image', evidence: '报告甲疑似骨折', sourceRefs: [
        { source: 'image', sourceId: 'image-1', evidence: '报告甲疑似骨折' },
        { source: 'image', sourceId: 'image-2', evidence: '报告甲疑似骨折' },
      ], finding: '损伤类型：骨折', verification: 'quoted' },
      { id: 'F2', field: 'injury_type', value: 'rib_fracture', certainty: 'conflicted', assertedCertainty: 'excluded', source: 'description', evidence: '报告乙未见骨折', finding: '损伤类型：骨折', verification: 'quoted' },
    ] });
  const text = reportText(result);
  assert.match(text, /需复核/); assert.match(text, /骨折记载互相矛盾/);
  assert.match(text, /报告甲疑似骨折/); assert.match(text, /存在冲突/);
  assert.match(text, /图片1/); assert.match(text, /图片2/);
});
