import test from 'node:test';
import assert from 'node:assert/strict';
import { assess } from '../gemini/lib/assessment.js';
import { normalizeResult } from '../gemini/lib/results.js';
import { catalogs, retrieveClauses } from '../gemini/lib/catalog.js';
import { normalizeExtractedFacts, normalizeRibFacts } from '../gemini/lib/facts.js';
import { FACT_EXTRACTION_PROMPT } from '../gemini/lib/prompts.js';
import { inputs, providerFixture } from './fixtures.js';

const conflictInput = {
  assessmentType: 'injury',
  description: '病历一记载疑似第六肋骨骨折；复查报告记载未见骨折。',
  images: [], injuryDate: '', treatmentStatus: 'unknown',
};
const rawConflictFacts = {
  facts: [
    { id: 'F1', field: 'sixth_rib_fracture', value: '疑似骨折', certainty: 'uncertain', source: 'description', evidence: '病历一记载疑似第六肋骨骨折' },
    { id: 'F2', field: 'sixth_rib_fracture', value: '未见骨折', certainty: 'excluded', source: 'description', evidence: '复查报告记载未见骨折' },
  ],
  missingMaterials: [],
  conflicts: [{ between: ['F1', 'F2'], description: '病历一疑似第六肋骨骨折，复查报告未见骨折' }],
  requiresReview: true,
};
const rawAliasConflictFacts = {
  facts: [
    { id: 'F1', field: 'rib_number', value: 6, certainty: 'reported', source_type: 'medical_record', source_excerpt: '疑似第六肋骨骨折' },
    { id: 'F2', field: 'rib_fracture', value: 'suspected', certainty: 'uncertain', source_type: 'medical_record', source_excerpt: '疑似第六肋骨骨折' },
    { id: 'F3', field: 'rib_fracture', value: 'excluded', certainty: 'excluded', source_type: 'medical_record', source_excerpt: '未见骨折' },
  ],
  missing_information: [],
  conflicts: [{ fact_ids: ['F2', 'F3'], description: 'F2与F3关于第六肋骨骨折状态的陈述冲突' }],
  requires_review: true,
};

function mockProvider(rawFacts) {
  const calls = [];
  return {
    calls,
    provider: { async complete(request) {
      calls.push(request);
      return request.name === 'fact_extraction' ? rawFacts : { ...providerFixture('injury'), facts: [] };
    } },
  };
}

test('fact extraction prompt separates conditional, historical, source, time and subject context', () => {
  assert.match(FACT_EXTRACTION_PROMPT, /若、如果、假如[\s\S]*certainty 使用 unknown/);
  assert.match(FACT_EXTRACTION_PROMPT, /既往[\s\S]*prior_injury[\s\S]*本次损伤/);
  assert.match(FACT_EXTRACTION_PROMPT, /不同时间、报告来源和陈述主体/);
  assert.match(FACT_EXTRACTION_PROMPT, /家属或他人/);
  assert.match(FACT_EXTRACTION_PROMPT, /限定词[\s\S]*不跨逗号、分号或句号传播/);
});

test('catalog attaches explicit condition logic and an always-unknown opaque fallback', () => {
  const ribThreshold = catalogs.injury.clauses.find(clause => clause.id === '5.6.4.b');
  const ambiguousQualifier = catalogs.injury.clauses.find(clause => clause.id === '5.2.2.a');

  assert.equal(ribThreshold.conditionLogic.annotation, 'explicit');
  assert.equal(ribThreshold.conditionLogic.logic.op, 'all');
  assert.deepEqual(ribThreshold.conditionLogic.logic.children[1].predicate, {
    field: 'fracture_site_count', operator: 'gte', value: 2, unit: '处',
  });
  assert.equal(ambiguousQualifier.conditionLogic.annotation, 'opaque');
  assert.equal(ambiguousQualifier.conditionLogic.logic.op, 'condition');
  assert.equal(catalogs.injury.clauses.find(clause => clause.id === '5.6.3.c').conditionLogic.annotation, 'explicit');
});

test('catalog logic loader rejects unknown IDs, invalid source spans and unmapped explicit leaves', async () => {
  const { applyClauseLogicMetadata } = await import('../gemini/lib/catalog.js');
  assert.equal(typeof applyClauseLogicMetadata, 'function');

  const rawCatalogs = {
    injury: { clauses: [{ id: '5.6.4.b', text: '肋骨骨折2处以上' }] },
    disability: { clauses: [] },
  };
  const logic = entry => ({ version: 1, clauses: { injury: { '5.6.4.b': entry } } });
  const valid = { annotation: 'explicit', logic: { op: 'condition', sourceText: '肋骨骨折2处以上',
    conditionText: '肋骨骨折2处以上', predicate: { field: 'fracture_site_count', operator: 'gte', value: 2, unit: '处' } } };

  assert.equal(applyClauseLogicMetadata(rawCatalogs, logic(valid)).injury.clauses[0].conditionLogic.annotation, 'explicit');
  assert.throws(() => applyClauseLogicMetadata(rawCatalogs, { version: 1,
    clauses: { injury: { 'missing.clause': valid } } }), /未知|条款|clause/i);
  assert.throws(() => applyClauseLogicMetadata(rawCatalogs, logic({ ...valid, logic: { ...valid.logic, sourceText: '无关片段' } })), /原文|source|条款/i);
  assert.throws(() => applyClauseLogicMetadata(rawCatalogs, logic({ ...valid, logic: { ...valid.logic, sourceText: '' } })), /原文|source|条款/i);
  assert.throws(() => applyClauseLogicMetadata(rawCatalogs, logic({ ...valid, logic: { op: 'condition',
    sourceText: '肋骨骨折2处以上', conditionText: '肋骨骨折2处以上' } })), /predicate|factMatch|映射|条件/i);
  const anyWithoutLabel = { annotation: 'explicit', logic: { op: 'any', children: [
    valid.logic,
    { op: 'condition', sourceText: '骨折', conditionText: '骨折',
      factMatch: { field: 'injury_type', values: ['fracture'] } },
  ] } };
  assert.throws(() => applyClauseLogicMetadata(rawCatalogs, logic(anyWithoutLabel)), /显示|文本|sourceText/i);
});

test('every catalog clause has a validated explicit tree or a full-text opaque fallback', () => {
  let explicitCount = 0;
  let opaqueCount = 0;
  for (const catalog of Object.values(catalogs)) for (const clause of catalog.clauses) {
    const annotation = clause.conditionLogic?.annotation;
    assert.ok(annotation === 'explicit' || annotation === 'opaque', `${clause.id} lacks an annotation`);
    if (annotation === 'opaque') {
      opaqueCount += 1;
      assert.equal(clause.conditionLogic.logic.sourceText, clause.text);
      continue;
    }
    explicitCount += 1;
    const inspect = node => {
      if (node.op === 'condition' || node.sourceText) assert.ok(node.sourceText && clause.text.includes(node.sourceText));
      if (node.op === 'all' || node.op === 'any') node.children.forEach(inspect);
      else assert.equal(Boolean(node.factMatch) + Boolean(node.predicate), 1);
    };
    inspect(clause.conditionLogic.logic);
  }
  assert.equal(explicitCount, 4);
  assert.equal(explicitCount + opaqueCount, 847);
});

test('assessment extracts facts first and gives the second stage only the normalized fact snapshot', async () => {
  const { provider, calls } = mockProvider(rawConflictFacts);
  await assess(conflictInput, { provider, config: { textModel: 'kimi-k2.6', visionModel: 'kimi-k2.6' }, requestId: 'two-stage-test' });
  assert.deepEqual(calls.map(call => call.name), ['fact_extraction', 'assessment_result']);
  const tagged = calls[1].messages[1].content.match(/<verified_facts>\s*([\s\S]*?)\s*<\/verified_facts>/);
  assert.ok(tagged);
  const assessmentInput = JSON.parse(tagged[1]);
  assert.ok(Array.isArray(assessmentInput.facts));
  assert.equal('description' in assessmentInput, false);
  assert.equal('recognizedText' in assessmentInput, false);
  assert.match(calls[1].messages[0].content, /conditionLogic/);
  assert.match(calls[1].messages[0].content, /"annotation":"opaque"/);
  assert.match(calls[1].messages[0].content, /"op":"all"/);
});

test('independent K2.6 field aliases normalize to identical source-backed facts and conflict state', async () => {
  const normalized = [];
  for (const rawFacts of [rawConflictFacts, rawAliasConflictFacts]) {
    const { provider } = mockProvider(rawFacts);
    normalized.push(await assess(conflictInput, { provider,
      config: { textModel: 'kimi-k2.6', visionModel: 'kimi-k2.6' }, requestId: 'alias-test' }));
  }
  const projectFacts = result => result.facts.map(({ field, value, certainty, source, evidence }) => ({ field, value, certainty, source, evidence }));
  assert.deepEqual(projectFacts(normalized[0]), projectFacts(normalized[1]));
  assert.equal(normalized[0].status, 'needs_review');
  assert.equal(normalized[1].status, 'needs_review');
  assert.equal(normalized[0].grade, null);
  assert.equal(normalized[1].grade, null);
  assert.equal(normalized[0].conflicts.length, 1);
  assert.equal(normalized[1].conflicts.length, 1);
});

test('observed pain-field aliases normalize to one source-backed symptom fact', () => {
  const description = '左侧胸部疼痛，未提供影像检查或明确诊断。';
  const variants = [
    { facts: [{ id: 'F1', field: 'left_chest_pain', value: true, certainty: 'reported', source: 'description', evidence: description }], missingMaterials: ['imaging_examination', 'definitive_diagnosis'], conflicts: [], requiresReview: false },
    { facts: [{ id: 'F1', field: 'subjective_complaint', value: '左侧胸部疼痛', certainty: 'reported', source: 'description', evidence: description }], missingMaterials: ['影像学检查', '明确诊断'], conflicts: [], requiresReview: false },
  ];
  const normalized = variants.map(value => normalizeExtractedFacts(value, { description }));
  assert.deepEqual(normalized[0].facts.map(({ field, value, certainty, evidence }) => ({ field, value, certainty, evidence })),
    normalized[1].facts.map(({ field, value, certainty, evidence }) => ({ field, value, certainty, evidence })));
  assert.deepEqual(normalized[0].missingMaterials, normalized[1].missingMaterials);
});

test('observed K2.6 imaging and diagnosis missing-material aliases normalize consistently', () => {
  const first = normalizeExtractedFacts({ facts: [], missingMaterials: ['影像检查', '诊断报告'], conflicts: [], requiresReview: false }, { description: '左侧胸部疼痛。' });
  const second = normalizeExtractedFacts({ facts: [], missingMaterials: ['影像学检查资料', '诊断资料'], conflicts: [], requiresReview: false }, { description: '左侧胸部疼痛。' });
  assert.deepEqual(first.missingMaterials, second.missingMaterials);
});

