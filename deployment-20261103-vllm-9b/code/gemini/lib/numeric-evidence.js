import { hasExplicitLimbLengthDifferenceLink, hasExplicitOrbitalFractureEnophthalmosLink, parseNumber } from './facts.js';
import { normalizeForMatching } from './text-normalization.js';

const normalize = normalizeForMatching;
const reliableCertainties = new Set(['reported', 'observed', 'derived']);

function verifiedTypedMeasurement(predicate, fact, evidence) {
  const unitPatterns = {
    cm: '(cm|厘米|mm|毫米)(?!2)',
    '°': '(°|度|o)',
    '%': '(%|％)',
  };
  const pattern = unitPatterns[predicate.unit];
  if (!pattern) return null;
  const number = '(\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百]+)';
  const measurements = [...evidence.matchAll(new RegExp(`${number}\\s*${pattern}`, 'giu'))];
  if (!measurements.length) return null;
  const groups = predicate.evidenceGroups || [];
  if (!groups.length) return null;
  const clauseBounds = measurement => ({
    start: Math.max(evidence.lastIndexOf('。', measurement.index), evidence.lastIndexOf('；', measurement.index),
      evidence.lastIndexOf(';', measurement.index), evidence.lastIndexOf('\n', measurement.index)) + 1,
    end: [evidence.indexOf('。', measurement.index + measurement[0].length),
      evidence.indexOf('；', measurement.index + measurement[0].length), evidence.indexOf(';', measurement.index + measurement[0].length),
      evidence.indexOf('\n', measurement.index + measurement[0].length)].filter(index => index >= 0)
      .reduce((end, index) => Math.min(end, index), evidence.length),
  });
  const contextFor = measurement => {
    const bounds = clauseBounds(measurement);
    const contextStart = Math.max(bounds.start, measurement.index - 48);
    const context = evidence.slice(contextStart, bounds.end);
    const normalizedContext = normalize(context);
    const entityMatches = groups[0].map(alias => ({ alias: normalize(alias),
      index: normalizedContext.lastIndexOf(normalize(alias)) })).filter(item => item.index >= 0)
      .sort((left, right) => right.index - left.index);
    if (!entityMatches.length) return null;
    const relationText = normalizedContext.slice(entityMatches[0].index + entityMatches[0].alias.length,
      normalizedContext.indexOf(normalize(measurement[0]), entityMatches[0].index));
    if (groups.slice(1).some(group => !group.some(alias => relationText.includes(normalize(alias))))) return null;
    return bounds;
  };
  const supportedMeasurements = measurements.map(measurement => ({ measurement, context: contextFor(measurement) }))
    .filter(item => item.context);
  if (!supportedMeasurements.length) return null;
  const values = supportedMeasurements.map(({ measurement }) => {
    const numeric = /^\d+(?:\.\d+)?$/u.test(measurement[1]) ? Number(measurement[1]) : parseNumber(measurement[1]);
    const actualUnit = measurement[2].toLowerCase();
    return predicate.unit === 'cm' && /^(?:mm|毫米)$/u.test(actualUnit) ? numeric / 10 : numeric;
  });
  if (values.some(value => !Number.isFinite(value) || value < 0) || new Set(values).size !== 1) return null;
  const sourceValue = values[0];
  for (const { measurement, context: { start, end } } of supportedMeasurements) {
    const clause = evidence.slice(start, end);
    if (/(?:约|大约|左右|接近|估计|疑似|可疑|考虑|可能|待排|待查|待核|不排除|未见|未发现|否认|排除|既往|陈旧|术前|术后)/u.test(clause)) return null;
    const before = evidence.slice(start, measurement.index);
    const after = evidence.slice(measurement.index + measurement[0].length, end);
    const upperBound = /(?:以下|以内|不超过|不高于|小于|低于|不足|少于|未达|未达到|不大于|至多|≤|<=)\s*$/u.test(before)
      || /^(?:以下|以内|不超过|不高于|不大于|至多|≤|<=)/u.test(after);
    const lowerBound = /(?:以上|至少|不少于|不低于|不小于|大于|超过|≥|>=)\s*$/u.test(before)
      || /^(?:以上|及以上|至少|不少于|不低于|不小于|大于|超过|≥|>=)/u.test(after);
    if (upperBound && ['gte', 'gt', 'eq'].includes(predicate.operator)
      || lowerBound && ['lte', 'lt', 'eq'].includes(predicate.operator)) return null;
  }
  const sourcedTextFact = typeof fact.value === 'string' && predicate.fields?.includes(fact.field)
    && normalize(String(fact.evidence || '')).includes(normalize(fact.value));
  return sourceValue === fact.value || sourcedTextFact ? sourceValue : null;
}

