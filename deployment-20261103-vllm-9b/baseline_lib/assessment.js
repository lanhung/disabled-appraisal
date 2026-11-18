import crypto from 'node:crypto';
import { extractionSchema, factExtractionSchema, providerResultSchema } from './contracts.js';
import { FACT_EXTRACTION_PROMPT, FACT_EXTRACTION_PROMPT_VERSION, STRUCTURED_MEASUREMENT_PROMPT,
  SELECTED_INJURY_DATE_CONTEXT_PROMPT } from './prompts.js';
import { normalizeExtractedFacts } from './facts.js';
import { catalogContext, catalogs, retrieveClauses } from './catalog.js';
import { evaluateConditionLogic, gradeOrder, includesEvidence, normalizeResult } from './results.js';
import { ServiceError } from './provider.js';
import { ASSESSMENT_CODE_VERSION, createAssessmentSnapshot } from './assessment-snapshot.js';
import { logicFactFields } from './condition-fields.js';
import { normalizeForMatching } from './text-normalization.js';
import { eventIdForSelectedInjuryDate } from './event-date-logic.js';

const genericConditionTerms = new Set(['一侧', '双侧', '或者', '以及', '损伤', '外伤', '骨折', '治疗', '手术',
  '术后', '功能', '障碍', '症状', '体征', '程度', '以上', '以下', '影响', '异常', '形成', '缺失', '骨骨', '骨骨折']);
const genericEnglishConditionTerms = new Set(['condition', 'damage', 'finding', 'fracture', 'fractured', 'fractures',
  'function', 'impairment', 'injuries', 'injury', 'loss', 'sign', 'signs', 'surgery', 'symptom', 'symptoms', 'treatment']);

function conditionEvidenceTerms(node, terms = []) {
  for (const value of [node?.sourceText, node?.conditionText,
    ...(node?.factMatch?.values || []), ...(node?.factMatch?.valueIncludes || []),
    ...(node?.factMatch?.evidenceAliases || [])]) {
    if (typeof value === 'string' && value.trim()) terms.push(value);
  }
  for (const child of node?.children || []) conditionEvidenceTerms(child, terms);
  return terms;
}

function meaningfulTerms(value) {
  const normalized = normalizeForMatching(value).toLowerCase();
  const terms = new Set();
  for (const run of normalized.matchAll(/\p{Script=Han}+/gu)) {
    const characters = [...run[0]];
    for (let length = 2; length <= Math.min(6, characters.length); length += 1) {
      for (let start = 0; start + length <= characters.length; start += 1) {
        const term = characters.slice(start, start + length).join('');
        if (!genericConditionTerms.has(term)) terms.add(term);
      }
    }
  }
  for (const token of normalized.match(/[a-z]+/gu) || []) {
    if (token.length >= 4 && !genericEnglishConditionTerms.has(token)) terms.add(token);
  }
  return terms;
}

function hasQuotedConditionEvidence(clause, facts) {
  const terms = conditionEvidenceTerms(clause.conditionLogic.logic)
    .filter(term => normalizeForMatching(term).length >= 4);
  const clauseTerms = new Set(terms.flatMap(term => [...meaningfulTerms(term)]));
  const fields = logicFactFields(clause.conditionLogic.logic);
  return facts.some(fact => {
    if (fact.gradeEligible === false || fact.source !== 'description' || fact.verification !== 'quoted'
      || !fields.has(fact.field)) return false;
    if (terms.some(term => includesEvidence(fact.evidence, term))) return true;
    return [...meaningfulTerms(`${fact.value ?? ''} ${fact.evidence || ''}`)].some(term => clauseTerms.has(term));
  });
}