test('conflicted facts deterministically force needs_review and suppress any model grade', () => {
  const facts = [
    { id: 'F1', field: 'injury_type', value: 'rib_fracture', certainty: 'conflicted', source: 'description', evidence: '疑似第六肋骨骨折', finding: '肋骨骨折' },
    { id: 'F2', field: 'injury_type', value: 'rib_fracture', certainty: 'conflicted', source: 'description', evidence: '复查报告记载未见骨折', finding: '肋骨骨折' },
  ];
  const conflicts = [{ factIds: ['F1', 'F2'], reason: '同一损伤存在相互矛盾的来源记载，需复核。' }];
  const raw = { ...providerFixture('injury'), facts: [], status: 'preliminary', grade: '轻伤二级' };
  const result = normalizeResult(raw, conflictInput, {
    clauses: retrieveClauses('injury', conflictInput.description), requestId: 'conflict-status-test', model: 'kimi-k2.6',
    extractedFacts: facts, conflicts, requiresReview: true,
  });
  assert.equal(result.status, 'needs_review');
  assert.equal(result.grade, null);
  assert.deepEqual(result.facts.map(({ verification, ...fact }) => fact), facts);
  assert.deepEqual(result.conflicts, conflicts);
});

test('rib pain without a fracture statement does not create a rib-fracture fact', () => {
  assert.deepEqual(normalizeRibFacts('左侧肋骨区域疼痛，未提供影像检查。'), []);
});

test('a model rib-fracture fact cannot borrow evidence from a nasal fracture', () => {
  const description = '左侧第3肋骨区域疼痛伴鼻骨骨折';
  const claims = [
    { field: 'injury_type', value: 'rib_fracture' },
    { field: 'fractured_rib_count', value: 1 },
    { field: 'fractured_rib_numbers', value: [3] },
    { field: 'fracture_site_count', value: 2 },
    { field: 'diagnosis', value: '肋骨骨折' },
  ];
  for (const [index, claim] of claims.entries()) {
    const snapshot = normalizeExtractedFacts({ facts: [
      { id: `F${index + 1}`, ...claim, certainty: 'reported', source: 'description', evidence: description },
    ], missingMaterials: [], conflicts: [], requiresReview: false }, { description });
    assert.equal(snapshot.facts.some(fact => ['injury_type', 'fractured_rib_count', 'fractured_rib_numbers', 'fracture_site_count'].includes(fact.field)), false, claim.field);
    assert.equal(snapshot.facts.some(fact => fact.field === claim.field && JSON.stringify(fact.value) === JSON.stringify(claim.value)), false, claim.field);
    if (claim.field === 'fracture_site_count') assert.ok(snapshot.missingMaterials.some(item => /骨折处数/.test(item)));
    else assert.equal(snapshot.requiresReview, true, claim.field);
  }
});

test('a source-quoted sentence total still maps to the deterministic rib fracture-site count', () => {
  const description = '本次事故后左侧第3肋骨有1处骨折线，左侧第4肋骨有1处骨折线，共2处骨折。';
  const snapshot = normalizeExtractedFacts({ facts: [
    { id: 'F1', field: 'injury_type', value: 'rib_fracture', certainty: 'reported', source: 'description', evidence: '左侧第3肋骨有1处骨折线' },
    { id: 'F2', field: 'fracture_site_count', value: 2, certainty: 'reported', source: 'description', evidence: '共2处骨折' },
  ], missingMaterials: [], conflicts: [], requiresReview: false }, { description });
  assert.equal(snapshot.requiresReview, false);
  assert.equal(snapshot.facts.find(fact => fact.field === 'fracture_site_count')?.value, 2);
});

test('a model site-count value cannot override the number in its source quote', () => {
  const description = '左侧第3肋骨骨折，共2处骨折。';
  const snapshot = normalizeExtractedFacts({ facts: [
    { id: 'F1', field: 'fracture_site_count', value: 99, certainty: 'reported', source: 'description', evidence: '共2处骨折' },
  ], missingMaterials: [], conflicts: [], requiresReview: false }, { description });
  assert.equal(snapshot.facts.filter(fact => fact.field === 'fracture_site_count').length, 1);
  assert.equal(snapshot.facts.find(fact => fact.field === 'fracture_site_count')?.value, 2);
  assert.equal(snapshot.requiresReview, false);
});

test('a model count above the quoted fracture-site count cannot support a rib threshold', () => {
  const description = '左侧第3肋骨有1处骨折线，共1处骨折。';
  const input = { ...inputs.injury, description };
  const snapshot = normalizeExtractedFacts({ facts: [
    { id: 'F1', field: 'fracture_site_count', value: 99, certainty: 'reported', source: 'description', evidence: '共1处骨折' },
  ], missingMaterials: [], conflicts: [], requiresReview: false }, { description });
  const injury = snapshot.facts.find(fact => fact.field === 'injury_type');
  const siteCount = snapshot.facts.find(fact => fact.field === 'fracture_site_count');
  const clauses = retrieveClauses('injury', description);
  const raw = structuredClone(providerFixture('injury'));
  raw.grade = '轻伤二级';
  raw.references = [{ ...raw.references[0], clauseId: '5.6.4.b', evidence: description, relation: 'supports', conditions: [
    { condition: '肋骨骨折', evidence: '左侧第3肋骨有1处骨折线', met: true, factIds: [injury.id] },
    { condition: '骨折处数2处以上', evidence: '共1处骨折', met: true, factIds: [siteCount.id] },
  ] }];
  const result = normalizeResult(raw, input, { clauses, requestId: 'quoted-count-overrides-model-value', model: 'test-model',
    extractedFacts: snapshot.facts, conflicts: snapshot.conflicts, requiresReview: snapshot.requiresReview,
    factMissingMaterials: snapshot.missingMaterials });
  assert.equal(siteCount.value, 1);
  assert.equal(result.status, 'insufficient');
  assert.equal(result.grade, null);
});

test('a model laterality value cannot contradict the source-quoted rib side', () => {
  const description = '左侧第3肋骨骨折。';
  const snapshot = normalizeExtractedFacts({ facts: [
    { id: 'F1', field: 'laterality', value: 'right', certainty: 'reported', source: 'description', evidence: description },
  ], missingMaterials: [], conflicts: [], requiresReview: false }, { description });
  assert.deepEqual(snapshot.facts.filter(fact => fact.field === 'laterality').map(fact => fact.value), ['left']);
  assert.equal(snapshot.requiresReview, false);
});

test('two model rib counts cannot conflict when the source only gives rib ordinals and fracture sites', () => {
  const description = '2025年4月12日急诊CT报告明确记载:本次事故后左侧第3肋骨有1处骨折线,左侧第4肋骨有1处骨折线,共2处骨折';
  const snapshot = normalizeExtractedFacts({ facts: [
    { id: 'F1', field: 'fractured_rib_count', value: 1, certainty: 'reported', source: 'description', evidence: description },
    { id: 'F2', field: 'fractured_rib_count', value: 2, certainty: 'reported', source: 'description', evidence: description },
  ], missingMaterials: [], conflicts: [], requiresReview: false }, { description });
  assert.equal(snapshot.facts.some(fact => fact.field === 'fractured_rib_count'), false);
  assert.equal(snapshot.conflicts.length, 0);
  assert.equal(snapshot.requiresReview, false);
  assert.deepEqual(snapshot.facts.filter(fact => fact.field === 'fractured_rib_numbers')
    .map(fact => fact.value[0]).sort((a, b) => a - b), [3, 4]);
  assert.equal(snapshot.facts.find(fact => fact.field === 'fracture_site_count')?.value, 2);
});

test('a full source quote links the deterministic rib site count to its model event', () => {
  const description = '本次事故后左侧第3肋骨有1处骨折线，左侧第4肋骨有1处骨折线，共2处骨折。既往没有肋骨损伤';
  const snapshot = normalizeExtractedFacts({ facts: [
    { id: 'F1', field: 'injury_type', value: 'rib_fracture', certainty: 'reported', source: 'description',
      evidence: '本次事故后左侧第3肋骨有1处骨折线，左侧第4肋骨有1处骨折线，共2处骨折', eventId: 'E1' },
    { id: 'F2', field: 'fracture_site_count', value: 2, certainty: 'reported', source: 'description',
      evidence: description },
  ], missingMaterials: [], conflicts: [], requiresReview: false }, { description });
  const siteCounts = snapshot.facts.filter(fact => fact.field === 'fracture_site_count');
  assert.equal(siteCounts.length, 1);
  assert.equal(siteCounts[0].value, 2);
  assert.equal(siteCounts[0].eventId, 'E1');
  assert.equal(snapshot.requiresReview, false);
});

test('a full quote across different accidents cannot assign one accident site count to another', () => {
  const description = '2021年事故左侧第3肋骨骨折，共1处骨折。2025年事故右侧第4肋骨骨折，共2处骨折。';
  const snapshot = normalizeExtractedFacts({ facts: [
    { id: 'F1', field: 'fracture_site_count', value: 2, certainty: 'reported', source: 'description',
      evidence: description, eventId: 'E1' },
  ], missingMaterials: [], conflicts: [], requiresReview: false }, { description });
  assert.equal(snapshot.requiresReview, true);
  assert.equal(snapshot.facts.some(fact => fact.field === 'fracture_site_count' && fact.value === 2 && fact.eventId === 'E1'), false);
});

test('rib ordinals, rib count, and fracture-site count stay separate', () => {
  const facts = normalizeRibFacts('左侧第3、4肋骨骨折，共2处骨折');
  assert.deepEqual(facts.find(fact => fact.field === 'fractured_rib_numbers')?.value, [3, 4]);
  assert.equal(facts.find(fact => fact.field === 'fractured_rib_count')?.value, 2);
  assert.equal(facts.find(fact => fact.field === 'fracture_site_count')?.value, 2);
  const sixRibs = normalizeRibFacts('六根肋骨骨折');
  assert.equal(sixRibs.find(fact => fact.field === 'fractured_rib_count')?.value, 6);
  assert.equal(sixRibs.some(fact => fact.field === 'fractured_rib_numbers'), false);
});

test('fact IDs and canonical business fields stay stable across equivalent source wording', () => {
  const texts = ['左侧第3、4肋骨骨折', '左边第三根和第四根肋骨骨折'];
  const snapshots = texts.map(description => normalizeExtractedFacts({
    facts: [], missingMaterials: [], conflicts: [], requiresReview: false,
  }, { description }));
  const project = snapshot => snapshot.facts.map(({ id, field, value, certainty, source }) => ({ id, field, value, certainty, source }));
  assert.deepEqual(project(snapshots[0]), project(snapshots[1]));
});

test('different source counts are preserved as conflicted values instead of being selected or merged', () => {
  const normalized = normalizeExtractedFacts({
    facts: [
      { id: 'F1', field: 'fractured_rib_count', value: 6, certainty: 'reported', source: 'description', evidence: '报告甲记载肋骨骨折6根' },
      { id: 'F2', field: 'fractured_rib_count', value: 5, certainty: 'reported', source: 'description', evidence: '报告乙记载肋骨骨折5根' },
    ], missingMaterials: [], conflicts: [{ factIds: ['F1', 'F2'], reason: '两份报告记载不同' }], requiresReview: true,
  }, { description: '报告甲记载肋骨骨折6根；报告乙记载肋骨骨折5根' });
  assert.deepEqual(normalized.facts.filter(fact => fact.field === 'fractured_rib_count').map(fact => fact.value), [5, 6]);
  assert.ok(normalized.facts.filter(fact => fact.field === 'fractured_rib_count').every(fact => fact.certainty === 'conflicted'));
  assert.equal(normalized.conflicts.length, 1);
});

