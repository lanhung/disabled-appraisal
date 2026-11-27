import { hasNonCurrentClinicalContext, parseEventDateAnchors } from './event-date-logic.js';

const toothLoss = 'scoped_tooth_loss_count';
const toothFracture = 'scoped_tooth_fracture_count';
const pelvis = 'scoped_pelvic_fracture_count';
const vertebralBody = 'scoped_vertebral_body_fracture_count';
const vertebralProcess = 'scoped_vertebral_process_fracture_count';
const lung = 'scoped_pleural_lung_collapse_percent';
const abdominalSurgery = 'scoped_abdominal_bleeding_surgery';
export const limbBoneFracture = 'scoped_limb_bone_fracture';
const fields = new Set([toothLoss, toothFracture, pelvis, vertebralBody, vertebralProcess, lung, abdominalSurgery, limbBoneFracture]);

export function isScopedEvidenceField(field) {
  return fields.has(field);
}

// These detectors recognize explicit observations, not grades. A rule decides what to count
// and what threshold to compare. Unrecognized wording must not turn into inferred evidence.
const sentencePattern = /[^。！？!?；;\n]+[？?]?/gu;
const nonObservation = /既往|陈旧|旧伤|此前|前次|上次|家族史|家属(?:有|曾|出现|发生)|其父|其母|另(?:一人|一名)|另(?:一次|一起|一场)|不同(?:次|一场)?(?:外伤|受伤|事故)|再次(?:外伤|受伤)|标准(?:原文|条款)|条款(?:原文|要求)|示例|假设|如果|倘若|若(?:有|出现|发现|发生)|如(?:有|出现|发现|发生)|必要时|不归因|外伤前|受伤前|与本次(?:外伤|损伤|事件)无关/u;
const nonObservationHeading = /^(?:【\s*)?(?:(?:原|既有|历史)?鉴定(?:意见|结论|分析(?:说明)?|结果|标准)|(?:适用|参照)?(?:标准原文|标准条文|条文|条款|规范原文)|历史(?:答案|等级)|既往(?:病|损伤|外伤)?史|家族史)(?:\s*[:：】]|\s*$)/u;
const observationHeading = /^(?:【\s*)?(?:现病史|主诉|病程记录|治疗经过|手术记录|手术所见|入院记录|出院记录|诊断(?:记录)?|(?:口腔(?:专科)?|牙科)?检查结果|影像(?:学)?(?:检查|报告)|体格检查|查体)(?:\s*[:：】]|\s*$)/u;
const assessmentScopeChange = /(?:本次|此次|本项)(?:鉴定|评估)?\s*(?:(?:仅|只)(?:对|评|鉴定|评估|纳入)|不(?:予|做|作|对)?(?:评定|鉴定|评估|纳入|列入))|(?:不纳入|不列入|不用于|不作为|排除在)\s*(?:本次|此次|本项).{0,12}(?:鉴定|评估)/u;
const unresolvedCorrection = /(?:上述|数值|数据|结果|比例|数量|计数|测量|读数|诊断)[^，,]{0,10}(?:有误|误录|不一致|存在争议|待复核|待核对|待确认)/u;
const negatingWords = '(?:未见|未发现|未显示|未提示|没有|无|排除|否认)';
const uncertainWords = '(?:尚不能排除|不能排除|不排除|尚未排除|未能排除|未排除|不能除外|不除外|疑似|可疑|怀疑|考虑|可能)';
const imagingExam = '(?:入院|急诊|复查)?\\s*(?:颈椎|胸椎|腰椎|头部|胸部|腹部|骨盆)?\\s*'
  + '(?:三维\\s*)?(?:CT|MRI|X线|DR)\\s*(?:三维重建|平扫|增强|检查|报告)?';
const examHead = `(?:${imagingExam}|(?:影像学?|复查|查体|检查)(?:检查)?)`;
const examResult = `${examHead}\\s*(?:显示|提示|所见|结果|示|见|(?=[:：]?\\s*(?:${negatingWords}|${uncertainWords})))`;
const diagnosticPrefix = new RegExp(`^(?:\\s|(?:${examResult}|(?:临床|入院|出院|明确)?诊断(?:为)?|病历记载|明确|证实)\\s*[:：]?\\s*)+`, 'iu');
const completedFinding = /(?:骨折|脱位|挫伤|裂伤|撕裂|折断|折裂|脱落|积血|血肿|肿胀)$/u;
const listToken = /[()（）,，、]|以及|及|和|并见|另见|同时见/gu;
const monthDayInjury = /(?<![\d年])(?:1[0-2]|0?[1-9])月(?:3[01]|[12]\d|0?[1-9])日\s*(?:(?:又|再次|不慎|发生|遭遇|遭受|因|致)\s*){0,4}(?:交通事故|车祸|摔伤|跌伤|撞伤|受伤|外伤|坠落|烧伤|烫伤|殴打|打伤)/gu;