const rules = `你提供的是基于已提交事实和给定标准的辅助评估，不是正式司法鉴定意见。
必须区分损伤程度与致残等级，不得混用标准。只使用下方提供的官方条款与总则，不得凭记忆编造编号、阈值、标准正文或医学事实。
对于《人体损伤程度鉴定标准》，不得仅因致伤机制属于化学中毒、毒物中毒或非机械性因素就断言不适用该标准，除非给定官方原文明确排除该机制。若提交事实无法对应具体条款，只说明缺少明确条款依据或事实不足，不作标准范围外结论。
<verified_facts> 是唯一事实依据；不得重新读取原始病历、图片或从常识补充事实。facts 输出必须为空数组，事实由前一阶段产生并在最终结果中保留。
若 requiresReview 为 true 或 conflicts 非空，不得输出等级；说明哪些事实存在冲突并需要复核。关键事实不确定时不能作为已确认的条款条件。
references 必须引用给定 clauseId。逐条按官方条款附带的 conditionLogic 逻辑树列出必要条件组；all 的每个子组均为必要条件，且每个直接支持该条款的事实必须具有同一个已知 eventId；不同 eventId 或缺失 eventId 的事实不得拼成一个 all 条件。any 组只需一个有依据的分支。not 组表示其唯一子条件必须被来源明确排除；未提及、疑似或无法核实的例外状态保持 unknown，不得将材料沉默当作排除。每项 condition 的 factIds 必须引用 <verified_facts> 中直接支持该组或分支的事实 ID，evidence 使用对应事实的原文依据；不得合并遗漏必需组，不得添加逻辑树之外的组。annotation 为 opaque 的条款不能作为 supports，条件状态必须保持未知。缺少条件或事件归属为未知时 met=null；只有明确来源事实支持时才可为 true；不能从未提及推断 false。模型提供的 met 仅是建议，最终状态由服务端依据 conditionLogic、规范事实字段和值、eventId、predicate 及引文重新计算。
不得只因出现“骨折”“手术”“瘢痕”等词便输出等级。不能从“未提到”推断“没有”，不能假设具体长度、面积、根数、功能比例、肌力、视听力、年龄、鉴定时机或伤病因果关系。
有可靠事实且满足完整条款条件时 status 为 preliminary，grade 必须完全等于相应条款的 grade 字段；必要资料缺失时 status 为 insufficient 且 grade=null；有关键冲突时 status 为 needs_review 且 grade=null；标准不适用时 status 为 not_applicable 且 grade=null。
不得仅凭材料不足输出“不构成伤残”或“轻微伤”。不得输出无校准依据的概率、赔偿金额、诊疗或用药建议。缺失资料和不确定性应客观、简洁说明。
必须返回完整 JSON 对象，含 status、grade、summary、reasoning、facts、references、missingMaterials、nextSteps、warnings，不要返回 Markdown 或 JSON 之外文字。`;
const targetedReviewInstruction = '只复核待核条件和给定候选条款，不重新分析无关事实；候选条件及事实均不构成等级结论，服务端将重新核验每个条件。';
export const ASSESSMENT_PROMPT_VERSION = crypto.createHash('sha256')
  .update(`${rules}\n${targetedReviewInstruction}`, 'utf8').digest('hex');

