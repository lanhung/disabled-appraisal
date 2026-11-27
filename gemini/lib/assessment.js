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
references 必须引用给定 clauseId。逐条按官方条款附带的 conditionLogic 逻辑树列出必要条件组；all 的每个子组均为必要条件，且每个直接支持该条款的事实必须具有同一个已知 eventId；不同 eventId 或缺失 eventId 的事实不得拼成一个 all 条件。any 组只需一个有依据的分支。not 组表示其唯一子条件必须被来源明确排除；未提及、疑似或无法核实的例外状态保持 unknown，不得将材料沉默当作排除。每项 condition 的 factIds 必须引用 <verified_facts> 中直接支持该组或分支的事实 ID，evidence 使用对应事实的原文依据；不得合并遗漏必需组，不得添加逻辑树之外的组；输出只需保留对结论有决定作用或仍待核的条件组，其余由服务端按事实与 conditionLogic 重算，不必逐组展开。annotation 为 opaque 的条款不能作为 supports，条件状态必须保持未知。缺少条件或事件归属为未知时 met=null；只有明确来源事实支持时才可为 true；不能从未提及推断 false。模型提供的 met 仅是建议，最终状态由服务端依据 conditionLogic、规范事实字段和值、eventId、predicate 及引文重新计算。
不得只因出现“骨折”“手术”“瘢痕”等词便输出等级。不能从“未提到”推断“没有”，不能假设具体长度、面积、根数、功能比例、肌力、视听力、年龄、鉴定时机或伤病因果关系。
有可靠事实且满足完整条款条件时 status 为 preliminary，grade 必须完全等于相应条款的 grade 字段；必要资料缺失时 status 为 insufficient 且 grade=null；有关键冲突时 status 为 needs_review 且 grade=null；标准不适用时 status 为 not_applicable 且 grade=null。
不得仅凭材料不足输出“不构成伤残”或“轻微伤”。不得输出无校准依据的概率、赔偿金额、诊疗或用药建议。缺失资料和不确定性应客观、简洁说明。
输出必须简短，按正式鉴定意见的写法：
- summary 一句话，格式为“依据《人体损伤程度鉴定标准》<条款号>规定，评定为<等级>。”，不超过 80 字；无法鉴别时写“现有材料不足，无法鉴别”，只列关键缺项。
- reasoning 不超过 120 字，只写决定等级的关键事实和条款，不逐条复述条件。
- references 只列决定等级的条款，通常 1–3 条、最多 5 条；每条 reasoning 不超过 40 字；每个条款只列对结论有决定作用或仍待核的 1–3 个条件，每项 condition 不超过 30 字，evidence 只引用最短的必要原句（不超过 60 字）。
- missingMaterials 只列影响定级的关键缺项，最多 5 项、每项不超过 30 字；nextSteps 与 warnings 没有必要时用空数组，有则每项不超过 30 字。
- 不得为了“完整”而展开推理、重复条款原文或罗列无关条件。
必须返回完整 JSON 对象，含 status、grade、summary、reasoning、facts、references、missingMaterials、nextSteps、warnings，不要返回 Markdown 或 JSON 之外文字。`;
const targetedReviewInstruction = '只复核待核条件和给定候选条款，不重新分析无关事实；候选条件及事实均不构成等级结论，服务端将重新核验每个条件。';
export const ASSESSMENT_PROMPT_VERSION = crypto.createHash('sha256')
  .update(`${rules}\n${targetedReviewInstruction}`, 'utf8').digest('hex');

// Y Luo 2026-11-25 决定：预检判定材料不足（insufficient）且 grade-eligible 事实少于 3 条时，
// 不再调用主评估模型（assessment_result），直接返回“无法鉴别”，避免模型在极小输入上生成失控。
const MIN_GRADE_ELIGIBLE_FACTS_FOR_ASSESSMENT = 3;

// Y Luo 2026-11-25 决定：描述超过 600 字按段落/章节分块抽事实，避免单次抽取在长文上失控；短文仍走原单次路径。
const MAX_DESC_CHARS_FOR_SINGLE_EXTRACTION = 600;

// Y Luo 2026-11-25 决定：主评估送评条款压到 15 条（按现有检索/复核顺序取前 15 条），
// 只影响模型提议；服务端仍对全部候选条款做确定性条件重算，条款内容/条件逻辑不变。
export const MAX_ASSESSMENT_CLAUSES = 15;

// T-20261127: 8K 小上下文模式（4B/3080 部署用）。只压缩主评估提示的组装，
// 不改标准、门槛、条件逻辑；服务端仍按完整条款重算。用 COMPACT_ASSESSMENT_CONTEXT=1 开启。
const COMPACT_ASSESSMENT_MAX_CLAUSES = 8;
const COMPACT_ASSESSMENT_MAX_FACTS = 20;
const COMPACT_ASSESSMENT_EVIDENCE_CHARS = 50;
function compactAssessmentEnabled() {
  return process.env.COMPACT_ASSESSMENT_CONTEXT === '1';
}

// 把文本切成长度 ≤ maxLen 的块；各块按顺序拼接后与原字符串完全一致（不丢段、不改原文）。
function chunkTextKeepAll(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let cur = '';
  const flush = () => { if (cur) { chunks.push(cur); cur = ''; } };
  for (const para of text.split(/(?<=\n)/)) {
    if (para.length <= maxLen) {
      if (cur.length + para.length > maxLen) flush();
      cur += para;
      continue;
    }
    flush();
    for (const sent of para.split(/(?<=[。；;！？!?\n])/)) {
      if (sent.length > maxLen) {
        flush();
        for (let i = 0; i < sent.length; i += maxLen) chunks.push(sent.slice(i, i + maxLen));
      } else {
        if (cur.length + sent.length > maxLen) flush();
        cur += sent;
      }
    }
  }
  flush();
  return chunks;
}

// 合并各块抽取结果：事实按 (field,value,evidence,eventId) 去重并保持块顺序；缺失项/冲突去重；需复核取或。
export function mergeExtractedFacts(parts) {
  const merged = { facts: [], missingMaterials: [], conflicts: [], requiresReview: false };
  const seenFacts = new Set();
  const seenMissing = new Set();
  const seenConflicts = new Set();
  for (const part of parts) {
    for (const fact of part?.facts || []) {
      const key = `${fact.field}\u0000${fact.value}\u0000${fact.evidence}\u0000${fact.eventId ?? ''}`;
      if (seenFacts.has(key)) continue;
      seenFacts.add(key);
      merged.facts.push(fact);
    }
    for (const item of part?.missingMaterials || []) {
      const key = JSON.stringify(item);
      if (!seenMissing.has(key)) { seenMissing.add(key); merged.missingMaterials.push(item); }
    }
    for (const item of part?.conflicts || []) {
      const key = JSON.stringify(item);
      if (!seenConflicts.has(key)) { seenConflicts.add(key); merged.conflicts.push(item); }
    }
    merged.requiresReview = merged.requiresReview || Boolean(part?.requiresReview);
  }
  return merged;
}

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

  const sourceText = `${input.description}\n${recognizedText}`;
  const extractionClauses = retrieveClauses(input.assessmentType, sourceText, 40);
  const extractionPhrases = new Map();
  let extractionPhraseCount = 0;
  const collectExtractionPhrases = node => {
    const match = node?.factMatch;
    const phrases = [...new Set([...(match?.values || []), ...(match?.valueIncludes || []),
      ...(match?.evidenceAliases || [])].filter(value => typeof value === 'string' && value.trim()))];
    for (const field of new Set([match?.field, ...(match?.fields || [])].filter(Boolean))) {
      for (const phrase of phrases) {
        if (extractionPhraseCount >= 80) break;
        const values = extractionPhrases.get(field) || new Set();
        if (!values.has(phrase)) {
          values.add(phrase);
          extractionPhrases.set(field, values);
          extractionPhraseCount += 1;
        }
      }
    }
    for (const child of node?.children || []) collectExtractionPhrases(child);
  };
  for (const clause of extractionClauses.slice(0, 15)) collectExtractionPhrases(clause.conditionLogic?.logic);
  const extractionPhraseList = [...extractionPhrases].map(([field, values]) => `${field}: ${[...values].join('|')}`).join('\n');
  const extractionFieldHint = `候选条款核验所需事实清单（字段名: 可接受取值短语，| 分隔）：\n${extractionPhraseList}\n凡原文中出现与上述某短语对应的伤情表述（允许带部位、程度、测量值等修饰前缀的同义表述，例如原文“顶部2.2cm头皮瘢痕”对应短语“头皮瘢痕”），必须另输出一条独立事实：field 填该字段名，value 逐字填该短语本身，evidence 填原文对应引文。仅当原文确有对应表述时才输出，不得虚构。`;

  const factSystemPrompt = `${FACT_EXTRACTION_PROMPT}\n\n${STRUCTURED_MEASUREMENT_PROMPT}${input.injuryDate
    ? `\n\n${SELECTED_INJURY_DATE_CONTEXT_PROMPT}` : ''}\n\n输出版本：${FACT_EXTRACTION_PROMPT_VERSION}\n\n${extractionFieldHint}`;
  const factUserContent = (description, recognized) => JSON.stringify({ description, recognizedText: recognized,
    ...(input.injuryDate ? { assessmentContext: { selectedInjuryDate: input.injuryDate } } : {}) });
  let factResponse;
  if (sourceText.length <= MAX_DESC_CHARS_FOR_SINGLE_EXTRACTION) {
    factResponse = await complete({ model: config.textModel, schema: factExtractionSchema,
      name: 'fact_extraction', signal, messages: [
        { role: 'system', content: factSystemPrompt },
        { role: 'user', content: factUserContent(input.description, recognizedText) },
      ],
    });
  } else {
    // 长描述：按块分别抽取，再按 (field,value,evidence,eventId) 合并去重；块顺序即原文顺序。
    const chunks = chunkTextKeepAll(sourceText, MAX_DESC_CHARS_FOR_SINGLE_EXTRACTION);
    const parts = [];
    for (const chunk of chunks) {
      parts.push(await complete({ model: config.textModel, schema: factExtractionSchema,
        name: 'fact_extraction', signal, messages: [
          { role: 'system', content: factSystemPrompt },
          { role: 'user', content: factUserContent(chunk, '') },
        ],
      }));
    }
    factResponse = mergeExtractedFacts(parts);
  }
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
  let clauses = retrieveClauses(input.assessmentType, extracted.scopeText || sourceText, 40, extracted.facts);
  const model = config.textModel;
  // T-20261125-02: 材料不足时不再调用 reference_grade，恢复旧语义（直接返回无法鉴别/insufficient）。
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

  // T-20261125-03：预检不足且可用事实少于 3 条 → 跳过主评估，直接返回无法鉴别（日志 skipped_insufficient_low_facts）。
  const gradeEligibleFactCount = factsInAssessmentScope(extracted.facts)
    .filter(fact => fact.gradeEligible !== false).length;
  if (deterministicResult.status === 'insufficient' && gradeEligibleFactCount < MIN_GRADE_ELIGIBLE_FACTS_FOR_ASSESSMENT) {
    console.log(JSON.stringify({ event: 'skipped_insufficient_low_facts', requestId,
      gradeEligibleFacts: gradeEligibleFactCount }));
    return deterministicResult;
  }

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
    return evaluation.met === true || evaluation.met === null;
  });
  const pendingIds = new Set([...pendingReferences.map(reference => reference.id),
    ...semanticCandidates.map(clause => clause.id)]);
  if (!pendingIds.size) return deterministicResult;
  const reviewClauses = catalogs[input.assessmentType].clauses.filter(clause => pendingIds.has(clause.id));
  if (!reviewClauses.length) return deterministicResult;
  const compactAssessment = compactAssessmentEnabled();
  const modelReviewClauses = reviewClauses.slice(0, compactAssessment
    ? Math.min(MAX_ASSESSMENT_CLAUSES, COMPACT_ASSESSMENT_MAX_CLAUSES)
    : MAX_ASSESSMENT_CLAUSES);
  const pendingFactIds = new Set(pendingReferences.flatMap(reference => reference.conditions
    .flatMap(condition => condition.factIds || [])));
  const reviewFields = new Set(reviewClauses.flatMap(clause => [...logicFactFields(clause.conditionLogic.logic)]));
  const scopedExtractedFacts = factsInAssessmentScope(extracted.facts);
  const factsById = new Map(scopedExtractedFacts.map(fact => [fact.id, fact]));
  const relevantFactIds = new Set(pendingFactIds);
  for (const id of pendingFactIds) for (const parentId of factsById.get(id)?.derivedFrom || []) relevantFactIds.add(parentId);
  const targetedFacts = scopedExtractedFacts.filter(fact => relevantFactIds.has(fact.id)
    || availableFactFields.has(fact.field) && reviewFields.has(fact.field));
  const promptFacts = compactAssessment
    ? [...targetedFacts.filter(fact => relevantFactIds.has(fact.id)),
        ...targetedFacts.filter(fact => !relevantFactIds.has(fact.id))]
        .slice(0, COMPACT_ASSESSMENT_MAX_FACTS)
        .map(fact => ({
          id: fact.id,
          field: fact.field,
          value: fact.value,
          evidence: typeof fact.evidence === 'string'
            ? fact.evidence.slice(0, COMPACT_ASSESSMENT_EVIDENCE_CHARS) : fact.evidence,
          eventId: fact.eventId,
        }))
    : targetedFacts;
  const referencesById = new Map(deterministicResult.references.map(reference => [reference.id, reference]));
  const assessmentInput = {
    assessmentType: input.assessmentType,
    facts: promptFacts,
    conflicts: [],
    requiresReview: false,
    missingMaterials: extracted.missingMaterials,
    injuryDate: input.injuryDate,
    treatmentStatus: input.treatmentStatus,
    reviewConditions: modelReviewClauses.map(clause => {
      const reference = referencesById.get(clause.id);
      const pending = reference?.conditions.filter(condition => condition.met === null);
      const conditions = pending?.length ? pending : [{ condition: clause.text, evidence: '', factIds: [], met: null }];
      return compactAssessment
        ? { clauseId: clause.id,
            conditions: conditions.map(condition => ({ condition: condition.condition, factIds: condition.factIds || [] })) }
        : { clauseId: clause.id, conditionLogic: clause.conditionLogic.logic, conditions };
    }),
  };
  const reviewedIds = new Set(reviewClauses.map(clause => clause.id));
  clauses = [...clauses.filter(clause => !reviewedIds.has(clause.id)), ...reviewClauses];
  resultContext.clauses = clauses;
  resultContext.reviewClauseIds = [...reviewedIds];

  const clauseContext = compactAssessment
    ? JSON.stringify({
        standard: catalogs[input.assessmentType].standard,
        clauses: modelReviewClauses.map(clause => ({
          id: clause.id, grade: clause.grade, category: clause.category, text: clause.text,
        })),
      })
    : catalogContext(input.assessmentType, modelReviewClauses);
  const result = await complete({ model, schema: providerResultSchema, name: 'assessment_result', signal, messages: [
    { role: 'system', content: `${rules}\n\n${targetedReviewInstruction}\n\n本次评估类型：${input.assessmentType}\n官方原文依据：${clauseContext}` },
    { role: 'user', content: `<verified_facts>\n${JSON.stringify(assessmentInput)}\n</verified_facts>` },
  ] });
  try {
    return normalizeResult(result, input, resultContext);
  } catch (error) {
    if (error.name === 'ZodError') throw new ServiceError(502, 'INVALID_RESULT', '分析结果未通过完整性校验，未生成评估结论，请重试。');
    throw error;
  }
}