function countItems(text, tokens = listToken, splitSharedFinding = false) {
  const parts = [];
  let start = 0;
  let depth = 0;
  for (const { 0: token, index } of text.matchAll(tokens)) {
    if (token === '(' || token === '（') { depth++; continue; }
    if (token === ')' || token === '）') { depth = Math.max(0, depth - 1); continue; }
    if (depth > 0) continue;
    const item = text.slice(start, index).trim();
    // The separator after a complete finding can start a new injury, but a list of
    // levels or tooth positions before the diagnosis belongs to that single finding.
    if (!splitSharedFinding && token !== ',' && token !== '，' && !completedFinding.test(item)) continue;
    parts.push(item);
    start = index + token.length;
  }
  parts.push(text.slice(start).trim());
  return parts;
}
const standaloneQualifier = /^(?:但|仍|尚|均|性质|结果|诊断|上述(?:损伤|骨折|诊断)?)*(?:待排|待查|待核实|待确认|疑似|可疑|不除外|不能除外|未明确|不明确|已排除|排除|未见|否认)$/u;
const listEndQualifier = /(?:均|皆|各|上述(?:损伤|骨折|诊断)?)(?:仍|尚|已)?(?:待排|待查|待核实|待确认|疑似|可疑|可能|不除外|不能除外|未明确|不明确|未证实|排除|否定)\s*[)）]?\s*$/u;
const negatedPrefix = new RegExp(`^${negatingWords}\\s*`, 'u');
const uncertainPrefix = new RegExp(`^${uncertainWords}\\s*`, 'u');
const partInParentheses = /\s*\((?:待排|待查|待确认|待核实|疑似|可疑|不除外|不能除外|可能)\)\s*$/u;

function qualified(raw) {
  const withoutHeading = raw.trim().replace(observationHeading, '').replace(/^\s*[:：]?\s*/u, '');
  let text = withoutHeading.replace(diagnosticPrefix, '');
  let state = 'present';
  if (uncertainPrefix.test(text)) {
    state = 'uncertain';
    text = text.replace(uncertainPrefix, '');
  } else if (negatedPrefix.test(text)) {
    state = 'excluded';
    text = text.replace(negatedPrefix, '');
  }
  if (partInParentheses.test(text) || /(?:待排|待查|待核实|待确认|可疑|可能|不除外|不能除外)$/u.test(text)) {
    state = 'uncertain';
    text = text.replace(partInParentheses, '').replace(/(?:待排|待查|待核实|待确认|可疑|可能|不除外|不能除外)$/u, '');
  } else if (/(?:已排除|已否定)$/u.test(text)) {
    state = 'excluded';
    text = text.replace(/(?:已排除|已否定)$/u, '');
  }
  return { text: text.trim(), state };
}

const chineseDigits = Object.freeze({ 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 });
const countToken = '(?:[0-9]{1,2}|[一二两三四五六七八九]?十[一二三四五六七八九]?|[零〇一二两三四五六七八九])';
function smallCount(raw) {
  if (/^[0-9]{1,2}$/u.test(raw)) return Number(raw);
  if (Object.hasOwn(chineseDigits, raw)) return chineseDigits[raw];
  const [tens, ones] = raw.split('十');
  return raw.includes('十') ? (chineseDigits[tens] ?? 1) * 10 + (chineseDigits[ones] ?? 0) : NaN;
}

const side = label => label?.startsWith('左') ? 'left' : label?.startsWith('右') ? 'right' : null;
const sideLabel = label => /^(?:双侧|两侧)$/u.test(label || '') ? 'both' : side(label);
const sectionKey = Object.freeze({ 颈椎: 'C', 胸椎: 'T', 腰椎: 'L' });
const levelLimits = Object.freeze({ C: 7, T: 12, L: 5 });
const countedJoin = '(?:[,，、]|以及|及|和|与)';
const countedMemberSplit = /[,，、]|以及|及|和|与/u;
const spineMember = `(?:[CTL]\\s*)?(?:第\\s*)?${countToken}`;
const spineList = `${spineMember}(?:\\s*(?:[-–—~～至到]|${countedJoin})\\s*${spineMember}){0,11}`;
const spineObservation = `(?:(左侧?|右侧?|双侧|两侧)\\s*)?(颈椎|胸椎|腰椎|[CTL])\\s*(${spineList})\\s*(?:节\\s*)?(?:(左侧?|右侧?|双侧|两侧)\\s*)?(横突|棘突|椎弓根|椎弓|椎体)\\s*(?:均|分别|各有)?\\s*(?:有|见)?(?:压缩性?|粉碎性?)?骨折`;
const spinePattern = new RegExp(`^${spineObservation}$`, 'iu');
function vertebralLevels(raw, region) {
  const members = new Set();
  for (const member of raw.split(countedMemberSplit)) {
    const range = member.split(/[-–—~～至到]/u);
    if (range.length > 2) return [];
    const numbers = range.map(part => {
      const match = /^(?:([CTL])\s*)?(?:第\s*)?([0-9]{1,2}|[零〇一二两三四五六七八九十]+)$/iu.exec(part.trim());
      if (!match || match[1] && match[1].toUpperCase() !== region) return NaN;
      return smallCount(match[2]);
    });
    const [start, end = start] = numbers;
    if (![start, end].every(n => Number.isInteger(n) && n >= 1 && n <= levelLimits[region]) || end < start) return [];
    for (let n = start; n <= end; n++) members.add(`${region}${n}`);
  }
  return [...members];
}

