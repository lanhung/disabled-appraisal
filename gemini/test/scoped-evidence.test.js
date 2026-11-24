import assert from 'node:assert/strict';
import test from 'node:test';
import { assess } from '../lib/assessment.js';
import { catalogs, retrieveClauses } from '../lib/catalog.js';
import { requestSchema, resultSchema } from '../lib/contracts.js';
import { normalizeExtractedFacts } from '../lib/facts.js';
import { evaluateConditionLogic } from '../lib/results.js';

// All descriptions in this file are fabricated and carry no case information.
const emptyExtraction = { facts: [], missingMaterials: [], conflicts: [], requiresReview: false };
const clause = id => catalogs.injury.clauses.find(item => item.id === id);
const canonical = source => source.normalize('NFKC').trim();
const scopedFacts = facts => facts.filter(fact => fact.field.startsWith('scoped_'));

function checkQuote(description, fact) {
  assert.equal(fact.source, 'description');
  assert.equal(fact.verification, 'quoted');
  assert.equal(fact.value, fact.evidence);
  const [ref] = fact.sourceRefs;
  assert.equal(ref.sourceId, 'description');
  const spans = ref.positions || [ref];
  for (const { normalizedStart, normalizedEnd } of spans) {
    assert.equal(canonical(description).slice(normalizedStart, normalizedEnd), fact.evidence);
  }
}

