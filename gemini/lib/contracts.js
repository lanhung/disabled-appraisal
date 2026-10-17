import { z } from 'zod';

const text = z.string().trim().max(8000);
const shortText = z.string().trim().max(1000);
export const assessmentTypeSchema = z.enum(['injury', 'disability']);
export const statusSchema = z.enum(['preliminary', 'insufficient', 'needs_review', 'not_applicable']);

export const requestSchema = z.object({
  assessmentType: assessmentTypeSchema,
  description: z.string().trim().max(40000).default(''),
  images: z.array(z.object({
    mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    data: z.string().min(1),
    name: z.string().max(200).default(''),
  })).max(6).default([]),
  injuryDate: z.union([z.iso.date(), z.literal(''), z.null()]).default(''),
  treatmentStatus: z.enum(['unknown', 'ongoing', 'stable']).default('unknown'),
  forceReanalysis: z.boolean().default(false),
}).superRefine((value, context) => {
  if (!value.description && !value.images.length) {
    context.addIssue({ code: 'custom', message: '请填写病历内容或上传报告图片。' });
  }
  if (value.injuryDate && value.injuryDate > new Date().toISOString().slice(0, 10)) {
    context.addIssue({ code: 'custom', path: ['injuryDate'], message: '受伤日期不能晚于今天。' });
  }
});

export const providerResultSchema = z.object({
  status: statusSchema,
  grade: z.string().max(30).nullable(),
  summary: shortText,
  reasoning: text,
  facts: z.array(z.object({
    finding: shortText,
    source: z.enum(['description', 'image']),
    evidence: shortText,
  })).max(30),
  references: z.array(z.object({
    clauseId: z.string().max(40),
    evidence: shortText,
    reasoning: shortText,
    relation: z.enum(['supports', 'incomplete', 'differential']),
    conditions: z.array(z.object({
      condition: shortText,
      evidence: shortText,
      factIds: z.array(z.string().trim().min(1).max(24)).max(30).optional(),
      met: z.boolean().nullable(),
    })).min(1).max(12),
  })).max(16),
  missingMaterials: z.array(shortText).max(20),
  nextSteps: z.array(shortText).max(12),
  warnings: z.array(shortText).max(20),
});

export const extractionSchema = z.object({
  pages: z.array(z.object({ imageIndex: z.number().int().min(1).max(6), text, issues: z.array(shortText).max(15) })).max(6),
});

export const factCertaintySchema = z.enum(['reported', 'observed', 'derived', 'uncertain', 'excluded', 'conflicted', 'unknown']);
export const factSourceReferenceSchema = z.object({
  source: z.enum(['description', 'image']),
  sourceId: z.string().trim().regex(/^(?:description|image-[1-6])$/).nullable(),
  evidence: shortText,
});
export const extractedFactSchema = z.object({
  id: z.string().trim().max(24).optional(),
  eventId: z.string().trim().regex(/^E[1-9]\d{0,2}$/).nullable().optional(),
  field: z.string().trim().min(1).max(64),
  value: z.json(),
  certainty: factCertaintySchema,
  source: z.enum(['description', 'image']),
  evidence: shortText,
  sourceRefs: z.array(factSourceReferenceSchema).max(6).optional(),
});
export const factConflictSchema = z.object({
  factIds: z.array(z.string().trim().min(1).max(24)).max(30),
  reason: shortText,
});
export const factExtractionSchema = z.object({
  facts: z.array(extractedFactSchema).max(200),
  missingMaterials: z.array(shortText).max(100),
  conflicts: z.array(factConflictSchema).max(100),
  requiresReview: z.boolean(),
});

export const standardSchema = z.object({
  type: assessmentTypeSchema,
  name: shortText,
  version: shortText,
  effectiveDate: z.iso.date(),
  sourceUrl: z.url(),
});

export const resultSchema = providerResultSchema.omit({ references: true, facts: true }).extend({
  schemaVersion: z.literal(2),
  assessmentType: assessmentTypeSchema,
  standard: standardSchema,
  facts: z.array(extractedFactSchema.extend({
    finding: shortText,
    verification: z.enum(['quoted', 'image_pending']),
    assertedCertainty: factCertaintySchema.optional(),
    derivedFrom: z.array(z.string().trim().min(1).max(24)).max(30).optional(),
  })),
  conflicts: z.array(factConflictSchema).max(100),
  requiresReview: z.boolean(),
  references: z.array(z.object({
    id: shortText, grade: shortText, category: shortText, text,
    sourceUrl: z.url(), evidence: shortText, reasoning: shortText,
    relation: z.enum(['supports', 'incomplete', 'differential']),
    conditions: z.array(z.object({ condition: shortText, evidence: shortText,
      factIds: z.array(z.string().trim().min(1).max(24)).max(30).optional(), met: z.boolean().nullable() })),
  })),
  recognizedText: z.string().max(60000),
  createdAt: z.iso.datetime(),
  requestId: shortText,
  model: shortText,
});