const toothObservation = `(牙位\\s*)?([1-4][1-8](?:\\s*${countedJoin}\\s*[1-4][1-8])*)\\s*(号牙|牙齿|牙)?\\s*(?:均|分别)?\\s*(脱落|折断|折裂|折)`;
const toothPattern = new RegExp(`^${toothObservation}$`, 'u');
const pelvicMember = '(?:耻骨上支|耻骨下支|髂骨翼|髋臼|骶骨|坐骨支|髂骨)';
const pelvisObservation = `(左侧?|右侧?|双侧|两侧)\\s*(${pelvicMember}(?:\\s*${countedJoin}\\s*${pelvicMember})*)\\s*(?:均)?\\s*(?:有|见)?(?:粉碎性)?骨折`;
const pelvisPattern = new RegExp(`^${pelvisObservation}$`, 'u');
const commaInCountList = new RegExp(`${spineObservation}|(?<![0-9])${toothObservation}(?![伤线])|${pelvisObservation}`, 'giu');
const pubicRamiPattern = /^(左侧?|右侧?|双侧|两侧)\s*耻骨(上|下)(?:支)?\s*(?:、|及|和|与)\s*(?:耻骨)?(上|下)支\s*(?:均)?\s*(?:有|见)?(?:粉碎性)?骨折$/u;
const dentalCountFirst = new RegExp(`^(?:共|合计)?\\s*(${countToken})\\s*(?:枚|颗)\\s*(?:上颌|下颌)?(?:切牙|门牙|前牙|恒牙|牙齿|牙)\\s*(?:均|分别|完全)?\\s*(脱落|脱失|缺失|折断|折裂)$`, 'u');
const totalPatterns = [
  [toothLoss, new RegExp(`^牙齿(?:脱落|脱失)\\s*(?:共|合计)?\\s*(${countToken})\\s*(?:枚|颗)(以上)?$`, 'u')],
  [toothFracture, new RegExp(`^(?:牙齿(?:折断|折裂)|牙折)\\s*(?:共|合计)?\\s*(${countToken})\\s*(?:枚|颗)(以上)?$`, 'u')],
  [pelvis, new RegExp(`^骨盆\\s*(?:有|见|共|合计)?\\s*(${countToken})\\s*处(以上)?\\s*骨折$`, 'u')],
  [vertebralBody, new RegExp(`^(${countToken})\\s*节(以上)?\\s*椎体骨折$`, 'u')],
  [vertebralProcess, new RegExp(`^(${countToken})\\s*处(以上)?\\s*(?:横突|棘突|椎弓|椎弓根)骨折$`, 'u')],
];

function counted(text, state, add) {
  const spine = spinePattern.exec(text);
  if (spine) {
    const [, leadingSide, regionName, list, endingSide, part] = spine;
    if (leadingSide && endingSide && sideLabel(leadingSide) !== sideLabel(endingSide)) return;
    const region = sectionKey[regionName] || regionName.toUpperCase();
    const site = part.replace('椎弓根', '椎弓');
    const label = sideLabel(leadingSide || endingSide);
    const sides = site === '椎体' || site === '棘突' ? [null]
      : label === 'both' ? ['left', 'right'] : [label];
    for (const member of vertebralLevels(list, region)) {
      for (const s of sides) add(part === '椎体' ? vertebralBody : vertebralProcess, { member, site, side: s, state });
    }
  }
  const dental = toothPattern.exec(text);
  if (dental && (dental[1] || dental[3])) {
    for (const member of dental[2].split(countedMemberSplit).map(item => item.trim())) {
      add(dental[4] === '脱落' ? toothLoss : toothFracture, { member, state });
    }
  }
  const countedDental = dentalCountFirst.exec(text);
  if (countedDental) {
    const count = smallCount(countedDental[1]);
    const field = /^(?:折断|折裂)$/u.test(countedDental[2]) ? toothFracture : toothLoss;
    if (count > 0) add(field, { minimum: count, exact: true, state });
  }
  const pelvic = pelvisPattern.exec(text);
  const pubicRami = pubicRamiPattern.exec(text);
  if (pelvic || pubicRami) {
    const label = sideLabel((pelvic || pubicRami)[1]);
    const sides = label === 'both' ? ['left', 'right'] : [label];
    const members = pelvic ? pelvic[2].split(countedMemberSplit).map(item => item.trim())
      : [pubicRami[2], pubicRami[3]].map(part => `耻骨${part}支`);
    for (const s of sides) for (const member of members) add(pelvis, { member: `${s}:${member}`, state });
  }
  for (const [field, pattern] of totalPatterns) {
    const explicit = pattern.exec(text);
    if (!explicit) continue;
    const minimum = smallCount(explicit[1]);
    if (Number.isInteger(minimum) && minimum >= 0) add(field, { minimum, exact: !explicit[2], state });
  }
}