const scenarios = [
  ['5.2.4.q', '牙位24、25均折断。复查见牙位24折断。', true],
  ['5.2.4.q', '牙位24、24均折断。复查见24号牙折断。', null],
  ['5.2.4.q', '牙齿脱落共2颗。', true],
  ['5.2.4.q', '牙位14、15均脱落。未见15号牙脱落。', null],
  ['5.2.4.q', '牙折2枚。另一张报告仅写牙折3枚。牙折3枚。', null],
  ['5.2.4.q', '鉴定意见：\n牙折2枚。', null],
  ['5.2.4.q', '鉴定意见：\n牙折2枚。\n诊断记录：\n牙位14、15均折断。', true],
  ['5.8.3.a', '影像显示左侧耻骨上支骨折，右侧耻骨下支骨折。', true],
  ['5.8.3.a', '影像显示左耻骨上支骨折，左侧耻骨上支骨折。', null],
  ['5.8.3.a', '左侧耻骨上支骨折，另一次受伤时见右侧耻骨下支骨折。', null],
  ['5.8.3.a', '不能排除左侧耻骨上支骨折，右侧耻骨下支骨折。', null],
  ['5.8.3.a', '本次不评定骨盆骨折，影像显示左耻骨上支骨折，右耻骨下支骨折。', null],
  ['5.8.3.a', '2025-01-02因车祸受伤，骨盆骨折不纳入本次鉴定，骨盆2处骨折。', null],
  ['5.9.3.b', '本次仅评胸部，影像显示C3-C5棘突均骨折。', null],
  ['5.9.3.b', '影像显示腰椎1–3横突均骨折，腰椎2横突骨折。', true],
  ['5.9.3.b', '影像显示C3至C5范围内可见棘突骨折。', null],
  ['5.9.3.b', 'C3-C5棘突均骨折？', null],
  ['5.9.3.b', 'C3-C5棘突骨折，结果仍待核实。', null],
  ['5.9.3.b', '未见L1横突骨折，L2、L3、L4横突骨折。', null],
  ['5.9.3.b', 'L2横突骨折，L2左侧横突骨折，L2右侧横突骨折。', null],
  ['5.9.3.b', 'L2双侧横突骨折，L2棘突骨折。', true],
  ['5.9.3.b', 'C4、C5椎体骨折。', true],
  ['5.9.3.b', '复查胸椎三维CT显示肩部挫伤及T4、T5和T6右侧横突均骨折。', true],
  ['5.9.3.b', '急诊颈椎MRI提示颈部挫伤、C3、C4椎体骨折。', true],
  ['5.9.3.b', '腰椎CT示L1椎体骨折、L2椎体骨折及L3椎体骨折。', true],
  ['5.9.3.b', '腰椎CT未见L1椎体骨折、L2椎体骨折及L3椎体骨折。', null],
  ['5.9.3.b', '腰椎CT示未见L1椎体骨折、L2椎体骨折及L3椎体骨折。', null],
  ['5.9.3.b', '腰椎CT：考虑L1椎体骨折、L2椎体骨折及L3椎体骨折。', null],
  ['5.9.3.b', '腰椎CT示L1椎体骨折、L2椎体骨折及L3椎体骨折均待排。', null],
  ['5.9.3.b', '腰椎CT示L1椎体骨折、L2椎体骨折及L3椎体骨折均已排除。', null],
  ['5.9.3.b', '5月1日摔伤，腰椎CT示L1椎体骨折，6月1日又发生车祸，急诊腰椎CT示L2椎体骨折。', null],
  ['5.9.3.b', '5月1日摔伤，腰椎CT示L1椎体骨折、L2椎体骨折，5月2日复查。', true],
  ['5.6.2.g', '左侧气胸伴左肺萎陷70％。', true],
  ['5.6.2.g', '双侧气胸伴左肺萎陷50%，右肺萎陷50%。', true],
  ['5.6.2.g', '双侧气胸伴双侧肺萎陷均在50%以上。', true],
  ['5.6.2.g', '双侧气胸伴双侧肺萎陷合计95%。', null],
  ['5.6.2.g', '双侧气胸伴左肺萎陷63%，右肺萎陷39%。', null],
  ['5.6.2.g', '右侧气胸伴左肺萎陷77%。', null],
  ['5.6.2.g', '气胸伴左肺萎陷12%，另见右肺挫伤，右肺萎陷75%。', null],
  ['5.6.2.g', '左侧气胸伴左肺萎陷约70%。', null],
  ['5.6.2.g', '左侧气胸伴左肺萎陷72%。复查见左侧气胸伴左肺萎陷45%。', null],
  ['5.6.2.g', '左侧气胸伴左肺萎陷72%，后证实肺萎陷数值有误。', null],
  ['5.6.2.g', '左侧气胸伴左肺萎陷75毫升。', null],
  ['5.6.3.e', '双侧血胸伴左肺萎陷20%，右肺萎陷20%。', true],
  ['5.6.3.e', '左侧血气胸伴左肺萎陷30%以上。', true],
  ['5.6.3.e', '左侧血气胸伴左肺萎陷30%以下。', null],
  ['5.6.3.e', '左侧气胸。右肺萎陷40%。', null],
  ['5.7.2.k', '因腹膜后血肿，已行手术治疗。', true],
  ['5.7.2.k', '腹腔积血，需手术治疗。', true],
  ['5.7.2.k', '腹腔积血，另因手部骨折已行手术。', null],
  ['5.7.2.k', '腹腔积血。另因手部骨折已行手术。', null],
  ['5.7.2.k', '疑似腹腔积血，需手术治疗。', null],
  ['5.7.2.k', '未见腹腔积血。因腹腔积血须手术。', null],
  ['5.7.2.k', '腹膜后血肿，无需手术。', null],
  ['5.7.2.k', '腹膜后血肿，无需手术。未见腹腔积血。', false],
  ['5.9.4.f', '检查显示左侧肱骨骨折。', true],
  ['5.9.4.f', '左侧尺骨骨干骨折。', true],
  ['5.9.4.f', '右侧股骨颈骨折。', true],
  ['5.9.4.f', '影像证实右腓骨下端骨折。', true],
  ['5.9.4.f', '急诊诊断为左侧胫骨中段骨折。', true],
  ['5.9.4.f', '左侧腕关节CT示左桡骨远端骨折。', true],
  ['5.9.4.f', '诊断：1.左桡骨远端骨折；2.软组织挫伤。', true],
  ['5.9.4.f', '四肢长骨骨折。', true],
  ['5.9.4.f', '左侧桡骨远端骨折（骨折线未累及关节面）。', true],
  ['5.9.4.f', '左侧桡骨远端骨折，未见关节面受累。', true],
  ['5.9.4.f', '左侧桡骨远端骨折。复查提示骨折线未累及关节面。', true],
  ['5.9.4.f', '左肱骨骨折。复查见左侧肱骨骨折。', true],
  ['5.9.4.f', '未见右侧胫骨中段骨折，另见左侧胫骨中段骨折。', true],
  ['5.9.4.f', '左桡骨远端骨折。未见左尺骨茎突骨折。', true],
  ['5.9.4.f', '左肱骨骨折，另见多处软组织挫伤。', true],
  ['5.9.4.f', '右侧股骨颈骨折。已行左侧髋关节置换术。', true],
  ['5.9.4.f', '影像未见左侧肱骨骨折。', null],
  ['5.9.4.f', '不能排除左胫骨中段骨折。', null],
  ['5.9.4.f', '左侧肱骨骨折？', null],
  ['5.9.4.f', '左肱骨骨折。未见左侧肱骨骨折。', null],
  ['5.9.4.f', '左肱骨骨折。复查未见骨折。', null],
  ['5.9.4.f', '左肱骨骨折。左上臂CT未见明显骨折。', null],
  ['5.9.4.f', '左肱骨骨折。右上臂CT未见骨折。', true],
  ['5.9.4.f', '左肱骨骨折。头部CT未见骨折。', true],
  ['5.9.4.f', '左肱骨骨折。上述骨折与本次无关。', null],
  ['5.9.4.f', '左肱骨骨折。后报告称骨折诊断已排除。', null],
  ['5.9.4.f', '左侧桡骨远端骨折。该处仍未证实。', null],
  ['5.9.4.f', '既往损伤史：\n左侧肱骨骨折。', null],
  ['5.9.4.f', '左肱骨陈旧性骨折。', null],
  ['5.9.4.f', '本次仅评胸部。影像显示左肱骨骨折。', null],
  ['5.9.4.f', '上肢不纳入本次鉴定范围。影像显示左肱骨骨折。', null],
  ['5.9.4.f', '5月1日摔伤。影像见左肱骨骨折。6月1日又摔伤。复查见左肱骨骨折。', null],
  ['5.9.4.f', '左侧肱骨骨折。另一次交通事故受伤。左侧肱骨骨折。', null],
  ['5.9.4.f', '右腓骨下端轻微撕脱性骨折（无功能障碍）。', null],
  ['5.9.4.f', '右腓骨下端撕脱性骨折。', null],
  ['5.9.4.f', '右腓骨下端撕脱性骨折伴功能障碍。', null],
  ['5.9.4.f', '左胫骨骨皮质见刺痕。', null],
  ['5.9.4.f', '左肱骨骨折。复查提示肱骨轻微撕脱性骨折。', null],
  ['5.9.4.f', '左侧桡骨远端骨折，左尺骨茎突骨折。', null],
  ['5.9.4.f', '左胫骨上段骨折，左胫骨下段骨折。', null],
  ['5.9.4.f', '左侧肱骨骨折。右侧肱骨骨折。', null],
  ['5.9.4.f', '左侧肱骨骨折，另见左侧肱骨骨折。', null],
  ['5.9.4.f', '右胫腓骨骨折。', null],
  ['5.9.4.f', '左股骨骨折。检查提示该处为粉碎性骨折。', null],
  ['5.9.4.f', '左侧桡骨远端骨折，可能累及关节面。', null],
  ['5.9.4.f', '左侧桡骨远端骨折。复查提示骨折线累及关节面。', null],
  ['5.9.4.f', '左侧桡骨远端骨折。复查提示骨折线延伸至关节面。', null],
  ['5.9.4.f', '左侧桡骨远端骨折。复查提示骨折线累及关节面，既往无类似外伤。', null],
  ['5.9.4.f', '左侧桡骨远端骨折，关节面是否受累尚不明确。', null],
  ['5.9.4.f', '左胫骨平台骨折。', null],
  ['5.9.4.f', '右侧股骨颈骨折。右股骨头已行假体置换。', null],
  ['5.9.4.f', '门诊记录，2025-01-02因车祸受伤，X线示左股骨颈骨折，随后行左侧人工全髋置换术。', null],
  ['5.9.4.f', '门诊记录，2025-01-02因车祸受伤，X线示左股骨颈骨折，随后行左侧半髋置换术。', null],
  ['5.9.4.f', '未见左肱骨骨折，2025-01-02因车祸受伤，检查显示左肱骨骨折。', null],
  ['5.9.4.f', '左侧肱骨骨折。复查提示骺板断裂。', null],
  ['5.9.4.f', '左胫骨骨折。复查提示畸形愈合。', null],
  ['5.9.4.f', '左胫骨骨折。复查提示骨折不愈合。', null],
];

