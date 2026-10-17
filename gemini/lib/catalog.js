import fs from 'node:fs';
import MiniSearch from 'minisearch';

const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
const tokenize = value => [...segmenter.segment(value.normalize('NFKC'))]
  .filter(part => part.isWordLike).map(part => part.segment.toLowerCase());

const rawCatalogs = Object.fromEntries(['injury', 'disability'].map(type => {
  const catalog = JSON.parse(fs.readFileSync(new URL(`../data/${type}.json`, import.meta.url), 'utf8'));
  return [type, catalog];
}));

const clauseLogicMetadata = JSON.parse(fs.readFileSync(new URL('../data/clause-logic-v1.json', import.meta.url), 'utf8'));

const normalizeClauseText = value => value.normalize('NFKC').replace(/\s+/g, '');
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validateLogicNode(node, clauseText, annotation) {
  if (!isRecord(node) || typeof node.op !== 'string') throw new TypeError('条款逻辑节点格式无效');
  if (node.sourceText != null && (typeof node.sourceText !== 'string' || !node.sourceText.trim()
    || !normalizeClauseText(clauseText).includes(normalizeClauseText(node.sourceText)))) {
    throw new TypeError('条款逻辑 sourceText 不在官方原文中');
  }
  if (node.op === 'all' || node.op === 'any') {
    if (!Array.isArray(node.children) || node.children.length < 2) throw new TypeError('条款逻辑组至少需要两个子节点');
    for (const child of node.children) validateLogicNode(child, clauseText, annotation);
    return;
  }
  if (node.op !== 'condition' || typeof node.sourceText !== 'string' || typeof node.conditionText !== 'string'
    || !node.conditionText.trim()) throw new TypeError('条款 condition 节点格式无效');
  if (annotation === 'opaque') return;
  const hasFactMatch = isRecord(node.factMatch);
  const hasPredicate = isRecord(node.predicate);
  if (hasFactMatch === hasPredicate) throw new TypeError('显式条件必须且只能配置 factMatch 或 predicate');
  if (hasFactMatch) {
    if (typeof node.factMatch.field !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(node.factMatch.field)
      || !Array.isArray(node.factMatch.values) || node.factMatch.values.length === 0
      || node.factMatch.values.some(value => value === null || typeof value === 'object')) {
      throw new TypeError('条款 factMatch 字段或值无效');
    }
  }
  if (hasPredicate) {
    const { field, operator, value, unit } = node.predicate;
    if (typeof field !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(field)
      || !['eq', 'gt', 'gte', 'lt', 'lte'].includes(operator)
      || typeof value !== 'number' || !Number.isFinite(value)
      || unit != null && typeof unit !== 'string') throw new TypeError('条款 predicate 无效');
  }
}

export function applyClauseLogicMetadata(catalogs, metadata) {
  if (!isRecord(metadata) || metadata.version !== 1 || !isRecord(metadata.clauses)) {
    throw new TypeError('条款逻辑元数据版本或结构无效');
  }
  for (const type of Object.keys(metadata.clauses)) {
    if (!Object.hasOwn(catalogs, type) || !isRecord(metadata.clauses[type])) throw new TypeError(`未知条款元数据类型：${type}`);
    const knownIds = new Set(catalogs[type].clauses.map(clause => clause.id));
    for (const [id, entry] of Object.entries(metadata.clauses[type])) {
      if (!knownIds.has(id)) throw new TypeError(`未知条款 ID：${id}`);
      if (!isRecord(entry) || entry.annotation !== 'explicit' || !entry.logic) throw new TypeError(`条款 ${id} 元数据标记无效`);
      const clause = catalogs[type].clauses.find(item => item.id === id);
      validateLogicNode(entry.logic, clause.text, entry.annotation);
      const displayGroups = entry.logic.op === 'all' ? entry.logic.children : [entry.logic];
      if (displayGroups.some(group => ![group.conditionText, group.sourceText]
        .some(text => typeof text === 'string' && text.trim()))) {
        throw new TypeError(`条款 ${id} 的逻辑显示组缺少可读原文`);
      }
    }
  }
  return Object.fromEntries(Object.entries(catalogs).map(([type, catalog]) => [type, {
    ...catalog,
    clauses: catalog.clauses.map(clause => {
      const explicit = metadata.clauses[type]?.[clause.id];
      return { ...clause, conditionLogic: explicit || {
        annotation: 'opaque',
        logic: { op: 'condition', sourceText: clause.text, conditionText: clause.text },
      } };
    }),
  }]));
}

export const catalogs = applyClauseLogicMetadata(rawCatalogs, clauseLogicMetadata);

const indexes = Object.fromEntries(Object.entries(catalogs).map(([type, catalog]) => {
  const index = new MiniSearch({ fields: ['text', 'category'], storeFields: ['id'], tokenize });
  index.addAll(catalog.clauses);
  return [type, index];
}));

export function retrieveClauses(type, description, limit = 28) {
  const catalog = catalogs[type];
  const matches = indexes[type].search(description, { combineWith: 'OR', boost: { text: 2 } });
  const ids = new Set(matches.slice(0, limit).map(match => match.id));
  return catalog.clauses.filter(clause => ids.has(clause.id));
}

export function catalogContext(type, clauses) {
  const { standard, principles } = catalogs[type];
  return JSON.stringify({ standard, principles, clauses });
}