test('conflict references to unknown fact IDs are rejected instead of silently discarded', () => {
  assert.throws(() => normalizeExtractedFacts({
    facts: [{ id: 'F1', field: 'diagnosis', value: '骨折', certainty: 'reported', source: 'description', evidence: '骨折' }],
    missingMaterials: [], conflicts: [{ factIds: ['F1', 'F9'], reason: '冲突' }], requiresReview: true,
  }, { description: '骨折' }), /冲突|事实|ID/);
});

test('a conflict whose raw fact IDs deduplicate to one fact remains reviewable but unlinked', () => {
  const quote = 'CT报告记载骨折';
  const snapshot = normalizeExtractedFacts({
    facts: [
      { id: 'F1', field: 'diagnosis', value: '骨折', certainty: 'reported', source: 'description', evidence: quote },
      { id: 'F2', field: 'diagnosis', value: '骨折', certainty: 'reported', source: 'description', evidence: quote },
    ], missingMaterials: [], conflicts: [{ factIds: ['F1', 'F2'], reason: '两个重复条目被标为冲突' }], requiresReview: false,
  }, { description: `${quote}。` });

  assert.equal(snapshot.facts.length, 1);
  assert.equal(snapshot.conflicts.length, 1);
  assert.deepEqual(snapshot.conflicts[0].factIds, []);
  assert.equal(snapshot.requiresReview, true);
});

test('equivalent facts from text and image retain both source links without a cross-source merge', () => {
  const quote = 'CT报告记载肺挫伤';
  const raw = { facts: [
    { id: 'F1', field: 'diagnosis', value: '骨折', certainty: 'reported', source: 'description', evidence: quote },
    { id: 'F2', field: 'diagnosis', value: '骨折', certainty: 'reported', source: 'image', evidence: quote },
  ], missingMaterials: [], conflicts: [], requiresReview: false };
  const input = { description: `${quote}。`, recognizedText: quote };
  const first = normalizeExtractedFacts(raw, input);
  const second = normalizeExtractedFacts(raw, input);
  const diagnosisFacts = first.facts.filter(fact => fact.field === 'diagnosis');

  assert.deepEqual(first, second);
  assert.deepEqual(diagnosisFacts.map(fact => fact.source).sort(), ['description', 'image']);
  assert.equal(diagnosisFacts.length, 2);
});

test('equivalent facts repeated across image pages retain each page source after deduplication and result normalization', () => {
  const quote = '检查记录显示双侧对称';
  const recognizedText = `【图片1】\n${quote}。\n\n【图片2】\n${quote}。`;
  const raw = { facts: [
    { id: 'F1', field: 'diagnosis', value: 'finding_x', certainty: 'reported', source: 'image', evidence: quote, eventId: 'E1' },
    { id: 'F2', field: 'diagnosis', value: 'finding_x', certainty: 'reported', source: 'image', evidence: quote, eventId: 'E1' },
  ], missingMaterials: [], conflicts: [], requiresReview: false };
  const snapshot = normalizeExtractedFacts(raw, { recognizedText });
  const diagnosisFacts = snapshot.facts.filter(fact => fact.field === 'diagnosis');

  assert.equal(diagnosisFacts.length, 1);
  assert.deepEqual(diagnosisFacts[0].sourceRefs.map(reference => reference.sourceId), ['image-1', 'image-2']);
  assert.ok(diagnosisFacts[0].sourceRefs.every(reference => reference.evidence === quote));

  const result = normalizeResult({ ...providerFixture('injury'), status: 'insufficient', grade: null, references: [] },
    { ...inputs.injury, description: '' }, { clauses: [], recognizedText, requestId: 'image-source-provenance',
      model: 'test-model', extractedFacts: snapshot.facts, conflicts: snapshot.conflicts,
      requiresReview: snapshot.requiresReview, factMissingMaterials: snapshot.missingMaterials });
  assert.deepEqual(result.facts.find(fact => fact.field === 'diagnosis').sourceRefs, diagnosisFacts[0].sourceRefs);
});

test('a page source reference that does not contain its quoted evidence is rejected', () => {
  const quote = '检查记录显示双侧对称';
  const recognizedText = `【图片1】\n${quote}。`;
  const fact = { id: 'F1', field: 'diagnosis', value: 'finding_x', certainty: 'reported', source: 'image',
    evidence: quote, eventId: 'E1', sourceRefs: [{ source: 'image', sourceId: 'image-2', evidence: quote }] };
  const result = normalizeResult({ ...providerFixture('injury'), status: 'insufficient', grade: null, references: [] },
    { ...inputs.injury, description: '' }, { clauses: [], recognizedText, requestId: 'invalid-image-source-reference',
      model: 'test-model', extractedFacts: [fact], conflicts: [], requiresReview: false, factMissingMaterials: [] });

  assert.equal(result.facts.length, 0);
  assert.ok(result.warnings.some(warning => warning.includes('图片页')));
});

test('duplicate OCR page IDs remain unscoped instead of claiming a specific image', () => {
  const quote = '检查记录显示双侧对称';
  const recognizedText = `【图片1】\n${quote}。\n\n【图片1】\n${quote}。`;
  const snapshot = normalizeExtractedFacts({ facts: [
    { id: 'F1', field: 'diagnosis', value: 'finding_x', certainty: 'reported', source: 'image', evidence: quote },
  ], missingMaterials: [], conflicts: [], requiresReview: false }, { recognizedText });
  const fact = snapshot.facts.find(item => item.field === 'diagnosis');

  assert.deepEqual(fact.sourceRefs.map(reference => reference.sourceId), [null]);
});

test('event IDs survive fact normalization and separate episode-level differences from conflicts', () => {
  const description = '2021年事故疑似第六肋骨骨折。2025年事故复查排除第六肋骨骨折。';
  const rawFacts = eventIds => ({ facts: [
    { id: 'F1', field: 'injury_type', value: 'rib_fracture', certainty: 'uncertain', source: 'description',
      evidence: '2021年事故疑似第六肋骨骨折', eventId: eventIds[0] },
    { id: 'F2', field: 'injury_type', value: 'rib_fracture', certainty: 'excluded', source: 'description',
      evidence: '2025年事故复查排除第六肋骨骨折', eventId: eventIds[1] },
  ], missingMaterials: [], conflicts: [], requiresReview: false });

  const separateEpisodes = normalizeExtractedFacts(rawFacts(['E1', 'E2']), { description });
  assert.equal(separateEpisodes.facts.filter(fact => fact.field === 'injury_type').length, 2);
  assert.deepEqual(new Set(separateEpisodes.facts.filter(fact => fact.field === 'injury_type').map(fact => fact.eventId)), new Set(['E1', 'E2']));
  assert.equal(separateEpisodes.conflicts.length, 0);
  assert.equal(separateEpisodes.requiresReview, true);

  const sameEpisode = normalizeExtractedFacts(rawFacts(['E1', 'E1']), { description });
  assert.ok(sameEpisode.conflicts.some(conflict => conflict.factIds.some(id =>
    sameEpisode.facts.find(fact => fact.id === id)?.field === 'injury_type')));
  assert.equal(sameEpisode.requiresReview, true);
});

test('unscoped rib facts from separate dated accidents do not receive a shared inferred event ID', () => {
  const description = '2021年事故左侧第3肋骨骨折，共1处骨折。2025年事故右侧第4肋骨骨折，共2处骨折。';
  const snapshot = normalizeExtractedFacts({ facts: [], missingMaterials: [], conflicts: [], requiresReview: false }, { description });
  const ribFacts = snapshot.facts.filter(fact => ['injury_type', 'fracture_site_count'].includes(fact.field));
  assert.ok(ribFacts.length > 0);
  assert.ok(ribFacts.every(fact => !fact.eventId));
});

test('an explicit current rib event remains scoped when the source denies prior rib injury', () => {
  const description = '既往没有肋骨损伤。本次事故后左侧第3肋骨有1处骨折线,左侧第4肋骨有1处骨折线,共2处骨折';
  const snapshot = normalizeExtractedFacts({ facts: [], missingMaterials: [], conflicts: [], requiresReview: false }, { description });
  const ribFacts = snapshot.facts.filter(fact => ['injury_type', 'fracture_site_count'].includes(fact.field));
  assert.ok(ribFacts.length > 0);
  assert.ok(ribFacts.every(fact => fact.eventId === 'E1'));
});

test('a single explicit current rib event overrides inconsistent model event IDs', () => {
  const description = '2025年4月12日急诊CT报告明确记载:本次事故后左侧第3肋骨有1处骨折线,左侧第4肋骨有1处骨折线,共2处骨折';
  const snapshot = normalizeExtractedFacts({ facts: [
    { id: 'F1', field: 'injury_type', value: 'rib_fracture', certainty: 'reported', source: 'description', evidence: description, eventId: 'E1' },
    { id: 'F2', field: 'fracture_site_count', value: 2, certainty: 'reported', source: 'description', evidence: '共2处骨折', eventId: 'E2' },
  ], missingMaterials: [], conflicts: [], requiresReview: false }, { description });
  const currentRibFacts = snapshot.facts.filter(fact => ['injury_type', 'fracture_site_count'].includes(fact.field));
  assert.ok(currentRibFacts.length > 1);
  assert.equal(new Set(currentRibFacts.map(fact => fact.eventId)).size, 1);
  assert.equal(snapshot.requiresReview, false);
  assert.equal(snapshot.conflicts.length, 0);
});