// Only a directly stated, uncomplicated fracture can support the ordinary long-bone branch.
const singleLimbBone = '肱骨|桡骨|尺骨|股骨|胫骨|腓骨';
const limbBoneNames = `${singleLimbBone}|胫腓骨|尺桡骨|桡尺骨|四肢长骨`;
const limbBonePart = '近端|远端|上端|下端|上段|中段|下段|外科颈|粗隆间|转子间|粗隆|转子|颈部?|头部?|骨干|干|平台|髁上|内踝|外踝|茎突';
const fractureType = '(?:外伤性|新鲜|闭合性|完全性|单纯性|线性|横形|斜形|螺旋形|一处|轻微|开放性|粉碎性?|撕脱性?|多处|两处|双侧)';
const limbFractureItem = new RegExp(`^(?<lead>${fractureType}*)\\s*(?<laterality>左侧?|右侧?|双侧|两侧)?\\s*(?<bone>${limbBoneNames})\\s*(?<part>${limbBonePart})?\\s*(?:见|有)?\\s*(?<type>${fractureType}*)\\s*骨折(?<rest>.*)$`, 'u');
const jointSurfaceLink = '(?:累及|涉及|波及|延及|达到|延伸至|进入)[^,，、]{0,8}关节面';
const noJointSurfaceLink = '(?:未(?:见)?|不)(?:累及|涉及|波及|延及)(?:[上下内外远近端侧]{1,3})?(?:肩|肘|腕|髋|膝|踝)?(?:关节)?关节面|(?:未见|无)关节面受累|关节面未受累';
const routineFractureTail = new RegExp(`^(?:(?:伴(?:有)?|并|但|且)?(?:对位对线良好|无(?:明显)?移位|未见(?:明显)?移位|(?:断端)?(?:稍有|轻度)移位|(?:骨折线)?(?:${noJointSurfaceLink}))){0,3}$`, 'u');
const complicationTerms = `撕脱(?:性?骨折)?|骨皮质[^,，、]{0,8}(?:砍|刺)痕|粉碎(?:性?骨折)?|(?:多处|多发性?|[二两2三3]处|双侧|两侧|开放性)骨折|关节内骨折|关节面(?:受累|是否受累|塌陷)|${jointSurfaceLink}|不愈合|假关节|畸形愈合|慢性骨髓炎|骺板(?:断裂|分离|损伤)|骨骺分离`;
const complexFractureType = /撕脱|粉碎|多处|两处|双侧|两侧|开放性/u;
const linkedComplexFracture = new RegExp(`^(?:(?:上述|该(?:处|部位)?)?骨折(?:线|处)?|该(?:处|部位)|此处|但|并|伴|且|有|为|尚不能确定|尚|仍|考虑|疑似|疑有|可疑|可能|不能排除|不排除|不除外|待排|是否|\\s)*(?:${complicationTerms})`, 'u');
const namedComplexFracture = new RegExp(complicationTerms, 'u');
const limbBoneTerms = new RegExp(limbBoneNames, 'gu');
const simpleLimbBone = new RegExp(`^(?:${singleLimbBone})$`, 'u');
const hipReplacement = /(?:全髋|半髋|髋关节|股骨头|人工关节)(?:关节)?(?:假体)?(?:置换|更换)|假体置换/u;
const limbExamSites = '肩(?:关节|部)?|上臂|肘(?:关节|部)?|前臂|腕(?:关节|部)?|髋(?:关节|部)?|大腿|膝(?:关节|部)?|小腿|踝(?:关节|部)?|足(?:部)?';
const limbExamSite = `(?:左侧?|右侧?|双侧)?\\s*(?:${limbExamSites})\\s*`;
const limbExamPrefix = new RegExp(`^(?:入院|急诊|复查)?\\s*(?<sites>${limbExamSite}(?:[及和、]${limbExamSite}){0,2})(?:三维\\s*)?(?:CT|MRI|X线(?:片)?|X片|DR)(?:三维重建|平扫|检查|报告)?\\s*(?:显示|提示|所见|结果|示|见|(?=[:：]|${negatingWords}|${uncertainWords}))\\s*[:：]?\\s*`, 'iu');
const limbExamTarget = new RegExp(`^(左侧?|右侧?|双侧)?\\s*(${limbExamSites})\\s*$`, 'u');
const bonesByExamination = [
  [/^(?:肩|上臂)/u, ['肱骨']], [/^肘/u, ['肱骨', '尺骨', '桡骨']], [/^(?:前臂|腕)/u, ['尺骨', '桡骨']],
  [/^(?:髋|大腿)/u, ['股骨']], [/^膝/u, ['股骨', '胫骨', '腓骨']], [/^(?:小腿|踝|足)/u, ['胫骨', '腓骨']],
];
const unsitedFractureReport = new RegExp(`^(?:(?:复查|检查|急诊|影像学?|CT|MRI|X线(?:片)?|X片|DR|报告|提示|显示|示)\\s*[:：]?\\s*)*(?:${negatingWords}|${uncertainWords})`, 'iu');
const limbReportPrefix = /^(?:(?:影像(?:学|检查)?(?:证实|确诊)|(?:急诊|复查|最终)诊断(?:为)?|(?:后续?|复查)?报告(?:证实|确诊|显示|提示|称)|X片(?:示|显示|提示))\s*[:：]?\s*)+/iu;
const limbItemNumber = /^\s*\d{1,2}\s*[.、:：)]\s*(?!\d)/u;
const newLimbFinding = /^(?:另见|另有|并见|同时见|另外|另查见|但明确(?:见)?|证实(?:为)?)\s*[:：]?\s*/u;
const canonicalLimbPart = part => ({ 上端: '近端', 下端: '远端', 干: '骨干', 颈部: '颈', 头部: '头', 转子间: '粗隆间' })[part] || part || null;