export async function assess(input, { provider, config, signal, requestId, onMetrics }) {
  const complete = request => provider.complete({ ...request, onMetrics });
  let recognizedText = '';
  const extractionWarnings = [];
  if (input.images.length) {
    const extraction = await complete({ model: config.visionModel, schema: extractionSchema,
      name: 'medical_report_transcription', signal, messages: [
        { role: 'system', content: '只转录报告图片中能够清晰辨认的文字，不进行伤情诊断，不猜测模糊数字、单位或阴阳性。无法辨认时保留为空并列入issues。X光或CT影像本身不含可读诊断文字时说明需要正式影像报告，不自行诊断。每张图片输出一项pages，含imageIndex（从1开始）、text、issues。只输出完整JSON。' },
        { role: 'user', content: input.images.flatMap((image, index) => [
          { type: 'text', text: `图片 ${index + 1}` },
          { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } },
        ]) },
      ],
    });
    const pages = extraction.pages.filter(page => page.imageIndex <= input.images.length);
    recognizedText = pages.map(page => `【图片${page.imageIndex}】\n${page.text}`).join('\n\n');
    extractionWarnings.push(...pages.flatMap(page => page.issues.map(issue => `图片${page.imageIndex}：${issue}`)));
    if (pages.length !== input.images.length) extractionWarnings.push('部分图片没有得到完整转录，请核对或补充文字报告。');
  }

  const factResponse = await complete({ model: config.textModel, schema: factExtractionSchema,
    name: 'fact_extraction', signal, messages: [
      { role: 'system', content: `${FACT_EXTRACTION_PROMPT}\n\n${STRUCTURED_MEASUREMENT_PROMPT}${input.injuryDate
        ? `\n\n${SELECTED_INJURY_DATE_CONTEXT_PROMPT}` : ''}\n\n输出版本：${FACT_EXTRACTION_PROMPT_VERSION}` },
      { role: 'user', content: JSON.stringify({ description: input.description, recognizedText,
        ...(input.injuryDate ? { assessmentContext: { selectedInjuryDate: input.injuryDate } } : {}) }) },
    ],
  });
  const extracted = normalizeExtractedFacts(factResponse, { description: input.description, recognizedText });
  const assessmentEventId = eventIdForSelectedInjuryDate(extracted.facts, input.injuryDate);
  const factsInAssessmentScope = facts => assessmentEventId
    ? facts.filter(fact => !fact.eventId || fact.eventId === assessmentEventId) : facts;
  extractionWarnings.push(...(extracted.warnings || []));
  const analysisSnapshot = createAssessmentSnapshot(input, extracted, config, {
    factPromptVersion: FACT_EXTRACTION_PROMPT_VERSION,
    assessmentPromptVersion: ASSESSMENT_PROMPT_VERSION,
    codeVersion: config.codeVersion || process.env.APP_CODE_VERSION || process.env.GIT_COMMIT || ASSESSMENT_CODE_VERSION,
  });
  const sourceText = `${input.description}\n${recognizedText}`;
  let clauses = retrieveClauses(input.assessmentType, extracted.scopeText || sourceText, 40, extracted.facts);
  const model = config.textModel;
  const resultContext = { clauses, recognizedText, extractionWarnings, requestId, model,
    extractedFacts: extracted.facts, conflicts: extracted.conflicts, requiresReview: extracted.requiresReview,
    reviewReasons: extracted.reviewReasons,
    factMissingMaterials: extracted.missingMaterials, factAudit: extracted.factAudit, analysisSnapshot, assessmentEventId };
  const deterministicSeed = {
    status: 'insufficient', grade: null, summary: '现有材料不足以形成可靠的等级评估。',
    reasoning: '等待服务端依据来源核验后的事实和完整条款条件计算。', facts: [], references: [],
    missingMaterials: [], nextSteps: [], warnings: [],
  };
  const deterministicResult = normalizeResult(deterministicSeed, input, resultContext);
  const conflictReview = deterministicResult.status === 'needs_review';
  if (conflictReview) return deterministicResult;

  const pendingReferences = deterministicResult.references.filter(reference => reference.grade
    && reference.relation === 'incomplete' && reference.conditions.some(condition => condition.met === true)
    && reference.conditions.some(condition => condition.met === null));
  const deterministicFacts = factsInAssessmentScope(deterministicResult.facts);
  const availableFactFields = new Set(deterministicFacts.filter(fact => fact.gradeEligible !== false)
    .map(fact => fact.field));
  const currentGradeRank = gradeOrder[input.assessmentType].indexOf(deterministicResult.grade);
  const semanticCandidates = clauses.filter(clause => {
    if (!clause.grade || clause.conditionLogic?.annotation !== 'explicit'
      || ![...logicFactFields(clause.conditionLogic.logic)].some(field => availableFactFields.has(field))
      || currentGradeRank >= 0 && gradeOrder[input.assessmentType].indexOf(clause.grade) >= currentGradeRank) return false;
    const evaluation = evaluateConditionLogic(clause.conditionLogic, deterministicFacts);
    return evaluation.met === true || evaluation.met === null
      && (evaluation.factIds.length > 0 || hasQuotedConditionEvidence(clause, deterministicFacts));
  });
  const pendingIds = new Set([...pendingReferences.map(reference => reference.id),
    ...semanticCandidates.map(clause => clause.id)]);
  if (!pendingIds.size) return deterministicResult;
  const reviewClauses = catalogs[input.assessmentType].clauses.filter(clause => pendingIds.has(clause.id));
  if (!reviewClauses.length) return deterministicResult;
  const pendingFactIds = new Set(pendingReferences.flatMap(reference => reference.conditions
    .flatMap(condition => condition.factIds || [])));
  const reviewFields = new Set(reviewClauses.flatMap(clause => [...logicFactFields(clause.conditionLogic.logic)]));
  const scopedExtractedFacts = factsInAssessmentScope(extracted.facts);
  const factsById = new Map(scopedExtractedFacts.map(fact => [fact.id, fact]));
  const relevantFactIds = new Set(pendingFactIds);
  for (const id of pendingFactIds) for (const parentId of factsById.get(id)?.derivedFrom || []) relevantFactIds.add(parentId);
  const targetedFacts = scopedExtractedFacts.filter(fact => relevantFactIds.has(fact.id)
    || availableFactFields.has(fact.field) && reviewFields.has(fact.field));
  const referencesById = new Map(deterministicResult.references.map(reference => [reference.id, reference]));
  const assessmentInput = {
    assessmentType: input.assessmentType,
    facts: targetedFacts,
    conflicts: [],
    requiresReview: false,
    missingMaterials: extracted.missingMaterials,
    injuryDate: input.injuryDate,
    treatmentStatus: input.treatmentStatus,
    reviewConditions: reviewClauses.map(clause => {
      const reference = referencesById.get(clause.id);
      const conditions = reference?.conditions.filter(condition => condition.met === null);
      return { clauseId: clause.id, conditionLogic: clause.conditionLogic.logic,
        conditions: conditions?.length ? conditions : [{ condition: clause.text, evidence: '', factIds: [], met: null }] };
    }),
  };
  const reviewedIds = new Set(reviewClauses.map(clause => clause.id));
  clauses = [...clauses.filter(clause => !reviewedIds.has(clause.id)), ...reviewClauses];
  resultContext.clauses = clauses;
  resultContext.reviewClauseIds = [...reviewedIds];

  const result = await complete({ model, schema: providerResultSchema, name: 'assessment_result', signal, messages: [
    { role: 'system', content: `${rules}\n\n${targetedReviewInstruction}\n\n本次评估类型：${input.assessmentType}\n官方原文依据：${catalogContext(input.assessmentType, reviewClauses)}` },
    { role: 'user', content: `<verified_facts>\n${JSON.stringify(assessmentInput)}\n</verified_facts>` },
  ] });
  try {
    return normalizeResult(result, input, resultContext);
  } catch (error) {
    if (error.name === 'ZodError') throw new ServiceError(502, 'INVALID_RESULT', '分析结果未通过完整性校验，未生成评估结论，请重试。');
    throw error;
  }
}