test('a single explicit current event overrides inconsistent IDs on separately quoted rib clauses', () => {
  const description = '本次事故后左侧第3肋骨有1处骨折线，左侧第4肋骨有1处骨折线，共2处骨折。既往没有肋骨损伤，治疗已终结，病情稳定。';
  const snapshot = normalizeExtractedFacts({ facts: [
    { id: 'F0', field: 'anatomical_site', value: '肋骨', certainty: 'reported', source: 'description', evidence: '本次事故后左侧第3肋骨有1处骨折线', eventId: 'E1' },
    { id: 'F1', field: 'injury_type', value: 'rib_fracture', certainty: 'reported', source: 'description', evidence: '本次事故后左侧第3肋骨有1处骨折线', eventId: 'E1' },
    { id: 'F7', field: 'diagnosis', value: '肋骨骨折', certainty: 'reported', source: 'description', evidence: '本次事故后左侧第3肋骨有1处骨折线', eventId: 'E2' },
    { id: 'F11', field: 'other', value: '2025年4月12日急诊CT报告', certainty: 'reported', source: 'description', evidence: '本次事故后左侧第3肋骨有1处骨折线', eventId: 'E2' },
    { id: 'F12', field: 'other', value: '本次事故后', certainty: 'reported', source: 'description', evidence: '本次事故后左侧第3肋骨有1处骨折线', eventId: 'E2' },
    { id: 'F6', field: 'anatomical_site', value: '肋骨', certainty: 'reported', source: 'description', evidence: '左侧第4肋骨有1处骨折线', eventId: 'E2' },
    { id: 'F2', field: 'injury_type', value: 'rib_fracture', certainty: 'reported', source: 'description', evidence: '左侧第4肋骨有1处骨折线', eventId: 'E2' },
    { id: 'F3', field: 'fractured_rib_numbers', value: [3], certainty: 'reported', source: 'description', evidence: '本次事故后左侧第3肋骨有1处骨折线', eventId: 'E1' },
    { id: 'F4', field: 'fractured_rib_numbers', value: [4], certainty: 'reported', source: 'description', evidence: '左侧第4肋骨有1处骨折线', eventId: 'E2' },
    { id: 'F5', field: 'fracture_site_count', value: 2, certainty: 'reported', source: 'description', evidence: '共2处骨折', eventId: 'E2' },
    { id: 'F8', field: 'prior_injury', value: false, certainty: 'reported', source: 'description', evidence: '既往没有肋骨损伤' },
    { id: 'F9', field: 'treatment', value: '治疗已终结', certainty: 'reported', source: 'description', evidence: '治疗已终结' },
    { id: 'F10', field: 'other', value: '病情稳定', certainty: 'reported', source: 'description', evidence: '病情稳定' },
  ], missingMaterials: [], conflicts: [], requiresReview: false }, { description });

  const currentRibFacts = snapshot.facts.filter(fact => ['anatomical_site', 'injury_type', 'fractured_rib_numbers', 'fracture_site_count'].includes(fact.field));
  assert.ok(currentRibFacts.length >= 5);
  assert.equal(new Set(currentRibFacts.map(fact => fact.eventId)).size, 1);
  assert.ok(currentRibFacts[0].eventId);
  assert.equal(snapshot.requiresReview, false);
  assert.deepEqual(snapshot.conflicts, []);
});

test('string-form conflict notices remain visible even when they do not cite fact IDs', () => {
  const snapshot = normalizeExtractedFacts({
    facts: [{ id: 'F1', field: 'diagnosis', value: '骨折', certainty: 'uncertain', source: 'description', evidence: '疑似骨折' }],
    missingMaterials: [], conflicts: ['材料记载疑似骨折，需复查确认'], requiresReview: true,
  }, { description: '疑似骨折' });
  assert.equal(snapshot.requiresReview, true);
  assert.equal(snapshot.conflicts.length, 1);
  assert.deepEqual(snapshot.conflicts[0].factIds, []);
  assert.match(snapshot.conflicts[0].reason, /冲突|复核/);
});

test('excluded facts cannot satisfy a positive grading condition or preserve a model grade', () => {
  const input = { ...inputs.injury, description: '排除第六肋骨骨折' };
  const quote = '排除第六肋骨骨折';
  const raw = { ...providerFixture('injury'), status: 'preliminary', grade: '轻伤二级',
    facts: [], references: [{ ...providerFixture('injury').references[0], evidence: quote,
      conditions: [{ condition: '肋骨骨折', evidence: quote, met: true }] }] };
  const result = normalizeResult(raw, input, {
    clauses: retrieveClauses('injury', input.description), requestId: 'excluded-grade-test', model: 'kimi-k2.6',
    extractedFacts: [{ id: 'F1', field: 'injury_type', value: 'rib_fracture', certainty: 'excluded',
      source: 'description', evidence: quote, finding: '损伤类型：rib_fracture' }], conflicts: [], requiresReview: false,
  });
  assert.equal(result.status, 'insufficient');
  assert.equal(result.grade, null);
  assert.notEqual(result.references[0]?.relation, 'supports');
});

test('cached clause conditions rebind fact IDs to the current source wording', () => {
  const input = { ...inputs.injury, description: '左边第三根和第四根肋骨骨折，共2处骨折。' };
  const snapshot = normalizeExtractedFacts({ facts: [], missingMaterials: [], conflicts: [], requiresReview: false }, { description: input.description });
  const siteCount = snapshot.facts.find(fact => fact.field === 'fracture_site_count');
  assert.ok(siteCount);
  const raw = structuredClone(providerFixture('injury'));
  const injury = snapshot.facts.find(fact => fact.field === 'injury_type');
  raw.references[0].conditions[0].factIds = [injury.id, siteCount.id];
  const result = normalizeResult(raw, input, {
    clauses: retrieveClauses('injury', input.description), requestId: 'rebind-source-test', model: 'kimi-k2.6',
    extractedFacts: snapshot.facts.map(fact => ({ ...fact, eventId: 'E1' })), conflicts: [], requiresReview: false,
  });
  assert.equal(result.status, 'preliminary');
  const countCondition = result.references[0].conditions.find(condition => condition.condition.includes('处数'));
  assert.equal(countCondition.evidence, siteCount.evidence);
  assert.deepEqual(countCondition.factIds, [siteCount.id]);
});

test('observed K2.6 rib aliases normalize to one fact set and do not infer fracture sites from rib ordinals', () => {
  const description = '左侧第3、4肋骨骨折。';
  const responses = [
    { facts: [
      { id: 'f1', field: 'injury_type', value: '骨折', certainty: 'reported', source: 'description', evidence: description.slice(0, -1) },
      { id: 'f2', field: 'anatomical_site', value: '肋骨', certainty: 'reported', source: 'description', evidence: description.slice(0, -1) },
      { id: 'f3', field: 'laterality', value: '左侧', certainty: 'reported', source: 'description', evidence: description.slice(0, -1) },
      { id: 'f4', field: 'fractured_rib_numbers', value: [3, 4], certainty: 'reported', source: 'description', evidence: description.slice(0, -1) },
      { id: 'f5', field: 'fractured_rib_count', value: 2, certainty: 'derived', source: 'description', evidence: description.slice(0, -1) },
      { id: 'f6', field: 'fracture_site_count', value: 2, certainty: 'derived', source: 'description', evidence: description.slice(0, -1) },
    ], missingMaterials: [], conflicts: [], requiresReview: false },
    { facts: [
      { field: 'anatomical_site', value: 'rib', certainty: 'reported', source: 'description', evidence: '肋骨' },
      { field: 'laterality', value: 'left', certainty: 'reported', source: 'description', evidence: '左侧' },
      { field: 'fractured_rib_numbers', value: [3, 4], certainty: 'reported', source: 'description', evidence: '第3、4肋骨' },
      { field: 'injury_type', value: 'fracture', certainty: 'reported', source: 'description', evidence: '骨折' },
    ], missingMaterials: [], conflicts: [], requiresReview: false },
  ];
  const normalized = responses.map(raw => normalizeExtractedFacts(raw, { description }));
  const project = value => value.facts.map(({ field, value, certainty, source, evidence }) => ({ field, value, certainty, source, evidence }));
  assert.deepEqual(project(normalized[0]), project(normalized[1]));
  assert.equal(normalized[0].facts.some(fact => fact.field === 'fracture_site_count'), false);
  assert.equal(normalized[0].facts.find(fact => fact.field === 'injury_type')?.value, 'rib_fracture');
  assert.equal(normalized[0].facts.find(fact => fact.field === 'anatomical_site')?.value, '肋骨');
});

test('rib ordinals cannot support a fracture-site grading condition without an explicit site-count fact', () => {
  const description = '左侧第3、4肋骨骨折。';
  const snapshot = normalizeExtractedFacts({ facts: [
    { field: 'injury_type', value: 'fracture', certainty: 'reported', source: 'description', evidence: '骨折' },
    { field: 'fracture_site_count', value: 2, certainty: 'derived', source: 'description', evidence: description.slice(0, -1) },
  ], missingMaterials: [], conflicts: [], requiresReview: false }, { description });
  assert.equal(snapshot.requiresReview, false);
  assert.ok(snapshot.missingMaterials.some(item => item.includes('骨折处数')));
  const injuryFact = snapshot.facts.find(fact => fact.field === 'injury_type');
  const raw = structuredClone(providerFixture('injury'));
  raw.references = [{ ...raw.references[0], evidence: description, conditions: [{
    condition: '肋骨骨折2处以上', evidence: description, met: true, factIds: [injuryFact.id],
  }] }];
  const result = normalizeResult(raw, { ...inputs.injury, description }, {
    clauses: retrieveClauses('injury', description), requestId: 'rib-site-count-guard', model: 'kimi-k2.6',
    extractedFacts: snapshot.facts, conflicts: snapshot.conflicts, requiresReview: snapshot.requiresReview,
  });
  assert.equal(result.status, 'insufficient');
  assert.equal(result.grade, null);
  assert.notEqual(result.references[0]?.relation, 'supports');
});

test('deterministic rib-count facts retain source evidence and an ID to their source ordinal fact', () => {
  const snapshot = normalizeExtractedFacts({ facts: [], missingMaterials: [], conflicts: [], requiresReview: false }, {
    description: '左侧第3、4肋骨骨折。',
  });
  const ordinals = snapshot.facts.find(fact => fact.field === 'fractured_rib_numbers');
  const count = snapshot.facts.find(fact => fact.field === 'fractured_rib_count');
  assert.deepEqual(ordinals.value, [3, 4]);
  assert.equal(count.value, 2);
  assert.equal(count.evidence, '左侧第3、4肋骨骨折');
  assert.deepEqual(count.derivedFrom, [ordinals.id]);
});

test('an explicit fracture-site count keeps the number and unit in its evidence quote', () => {
  const description = '左侧第3、4肋骨骨折，共2处骨折。';
  const snapshot = normalizeExtractedFacts({ facts: [], missingMaterials: [], conflicts: [], requiresReview: false }, { description });
  const count = snapshot.facts.find(fact => fact.field === 'fracture_site_count');
  assert.equal(count.value, 2);
  assert.match(count.evidence, /2处/);
  assert.ok(description.includes(count.evidence));
});

test('observed K2.6 contradiction aliases preserve the same canonical facts and review conflict', () => {
  const description = '病历一记载疑似第六肋骨骨折；复查报告记载未见骨折。';
  const responses = [
    { facts: [
      { id: 'f1', field: 'injury_type', value: '骨折', certainty: 'uncertain', source: 'description', evidence: '疑似第六肋骨骨折' },
      { id: 'f2', field: 'anatomical_site', value: '第六肋骨', certainty: 'uncertain', source: 'description', evidence: '第六肋骨骨折' },
      { id: 'f3', field: 'laterality', value: null, certainty: 'unknown', source: 'description', evidence: '第六肋骨骨折' },
      { id: 'f4', field: 'injury_type', value: '骨折', certainty: 'excluded', source: 'description', evidence: '未见骨折' },
    ], missingMaterials: [], conflicts: [{ factIds: ['f1', 'f4'], reason: '疑似骨折与复查未见骨折' }], requiresReview: true },
    { facts: [
      { id: 'f1', field: 'fractured_rib_numbers', value: [6], certainty: 'uncertain', source: 'description', evidence: '疑似第六肋骨骨折' },
      { id: 'f2', field: 'fractured_rib_numbers', value: [], certainty: 'excluded', source: 'description', evidence: '未见骨折' },
    ], missingMaterials: ['复查报告影像学资料', '复查报告具体检查时间', '病历一影像学检查资料'],
    conflicts: [{ factIds: ['f1', 'f2'], reason: '疑似骨折与复查未见骨折' }], requiresReview: true },
  ];
  const normalized = responses.map(raw => normalizeExtractedFacts(raw, { description }));
  const project = value => value.facts.map(({ field, value, certainty, source, evidence }) => ({ field, value, certainty, source, evidence }));
  assert.deepEqual(project(normalized[0]), project(normalized[1]));
  assert.equal(normalized[0].conflicts.length, 1);
  assert.equal(normalized[1].conflicts.length, 1);
  assert.equal(normalized[0].requiresReview, true);
  assert.equal(normalized[1].requiresReview, true);
});