export function quotedPredicateEvidenceValue(predicate, fact, facts = []) {
  const sourcedTextFact = typeof fact.value === 'string' && predicate.fields?.includes(fact.field)
    && normalize(String(fact.evidence || '')).includes(normalize(fact.value));
  if (!Number.isFinite(fact.value) && !sourcedTextFact) return null;
  if (predicate.field === 'organ_hematoma_diameter_cm') {
    const evidence = normalize(String(fact.evidence || ''));
    const measurements = [...evidence.matchAll(/(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(cm|厘米|mm|毫米)/gu)];
    const organs = [...evidence.matchAll(/肝(?:脏)?|脾(?:脏)?/gu)];
    const diameterMeasurements = measurements.filter(measurement =>
      /直径[^，,；;]{0,8}$/u.test(evidence.slice(Math.max(0, measurement.index - 8), measurement.index)));
    const centimetresFor = measurement => {
      const raw = /^\d/u.test(measurement[1]) ? Number(measurement[1]) : parseNumber(measurement[1]);
      return /^(?:mm|毫米)$/u.test(measurement[2]) ? raw / 10 : raw;
    };
    const sourceValues = measurements.map(centimetresFor);
    if (!measurements.length || diameterMeasurements.length !== 1 || organs.length !== 1
      || !/(?:肝(?:脏)?|脾(?:脏)?)实质(?:内)?血肿/u.test(evidence)
      || !/血肿[^，,；;]{0,8}直径/u.test(evidence)
      || sourceValues.some(value => !Number.isFinite(value) || value !== centimetresFor(diameterMeasurements[0]))
      || /(?:约|大约|左右|接近|估计|可疑|疑似|考虑|可能|待排|不排除|未达|低于|小于|不足|不超过|少于|超过|大于|至少|未见|未发现|否认|排除|无|既往|陈旧|术前|术后)/u.test(evidence)) return null;
    const centimetres = centimetresFor(diameterMeasurements[0]);
    return Number.isFinite(centimetres) && centimetres === fact.value && centimetres >= 0 ? centimetres : null;
  }
  if (predicate.field === 'orbital_enophthalmos_cm') {
    const evidence = normalize(String(fact.evidence || ''));
    const measurements = [...evidence.matchAll(/(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(cm|厘米|mm|毫米)/gu)];
    if (measurements.length !== 1
      || !hasExplicitOrbitalFractureEnophthalmosLink(evidence)
      || /(?:未达|低于|小于|不足|不超过|少于|超过|大于|至少|以上|以下|约|大约|左右|接近|估计|可疑|疑似|考虑|可能|待排|不排除|未见|未发现|否认|排除)/u.test(evidence)) return null;
    const amount = /^\d/u.test(measurements[0][1]) ? Number(measurements[0][1]) : parseNumber(measurements[0][1]);
    const centimetres = /^(?:mm|毫米)$/u.test(measurements[0][2]) ? amount / 10 : amount;
    return Number.isFinite(centimetres) && centimetres === fact.value && centimetres >= 0 ? centimetres : null;
  }
  if (predicate.field === 'limb_length_difference_cm') {
    const evidence = normalize(String(fact.evidence || ''));
    const measurements = [...evidence.matchAll(/(?:双|两)(?:上|下)肢(?:相对)?(?:长度|长短)(?:相差|差值|差距|差异)\s*(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(cm|厘米|mm|毫米)/gu)];
    const allLengthMeasurements = [...evidence.matchAll(/(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:cm|厘米|mm|毫米)/gu)];
    if (measurements.length !== 1 || allLengthMeasurements.length !== 1
      || !hasExplicitLimbLengthDifferenceLink(evidence)
      || /(?:未达|低于|小于|不足|不超过|少于|以下|约|大约|左右|接近|估计|可疑|疑似|考虑|可能|待排|不排除|未见|未发现|否认|排除)/u.test(evidence)) return null;
    const amount = /^\d/u.test(measurements[0][1]) ? Number(measurements[0][1]) : parseNumber(measurements[0][1]);
    const centimetres = /^(?:mm|毫米)$/u.test(measurements[0][2]) ? amount / 10 : amount;
    const lowerBound = /(?:至少|不低于|不小于|大于|超过|以上)/u.test(evidence);
    return Number.isFinite(centimetres) && centimetres === fact.value && centimetres >= 0
      && !(lowerBound && predicate.operator === 'gte' && centimetres < predicate.value) ? centimetres : null;
  }
  if (predicate.field === 'gcs_score') {
    const evidence = normalize(String(fact.evidence || ''));
    const score = /(?:GCS|格拉斯哥昏迷评分)\s*(?:评分|分数)?\s*[:：=]?\s*(1[0-5]|[3-9])\s*分?/iu.exec(evidence);
    return score && Number(score[1]) === fact.value ? fact.value : null;
  }
  if (['bone_shortening_cm', 'bone_angulation_degrees', 'joint_function_loss_percent'].includes(predicate.field)) {
    return verifiedTypedMeasurement(predicate, fact, normalize(String(fact.evidence || '')));
  }
  const number = '(\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百]+)';
  const unit = predicate.unit === 'cm' ? '(?:cm|厘米|mm|毫米)(?!2)'
    : predicate.unit === 'cm2' ? '(?:cm\\s*2|平方厘米)'
      : predicate.unit === '°' ? '(?:°|度|o)'
        : predicate.unit ? predicate.unit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
  const evidence = normalize(String(fact.evidence || ''));
  const facialScarMeasurementCues = {
    facial_scar_width_cm: /面部/u.test(evidence) && /条状瘢痕|条状疤痕/u.test(evidence) && /宽(?:度)?/u.test(evidence),
    aggregate_facial_scar_length_cm: /面部/u.test(evidence) && /条状瘢痕|条状疤痕/u.test(evidence)
      && /(?:累计|总计|合计)[^。；;]{0,12}长度|长度[^。；;]{0,12}(?:累计|总计|合计)/u.test(evidence),
    facial_center_scar_length_cm: /面部中心区/u.test(evidence) && /条状瘢痕|条状疤痕/u.test(evidence)
      && /长度|位于/u.test(evidence),
  };
  if (Object.hasOwn(facialScarMeasurementCues, predicate.field)) {
    const measurements = [...evidence.matchAll(new RegExp(`${number}\\s*${unit}`, 'gu'))];
    const uncertainOrComparative = /(?:未达|低于|小于|不足|不超过|少于|超过|大于|约|大约|左右|接近|估计|可疑|疑似|考虑|可能|待排|不排除|未见|未发现|否认|排除)/u.test(evidence);
    const beforeMeasurement = measurements.length === 1
      ? evidence.slice(Math.max(0, measurements[0].index - 24), measurements[0].index) : '';
    if (measurements.length !== 1 || !facialScarMeasurementCues[predicate.field] || uncertainOrComparative
      || /(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:-|–|—|至|到)\s*$/u.test(beforeMeasurement)) return null;
    const sourceValue = /^\d/u.test(measurements[0][1]) ? Number(measurements[0][1]) : parseNumber(measurements[0][1]);
    return Number.isFinite(sourceValue) && sourceValue === fact.value && sourceValue >= 0 ? sourceValue : null;
  }
  if (predicate.field === 'contusion_tbsa_percent') {
    const measurements = [...evidence.matchAll(new RegExp(`${number}\\s*(?:%|％)`, 'gu'))];
    const beforeMeasurement = measurements.length === 1
      ? evidence.slice(Math.max(0, measurements[0].index - 30), measurements[0].index) : '';
    if (measurements.length !== 1 || /擦伤|烧伤|烫伤|瘢痕|疤痕|未达|低于|小于|不足|不超过|少于|超过|大于|至少|以上|以下|约|大约|左右|接近|估计/u.test(evidence)
      || /(?:\d+(?:\.\d+)?)\s*(?:-|–|—|至|到)\s*$/u.test(beforeMeasurement)
      || !/挫伤/u.test(evidence) || !/(?:体表面积|TBSA)/iu.test(evidence)
      || !/挫伤[^，,；;]{0,24}面积[^，,；;]{0,24}(?:体表面积|TBSA)/iu.test(evidence)) return null;
    const sourceValue = /^\d/u.test(measurements[0][1]) ? Number(measurements[0][1]) : parseNumber(measurements[0][1]);
    return Number.isFinite(sourceValue) && sourceValue === fact.value && sourceValue >= 0 && sourceValue <= 100
      ? sourceValue : null;
  }
  if (predicate.field === 'facial_skin_abnormality_area_percent') {
    const percentPattern = /(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:%|％)|百分之(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)/gu;
    const measurements = [...evidence.matchAll(percentPattern)];
    if (measurements.length !== 1 || !/(?:面部|脸部|面颊)/u.test(evidence)
      || !/(?:面部|脸部)面积/u.test(evidence)
      || !/(?:色素显著异常|色素异常|色素沉着|片状细小瘢痕|细小瘢痕)/u.test(evidence)
      || /(?:未达|低于|小于|不足|不超过|少于|超过|大于|约|大约|左右|接近|估计|可疑|疑似|考虑|可能|待排|不排除)/u.test(evidence)) return null;
    const token = measurements[0][1] || measurements[0][2];
    const sourceValue = /^\d+(?:\.\d+)?$/u.test(token) ? Number(token) : parseNumber(token);
    return Number.isFinite(sourceValue) && sourceValue === fact.value && sourceValue >= 0 && sourceValue <= 100
      ? sourceValue : null;
  }
  if (typeof predicate.field === 'string' && predicate.field.startsWith('burn_tbsa_')) {
    const measurements = [...evidence.matchAll(new RegExp(`${number}\\s*(?:%|％)`, 'gu'))];
    const degrees = [...evidence.matchAll(/(深\s*)?(III|Ⅲ|三|II|Ⅱ|二)\s*(?:度|o|°)(?:以上|及以上)?/giu)];
    const beforeMeasurement = measurements.length === 1
      ? evidence.slice(Math.max(0, measurements[0].index - 30), measurements[0].index) : '';
    if (measurements.length !== 1 || degrees.length !== 1 || !/烧(?:烫)?伤|烫伤/u.test(evidence)
      || !/(?:体表面积|TBSA)/iu.test(evidence) || !/面积/u.test(evidence)
      || /(?:未达|低于|小于|不足|不超过|少于|超过|大于|至少|约|大约|左右|接近|估计|可疑|疑似|考虑|可能|待排|不排除)/u.test(evidence)
      || /(?:\d+(?:\.\d+)?)\s*(?:-|–|—|至|到)\s*$/u.test(beforeMeasurement)) return null;
    const degree = degrees[0];
    const className = normalize(degree[2]).toUpperCase();
    const isThird = className === 'III' || className === '三';
    const isSecond = className === 'II' || className === '二';
    const isDeepSecond = isSecond && Boolean(degree[1]);
    if (predicate.field === 'burn_tbsa_iii_percent' && !isThird
      || predicate.field === 'burn_tbsa_deep_ii_plus_percent' && !isThird && !isDeepSecond
      || predicate.field === 'burn_tbsa_ii_plus_percent' && !isThird && !isSecond) return null;
    const sourceValue = /^\d/u.test(measurements[0][1]) ? Number(measurements[0][1]) : parseNumber(measurements[0][1]);
    return Number.isFinite(sourceValue) && sourceValue === fact.value && sourceValue >= 0 && sourceValue <= 100
      ? sourceValue : null;
  }
  if (typeof predicate.field === 'string' && predicate.field.startsWith('burn_area_')) {
    const measurements = [...evidence.matchAll(new RegExp(`${number}\\s*(?:cm\\s*2|平方厘米)`, 'giu'))];
    const uncertainOrComparative = /(?:未达|低于|小于|不足|不超过|少于|超过|大于|至少|约|大约|左右|接近|估计|可疑|疑似|考虑|可能|待排|不排除|未见|未发现|否认|排除|无)/u.test(evidence);
    const beforeMeasurement = measurements.length === 1
      ? evidence.slice(Math.max(0, measurements[0].index - 30), measurements[0].index) : '';
    if (measurements.length !== 1 || uncertainOrComparative || !/烧(?:烫)?伤|烫伤/u.test(evidence)
      || /(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:-|–|—|至|到)\s*$/u.test(beforeMeasurement)) return null;
    const field = predicate.field;
    const siteMatches = field.includes('_face_') ? /面部|脸部|颜面/u.test(evidence)
      && !/颈部|体表|身体/u.test(evidence)
      : field.includes('_neck_') ? /颈部/u.test(evidence) && !/面部|脸部|颜面|体表|身体/u.test(evidence)
        : /体表|身体/u.test(evidence) && !/面部|脸部|颜面|颈部/u.test(evidence);
    const degreeMatches = field.includes('_first_degree_')
      ? /(?:(?<!I)I(?!I)|Ⅰ|一)\s*(?:度|o|°)(?!以上|及以上)/iu.test(evidence)
        && !/浅\s*(?:II|Ⅱ|二)\s*(?:度|o|°)|深\s*(?:II|Ⅱ|二)\s*(?:度|o|°)|(?<!I)I(?=I\s*(?:度|o|°))/iu.test(evidence)
      : /浅\s*(?:II|Ⅱ|二)\s*(?:度|o|°)(?!以上|及以上)/iu.test(evidence)
        && !/深\s*(?:II|Ⅱ|二)\s*(?:度|o|°)|(?:(?<!I)I(?!I)|Ⅰ|一)\s*(?:度|o|°)/iu.test(evidence);
    if (!siteMatches || !degreeMatches) return null;
    const sourceValue = /^\d/u.test(measurements[0][1]) ? Number(measurements[0][1]) : parseNumber(measurements[0][1]);
    return Number.isFinite(sourceValue) && sourceValue === fact.value && sourceValue >= 0 ? sourceValue : null;
  }
  if (predicate.field === 'scalp_defect_area_cm2' || predicate.field === 'scalp_avulsion_area_cm2') {
    const measurements = [...evidence.matchAll(new RegExp(`${number}\\s*(?:cm\\s*2|平方厘米)`, 'giu'))];
    const beforeMeasurement = measurements.length === 1
      ? evidence.slice(Math.max(0, measurements[0].index - 30), measurements[0].index) : '';
    const siteMatches = /头皮|头顶部|额顶部|颞顶部|颞枕部|顶枕部|枕顶部|枕部/u.test(evidence);
    const typeMatches = predicate.field === 'scalp_defect_area_cm2'
      ? /缺损/u.test(evidence) : /撕脱(?:伤|创)?/u.test(evidence);
    if (measurements.length !== 1 || !siteMatches || !typeMatches || !/面积/u.test(evidence)
      || /(?:约|大约|左右|接近|估计|可疑|疑似|考虑|可能|待排|不排除|未达|低于|小于|不足|不超过|少于|超过|大于|至少|未见|未发现|否认|排除|无)/u.test(evidence)
      || /(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:-|–|—|至|到)\s*$/u.test(beforeMeasurement)) return null;
    const sourceValue = /^\d/u.test(measurements[0][1]) ? Number(measurements[0][1]) : parseNumber(measurements[0][1]);
    return Number.isFinite(sourceValue) && sourceValue === fact.value && sourceValue >= 0 ? sourceValue : null;
  }
  if (predicate.field === 'fracture_site_count' && fact.certainty === 'derived'
    && fact.source === 'description' && fact.verification === 'quoted'
    && Array.isArray(fact.derivedFrom) && fact.derivedFrom.length > 0) {
    const parents = fact.derivedFrom.map(id => facts.find(candidate => candidate.id === id));
    const ribNumberParents = parents.filter(parent => parent?.field === 'fractured_rib_numbers'
      && parent.source === 'description' && parent.verification === 'quoted'
      && ['reported', 'observed', 'derived'].includes(parent.certainty)
      && Array.isArray(parent.value) && parent.value.length > 0
      && parent.value.every(value => Number.isInteger(value) && value > 0)
      && parent.eventId === fact.eventId);
    const rootCountParents = parents.filter(parent => parent?.field === 'fractured_rib_count'
      && parent.source === 'description' && parent.verification === 'quoted'
      && ['reported', 'observed', 'derived'].includes(parent.certainty)
      && Number.isInteger(parent.value) && parent.value > 0 && parent.eventId === fact.eventId
      && quotedPredicateEvidenceValue({ field: 'fractured_rib_count', unit: '根' }, parent, facts) === parent.value);
    const distinctRibNumbers = new Set(ribNumberParents.flatMap(parent => parent.value));
    const countsBySide = new Map();
    let unspecifiedRootCount = 0;
    for (const parent of rootCountParents) {
      const sideMatch = /(?:左侧|左)(?=第|\d|[零〇一二两三四五六七八九十百])/.test(parent.evidence) ? 'left'
        : /(?:右侧|右)(?=第|\d|[零〇一二两三四五六七八九十百])/.test(parent.evidence) ? 'right' : null;
      if (sideMatch) countsBySide.set(sideMatch, Math.max(countsBySide.get(sideMatch) || 0, parent.value));
      else unspecifiedRootCount = Math.max(unspecifiedRootCount, parent.value);
    }
    const rootCountLowerBound = Math.max([...countsBySide.values()].reduce((sum, value) => sum + value, 0),
      unspecifiedRootCount);
    const lowerBound = Math.max(distinctRibNumbers.size, rootCountLowerBound);
    const upperBound = Math.max(distinctRibNumbers.size * 2, rootCountLowerBound);
    if (fact.eventId && ribNumberParents.length + rootCountParents.length === parents.length
      && lowerBound > 0 && fact.value >= lowerBound && fact.value <= upperBound) return fact.value;
    return null;
  }
  if (['surface_scar_area_cm2', 'aggregate_surface_scar_area_cm2'].includes(predicate.field)) {
    const measurements = [...evidence.matchAll(new RegExp(`${number}\\s*(?:cm2|平方厘米)`, 'gu'))];
    const aggregate = predicate.field === 'aggregate_surface_scar_area_cm2';
    const beforeMeasurement = measurements.length === 1
      ? evidence.slice(Math.max(0, measurements[0].index - 24), measurements[0].index) : '';
    if (measurements.length !== 1 || !/(?:瘢痕|疤痕)/u.test(evidence) || !/面积/u.test(evidence)
      || aggregate && !/(?:累计|总面积|合计)/u.test(evidence)
      || !aggregate && /(?:多块|多处|多个|累计|总面积|合计)/u.test(evidence)
      || /(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:-|–|—|至|到)\s*$/u.test(beforeMeasurement)
      || /(?:未达|低于|小于|不足|不超过|少于|超过|大于|至少|约|大约|左右|接近|估计|可疑|疑似|考虑|可能|待排|不排除)/u.test(evidence)) return null;
    const sourceValue = /^\d/u.test(measurements[0][1]) ? Number(measurements[0][1]) : parseNumber(measurements[0][1]);
    return Number.isFinite(sourceValue) && sourceValue === fact.value && sourceValue >= 0 ? sourceValue : null;
  }
  for (const match of evidence.matchAll(new RegExp(`${number}\\s*${unit}`, 'gu'))) {
    const sourceValue = /^\d+(?:\.\d+)?$/.test(match[1]) ? Number(match[1]) : parseNumber(match[1]);
    if (Number.isFinite(sourceValue) && sourceValue === fact.value) return sourceValue;
  }
  if (predicate.field === 'wound_length_cm'
    && (/(?:创口|伤口|裂口|裂创|裂伤|切口)/u.test(evidence)
      || /(?:瘢痕|疤痕)/u.test(evidence) && /横(?:行|向)|纵(?:行|向)|线状|条状/u.test(evidence))) {
    const dimensions = new RegExp(`${number}\\s*(?:${unit})?\\s*[×xX*]\\s*${number}\\s*${unit}`, 'gu');
    for (const match of evidence.matchAll(dimensions)) {
      const first = /^\d+(?:\.\d+)?$/u.test(match[1]) ? Number(match[1]) : parseNumber(match[1]);
      const second = /^\d+(?:\.\d+)?$/u.test(match[2]) ? Number(match[2]) : parseNumber(match[2]);
      const longAxis = Math.max(first, second);
      const shortAxis = Math.min(first, second);
      if (Number.isFinite(longAxis) && Number.isFinite(shortAxis) && shortAxis > 0
        && longAxis / shortAxis >= 1.5 && longAxis === fact.value) return longAxis;
    }
  }
  return null;
}