function qualifiedLimbItem(raw) {
  const fragment = raw.replace(observationHeading, '').trim().replace(limbItemNumber, '');
  const intro = fragment.replace(newLimbFinding, '');
  const examination = limbExamPrefix.exec(intro);
  const report = intro.slice(examination?.[0].length || 0).replace(limbReportPrefix, '');
  const item = qualified(report);
  return { ...item, text: item.text.replace(limbItemNumber, ''), statement: report.replace(diagnosticPrefix, ''),
    examination: examination?.groups.sites, unsited: unsitedFractureReport.test(report),
    independent: report !== fragment || diagnosticPrefix.test(report) };
}

const limbLocation = new RegExp(`^(?<laterality>左侧?|右侧?)?\\s*(?<bone>${singleLimbBone})\\s*(?<part>${limbBonePart})?`, 'u');
const wholeLimbLocation = new RegExp(`${limbLocation.source}$`, 'u');
const limbCoordinationToken = /[()（）,，、]|以及|或者|及|和|与|或/gu;
const compactFractureDetail = text => text.replace(/[\s()（）]/gu, '');
const genericFractureQualifier = /^(?:(?:但|且|并|其|该(?:处|部位)|此处|上述)*骨折(?:性质|部位|诊断)?|但(?:性质|诊断)|该(?:处|部位)|此处|上述诊断)(?:(?:尚|仍|已|有)?(?:疑问|待核|不确定|不明确|未明确|未证实|排除|否定)|与本次无关|不属于本次(?:损伤|外伤))/u;

function limbExaminationTargets(examination) {
  return examination.split(/[及和、]/u).map(region => {
    const [, laterality, site] = limbExamTarget.exec(region.trim()) || [];
    const members = site ? bonesByExamination.find(([pattern]) => pattern.test(site))?.[1] || [] : [];
    return { side: side(laterality), members };
  });
}

function limbFindingSide(laterality, member, examination) {
  if (laterality) return side(laterality);
  if (!member || !examination) return null;
  const targets = limbExaminationTargets(examination);
  const examSide = targets[0].side;
  // Only inherit the side of a single-sided examination that covers this bone.
  return examSide && targets.every(target => target.side === examSide)
    && targets.some(target => target.members.includes(member)) ? examSide : null;
}

function addCoordinatedExclusions({ text, state, examination }, add) {
  if (state !== 'excluded' || !text.includes('骨折')) return false;
  const items = countItems(text, limbCoordinationToken, true);
  if (items.length < 2 || !text.match(limbBoneTerms)) return false;
  const locations = items.map(raw => wholeLimbLocation.exec(raw.replace(/\s*骨折$/u, '').trim())?.groups);
  if (locations.some(location => !location)) {
    // An unresolved member may refer to the affirmed site. Do not narrow the exclusion to the first member.
    add(limbBoneFracture, { state: 'review' });
    return true;
  }
  for (const { laterality, bone: member, part } of locations) {
    add(limbBoneFracture, { member, site: canonicalLimbPart(part),
      side: limbFindingSide(laterality, member, examination), state });
  }
  return true;
}

function bareFractureFollowUp({ text, state, examination, unsited }, add) {
  if (state === 'present' || !/^(?:明显|明确|新鲜)?骨折(?:征象|表现)?$/u.test(text)) return;
  if (!examination) {
    if (unsited) add(limbBoneFracture, { state, linkedOnly: true });
    return;
  }
  for (const { side: examinedSide, members } of limbExaminationTargets(examination)) {
    for (const member of members) add(limbBoneFracture, { member, side: examinedSide, state, linkedOnly: true });
  }
}

function limbFracture(item, add) {
  const { text, raw, statement, examination } = item;
  let { state } = item;
  if (addCoordinatedExclusions(item, add)) return;
  const finding = limbFractureItem.exec(state === 'present' ? text : text.replace(/^明显\s*/u, ''));
  if (finding) {
    const { bone, part, laterality, lead, type, rest } = finding.groups;
    const details = compactFractureDetail(rest);
    const member = simpleLimbBone.test(bone) ? bone : null;
    if (state === 'present') {
      if (complexFractureType.test(`${lead}${laterality || ''}${type}`) || part === '平台'
        || !member && bone !== '四肢长骨') state = 'review';
      else if (!routineFractureTail.test(details) || /轻微/u.test(`${lead}${type}`)) state = 'uncertain';
    }
    add(limbBoneFracture, { member, site: canonicalLimbPart(part),
      side: limbFindingSide(laterality, member, examination), state,
      additional: /^(?:另见|另有|另查见|另有一处)/u.test(raw) });
    return;
  }

  bareFractureFollowUp(item, add);
  // Imprecise descriptions can block the ordinary rule, but never establish a fracture.
  const bones = new Set(text.match(limbBoneTerms) || []);
  const location = bones.size === 1 ? limbLocation.exec(text)?.groups : null;
  const fractureMention = bones.size > 0 && /骨折|砍(?:刺)?痕|刺痕/u.test(text);
  const replacement = hipReplacement.test(text);
  const complication = bones.size > 0 && namedComplexFracture.test(text) || linkedComplexFracture.test(text);
  const genericCorrection = genericFractureQualifier.test(statement);
  if (!fractureMention && !replacement && !complication && !genericCorrection) return;
  if ((state === 'excluded' && !fractureMention && !genericCorrection)
    || routineFractureTail.test(compactFractureDetail(text))) return;
  const replacementSide = /^(?:(?:已行|施行|接受)\s*)?(左侧?|右侧?)/u.exec(text)?.[1];
  add(limbBoneFracture, { member: location?.bone || (replacement ? '股骨' : null),
    site: canonicalLimbPart(location?.part), side: side(location?.laterality || (replacement ? replacementSide : null)),
    linkedOnly: replacement && !fractureMention, state: state === 'excluded' ? 'excluded' : 'review' });
}