test('latest K2.6 conflict outputs normalize empty or aliased negative findings to the same rib facts', () => {
  const description = '病历一记载疑似第六肋骨骨折；复查报告记载未见骨折。';
  const responses = [
    { facts: [
      { id: 'f1', field: 'fractured_rib_numbers', value: [6], certainty: 'uncertain', source: 'description', evidence: '疑似第六肋骨骨折' },
      { id: 'f2', field: 'fractured_rib_numbers', value: [6], certainty: 'excluded', source: 'description', evidence: '未见骨折' },
    ], missingMaterials: [], conflicts: [{ factIds: ['f1', 'f2'], reason: '初诊疑似骨折与复查未见骨折结论矛盾' }], requiresReview: true },
    { facts: [
      { id: 'f1', field: 'diagnosis', value: '第六肋骨骨折', certainty: 'uncertain', source: 'description', evidence: '疑似第六肋骨骨折' },
      { id: 'f2', field: 'diagnosis', value: '第六肋骨骨折', certainty: 'excluded', source: 'description', evidence: '未见骨折' },
    ], missingMaterials: [], conflicts: [{ factIds: ['f1', 'f2'], reason: '疑似与排除的诊断状态冲突' }], requiresReview: true },
  ];
  const normalized = responses.map(raw => normalizeExtractedFacts(raw, { description }));
  const project = value => value.facts.map(({ field, value, certainty, source, evidence }) => ({ field, value, certainty, source, evidence }));
  assert.deepEqual(project(normalized[0]), project(normalized[1]));
  assert.equal(normalized[0].conflicts.length, 1);
  assert.equal(normalized[1].conflicts.length, 1);
  assert.equal(normalized[0].requiresReview, true);
  assert.equal(normalized[1].requiresReview, true);
});

test('observed Chinese injury-type values normalize to the canonical rib-fracture value', () => {
  const description = '资料记载排除第六肋骨骨折。';
  const normalized = normalizeExtractedFacts({ facts: [
    { id: 'f1', field: 'injury_type', value: '肋骨骨折', certainty: 'excluded', source: 'description', evidence: '排除第六肋骨骨折' },
  ], missingMaterials: [], conflicts: [], requiresReview: false }, { description });
  assert.equal(normalized.facts.find(fact => fact.field === 'injury_type')?.value, 'rib_fracture');
  assert.equal(normalized.facts.find(fact => fact.field === 'injury_type')?.certainty, 'excluded');
  assert.equal(normalized.facts.some(fact => fact.field === 'other'), false);
});

test('official clause conditions override K2.6 invented laterality requirements consistently', () => {
  const description = '左侧第3、4肋骨骨折，共2处骨折。';
  const input = { ...inputs.injury, description };
  const snapshot = normalizeExtractedFacts({ facts: [], missingMaterials: [], conflicts: [], requiresReview: false }, { description });
  const injury = snapshot.facts.find(fact => fact.field === 'injury_type');
  const siteCount = snapshot.facts.find(fact => fact.field === 'fracture_site_count');
  const clauses = retrieveClauses('injury', description);
  const supportedRaw = structuredClone(providerFixture('injury'));
  supportedRaw.grade = '轻伤二级';
  supportedRaw.summary = '肋骨骨折处数符合明示阈值，辅助评估为轻伤二级。';
  supportedRaw.reasoning = '肋骨骨折处数符合本条。';
  supportedRaw.references = [{ ...supportedRaw.references[0], clauseId: '5.6.4.b', evidence: description,
    relation: 'supports', conditions: [{ condition: '肋骨骨折2处以上', evidence: description, met: true, factIds: [injury.id, siteCount.id] }] }];
  const incompleteRaw = structuredClone(supportedRaw);
  incompleteRaw.status = 'insufficient'; incompleteRaw.grade = null;
  incompleteRaw.references = [
    { ...supportedRaw.references[0], clauseId: '5.6.3.c', evidence: description, relation: 'incomplete',
      conditions: [{ condition: '肋骨骨折6处以上', evidence: description, met: false, factIds: [injury.id, siteCount.id] }] },
    { ...supportedRaw.references[0], clauseId: '5.6.5.a', evidence: description, relation: 'incomplete',
      conditions: [{ condition: '肋骨骨折（需明确侧别定位）', evidence: description, met: null, factIds: [injury.id] }] },
  ];
  incompleteRaw.missingMaterials = ['肋骨侧别', '补充影像资料'];
  const normalize = raw => normalizeResult(raw, input, {
    clauses, requestId: 'official-condition-test', model: 'kimi-k2.6', extractedFacts: snapshot.facts.map(fact => ({ ...fact, eventId: 'E1' })),
    conflicts: snapshot.conflicts, requiresReview: snapshot.requiresReview,
    factMissingMaterials: snapshot.missingMaterials,
  });
  const first = normalize(supportedRaw);
  const second = normalize(incompleteRaw);
  assert.equal(first.status, 'preliminary');
  assert.equal(second.status, 'preliminary');
  assert.equal(first.grade, '轻伤二级');
  assert.equal(second.grade, '轻伤二级');
  assert.deepEqual(second.references.map(({ id, grade, relation }) => ({ id, grade, relation })),
    first.references.map(({ id, grade, relation }) => ({ id, grade, relation })));
  assert.doesNotMatch(first.summary + first.reasoning + second.summary + second.reasoning, /右侧/);
});

test('separately described rib fractures use their explicit sentence total for the injury grade', () => {
  const description = '本次事故后左侧第3肋骨有1处骨折线，左侧第4肋骨有1处骨折线，共2处骨折。既往没有肋骨损伤';
  const input = { ...inputs.injury, description };
  const snapshot = normalizeExtractedFacts({ facts: [], missingMaterials: [], conflicts: [], requiresReview: false }, { description });
  const siteCount = snapshot.facts.find(fact => fact.field === 'fracture_site_count');
  assert.equal(siteCount?.value, 2);
  assert.equal(snapshot.facts.some(fact => fact.field === 'fractured_rib_count' && fact.value === 1), false);

  const injury = snapshot.facts.find(fact => fact.field === 'injury_type');
  const raw = structuredClone(providerFixture('injury'));
  raw.grade = '轻伤二级';
  raw.references = [{ ...raw.references[0], clauseId: '5.6.4.b', evidence: description,
    relation: 'supports', conditions: [
      { condition: '肋骨骨折', evidence: '左侧第3肋骨有1处骨折线', met: true, factIds: [injury.id] },
      { condition: '骨折处数2处以上', evidence: '共2处骨折', met: true, factIds: [siteCount?.id].filter(Boolean) },
    ] }];
  const result = normalizeResult(raw, input, {
    clauses: retrieveClauses('injury', description), requestId: 'comma-separated-rib-site-total', model: 'test-model',
    extractedFacts: snapshot.facts.map(fact => ({ ...fact, eventId: 'E1' })),
    conflicts: snapshot.conflicts, requiresReview: snapshot.requiresReview, factMissingMaterials: snapshot.missingMaterials,
  });

  assert.equal(result.status, 'preliminary');
  assert.equal(result.grade, '轻伤二级');
  assert.equal(result.references.find(reference => reference.id === '5.6.4.b')?.relation, 'supports');
});

test('deterministic rib clause evaluation is not blocked by malformed model condition groups', () => {
  const description = '2025年4月12日急诊CT报告明确记载:本次事故后左侧第3肋骨有1处骨折线,左侧第4肋骨有1处骨折线,共2处骨折';
  const input = { ...inputs.injury, description };
  const snapshot = normalizeExtractedFacts({ facts: [], missingMaterials: [], conflicts: [], requiresReview: false }, { description });
  const injury = snapshot.facts.find(fact => fact.field === 'injury_type');
  const siteCount = snapshot.facts.find(fact => fact.field === 'fracture_site_count');
  const raw = { ...providerFixture('injury'), status: 'insufficient', grade: null, references: [
    { ...providerFixture('injury').references[0], clauseId: '5.6.4.b', evidence: description, relation: 'incomplete',
      conditions: [{ condition: '肋骨骨折且骨折处数2处以上', evidence: description, met: true, factIds: [injury.id, siteCount.id] }] },
  ] };
  const result = normalizeResult(raw, input, {
    clauses: retrieveClauses('injury', description), requestId: 'rib-model-condition-fallback', model: 'test-model',
    extractedFacts: snapshot.facts,
    conflicts: snapshot.conflicts, requiresReview: snapshot.requiresReview, factMissingMaterials: snapshot.missingMaterials,
  });

  assert.equal(result.status, 'preliminary');
  assert.equal(result.grade, '轻伤二级');
  assert.deepEqual(result.references.map(reference => reference.id), ['5.6.4.b']);
  assert.equal(result.warnings.some(warning => /条件组存在重复或未映射文本/.test(warning)), false);
});

test('repeated rib analysis emits the same locally relevant clause set when K2.6 selects different citations', () => {
  const description = '左侧第3、4肋骨骨折。';
  const input = { ...inputs.injury, description };
  const snapshot = normalizeExtractedFacts({ facts: [], missingMaterials: [], conflicts: [], requiresReview: false }, { description });
  const clauses = retrieveClauses('injury', description);
  const factIds = snapshot.facts.filter(fact => ['injury_type', 'fractured_rib_numbers'].includes(fact.field)).map(fact => fact.id);
  const clause = id => clauses.find(item => item.id === id);
  const reference = (id, relation, met) => ({ clauseId: id, evidence: description, reasoning: '模型条款判断。', relation,
    conditions: [{ condition: clause(id).text, evidence: description, factIds, met }] });
  const firstRaw = { ...providerFixture('injury'), status: 'insufficient', grade: null,
    references: [reference('5.6.4.b', 'incomplete', true), { clauseId: '6.19', evidence: '本标准中出现的数字均含本数',
      reasoning: '数字包含本数。', relation: 'supports', conditions: [{ condition: '数字含本数', evidence: '标准第6.19条', met: true }] }] };
  const secondRaw = { ...providerFixture('injury'), status: 'insufficient', grade: null,
    references: [reference('5.6.3.c', 'incomplete', true), reference('5.6.4.b', 'incomplete', true), reference('5.6.5.a', 'differential', true)] };
  const normalize = raw => normalizeResult(raw, input, { clauses, requestId: 'stable-rib-citations', model: 'kimi-k2.6',
    extractedFacts: snapshot.facts.map(fact => ({ ...fact, eventId: 'E1' })), conflicts: [], requiresReview: false, factMissingMaterials: snapshot.missingMaterials });
  const first = normalize(firstRaw);
  const second = normalize(secondRaw);
  const project = result => result.references.map(({ id, relation, conditions }) => ({ id, relation,
    conditionStates: conditions.map(condition => condition.met) }));
  assert.equal(first.status, 'insufficient');
  assert.equal(second.status, 'insufficient');
  assert.deepEqual(project(first), project(second));
  assert.deepEqual(project(first), [
    { id: '5.6.3.c', relation: 'incomplete', conditionStates: [true, null] },
    { id: '5.6.4.b', relation: 'incomplete', conditionStates: [true, null] },
    { id: '5.6.5.a', relation: 'incomplete', conditionStates: [null] },
  ]);
});

