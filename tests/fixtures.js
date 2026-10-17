import { catalogs } from '../gemini/lib/catalog.js';

export const inputs = {
  injury: { assessmentType: 'injury', description: 'CT报告明确记载左侧第3、4肋骨骨折，共2处骨折，均为本次外伤导致，无既往损伤。', images: [], injuryDate: '', treatmentStatus: 'stable' },
  disability: { assessmentType: 'disability', description: '成年人出院记录明确记载脾部分切除术后，治疗终结，临床效果稳定，无既往损伤。', images: [], injuryDate: '', treatmentStatus: 'stable' },
};

export function providerFixture(type = 'injury') {
  const injury = type === 'injury';
  const quote = injury ? '左侧第3、4肋骨骨折，共2处骨折' : '脾部分切除术后';
  return { status: 'preliminary', grade: injury ? '轻伤二级' : '九级伤残',
    summary: '现有报告明确记载的损伤与所引条款初步相符，仍需专业复核。',
    reasoning: '以报告原文及相应标准条款对照，材料中有明确的必要条件，初步考虑所示等级，不作正式鉴定结论。',
    facts: [{ finding: quote, source: 'description', evidence: quote }],
    references: [{ clauseId: injury ? '5.6.4.b' : '5.9.4.2', evidence: quote,
      reasoning: '报告记录的损伤符合本条文所列条件。', relation: 'supports',
      conditions: [{ condition: injury ? '肋骨骨折2处以上' : '脾部分切除术后', evidence: quote,
        factIds: injury ? ['F1', 'F2'] : ['F1'], met: true }] }],
    missingMaterials: [], nextSteps: ['由具有资质的机构结合完整材料复核。'], warnings: [] };
}

export function resultFixture(type = 'injury', overrides = {}) {
  const generated = { ...providerFixture(type), ...overrides };
  const firstReference = generated.references[0];
  const evidence = firstReference?.evidence || '';
  const fact = { id: 'F1', field: type === 'injury' ? 'injury_type' : 'treatment',
    value: type === 'injury' ? 'rib_fracture' : 'partial_splenectomy', certainty: 'reported', source: 'description',
    evidence, finding: evidence, verification: 'quoted' };
  return {
    ...generated, schemaVersion: 2, assessmentType: type, standard: catalogs[type].standard,
    facts: [fact], conflicts: [], requiresReview: false,
    references: generated.references.map(reference => {
      const referencedClause = catalogs[type].clauses.find(item => item.id === reference.clauseId);
      return { id: reference.clauseId, grade: referencedClause?.grade || '',
      category: referencedClause?.category || '总则与附则', text: referencedClause?.text || reference.clauseId,
      sourceUrl: catalogs[type].standard.sourceUrl,
      evidence: reference.evidence, reasoning: reference.reasoning, relation: reference.relation,
      conditions: reference.conditions.map(condition => ({ ...condition, factIds: ['F1'] })) };
    }),
    recognizedText: '', createdAt: new Date().toISOString(), requestId: 'test-result-' + type, model: 'test-model',
  };
}
