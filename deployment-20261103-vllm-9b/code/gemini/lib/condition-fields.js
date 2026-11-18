const CLINICAL_FINDING_FIELDS = Object.freeze([
  'diagnosis', 'imaging_finding', 'symptom', 'treatment', 'functional_impairment', 'injury_type',
]);

export function conditionFactFields(factMatch, predicate) {
  if (!factMatch) {
    const fields = new Set([predicate?.field, ...(predicate?.fields || [])].filter(Boolean));
    if (predicate?.field === 'aggregate_wound_length_cm'
      && predicate.evidenceGroups?.some(group => group.includes('头皮'))) fields.add('wound_length_cm');
    return fields;
  }
  const fields = new Set([factMatch.field, ...(factMatch.fields || [])].filter(Boolean));
  if (factMatch.field === 'clinical_finding' && !factMatch.fields?.length) {
    for (const field of CLINICAL_FINDING_FIELDS) fields.add(field);
  }
  return fields;
}

export function logicFactFields(node) {
  const fields = conditionFactFields(node?.factMatch, node?.predicate);
  if (node?.confirmedBy?.field) fields.add(node.confirmedBy.field);
  for (const field of node?.confirmedBy?.fields || []) fields.add(field);
  for (const child of node?.children || []) {
    for (const field of logicFactFields(child)) fields.add(field);
  }
  return fields;
}