const amount = '(\\d{1,3}(?:\\.\\d{1,2})?)';
const lungMeasurement = new RegExp(`^(左侧?|右侧?|双侧|同侧)?\\s*肺(?:组织)?(?:萎陷|压缩)\\s*(均)?\\s*(?:为|达|是|在)?\\s*(约|大约|估计)?\\s*(超过|大于|至少)?\\s*${amount}\\s*%\\s*(左右|以上|以下|以内)?$`, 'u');
const pleuralInjury = /^(?:(左侧?|右侧?|双侧)\s*)?(?:创伤性|外伤性)?(?:血气胸|液气胸|血胸|气胸)\s*(?:[,，]\s*(?:伴有?|合并|并见)?|伴有?|合并|并见)\s*(.+)$/u;
function linkedLungMeasurements(sentence, add) {
  const observation = qualified(sentence);
  const link = pleuralInjury.exec(observation.text);
  if (!link) return;
  const linkedSide = side(link[1]);
  for (const raw of link[2].split(/[,，、]|\s*及\s*/u)) {
    const item = qualified(raw);
    const measured = lungMeasurement.exec(item.text);
    // A different finding ends the list associated with this pleural injury.
    if (!measured) break;
    const [, site, distributes, approximation, lower, number, bound] = measured;
    const value = Number(number);
    const measuredSide = site && site !== '同侧' ? side(site) : linkedSide;
    if ((!measuredSide && site !== '双侧') || value < 0 || value > 100 || lower && bound
      || site === '双侧' && !distributes || site !== '双侧' && distributes) break;
    const state = observation.state !== 'present' ? observation.state
      : approximation || bound && bound !== '以上' ? 'uncertain' : item.state;
    for (const s of (site === '双侧' ? ['left', 'right'] : [measuredSide])) {
      if (!linkedSide || linkedSide === s) add(lung, { side: s, value, lowerBound: Boolean(lower || bound === '以上'), state });
    }
  }
}

const surgicalNeed = /^(?:(?:因|由于)\s*)?(腹腔积血|腹膜后血肿)\s*[,，]?\s*(?:需要|须|需|必须|不需要|无需|无须|尚不能确定是否需要)\s*(?:行|进行|接受)?\s*手术(?:治疗)?$/u;
const surgeryDone = /^(?:因|由于)\s*(腹腔积血|腹膜后血肿)\s*[,，]?\s*(?:已(?:经)?行|已接受|实施了|行了)\s*手术(?:治疗)?$/u;
function linkedSurgery(text, state, add) {
  const link = surgicalNeed.exec(text) || surgeryDone.exec(text);
  if (!link) return;
  if (state === 'present' && /(?:不需要|无需|无须)/u.test(text)) state = 'excluded';
  if (state === 'present' && text.includes('尚不能确定')) state = 'uncertain';
  add(abdominalSurgery, { member: link[1], state });
}

function bareInjuryDateMentions(text) {
  return [...text.matchAll(monthDayInjury)]
    .filter(match => !/(?:19|20)\d{2}年\s*$/u.test(text.slice(Math.max(0, match.index - 12), match.index)));
}

function injuryDateMentionCount(text) {
  return parseEventDateAnchors(text).length + bareInjuryDateMentions(text).length;
}

function parseStatement(sentence) {
  const observations = new Map();
  if (!sentence || sentence.length > 420 || assessmentScopeChange.test(sentence)) return observations;
  const nonCurrentStart = sentence.search(nonObservation);
  if (nonCurrentStart >= 0) {
    const before = sentence.slice(0, nonCurrentStart);
    if (!/[,，]\s*$/u.test(before)) return observations;
    // A historical aside must not hide a correction in the current report before it.
    // In a mixed sentence that fragment can block the ordinary rule, but not prove it.
    sentence = before.replace(/[,，]\s*$/u, '');
  }
  const question = /[?？]$/u.test(sentence);
  sentence = sentence.replace(/[?？]$/u, '');
  const fragments = sentence.split(/[,，]/u);
  if (/(?:19|20)\d{2}|\d月/u.test(sentence)) {
    const events = injuryDateMentionCount(sentence);
    if (events > 1 || events === 1 && !injuryDateMentionCount(fragments[0])) return observations;
    if (events && fragments.length > 1) fragments.shift();
  }
  const linkedText = fragments.join(',');
  const items = countItems(linkedText);
  const markUncertain = question || unresolvedCorrection.test(sentence)
    || items.length > 1 && listEndQualifier.test(sentence)
    || items.some(item => standaloneQualifier.test(item));
  const add = (field, observation) => {
    if (nonCurrentStart >= 0 && field !== limbBoneFracture) return;
    const entries = observations.get(field) || [];
    entries.push(markUncertain || nonCurrentStart >= 0 && observation.state === 'present'
      ? { ...observation, state: 'uncertain' } : observation);
    observations.set(field, entries);
  };
  let qualifiedList = false;
  // A comma between verified members belongs to the list, not to another report.
  // Keep the original text and offsets for the evidence; only tokenize this copy.
  const countedItems = countItems(linkedText.replace(commaInCountList, list => list.replace(/[,，]/gu, '、')));
  for (const fragment of countedItems) {
    const item = qualified(fragment);
    // An unqualified item after a negated or uncertain item may still be under that qualifier.
    counted(item.text, qualifiedList && item.state === 'present' ? 'uncertain' : item.state, add);
    qualifiedList ||= item.state !== 'present';
  }
  let qualifiedLimbList = false;
  for (const fragment of items) {
    const limbItem = qualifiedLimbItem(fragment);
    if (limbItem.independent) qualifiedLimbList = false;
    limbFracture({ ...limbItem, raw: fragment,
      state: qualifiedLimbList && limbItem.state === 'present' ? 'uncertain' : limbItem.state }, add);
    qualifiedLimbList ||= limbItem.state !== 'present';
  }
  // Check an explicit grammatical link, never co-occurrence of two phrases in different notes.
  const whole = qualified(linkedText);
  linkedSurgery(whole.text, whole.state, add);
  if (whole.state !== 'present' && /^(?:腹腔积血|腹膜后血肿)$/u.test(whole.text)) {
    add(abdominalSurgery, { member: whole.text, state: whole.state });
  }
  linkedLungMeasurements(linkedText, add);
  return observations;
}