for (const [id, description, expected] of scenarios) {
  test(`${id} ${description}`, () => {
    const { facts } = normalizeExtractedFacts(emptyExtraction, { description });
    const result = evaluateConditionLogic(clause(id).conditionLogic, facts);
    assert.strictEqual(result.met, expected);
    if (expected === null) return;
    assert.ok(result.factIds.length);
    for (const factId of result.factIds) {
      const fact = scopedFacts(facts).find(item => item.id === factId);
      assert.ok(fact);
      assert.ok(result.evidence.includes(fact.evidence));
      checkQuote(description, fact);
    }
    if (expected === true) assert.ok(retrieveClauses('injury', description, 40, facts).some(item => item.id === id));
  });
}

test('dated findings on opposite sides cannot be pooled', () => {
  const description = '2026-01-02因车祸受伤。\n左侧气胸伴左肺萎陷55%。\n2026-06-02另一次车祸受伤。\n右侧血胸伴右肺萎陷55%。';
  const { facts } = normalizeExtractedFacts(emptyExtraction, { description });
  assert.deepEqual(scopedFacts(facts).map(fact => fact.eventId).sort(), ['E1', 'E2']);
  assert.equal(evaluateConditionLogic(clause('5.6.2.g').conditionLogic, facts).met, null);
});