test('source-backed single rib fracture gets the same local clause result when K2.6 omits or invents citations', () => {
  const description = '第六肋骨骨折1处。';
  const input = { ...inputs.injury, description };
  const snapshot = normalizeExtractedFacts({ facts: [], missingMaterials: [], conflicts: [], requiresReview: false }, { description });
  const clauses = retrieveClauses('injury', description);
  const context = { clauses, requestId: 'stable-single-rib-result', model: 'kimi-k2.6', extractedFacts: snapshot.facts,
    conflicts: snapshot.conflicts, requiresReview: snapshot.requiresReview, factMissingMaterials: snapshot.missingMaterials };
  const noCitation = { ...providerFixture('injury'), status: 'preliminary', grade: null, references: [] };
  const inventedCitation = { ...providerFixture('injury'), status: 'insufficient', grade: null,
    references: [{ ...providerFixture('injury').references[0], clauseId: '5.6.4.b', relation: 'incomplete',
      conditions: [{ condition: '肋骨骨折2处以上', evidence: description,
        factIds: snapshot.facts.map(fact => fact.id), met: null }] }] };
  const first = normalizeResult(noCitation, input, context);
  const second = normalizeResult(inventedCitation, input, context);
  const project = result => ({ status: result.status, grade: result.grade,
    references: result.references.map(({ id, grade, relation }) => ({ id, grade, relation })),
    missingMaterials: result.missingMaterials });
  assert.deepEqual(project(first), project(second));
  assert.equal(first.status, 'insufficient');
  assert.equal(first.grade, null);
  assert.ok(first.references.every(reference => reference.relation !== 'supports'));
});

test('conflicting facts suppress variable model clause references', () => {
  const description = '病历一记载疑似第六肋骨骨折；复查报告记载未见骨折。';
  const input = { ...inputs.injury, description };
  const snapshot = normalizeExtractedFacts({ facts: [], missingMaterials: [], conflicts: [], requiresReview: false }, { description });
  const clauses = retrieveClauses('injury', description);
  const context = { clauses, requestId: 'stable-conflicted-references', model: 'kimi-k2.6', extractedFacts: snapshot.facts,
    conflicts: snapshot.conflicts, requiresReview: true, factMissingMaterials: snapshot.missingMaterials };
  const first = normalizeResult({ ...providerFixture('injury'), status: 'needs_review', grade: null, references: [] }, input, context);
  const second = normalizeResult({ ...providerFixture('injury'), status: 'needs_review', grade: null,
    references: [{ ...providerFixture('injury').references[0], clauseId: '5.6.5.a', relation: 'supports',
      conditions: [{ condition: '肋骨骨折', evidence: description,
        factIds: snapshot.facts.map(fact => fact.id), met: true }] }] }, input, context);
  assert.equal(first.status, 'needs_review');
  assert.equal(second.status, 'needs_review');
  assert.deepEqual(first.references, []);
  assert.deepEqual(second.references, []);
});

test('insufficient and review results keep fact-stage missing materials, not variable assessment wording', () => {
  const description = '左侧胸部疼痛，未提供影像检查或明确诊断。';
  const input = { ...inputs.injury, description };
  const clauses = retrieveClauses('injury', description);
  const context = { clauses, requestId: 'stable-missing-materials', model: 'kimi-k2.6',
    extractedFacts: [{ id: 'F1', field: 'symptom', value: '左侧胸部疼痛', certainty: 'reported', source: 'description', evidence: '左侧胸部疼痛', finding: '症状：胸部疼痛' }],
    conflicts: [], requiresReview: false, factMissingMaterials: ['影像学检查报告', '诊断证明'] };
  const firstRaw = { ...providerFixture('injury'), status: 'insufficient', grade: null, references: [],
    missingMaterials: ['影像检查报告（胸部X线、CT等）', '诊断证明或病历资料明确记载损伤类型', '致伤经过及损伤机制说明'] };
  const secondRaw = { ...providerFixture('injury'), status: 'insufficient', grade: null, references: [],
    missingMaterials: ['影像检查报告（如胸部X线、CT等）', '诊断证明（明确损伤类型及程度）', '体格检查记录'] };
  const first = normalizeResult(firstRaw, input, context);
  const second = normalizeResult(secondRaw, input, context);
  assert.deepEqual(first.missingMaterials, second.missingMaterials);
  assert.deepEqual(first.missingMaterials, ['明确诊断或复查结论', '影像检查报告']);

  const conflictContext = { ...context, conflicts: [{ factIds: ['F1', 'F2'], reason: '存在矛盾，需要复核。' }],
    requiresReview: true, factMissingMaterials: ['复查报告影像资料', '影像学检查日期'] };
  const reviewFirst = normalizeResult({ ...firstRaw, missingMaterials: ['复查报告具体检查部位'] }, input, conflictContext);
  const reviewSecond = normalizeResult({ ...firstRaw, missingMaterials: ['复查报告完整文字内容', '影像学图像'] }, input, conflictContext);
  assert.deepEqual(reviewFirst.missingMaterials, reviewSecond.missingMaterials);
  assert.deepEqual(reviewFirst.missingMaterials, ['核对冲突事实所涉及的原始资料。']);
});

test('preliminary supported grades do not retain model-added nonblocking missing materials', () => {
  const description = '左侧第3、4肋骨骨折，共2处骨折。';
  const input = { ...inputs.injury, description };
  const snapshot = normalizeExtractedFacts({ facts: [], missingMaterials: ['影像检查报告', '肋骨侧别信息'], conflicts: [], requiresReview: false }, { description });
  const clauses = retrieveClauses('injury', description);
  const injuryFact = snapshot.facts.find(fact => fact.field === 'injury_type');
  const siteCount = snapshot.facts.find(fact => fact.field === 'fracture_site_count');
  const raw = { ...providerFixture('injury'), status: 'preliminary', grade: '轻伤二级',
    references: [{ ...providerFixture('injury').references[0], clauseId: '5.6.4.b', evidence: description,
      conditions: [{ condition: '肋骨骨折2处以上', evidence: description,
        factIds: [injuryFact.id, siteCount.id], met: true }] }] };
  const result = normalizeResult(raw, input, { clauses, requestId: 'stable-supported-missing', model: 'kimi-k2.6',
    extractedFacts: snapshot.facts.map(fact => ({ ...fact, eventId: 'E1' })), conflicts: [], requiresReview: false, factMissingMaterials: snapshot.missingMaterials });
  assert.equal(result.status, 'preliminary');
  assert.deepEqual(result.missingMaterials, []);
});

test('anatomical sites absent from a quoted negative report are rejected consistently', () => {
  const description = '病历一记载疑似第六肋骨骨折；复查报告记载未见骨折。';
  const variants = [
    { facts: [
      { id: 'f1', field: 'injury_type', value: '骨折', certainty: 'uncertain', source: 'description', evidence: '疑似第六肋骨骨折' },
      { id: 'f2', field: 'anatomical_site', value: '第六肋骨', certainty: 'uncertain', source: 'description', evidence: '疑似第六肋骨骨折' },
      { id: 'f3', field: 'fractured_rib_numbers', value: [6], certainty: 'uncertain', source: 'description', evidence: '疑似第六肋骨骨折' },
      { id: 'f4', field: 'injury_type', value: '骨折', certainty: 'excluded', source: 'description', evidence: '复查报告记载未见骨折' },
      { id: 'f5', field: 'anatomical_site', value: '第六肋骨', certainty: 'excluded', source: 'description', evidence: '复查报告记载未见骨折' },
    ], missingMaterials: [], conflicts: [{ factIds: ['f1', 'f4'], reason: '记录冲突' }, { factIds: ['f2', 'f5'], reason: '部位冲突' }], requiresReview: true },
    { facts: [
      { id: 'f1', field: 'diagnosis', value: '第六肋骨骨折', certainty: 'uncertain', source: 'description', evidence: '疑似第六肋骨骨折' },
      { id: 'f2', field: 'diagnosis', value: '第六肋骨骨折', certainty: 'excluded', source: 'description', evidence: '复查报告记载未见骨折' },
    ], missingMaterials: [], conflicts: [{ factIds: ['f1', 'f2'], reason: '诊断冲突' }], requiresReview: true },
  ];
  const normalized = variants.map(value => normalizeExtractedFacts(value, { description }));
  const project = snapshot => snapshot.facts.map(({ field, value, certainty, source, evidence }) => ({ field, value, certainty, source, evidence }));
  assert.deepEqual(project(normalized[0]), project(normalized[1]));
  assert.equal(normalized[0].facts.some(fact => fact.field === 'anatomical_site' && fact.evidence === '复查报告记载未见骨折'), false);
  assert.equal(normalized[0].requiresReview, true);
  assert.equal(normalized[1].requiresReview, true);
});

test('observed chest-imaging and injury-diagnosis phrases map to the same missing-material labels', () => {
  const variants = [
    ['影像检查报告', '诊断证明'],
    ['胸部影像学检查', '胸部损伤诊断'],
  ];
  const normalized = variants.map(missingMaterials => normalizeExtractedFacts({ facts: [], missingMaterials, conflicts: [], requiresReview: false }, {
    description: '左侧胸部疼痛，未提供影像检查或明确诊断。',
  }));
  assert.deepEqual(normalized[0].missingMaterials, normalized[1].missingMaterials);
  assert.deepEqual(normalized[0].missingMaterials, ['明确诊断或复查结论', '影像检查报告']);
});

test('rib threshold insufficiency names unreported fracture-site count even when extraction omits it', () => {
  const description = '左侧第3、4肋骨骨折。';
  const input = { ...inputs.injury, description };
  const snapshot = normalizeExtractedFacts({ facts: [], missingMaterials: [], conflicts: [], requiresReview: false }, { description });
  const clauses = retrieveClauses('injury', description);
  const clause = clauses.find(item => item.id === '5.6.4.b');
  const raw = { ...providerFixture('injury'), status: 'insufficient', grade: null,
    references: [{ ...providerFixture('injury').references[0], clauseId: clause.id, evidence: description,
      conditions: [{ condition: clause.text, evidence: description, factIds: snapshot.facts.map(fact => fact.id), met: true }] }] };
  const result = normalizeResult(raw, input, { clauses, requestId: 'missing-rib-sites', model: 'kimi-k2.6',
    extractedFacts: snapshot.facts, conflicts: [], requiresReview: false,
    factMissingMaterials: [...snapshot.missingMaterials, '骨折处数未在原文明确记载'] });
  assert.equal(result.status, 'insufficient');
  assert.deepEqual(result.missingMaterials, ['骨折处数未在原文中明确记载，需核实']);
});