function limbQuoteAfterInjuryDate(evidence) {
  const comma = evidence.search(/[,，]/u);
  if (comma < 0 || !/(?:19|20)\d{2}/u.test(evidence.slice(comma + 1))
    || nonObservation.test(evidence) || assessmentScopeChange.test(evidence)) return null;
  const incidents = parseEventDateAnchors(evidence);
  if (incidents.length !== 1 || incidents[0].index <= comma || bareInjuryDateMentions(evidence).length) return null;
  const { index } = incidents[0];
  // Keep only the words from the dated event onward. A long-bone finding before the
  // date is not tied to it, and an unresolved conflict across that boundary needs review.
  if (parseStatement(evidence.slice(0, index)).has(limbBoneFracture)) return null;
  const text = evidence.slice(index);
  return parseStatement(text).has(limbBoneFracture) ? { text, offset: index } : null;
}

const separateLimbInjury = /(?:另一次|另一起|第二次|再次|不同次)[^,，。；;\n]{0,10}(?:外伤|受伤|事故|车祸|摔伤|跌伤|创伤)/u;
function unresolvedLimbScope(source) {
  // A restricted assessment or an undated second injury must not be treated as one unrestricted event.
  if (assessmentScopeChange.test(source)) return true;
  const incidents = parseEventDateAnchors(source);
  const partialDates = new Set(bareInjuryDateMentions(source).map(match => match[0].split('日', 1)[0]));
  if (partialDates.size && incidents.length + partialDates.size > 1) return true;
  return [...source.matchAll(sentencePattern)].some(match => separateLimbInjury.test(match[0])
    && !/既往|旧伤|陈旧/u.test(match[0])
    && !incidents.some(incident => incident.index >= match.index && incident.index < match.index + match[0].length));
}

export function findScopedEvidenceQuotes(source) {
  const quotes = [];
  let inNonObservationSection = false;
  for (const match of source.matchAll(sentencePattern)) {
    const evidence = match[0].trim();
    const normalizedStart = match.index + match[0].indexOf(evidence);
    const normalizedEnd = normalizedStart + evidence.length;
    if (nonObservationHeading.test(evidence)) inNonObservationSection = true;
    else if (observationHeading.test(evidence)) inNonObservationSection = false;
    if (inNonObservationSection) continue;
    const fields = [...parseStatement(evidence).keys()];
    const dated = fields.includes(limbBoneFracture) ? null : limbQuoteAfterInjuryDate(evidence);
    if ((!fields.length && !dated) || hasNonCurrentClinicalContext(source, normalizedStart, normalizedEnd)) continue;
    for (const field of fields) quotes.push({ field, evidence, normalizedStart, normalizedEnd });
    if (dated && !hasNonCurrentClinicalContext(source, normalizedStart + dated.offset, normalizedEnd)) {
      quotes.push({ field: limbBoneFracture, evidence: dated.text,
        normalizedStart: normalizedStart + dated.offset, normalizedEnd });
    }
  }
  if (quotes.some(quote => quote.field === limbBoneFracture) && unresolvedLimbScope(source)) {
    return quotes.filter(quote => quote.field !== limbBoneFracture);
  }
  return quotes;
}

const unknown = () => ({ met: null, evidence: '', factIds: [] });
const result = (met, proofs) => ({ met,
  evidence: [...new Set(proofs.map(proof => proof.fact.evidence))].join('；'),
  factIds: [...new Set(proofs.map(proof => proof.fact.id).filter(Boolean))] });

function countDistinctMembers(entries) {
  const bySite = new Map();
  for (const { member, site, side } of entries) {
    const key = `${member}:${site || ''}`;
    const sides = bySite.get(key) || new Set();
    if (side) sides.add(side);
    bySite.set(key, sides);
  }
  // A mention without a side may duplicate an explicitly named side.
  return [...bySite.values()].reduce((count, sides) => count + Math.max(1, sides.size), 0);
}