test('a conclusion copied inside a dated block cannot link an earlier undated finding to that date', () => {
  const description = '牙折2枚。\n2026-01-02因车祸受伤。\n鉴定意见：\n牙折2枚。';
  const { facts } = normalizeExtractedFacts(emptyExtraction, { description });
  const [finding] = scopedFacts(facts);
  assert.match(finding.eventId, /^U\d+$/);
  assert.equal(finding.sourceRefs[0].normalizedStart, 0);
  assert.equal(evaluateConditionLogic(clause('5.2.4.q').conditionLogic, facts).met, null);
});

test('model-proposed scoped facts do not enter rules or the clinical fact fallback', () => {
  const description = '牙折1枚。';
  const proposal = { id: 'unsupported', eventId: 'E1', field: 'scoped_tooth_fracture_count',
    value: '牙折2枚', evidence: '牙折1枚', source: 'description', certainty: 'reported' };
  const { facts } = normalizeExtractedFacts({ ...emptyExtraction, facts: [proposal] }, { description });
  assert.equal(scopedFacts(facts).length, 1);
  assert.equal(scopedFacts(facts)[0].value, '牙折1枚');
  assert.ok(!facts.some(fact => fact.value === proposal.value || fact.eventId === proposal.eventId));
  assert.equal(evaluateConditionLogic(clause('5.2.4.q').conditionLogic, facts).met, null);
});

test('scoped quotes cannot stand in for findings required by a different rule', () => {
  const description = '右侧气胸伴右肺萎陷30%。';
  const { facts } = normalizeExtractedFacts(emptyExtraction, { description });
  const legacyLogic = { annotation: 'explicit', logic: {
    op: 'condition', sourceText: '气胸', conditionText: '气胸', factMatch: { field: 'clinical_finding', values: ['气胸'] },
  } };
  assert.equal(scopedFacts(facts).length, 1);
  assert.equal(evaluateConditionLogic(legacyLogic, scopedFacts(facts)).met, null);
});

function woundLeaf(id, field, facts) {
  const logic = clause(id).conditionLogic;
  const leaf = logic.logic.predicate?.field === field ? logic.logic
    : logic.logic.children?.find(item => item.predicate?.field === field);
  assert.ok(leaf);
  return evaluateConditionLogic({ ...logic, logic: leaf }, facts);
}

const woundLengthFacts = facts => facts.filter(fact => fact.field === 'wound_length_cm');
const lengthProposal = (value, evidence) => ({ id: 'model-length', field: 'wound_length_cm', value, evidence,
  source: 'description', certainty: 'reported' });

for (const [description, wholeLength] of [
  ['额部跨发际线见线状瘢痕长7.4cm。', 7.4],
  ['额部创口长7.6cm，该创口跨过发际线。', 7.6],
  ['额部发际处见7.3cm长线状瘢痕，其中面部瘢痕长2.4cm。', 7.3],
  ['额部发际处创口长7.6cm，其中2.3cm位于面部。', 7.6],
  ['额部创口长6.8cm，并非全部位于面部，其中面部创口长2.4cm。', 6.8],
]) {
  test(`a regional limit cannot use the whole measurement: ${description}`, () => {
    const { facts } = normalizeExtractedFacts(emptyExtraction, { description });
    const whole = woundLengthFacts(facts).find(fact => fact.value === wholeLength);
    assert.equal(whole?.crossRegionTotal, true);
    assert.ok(whole.sourceRefs.some(ref => /跨|其中|并非全部/u.test(ref.evidence)));
    assert.notEqual(evaluateConditionLogic(clause('5.2.4.a').conditionLogic, facts).met, true);
    assert.ok(!facts.some(fact => fact.field === 'cross_region_wound_ratio'));
  });
}

test('only the independently measured face segment supports the single-wound requirement', () => {
  const description = '额部发际处见7.2cm长线状瘢痕，其中面部瘢痕长4.6cm。';
  const { facts } = normalizeExtractedFacts(emptyExtraction, { description });
  const face = woundLeaf('5.2.4.a', 'wound_length_cm', facts);
  assert.equal(face.met, true);
  assert.deepEqual(face.factIds.map(id => facts.find(fact => fact.id === id).value), [4.6]);
});

