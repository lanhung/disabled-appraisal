import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FACT_SCHEMA_VERSION } from './facts.js';
import { RULES_VERSION } from './catalog.js';

export const ANALYSIS_SNAPSHOT_VERSION = '1.1';

const digest = value => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');

export function hashAssessmentSources(root, sources) {
  const pathApi = /^[a-z]:[\\/]/iu.test(root) ? path.win32 : path.posix;
  const normalized = sources.map(source => ({
    path: pathApi.relative(root, source.path).replaceAll('\\', '/'),
    content: source.content.replace(/\r\n?/gu, '\n'),
  })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return createHash('sha256').update(normalized
    .map(source => `${source.path}\n${source.content}`).join('\n'), 'utf8').digest('hex');
}

const sourceDirectory = new URL('.', import.meta.url);
const sourceFiles = [
  ...readdirSync(sourceDirectory).filter(name => name.endsWith('.js')).sort()
    .map(name => new URL(name, sourceDirectory)),
  new URL('../server.js', import.meta.url),
  new URL('../package.json', import.meta.url),
  new URL('../package-lock.json', import.meta.url),
];
export const ASSESSMENT_CODE_VERSION = hashAssessmentSources(fileURLToPath(sourceDirectory), sourceFiles
  .map(file => ({ path: fileURLToPath(file), content: readFileSync(file, 'utf8') })));

export function createAssessmentSnapshot(input, extracted, config, { factPromptVersion, assessmentPromptVersion,
  codeVersion = 'development-unversioned' } = {}) {
  const inputDigest = digest({
    assessmentType: input.assessmentType,
    description: input.description,
    images: (input.images || []).map(image => ({ mimeType: image.mimeType,
      digest: createHash('sha256').update(image.data, 'utf8').digest('hex') })),
    injuryDate: input.injuryDate,
    treatmentStatus: input.treatmentStatus,
  });
  const factsDigest = digest({
    facts: extracted.facts,
    factAudit: extracted.factAudit,
    conflicts: extracted.conflicts,
    requiresReview: extracted.requiresReview,
    reviewReasons: extracted.reviewReasons || [],
    missingMaterials: extracted.missingMaterials,
  });
  const versions = {
    snapshot: ANALYSIS_SNAPSHOT_VERSION,
    factSchema: FACT_SCHEMA_VERSION,
    factPrompt: factPromptVersion,
    assessmentPrompt: assessmentPromptVersion,
    rules: RULES_VERSION,
    code: codeVersion,
    codeHash: ASSESSMENT_CODE_VERSION,
    provider: config.provider || 'unknown',
    textModel: config.textModel,
    visionModel: config.visionModel,
    temperature: config.temperature ?? null,
    maxTokens: config.maxTokens ?? null,
    thinking: config.thinking ?? null,
    jsonMode: config.jsonMode ?? null,
  };
  return {
    ...versions,
    inputDigest,
    factsDigest,
    snapshotId: digest({ ...versions, inputDigest, factsDigest }),
  };
}