test('same-clause anatomical detail already carried by a symptom is not emitted as a duplicate fact', () => {
  const description = '左侧胸部疼痛，未提供影像检查或明确诊断。';
  const variants = [
    { facts: [{ field: 'symptom', value: '左侧胸部疼痛', certainty: 'reported', source: 'description', evidence: '左侧胸部疼痛' }],
      missingMaterials: [], conflicts: [], requiresReview: false },
    { facts: [
      { field: 'symptom', value: '左侧胸部疼痛', certainty: 'reported', source: 'description', evidence: '左侧胸部疼痛' },
      { field: 'anatomical_site', value: '左侧胸部', certainty: 'reported', source: 'description', evidence: description },
    ], missingMaterials: [], conflicts: [], requiresReview: false },
  ];
  const normalized = variants.map(value => normalizeExtractedFacts(value, { description }));
  const project = snapshot => snapshot.facts.map(({ field, value, certainty, source, evidence }) => ({ field, value, certainty, source, evidence }));
  assert.deepEqual(project(normalized[0]), project(normalized[1]));
  assert.equal(normalized[1].facts.some(fact => fact.field === 'anatomical_site'), false);
});

test('explicit fracture-site count is not duplicated as a reported fractured-rib count', () => {
  const description = '第六肋骨骨折1处。';
  const variants = [
    { facts: [
      { field: 'anatomical_site', value: '肋骨', certainty: 'reported', source: 'description', evidence: '第六肋骨' },
      { field: 'fractured_rib_numbers', value: [6], certainty: 'reported', source: 'description', evidence: '第六肋骨' },
      { field: 'fracture_site_count', value: 1, certainty: 'reported', source: 'description', evidence: '1处' },
      { field: 'injury_type', value: '骨折', certainty: 'reported', source: 'description', evidence: '骨折' },
    ], missingMaterials: [], conflicts: [], requiresReview: false },
    { facts: [
      { field: 'anatomical_site', value: '第六肋骨', certainty: 'reported', source: 'description', evidence: description },
      { field: 'injury_type', value: '骨折', certainty: 'reported', source: 'description', evidence: description },
      { field: 'fractured_rib_numbers', value: [6], certainty: 'reported', source: 'description', evidence: description },
      { field: 'fractured_rib_count', value: 1, certainty: 'reported', source: 'description', evidence: description },
      { field: 'fracture_site_count', value: 1, certainty: 'reported', source: 'description', evidence: description },
    ], missingMaterials: [], conflicts: [], requiresReview: false },
  ];
  const normalized = variants.map(value => normalizeExtractedFacts(value, { description }));
  const project = snapshot => snapshot.facts.map(({ field, value, certainty, source, evidence }) => ({ field, value, certainty, source, evidence }));
  assert.deepEqual(project(normalized[0]), project(normalized[1]));
  assert.equal(normalized[0].facts.filter(fact => fact.field === 'fractured_rib_count').length, 1);
  assert.equal(normalized[0].facts.find(fact => fact.field === 'fractured_rib_count').certainty, 'derived');
});

test('negative generic fracture quotes stay generic when they do not name the rib site', () => {
  const description = '病历一记载疑似第六肋骨骨折；复查报告记载未见骨折。';
  const variants = [
    { facts: [
      { id: 'f1', field: 'diagnosis', value: '疑似第六肋骨骨折', certainty: 'uncertain', source: 'description', evidence: '病历一记载疑似第六肋骨骨折' },
      { id: 'f2', field: 'diagnosis', value: '未见骨折', certainty: 'excluded', source: 'description', evidence: '复查报告记载未见骨折' },
    ], missingMaterials: [], conflicts: [{ factIds: ['f1', 'f2'], reason: '同一骨折结论存在冲突' }], requiresReview: true },
    { facts: [
      { id: 'f1', field: 'injury_type', value: '骨折', certainty: 'uncertain', source: 'description', evidence: '疑似第六肋骨骨折' },
      { id: 'f2', field: 'anatomical_site', value: '第六肋骨', certainty: 'uncertain', source: 'description', evidence: '疑似第六肋骨骨折' },
      { id: 'f3', field: 'injury_type', value: '骨折', certainty: 'excluded', source: 'description', evidence: '未见骨折' },
    ], missingMaterials: [], conflicts: [{ factIds: ['f1', 'f3'], reason: '同一骨折结论存在冲突' }], requiresReview: true },
  ];
  const normalized = variants.map(value => normalizeExtractedFacts(value, { description }));
  const project = snapshot => snapshot.facts.map(({ field, value, certainty, source, evidence }) => ({ field, value, certainty, source, evidence }));
  assert.deepEqual(project(normalized[0]), project(normalized[1]));
  assert.ok(normalized[0].facts.some(fact => fact.field === 'injury_type' && fact.value === 'fracture' && fact.certainty === 'conflicted'));
  assert.equal(normalized[0].requiresReview, true);
  assert.equal(normalized[1].requiresReview, true);
});

test('model-only review statuses cannot upgrade a fact-complete insufficient case', () => {
  const description = '左侧胸部疼痛，未提供影像检查或明确诊断。';
  const input = { ...inputs.injury, description };
  const extracted = normalizeExtractedFacts({ facts: [
    { field: 'symptom', value: '左侧胸部疼痛', certainty: 'reported', source: 'description', evidence: '左侧胸部疼痛' },
  ], missingMaterials: ['影像检查资料', '胸部损伤诊断'], conflicts: [], requiresReview: false }, { description });
  const clauses = retrieveClauses('injury', description);
  const base = { ...providerFixture('injury'), grade: null, references: [],
    missingMaterials: ['鉴定时机确认', '体格检查记录'] };
  const context = { clauses, requestId: 'stable-model-review-status', model: 'kimi-k2.6', extractedFacts: extracted.facts,
    conflicts: extracted.conflicts, requiresReview: extracted.requiresReview, factMissingMaterials: extracted.missingMaterials };
  const insufficient = normalizeResult({ ...base, status: 'insufficient' }, input, context);
  const reviewOnly = normalizeResult({ ...base, status: 'needs_review' }, input, context);
  assert.equal(insufficient.status, 'insufficient');
  assert.equal(reviewOnly.status, 'insufficient');
  assert.equal(reviewOnly.requiresReview, false);
  assert.deepEqual(insufficient.missingMaterials, reviewOnly.missingMaterials);
  assert.deepEqual(reviewOnly.missingMaterials, ['明确诊断或复查结论', '影像检查报告']);
});

test('an ungrounded review flag does not turn verified facts and missing materials into review status', () => {
  const description = '材料记载左侧胸部疼痛。';
  const extracted = normalizeExtractedFacts({
    facts: [{ field: 'symptom', value: '左侧胸部疼痛', certainty: 'reported', source: 'description', evidence: '左侧胸部疼痛' }],
    missingMaterials: ['影像学检查资料', '明确诊断'],
    conflicts: [],
    requiresReview: true,
  }, { description });

  assert.equal(extracted.requiresReview, false);
  assert.deepEqual(extracted.missingMaterials, ['明确诊断或复查结论', '影像检查报告']);
});

test('explicitly excluded-only evidence stays insufficient unless another standard is requested', () => {
  const description = '资料记载排除第六肋骨骨折。';
  const input = { ...inputs.injury, description };
  const extracted = normalizeExtractedFacts({ facts: [], missingMaterials: ['影像检查资料'], conflicts: [], requiresReview: false }, { description });
  const clauses = retrieveClauses('injury', description);
  const context = { clauses, requestId: 'stable-excluded-status', model: 'kimi-k2.6', extractedFacts: extracted.facts,
    conflicts: [], requiresReview: false, factMissingMaterials: extracted.missingMaterials };
  const base = { ...providerFixture('injury'), grade: null, references: [] };
  const insufficient = normalizeResult({ ...base, status: 'insufficient' }, input, context);
  const notApplicable = normalizeResult({ ...base, status: 'not_applicable' }, input, context);
  assert.equal(insufficient.status, 'insufficient');
  assert.equal(notApplicable.status, 'insufficient');
  assert.deepEqual(insufficient.missingMaterials, notApplicable.missingMaterials);
  assert.deepEqual(notApplicable.missingMaterials, ['补充与适用条款相关的客观材料。']);

  const alternate = { ...input, description: '请按工伤劳动能力鉴定标准分析。' };
  const alternateContext = { ...context, clauses: retrieveClauses('injury', alternate.description) };
  const preserved = normalizeResult({ ...base, status: 'not_applicable' }, alternate, alternateContext);
  assert.equal(preserved.status, 'not_applicable');
});

test('source-quoted other statements normalize string and statement-object representations', () => {
  const description = '门诊资料记载既往高血压。';
  const variants = [
    { facts: [{ field: 'other', value: '既往高血压', certainty: 'reported', source: 'description', evidence: '既往高血压' }],
      missingMaterials: [], conflicts: [], requiresReview: false },
    { facts: [{ field: 'other', value: { statement: '既往高血压' }, certainty: 'reported', source: 'description', evidence: '既往高血压' }],
      missingMaterials: [], conflicts: [], requiresReview: false },
  ];
  const normalized = variants.map(value => normalizeExtractedFacts(value, { description }));
  const project = snapshot => snapshot.facts.map(({ field, value, certainty, source, evidence }) => ({ field, value, certainty, source, evidence }));
  assert.deepEqual(project(normalized[0]), project(normalized[1]));
  assert.equal(normalized[1].facts.find(fact => fact.field === 'other').value, '既往高血压');
});

test('generic negative fracture evidence is preserved consistently and conflicts with a suspected rib fracture', () => {
  const description = '病历一记载疑似第六肋骨骨折；复查报告记载未见骨折。';
  const variants = [
    { facts: [
      { id: 'f1', field: 'fractured_rib_numbers', value: [6], certainty: 'uncertain', source: 'description', evidence: '疑似第六肋骨骨折' },
      { id: 'f2', field: 'fractured_rib_numbers', value: [6], certainty: 'excluded', source: 'description', evidence: '未见骨折' },
    ], missingMaterials: [], conflicts: [], requiresReview: false },
    { facts: [
      { id: 'f1', field: 'injury_type', value: '骨折', certainty: 'uncertain', source: 'description', evidence: '疑似第六肋骨骨折' },
      { id: 'f2', field: 'anatomical_site', value: '第六肋骨', certainty: 'excluded', source: 'description', evidence: '未见骨折' },
    ], missingMaterials: [], conflicts: [], requiresReview: false },
  ];
  const normalized = variants.map(value => normalizeExtractedFacts(value, { description }));
  const project = snapshot => snapshot.facts.map(({ field, value, certainty, source, evidence }) => ({ field, value, certainty, source, evidence }));
  assert.deepEqual(project(normalized[0]), project(normalized[1]));
  assert.ok(normalized[0].facts.some(fact => fact.field === 'injury_type' && fact.value === 'fracture'
    && fact.certainty === 'conflicted' && fact.evidence === '复查报告记载未见骨折'));
  assert.equal(normalized[0].requiresReview, true);
});

test('explicit denial of a rib fracture stays excluded in deterministic extraction', () => {
  const snapshot = normalizeExtractedFacts({ facts: [], missingMaterials: [], conflicts: [], requiresReview: false }, {
    description: '患者否认第六肋骨骨折。',
  });
  const injuryFact = snapshot.facts.find(fact => fact.field === 'injury_type');

  assert.equal(injuryFact?.certainty, 'excluded');
  assert.equal(injuryFact?.evidence, '患者否认第六肋骨骨折');
  assert.equal(snapshot.requiresReview, false);
});