test('a whole wound is not added to its own face segment or to a regional accumulation', () => {
  const description = '额部发际处见7.3cm长线状瘢痕，其中面部瘢痕长2.4cm，另见眉弓瘢痕长1.9cm。';
  const { facts } = normalizeExtractedFacts(emptyExtraction, { description });
  const [aggregate] = facts.filter(fact => fact.field === 'aggregate_wound_length_cm' && fact.aggregateRegion === 'face');
  assert.equal(aggregate?.value, 4.3);
  assert.deepEqual(aggregate.derivedFrom.map(id => facts.find(fact => fact.id === id).value).sort(), [1.9, 2.4]);
  assert.notEqual(woundLeaf('5.2.4.a', 'aggregate_wound_length_cm', facts).met, true);
});

test('scalp, neck and ear requirements cannot use a whole cross-region wound', () => {
  for (const [id, field, description] of [
    ['5.1.4.a', 'aggregate_wound_length_cm', '头皮创口总长9.3cm，跨过发际线。'],
    ['5.5.4.a', 'wound_length_cm', '颈前部创口长6.2cm，跨越面部与颈部交界。'],
    ['5.2.4.l', 'aggregate_wound_length_cm', '左耳廓见一条横跨耳廓及头皮的创口总长9cm，其中耳廓创口长3cm。'],
  ]) {
    const { facts } = normalizeExtractedFacts(emptyExtraction, { description });
    assert.ok(facts.some(fact => fact.crossRegionTotal));
    assert.notEqual(woundLeaf(id, field, facts).met, true);
  }
});

test('a model quote of the same measurement cannot remove the whole-wound flag', () => {
  const description = '额部创口长7.2cm，跨过发际线。';
  const proposal = lengthProposal(7.2, '额部创口长7.2cm');
  const { facts } = normalizeExtractedFacts({ ...emptyExtraction, facts: [proposal] }, { description });
  const [whole] = woundLengthFacts(facts);
  assert.equal(woundLengthFacts(facts).length, 1);
  assert.ok(whole.sourceFactIds.includes(proposal.id));
  assert.equal(whole.crossRegionTotal, true);
  assert.notEqual(woundLeaf('5.2.4.a', 'wound_length_cm', facts).met, true);
});

test('the same numerical length at two positions does not erase an independent face wound', () => {
  const description = '额部创口长5.2cm，跨过发际线。另见额部创口长5.2cm。';
  const proposal = lengthProposal(5.2, '额部创口长5.2cm');
  const { facts } = normalizeExtractedFacts({ ...emptyExtraction, facts: [proposal] }, { description });
  assert.equal(woundLengthFacts(facts).length, 2);
  const result = woundLeaf('5.2.4.a', 'wound_length_cm', facts);
  assert.equal(result.met, true);
  const [local] = woundLengthFacts(facts).filter(fact => !fact.crossRegionTotal);
  assert.deepEqual(result.factIds, [local.id]);
  assert.equal(local.sourceRefs[0].normalizedStart, canonical(description).lastIndexOf(local.evidence));
});

test('an independent wound joined in the same sentence keeps its own measurement', () => {
  for (const description of [
    '前额创口长4.8cm，另有头皮创口长1.1cm。',
    '额部跨发际线瘢痕长7.3cm及前额瘢痕长5.1cm。',
    '额部创口长5.2cm，未跨过发际线。',
  ]) {
    const { facts } = normalizeExtractedFacts(emptyExtraction, { description });
    const result = woundLeaf('5.2.4.a', 'wound_length_cm', facts);
    assert.equal(result.met, true);
    assert.ok(result.factIds.every(id => !facts.find(fact => fact.id === id).crossRegionTotal));
  }
});

test('the whole measurement is still usable where a body region is not required', () => {
  const { facts } = normalizeExtractedFacts(emptyExtraction, { description: '额部创口长12cm，跨过发际线。' });
  const result = woundLeaf('5.11.3.b', 'wound_length_cm', facts);
  assert.equal(result.met, true);
  assert.equal(woundLengthFacts(facts).find(fact => result.factIds.includes(fact.id)).crossRegionTotal, true);
});

test('the original face–scalp calculation still accepts two linked measurements, not independent wounds', () => {
  const linked = '额部见8cm长创口，其中面部创口长3cm，头皮创口长5cm。';
  const independent = '面部创口长3cm，另有头皮创口长5cm。';
  const { facts } = normalizeExtractedFacts(emptyExtraction, { description: linked });
  assert.notEqual(woundLeaf('5.2.4.a', 'wound_length_cm', facts).met, true);
  const ratio = woundLeaf('5.2.4.a', 'cross_region_wound_ratio', facts);
  assert.equal(ratio.met, true);
  const [derived] = ratio.factIds.map(id => facts.find(fact => fact.id === id));
  assert.equal(derived.value, 3 / 4.5 + 5 / 8);
  assert.deepEqual(derived.derivedFrom.map(id => facts.find(fact => fact.id === id).value).sort(), [3, 5]);
  const separate = normalizeExtractedFacts(emptyExtraction, { description: independent }).facts;
  assert.notEqual(evaluateConditionLogic(clause('5.2.4.a').conditionLogic, separate).met, true);
});

