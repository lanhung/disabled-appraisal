import { extractionSchema, factExtractionSchema, providerResultSchema } from './contracts.js';
import { FACT_EXTRACTION_PROMPT, FACT_EXTRACTION_PROMPT_VERSION } from './prompts.js';
import { normalizeExtractedFacts } from './facts.js';
import { catalogContext, retrieveClauses } from './catalog.js';
import { normalizeResult } from './results.js';
import { ServiceError } from './provider.js';

const rules = `你提供的是基于已提交事实和给定标准的辅助评估，不是正式司法鉴定意见。
必须区分损伤程度与致残等级，不得混用标准。只使用下方提供的官方条款与总则，不得凭记忆编造编号、阈值、标准正文或医学事实。
<verified_facts> 是唯一事实依据；不得重新读取原始病历、图片或从常识补充事实。facts 输出必须为空数组，事实由前一阶段产生并在最终结果中保留。
若 requiresReview 为 true 或 conflicts 非空，不得输出等级；说明哪些事实存在冲突并需要复核。关键事实不确定时不能作为已确认的条款条件。
references 必须引用给定 clauseId。逐条按官方条款附带的 conditionLogic 逻辑树列出必要条件组；all 的每个子组均为必要条件，且每个直接支持该条款的事实必须具有同一个已知 eventId；不同 eventId 或缺失 eventId 的事实不得拼成一个 all 条件。any 组只需一个有依据的分支。每项 condition 的 factIds 必须引用 <verified_facts> 中直接支持该组或分支的事实 ID，evidence 使用对应事实的原文依据；不得合并遗漏必需组，不得添加逻辑树之外的组。annotation 为 opaque 的条款不能作为 supports，条件状态必须保持未知。缺少条件或事件归属为未知时 met=null；只有明确来源事实支持时才可为 true；不能从未提及推断 false。模型提供的 met 仅是建议，最终状态由服务端依据 conditionLogic、规范事实字段和值、eventId、predicate 及引文重新计算。
不得只因出现“骨折”“手术”“瘢痕”等词便输出等级。不能从“未提到”推断“没有”，不能假设具体长度、面积、根数、功能比例、肌力、视听力、年龄、鉴定时机或伤病因果关系。
有可靠事实且满足完整条款条件时 status 为 preliminary，grade 必须完全等于相应条款的 grade 字段；必要资料缺失时 status 为 insufficient 且 grade=null；有关键冲突时 status 为 needs_review 且 grade=null；标准不适用时 status 为 not_applicable 且 grade=null。
不得仅凭材料不足输出“不构成伤残”或“轻微伤”。不得输出无校准依据的概率、赔偿金额、诊疗或用药建议。缺失资料和不确定性应客观、简洁说明。
必须返回完整 JSON 对象，含 status、grade、summary、reasoning、facts、references、missingMaterials、nextSteps、warnings，不要返回 Markdown 或 JSON 之外文字。`;

export async function assess(input, { provider, config, signal, requestId }) {
  let recognizedText = '';
  const extractionWarnings = [];
  if (input.images.length) {
    const extraction = await provider.complete({ model: config.visionModel, schema: extractionSchema,
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

  const factResponse = await provider.complete({ model: config.textModel, schema: factExtractionSchema,
    name: 'fact_extraction', signal, messages: [
      { role: 'system', content: `${FACT_EXTRACTION_PROMPT}\n\n输出版本：${FACT_EXTRACTION_PROMPT_VERSION}` },
      { role: 'user', content: JSON.stringify({ description: input.description, recognizedText }) },
    ],
  });
  const extracted = normalizeExtractedFacts(factResponse, { description: input.description, recognizedText });
  extractionWarnings.push(...(extracted.warnings || []));
  const sourceText = `${input.description}\n${recognizedText}`;
  const clauses = retrieveClauses(input.assessmentType, sourceText);
  const model = config.textModel;
  const assessmentInput = {
    assessmentType: input.assessmentType,
    facts: extracted.facts,
    conflicts: extracted.conflicts,
    requiresReview: extracted.requiresReview,
    missingMaterials: extracted.missingMaterials,
    injuryDate: input.injuryDate,
    treatmentStatus: input.treatmentStatus,
  };
  const result = await provider.complete({ model, schema: providerResultSchema, name: 'assessment_result', signal, messages: [
    { role: 'system', content: `${rules}\n\n本次评估类型：${input.assessmentType}\n官方原文依据：${catalogContext(input.assessmentType, clauses)}` },
    { role: 'user', content: `<verified_facts>\n${JSON.stringify(assessmentInput)}\n</verified_facts>` },
  ] });
  try {
    return normalizeResult(result, input, { clauses, recognizedText, extractionWarnings, requestId, model,
      extractedFacts: extracted.facts, conflicts: extracted.conflicts, requiresReview: extracted.requiresReview,
      factMissingMaterials: extracted.missingMaterials });
  } catch (error) {
    if (error.name === 'ZodError') throw new ServiceError(502, 'INVALID_RESULT', '分析结果未通过完整性校验，未生成评估结论，请重试。');
    throw error;
  }
}