function scopedCounts(predicate, proofs) {
  const entries = proofs.flatMap(proof => proof.entries);
  const conflicts = entries.filter(item => item.state !== 'present');
  const exactTotals = new Set(entries.filter(item => item.state === 'present' && item.exact).map(item => item.minimum));
  if (exactTotals.size > 1 || conflicts.some(item => item.minimum !== undefined)) return unknown();
  const [total] = exactTotals;
  const sameObject = (first, second) => first.member === second.member
    && (!first.site || !second.site || first.site === second.site)
    && (!first.side || !second.side || first.side === second.side);
  const alternatives = proofs.map(proof => {
    const members = proof.entries.filter(item => item.member && item.state === 'present'
      && !conflicts.some(other => sameObject(item, other)));
    const minimums = proof.entries.filter(item => item.state === 'present' && item.minimum !== undefined
      && !conflicts.some(other => other.member)).map(item => item.minimum);
    return { proof, count: Math.max(countDistinctMembers(members), ...minimums) };
  });
  // Counts in different notes may repeat the same injuries. Use the largest supported lower
  // bound from a single observation; do not add separate totals or unlinked observations.
  if (total !== undefined && alternatives.some(item => item.count > total)) return unknown();
  const passing = alternatives.filter(item => item.count >= predicate.value);
  if (passing.length) return result(true, passing.map(item => item.proof));
  // An incomplete list is not a proven total below the threshold.
  return unknown();
}

const limbRegion = part => /^(?:近端|外科颈|颈|头|粗隆|粗隆间|转子|平台)$/u.test(part) ? 'proximal'
  : /^(?:远端|髁上|内踝|外踝|茎突)$/u.test(part) ? 'distal'
    : /^(?:骨干|上段|中段|下段)$/u.test(part) ? 'shaft' : null;
const couldDescribeSameFracture = (a, b) => {
  const aRegion = limbRegion(a.site), bRegion = limbRegion(b.site);
  return (!a.member || !b.member || a.member === b.member)
    && (!a.side || !b.side || a.side === b.side)
    && (!aRegion || !bRegion || aRegion === bRegion);
};

function ordinaryLimbFracture(proofs) {
  const entries = proofs.flatMap(proof => proof.entries);
  const affirmed = entries.filter(item => item.state === 'present');
  const [first] = affirmed;
  if (!first || affirmed.length > 1 && affirmed.some(item => item.additional
    || item.member !== first.member || item.side !== first.side || item.site !== first.site)) return unknown();
  if (entries.some(item => item.state !== 'present'
    && (item.state !== 'excluded' && !item.linkedOnly || couldDescribeSameFracture(first, item)))) return unknown();
  // Identical descriptions of the same site do not create a second site.
  return result(true, proofs.filter(proof => proof.entries.some(item => item.state === 'present')));
}

export function evaluateScopedEvidence(predicate, facts) {
  const { field, operator, value } = predicate;
  const binary = field === abdominalSurgery || field === limbBoneFracture;
  if (binary ? operator !== 'eq' || value !== 1
    : operator !== 'gte' || !Number.isFinite(value) || value <= 0) return unknown();
  if (field === lung && (!['either', 'both'].includes(predicate.sides) || value > 100)) return unknown();
  const proofs = facts.filter(fact => fact.field === field && fact.source === 'description'
    && fact.verification === 'quoted' && fact.certainty === 'reported' && fact.value === fact.evidence
    && fact.gradeEligible !== false && !/^U\d+$/u.test(fact.eventId || '')
    && fact.sourceRefs?.some(ref => ref.source === 'description' && ref.sourceId === 'description'
      && ref.evidence === fact.evidence && ref.positionsComplete !== false))
    .map(fact => ({ fact, entries: parseStatement(fact.evidence).get(field) || [] }))
    .filter(proof => proof.entries.length);
  if (!proofs.length) return unknown();
  if (field === lung) {
    const evidence = proofs.flatMap(proof => proof.entries);
    const resolved = s => {
      const observations = evidence.filter(entry => entry.side === s);
      if (!observations.length || observations.some(entry => entry.state !== 'present')) return false;
      const exact = new Set(observations.filter(entry => !entry.lowerBound).map(entry => entry.value));
      const [measurement] = exact;
      return exact.size === 0 || exact.size === 1 && observations.every(entry => entry.value <= measurement);
    };
    const usable = { left: resolved('left'), right: resolved('right') };
    for (const proof of proofs) {
      const satisfying = new Set(proof.entries.filter(entry => entry.state === 'present'
        && usable[entry.side] && entry.value >= value).map(entry => entry.side));
      if (predicate.sides === 'both' ? satisfying.size === 2 : satisfying.size > 0) return result(true, [proof]);
    }
    // A bilateral conclusion requires both measurements in the same linked observation.
    return unknown();
  }
  if (field === abdominalSurgery) {
    const all = proofs.flatMap(proof => proof.entries);
    const supporting = proofs.filter(proof => proof.entries.some(item => item.state === 'present'
      && !all.some(other => other.member === item.member && other.state !== 'present')));
    if (supporting.length) return result(true, supporting);
    if (all.every(item => item.state === 'excluded') && new Set(all.map(item => item.member)).size === 2) {
      return result(false, proofs);
    }
    return unknown();
  }
  if (field === limbBoneFracture) return ordinaryLimbFracture(proofs);
  return scopedCounts(predicate, proofs);
}