test('the original ear–scalp calculation keeps its whole wound as a check, not a segment', () => {
  const description = '左耳廓见一条横跨耳廓及头皮的创口总长9cm，其中耳廓创口长3cm，头皮创口长6cm。';
  const { facts } = normalizeExtractedFacts(emptyExtraction, { description });
  assert.notEqual(woundLeaf('5.2.4.l', 'aggregate_wound_length_cm', facts).met, true);
  const ratio = woundLeaf('5.2.4.l', 'ear_scalp_wound_ratio', facts);
  assert.equal(ratio.met, true);
  const [derived] = ratio.factIds.map(id => facts.find(fact => fact.id === id));
  assert.equal(derived.value, 3 / 6 + 6 / 8);
});

const noGrade = { status: 'insufficient', grade: null, summary: '', reasoning: '', facts: [], references: [],
  missingMaterials: [], nextSteps: [], warnings: [] };

async function runAssessment(description, { injuryDate, modelClause, modelQuote, extraction = emptyExtraction } = {}) {
  const calls = [];
  const provider = {
    complete({ name, schema, messages }) {
      calls.push(name);
      if (name === 'fact_extraction') return schema.parse(extraction);
      if (name === 'reference_grade') return schema.parse({ grade: null, clauseId: null, confidence: null, reason: '' });
      assert.equal(name, 'assessment_result');
      if (!modelClause) return schema.parse(noGrade);
      const snapshot = JSON.parse(messages.at(-1).content.split('\n')[1]);
      const selected = modelQuote ? snapshot.facts.find(fact => fact.evidence === modelQuote) : snapshot.facts[0];
      if (modelQuote) assert.ok(selected);
      const evidence = selected?.evidence || '';
      const references = [{ clauseId: modelClause.id, evidence, reasoning: '', relation: 'supports', conditions: [{
        condition: modelClause.conditionLogic.logic.conditionText || modelClause.text,
        evidence, factIds: selected ? [selected.id] : [], met: true,
      }] }];
      return schema.parse({ ...noGrade, status: 'preliminary', grade: modelClause.grade, references });
    },
  };
  const input = requestSchema.parse({ assessmentType: 'injury', description, injuryDate });
  const output = await assess(input, { provider, config: { textModel: 'local-test', visionModel: 'local-test' },
    requestId: 'local-test' });
  return { output: resultSchema.parse(output), calls };
}

for (const [id, description] of [
  ['5.2.4.q', '牙位24、25均折断。'],
  ['5.8.3.a', '影像显示左侧耻骨上支骨折，右侧耻骨下支骨折。'],
  ['5.9.3.b', '影像显示腰椎1–3横突均骨折。'],
  ['5.6.2.g', '双侧气胸伴左肺萎陷50%，右肺萎陷50%。'],
  ['5.6.3.e', '双侧气胸伴左肺萎陷20%，右肺萎陷20%。'],
  ['5.7.2.k', '因腹膜后血肿，已行手术治疗。'],
  ['5.9.4.f', '腕部CT显示左桡骨远端骨折，骨折线未累及关节面。'],
  ['5.9.4.f', '急诊诊断右侧胫骨中段骨折。'],
]) {
  test(`${id} produces the expected grade and matching source in a full assessment`, async () => {
    const { output } = await runAssessment(description);
    assert.equal(output.status, 'preliminary');
    assert.equal(output.grade, clause(id).grade);
    const reference = output.references.find(item => item.id === id && item.relation === 'supports');
    assert.ok(reference);
    assert.ok(reference.conditions.every(condition => condition.met === true && condition.factIds.length));
    for (const condition of reference.conditions) for (const factId of condition.factIds) {
      const fact = scopedFacts(output.facts).find(item => item.id === factId);
      assert.ok(fact);
      assert.equal(condition.evidence, fact.evidence);
      checkQuote(description, fact);
    }
  });
}

test('the assessment cannot adopt a proposed face grade based on a whole cross-region wound', async () => {
  const description = '额部创口长7.2cm，跨过发际线。';
  const modelClause = clause('5.2.4.a');
  const extraction = { ...emptyExtraction, facts: [lengthProposal(7.2, '额部创口长7.2cm')] };
  const { output, calls } = await runAssessment(description, { modelClause, extraction });
  assert.ok(calls.includes('assessment_result'));
  assert.notEqual(output.grade, modelClause.grade);
  assert.ok(!output.references.some(item => item.id === modelClause.id && item.relation === 'supports'));
});

