export function reportText(result) {
  const statuses = { preliminary: '初步评估', insufficient: '材料不足', needs_review: '需复核', not_applicable: '标准不适用' };
  const certainties = { reported: '材料陈述', observed: '已观察', derived: '规则推导', uncertain: '不确定', excluded: '已排除', conflicted: '存在冲突', unknown: '待核实' };
  const conflicts = result.conflicts || [];
  const lines = [result.standard.name + ' · 辅助评估', `时间：${new Date(result.createdAt).toLocaleString('zh-CN')}`,
    `结论状态：${statuses[result.status] || '待核实'}`,
    `预估等级：${result.grade || '暂不输出等级'}`, result.summary, '', '分析依据', result.reasoning,
    '', '需复核的资料冲突', ...conflicts.map(conflict => `${conflict.reason}${conflict.factIds?.length ? `（事实：${conflict.factIds.join('、')}）` : ''}`),
    ...(result.requiresReview && conflicts.length === 0 ? ['存在待复核事实。'] : []),
    '', '材料事实', ...result.facts.map(fact => {
      const sourceSummary = sourceReferenceSummary(fact);
      return [
        `${fact.finding}（${certainties[fact.certainty] || '待核实'}）`,
        `材料原文：${fact.evidence}${fact.source === 'image' ? '（图片识别，待核对）' : ''}`,
        ...(sourceSummary ? [`材料来源：${sourceSummary}`] : []),
      ].join('\n');
    }),
    '', '条款对照', ...result.references.map(reference => `${reference.id}（${reference.grade}）${reference.text}\n材料依据：${reference.evidence || '尚未确认'}\n分析：${reference.reasoning}\n${reference.conditions.map(condition => `${condition.condition}：${condition.met === true ? '初步满足' : condition.met === false ? '不满足' : '待确认'}；${condition.evidence || '材料未提供'}`).join('\n')}\n出处：${reference.sourceUrl}`),
    '', '需补充材料', ...result.missingMaterials, '', '后续核对', ...result.nextSteps,
    '', '不确定性与限制', ...result.warnings,
    '', `标准版本：${result.standard.version}，${result.standard.effectiveDate}起施行`, `原文：${result.standard.sourceUrl}`,
    '本结果为辅助分析，不是正式司法鉴定意见。最终结论应由具有资质的鉴定机构依据完整材料出具。'];
  return lines.join('\n');
}

export function sourceReferenceSummary(fact) {
  if (!Array.isArray(fact?.sourceRefs) || !fact.sourceRefs.length) return '';
  const labels = fact.sourceRefs.map(reference => {
    if (reference.source === 'description') return '文字描述';
    const imageIndex = reference.sourceId?.match(/^image-(\d+)$/)?.[1];
    return imageIndex ? `图片${imageIndex}` : '图片页码未确定';
  });
  return [...new Set(labels)].join('、');
}

export function downloadReport(result) {
  const blob = new Blob([reportText(result)], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${result.assessmentType}-${result.createdAt.slice(0, 10)}.txt`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
