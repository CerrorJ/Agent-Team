import { z } from 'zod'

const id = z.string().uuid()
const version = z.number().int().positive()
export const skillDigestSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const skillCommitSchema = z.string().regex(/^[a-f0-9]{40}$/)
export const skillRepositorySchema = z
  .string()
  .regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
export const skillPathSchema = z.string().min(1).max(240)
export const skillReferenceSchema = z
  .object({ id, digest: skillDigestSchema })
  .strict()

export const skillSourceSchema = z
  .object({
    id,
    version,
    name: z.string().trim().min(1).max(120),
    repository: skillRepositorySchema,
    commit: skillCommitSchema,
    createdAt: z.string().datetime(),
  })
  .strict()

export const skillFileSchema = z
  .object({
    path: skillPathSchema,
    size: z.number().int().nonnegative().max(2_000_000),
    sha256: skillDigestSchema,
  })
  .strict()

export const skillPackageSchema = z
  .object({
    id,
    version,
    source: skillSourceSchema,
    directory: skillPathSchema,
    name: z.string().min(1).max(64),
    description: z.string().min(1).max(1024),
    instructions: z.string().min(1).max(64_000),
    licensePath: skillPathSchema,
    licenseText: z.string().min(1).max(64_000),
    files: z.array(skillFileSchema).min(2).max(201),
    digest: skillDigestSchema,
    available: z.boolean(),
    installedAt: z.string().datetime(),
  })
  .strict()

export const skillImportSchema = z
  .object({
    id,
    version,
    source: skillSourceSchema,
    directory: skillPathSchema,
    licensePath: skillPathSchema,
    state: z.enum([
      'queued',
      'fetching',
      'preview_ready',
      'activating',
      'installed',
      'failed',
    ]),
    package: skillPackageSchema.nullable(),
    failureCode: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()

export const skillCommandSchemas = [
  z
    .object({
      type: z.literal('skill.source.save'),
      id: id.optional(),
      expectedVersion: z.number().int().nonnegative(),
      name: z.string().trim().min(1).max(120),
      repository: skillRepositorySchema,
      commit: skillCommitSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('skill.import'),
      sourceId: id,
      sourceVersion: version,
      directory: skillPathSchema,
      licensePath: skillPathSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('skill.activate'),
      id,
      expectedVersion: version,
      digest: skillDigestSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('skill.uninstall'),
      id,
      expectedVersion: version,
    })
    .strict(),
] as const

export type SkillSource = z.infer<typeof skillSourceSchema>
export type SkillPackage = z.infer<typeof skillPackageSchema>
export type SkillImport = z.infer<typeof skillImportSchema>
export type SkillReference = z.infer<typeof skillReferenceSchema>