test('a hypothetical future fracture remains unknown rather than a current report', () => {
  const description = '若出现第六肋骨骨折，应进一步检查。';
  const snapshot = normalizeExtractedFacts({ facts: [
    { id: 'F1', field: 'injury_type', value: 'rib_fracture', certainty: 'reported', source: 'description',
      evidence: '若出现第六肋骨骨折' },
  ], missingMaterials: [], conflicts: [], requiresReview: false }, { description });
  const injury = snapshot.facts.find(fact => fact.field === 'injury_type');

  assert.equal(injury?.certainty, 'unknown');
  assert.equal(injury?.evidence, '若出现第六肋骨骨折');
  assert.equal(snapshot.requiresReview, true);
});

test('the quantity word 若干 is not treated as a hypothetical cue', () => {
  const description = '影像报告记载若干根肋骨骨折。';
  const snapshot = normalizeExtractedFacts({ facts: [
    { id: 'F1', field: 'injury_type', value: 'rib_fracture', certainty: 'reported', source: 'description',
      evidence: '若干根肋骨骨折' },
  ], missingMaterials: [], conflicts: [], requiresReview: false }, { description });
  const injury = snapshot.facts.find(fact => fact.field === 'injury_type');

  assert.equal(injury?.certainty, 'reported');
  assert.equal(snapshot.requiresReview, false);
});

test('an other-person symptom is unknown unless the source identifies the patient as subject', () => {
  const otherDescription = '患者父亲主诉腰痛。';
  const otherSnapshot = normalizeExtractedFacts({ facts: [
    { id: 'F1', field: 'symptom', value: '腰痛', certainty: 'reported', source: 'description', evidence: '患者父亲主诉腰痛' },
  ], missingMaterials: [], conflicts: [], requiresReview: false }, { description: otherDescription });
  const patientDescription = '家属代诉患者腰痛。';
  const patientSnapshot = normalizeExtractedFacts({ facts: [
    { id: 'F1', field: 'symptom', value: '腰痛', certainty: 'reported', source: 'description', evidence: '家属代诉患者腰痛' },
  ], missingMaterials: [], conflicts: [], requiresReview: false }, { description: patientDescription });

  assert.equal(otherSnapshot.facts.find(fact => fact.field === 'symptom')?.certainty, 'unknown');
  assert.equal(otherSnapshot.requiresReview, true);
  assert.equal(patientSnapshot.facts.find(fact => fact.field === 'symptom')?.certainty, 'reported');
  assert.equal(patientSnapshot.requiresReview, false);
});

test('explicitly historical rib fracture is not emitted as a current grading fact', () => {
  const snapshot = normalizeExtractedFacts({ facts: [
    { id: 'F1', field: 'injury_type', value: 'rib_fracture', certainty: 'reported', source: 'description', evidence: '左侧第六肋骨骨折' },
  ], missingMaterials: [], conflicts: [], requiresReview: false }, {
    description: '既往病史记载左侧第六肋骨骨折。',
  });

  assert.ok(snapshot.facts.some(fact => fact.field === 'prior_injury' && fact.value === 'rib_fracture'
    && fact.certainty === 'reported' && fact.evidence === '既往病史记载左侧第六肋骨骨折'));
  assert.equal(snapshot.facts.some(fact => ['injury_type', 'fractured_rib_count', 'fracture_site_count'].includes(fact.field)), false);
  assert.equal(snapshot.requiresReview, false);
});

test('multiple values in a critical injury type are preserved and require review', () => {
  const value = ['rib_fracture', 'fracture'];
  const snapshot = normalizeExtractedFacts({ facts: [
    { id: 'F1', field: 'injury_type', value, certainty: 'reported', source: 'description', evidence: '报告记载两种骨折类型' },
  ], missingMaterials: [], conflicts: [], requiresReview: false }, { description: '报告记载两种骨折类型。' });
  const fact = snapshot.facts.find(item => item.field === 'injury_type');

  assert.deepEqual(fact?.value, value);
  assert.deepEqual(snapshot.conflicts, []);
  assert.equal(snapshot.requiresReview, true);
});

test('an immediately preceding historical heading marks the rib fact as prior history', () => {
  const description = '既往史\n左侧第六肋骨骨折。\n现病史\n右侧第七肋骨骨折。';
  const snapshot = normalizeExtractedFacts({ facts: [], missingMaterials: [], conflicts: [], requiresReview: false }, { description });
  const prior = snapshot.facts.find(fact => fact.field === 'prior_injury');
  const current = snapshot.facts.find(fact => fact.field === 'injury_type' && fact.evidence.includes('右侧第七肋骨'));

  assert.ok(prior);
  assert.match(prior.evidence, /既往史[\s\S]*左侧第六肋骨骨折/);
  assert.equal(snapshot.facts.some(fact => fact.field === 'injury_type' && fact.evidence.includes('左侧第六肋骨')), false);
  assert.ok(current);
  assert.equal(snapshot.facts.some(fact => fact.field === 'prior_injury' && fact.evidence.includes('右侧第七肋骨')), false);
});

test('a historical section heading scopes rib facts across intervening lines but stops at current history', () => {
  const description = '既往史\n此前病历有记录。\n左侧第六肋骨骨折。\n现病史\n右侧第七肋骨骨折。';
  const snapshot = normalizeExtractedFacts({ facts: [
    { id: 'F1', field: 'injury_type', value: 'rib_fracture', certainty: 'reported', source: 'description', evidence: '左侧第六肋骨骨折' },
    { id: 'F2', field: 'injury_type', value: 'rib_fracture', certainty: 'reported', source: 'description', evidence: '右侧第七肋骨骨折' },
  ], missingMaterials: [], conflicts: [], requiresReview: false }, { description });
  const prior = snapshot.facts.find(fact => fact.field === 'prior_injury');
  const current = snapshot.facts.find(fact => fact.field === 'injury_type' && fact.evidence.includes('右侧第七肋骨'));

  assert.ok(prior);
  assert.match(prior.evidence, /既往史[\s\S]*左侧第六肋骨骨折/);
  assert.equal(snapshot.facts.some(fact => fact.field === 'injury_type' && fact.evidence.includes('左侧第六肋骨')), false);
  assert.ok(current);
  assert.equal(snapshot.facts.some(fact => fact.field === 'prior_injury' && fact.evidence.includes('右侧第七肋骨')), false);
});

test('comma-separated suspected and excluded statements keep separate assertion scope and evidence', () => {
  const description = '报告甲疑似第六肋骨骨折，复查报告乙未见骨折。';
  const snapshot = normalizeExtractedFacts({ facts: [], missingMaterials: [], conflicts: [], requiresReview: false }, { description });
  const injuryFacts = snapshot.facts.filter(fact => fact.field === 'injury_type');

  assert.equal(injuryFacts.length, 2);
  assert.deepEqual(injuryFacts.map(({ value, assertedCertainty, certainty, evidence }) => ({
    value, assertedCertainty, certainty, evidence,
  })).sort((a, b) => a.value.localeCompare(b.value)), [
    { value: 'fracture', assertedCertainty: 'excluded', certainty: 'conflicted', evidence: '复查报告乙未见骨折' },
    { value: 'rib_fracture', assertedCertainty: 'uncertain', certainty: 'conflicted', evidence: '报告甲疑似第六肋骨骨折' },
  ].sort((a, b) => a.value.localeCompare(b.value)));
  assert.deepEqual(snapshot.conflicts.map(conflict => conflict.factIds), [injuryFacts.map(fact => fact.id).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))]);
  assert.equal(snapshot.requiresReview, true);
});

test('a later negative statement cannot change an earlier confirmed fracture and both stay reviewable', () => {
  const description = '报告甲明确记载第六肋骨骨折，复查报告乙未见骨折。';
  const snapshot = normalizeExtractedFacts({ facts: [], missingMaterials: [], conflicts: [], requiresReview: false }, { description });
  const facts = snapshot.facts.filter(fact => fact.field === 'injury_type');

  assert.deepEqual(facts.map(({ value, certainty, evidence }) => ({ value, certainty, evidence }))
    .sort((a, b) => a.value.localeCompare(b.value)), [
    { value: 'fracture', certainty: 'excluded', evidence: '复查报告乙未见骨折' },
    { value: 'rib_fracture', certainty: 'reported', evidence: '报告甲明确记载第六肋骨骨折' },
  ].sort((a, b) => a.value.localeCompare(b.value)));
  assert.equal(snapshot.requiresReview, true);
  assert.equal(snapshot.conflicts.length, 0);
});

test('a structured excluded rib fact makes an identical other statement redundant', () => {
  const description = '资料记载排除第六肋骨骨折。';
  const variants = [
    { facts: [
      { field: 'injury_type', value: '肋骨骨折', certainty: 'excluded', source: 'description', evidence: '排除第六肋骨骨折' },
      { field: 'anatomical_site', value: '第六肋骨', certainty: 'excluded', source: 'description', evidence: '排除第六肋骨骨折' },
    ], missingMaterials: [], conflicts: [], requiresReview: false },
    { facts: [
      { field: 'other', value: '排除第六肋骨骨折', certainty: 'excluded', source: 'description', evidence: '排除第六肋骨骨折' },
    ], missingMaterials: [], conflicts: [], requiresReview: false },
  ];
  const normalized = variants.map(value => normalizeExtractedFacts(value, { description }));
  const project = snapshot => snapshot.facts.map(({ field, value, certainty, source, evidence }) => ({ field, value, certainty, source, evidence }));
  assert.deepEqual(project(normalized[0]), project(normalized[1]));
  assert.equal(normalized[1].facts.some(fact => fact.field === 'other'), false);
});

test('diagnosis report and definitive diagnosis requests share one missing-material label', () => {
  const variants = [
    ['诊断资料', '影像检查报告'],
    ['诊断意见', '影像检查报告'],
  ];
  const normalized = variants.map(missingMaterials => normalizeExtractedFacts({ facts: [], missingMaterials,
    conflicts: [], requiresReview: false }, { description: '左侧胸部疼痛，未提供影像检查或明确诊断。' }));
  assert.deepEqual(normalized[0].missingMaterials, normalized[1].missingMaterials);
});

test('null model facts do not create review from an unquoted placeholder', () => {
  const description = '左侧胸部疼痛，未提供影像检查或明确诊断。';
  const snapshot = normalizeExtractedFacts({ facts: [
    { field: 'diagnosis', value: null, certainty: 'excluded', source: 'description', evidence: '未提供明确诊断' },
  ], missingMaterials: ['明确诊断或复查结论'], conflicts: [], requiresReview: false }, { description });
  assert.deepEqual(snapshot.facts, []);
  assert.equal(snapshot.requiresReview, false);
  assert.deepEqual(snapshot.missingMaterials, ['明确诊断或复查结论']);
});

// Keep baseline clauses and input helpers exercised as this suite grows.
assert.equal(retrieveClauses('injury', inputs.injury.description).length > 0, true);