test('the assessment quotes the three fracture sites in the original multi-finding report', async () => {
  const description = '复查胸椎三维CT显示肩部挫伤及T4、T5和T6右侧横突均骨折。';
  const { output } = await runAssessment(description);
  const reference = output.references.find(item => item.id === '5.9.3.b' && item.relation === 'supports');
  assert.equal(output.grade, '轻伤一级');
  assert.ok(reference);
  const proofIds = reference.conditions.filter(condition => condition.met === true).flatMap(condition => condition.factIds);
  const proof = output.facts.find(fact => proofIds.includes(fact.id) && fact.field === 'scoped_vertebral_process_fracture_count');
  assert.ok(proof);
  assert.ok(proof.evidence.includes('T4、T5和T6'));
  checkQuote(description, proof);
});

test('conflicting measurements cannot be turned into a confirmed grade by the proposed result', async () => {
  const modelClause = clause('5.6.2.g');
  const { output, calls } = await runAssessment('左侧气胸伴左肺萎陷76%。复查见左侧气胸伴左肺萎陷48%。', { modelClause });
  assert.ok(calls.includes('assessment_result'));
  assert.equal(output.grade, null);
  assert.ok(!output.references.some(item => item.id === modelClause.id && item.relation === 'supports'));
});

test('selection of a different injury date cannot reuse a stronger finding', async () => {
  const description = '2025-01-02因车祸受伤。\n腰椎1–3横突均骨折。\n2025-06-02另一次车祸受伤。\n腰椎2横突骨折。';
  const first = await runAssessment(description, { injuryDate: '2025-01-02' });
  assert.equal(first.output.grade, '轻伤一级');
  assert.equal(first.output.references.find(item => item.id === '5.9.3.b').evidence, '腰椎1–3横突均骨折');
  const second = await runAssessment(description, { injuryDate: '2025-06-02', modelClause: clause('5.9.3.b') });
  assert.ok(second.calls.includes('assessment_result'));
  assert.equal(second.output.grade, null);
  assert.ok(!second.output.references.some(item => item.id === '5.9.3.b' && item.relation === 'supports'));
});

test('the unchanged acetabular fracture branch still supports its grade', async () => {
  const description = '影像检查显示髋臼骨折。';
  const finding = { field: 'clinical_finding', value: '髋臼骨折', certainty: 'reported', source: 'description',
    evidence: '影像检查显示髋臼骨折' };
  const extraction = { ...emptyExtraction, facts: [finding] };
  const { output } = await runAssessment(description, { extraction });
  assert.equal(output.grade, '轻伤一级');
  assert.ok(output.references.some(item => item.id === '5.8.3.a' && item.relation === 'supports'));
});

test('a diagnosis after the dated injury within a longer record keeps its exact source position', async () => {
  const description = '门诊记录，2025-01-02因车祸受伤，左小腿及左踝关节CT示左胫骨中段骨折。';
  const { output } = await runAssessment(description);
  assert.equal(output.grade, '轻伤二级');
  const reference = output.references.find(item => item.id === '5.9.4.f' && item.relation === 'supports');
  assert.ok(reference);
  const [id] = reference.conditions.flatMap(condition => condition.factIds);
  const proof = output.facts.find(fact => fact.id === id);
  checkQuote(description, proof);
  assert.equal(proof.eventId, 'E1');
  assert.equal(proof.sourceRefs[0].normalizedStart, description.indexOf('2025-01-02'));
});

test('long-bone reports from a different dated injury cannot cancel or support this one', async () => {
  const description = '2025-01-02因车祸受伤。\n左桡骨远端骨折。\n2025-06-02另一次车祸受伤。\n左桡骨远端骨折，可能累及关节面。';
  const first = await runAssessment(description, { injuryDate: '2025-01-02' });
  assert.equal(first.output.grade, '轻伤二级');
  const reference = first.output.references.find(item => item.id === '5.9.4.f' && item.relation === 'supports');
  assert.equal(reference?.evidence, '左桡骨远端骨折');
  const second = await runAssessment(description, { injuryDate: '2025-06-02' });
  assert.equal(second.output.grade, null);
  assert.ok(!second.output.references.some(item => item.id === '5.9.4.f' && item.relation === 'supports'));
});

test('the same statement in two dated reports retains separate positions and blocks both ordinary grades', async () => {
  const followUp = '骨折线累及关节面';
  const description = `2025-01-02因车祸受伤。左桡骨远端骨折。${followUp}。2025-06-02另一次车祸受伤。左尺骨骨干骨折。${followUp}。`;
  const { facts } = normalizeExtractedFacts(emptyExtraction, { description });
  const guards = scopedFacts(facts).filter(fact => fact.evidence === followUp);
  assert.deepEqual(guards.map(fact => fact.eventId).sort(), ['E1', 'E2']);
  assert.deepEqual(guards.map(fact => fact.sourceRefs[0].normalizedStart).sort((a, b) => a - b),
    [description.indexOf(followUp), description.lastIndexOf(followUp)]);
  for (const injuryDate of ['2025-01-02', '2025-06-02']) {
    const { output } = await runAssessment(description, { injuryDate });
    assert.equal(output.grade, null);
    assert.ok(!output.references.some(item => item.id === '5.9.4.f' && item.relation === 'supports'));
  }
});

for (const followUp of ['复查提示骨折线累及关节面。', '复查未见左桡骨远端骨折。']) {
  test(`the model cannot bypass a long-bone safeguard by leaving out the follow-up: ${followUp}`, async () => {
    const modelClause = clause('5.9.4.f');
    const modelQuote = '左桡骨远端骨折';
    const description = `${modelQuote}。${followUp}`;
    const { output, calls } = await runAssessment(description, { modelClause, modelQuote });
    assert.ok(calls.includes('assessment_result'));
    assert.equal(output.grade, null);
    assert.ok(output.references.some(item => item.id === modelClause.id && item.relation === 'incomplete'));
    assert.ok(!output.references.some(item => item.id === modelClause.id && item.relation === 'supports'));
  });
}

test('the unchanged patella branch can still establish the same grade', async () => {
  const description = '影像检查显示左侧髌骨骨折。';
  const extraction = { ...emptyExtraction, facts: [{ field: 'clinical_finding', value: '髌骨骨折',
    certainty: 'reported', source: 'description', evidence: '影像检查显示左侧髌骨骨折' }] };
  const { output } = await runAssessment(description, { extraction });
  assert.equal(output.grade, '轻伤二级');
  const reference = output.references.find(item => item.id === '5.9.4.f' && item.relation === 'supports');
  assert.ok(reference?.evidence.includes('髌骨骨折'));
  assert.ok(!output.facts.some(fact => fact.field === 'scoped_limb_bone_fracture'));
});

test('a coordinated fracture exclusion covers both listed sites, not just the first', async () => {
  const modelClause = clause('5.9.4.f');
  const counterexample = '右桡骨远端骨折，复查排除左桡骨远端、右桡骨远端骨折。';
  for (const [description, expected] of [
    [counterexample, null],
    ['左桡骨远端骨折。复查排除右桡骨远端及左桡骨远端骨折。', null],
    ['右桡骨远端骨折。复查排除左桡骨远端骨折与右桡骨远端骨折。', null],
    ['右桡骨远端骨折。复查排除左桡骨远端、右侧远端骨折。', null],
    ['右胫骨骨干骨折。复查排除左桡骨远端、右桡骨远端骨折。', true],
  ]) {
    const { facts } = normalizeExtractedFacts(emptyExtraction, { description });
    assert.equal(evaluateConditionLogic(modelClause.conditionLogic, facts).met, expected, description);
  }
  const { output } = await runAssessment(counterexample, { modelClause });
  assert.equal(output.grade, null);
  assert.ok(!output.references.some(item => item.id === modelClause.id && item.relation === 'supports'));
});

test('a unilateral examination name retains the side of an otherwise unsided fracture', async () => {
  const modelClause = clause('5.9.4.f');
  const counterexample = '左小腿X线显示胫骨骨干骨折，右小腿X线显示胫骨骨干骨折。';
  for (const [description, expected] of [
    [counterexample, null],
    ['左上臂CT显示肱骨骨干骨折。复查左上臂CT显示左肱骨骨干骨折。', true],
    ['左前臂X线显示桡骨骨干骨折。右前臂X线未见桡骨骨干骨折。', true],
    ['左前臂X线显示桡骨骨干骨折。左前臂X线未见桡骨骨干骨折。', null],
    ['左小腿及右膝CT显示胫骨骨干骨折。右小腿CT未见胫骨骨干骨折。', null],
  ]) {
    const { facts } = normalizeExtractedFacts(emptyExtraction, { description });
    assert.equal(evaluateConditionLogic(modelClause.conditionLogic, facts).met, expected, description);
    for (const fact of scopedFacts(facts)) checkQuote(description, fact);
  }
  const { output } = await runAssessment(counterexample, { modelClause });
  assert.equal(output.grade, null);
  assert.ok(!output.references.some(item => item.id === modelClause.id && item.relation === 'supports'));
});
