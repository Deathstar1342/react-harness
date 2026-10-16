import { createHash } from 'node:crypto';
import { z } from 'zod';
import { helperCanonical, packageRequestSchema } from './package-helper.js';
import type { InstallRecord, PackageHelperRecord } from '../shared/types.js';

const hex = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().max(512);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const name = z.string().regex(/^[a-z0-9][a-z0-9+.-]{1,63}$/);
const version = z.string().regex(/^[0-9][A-Za-z0-9.+:~\-]{0,127}$/);
const localTargetSchema = z.object({ id: hex, installationId: z.string().uuid(), machineId: z.string().regex(/^[a-f0-9]{32}$/), distribution: z.enum(['ubuntu','debian']), release: z.string().regex(/^[0-9.]{1,32}$/), architecture: z.literal('amd64'), manager: z.literal('apt'), adapterVersion: z.literal(1) }).strict();
export const containerTargetSchema=z.object({scope:z.literal('project-container'),id:hex,storageId:z.string().uuid(),projectId:hex,baseImageId:z.string().regex(/^sha256:[a-f0-9]{64}$/),generation:z.string().uuid(),distribution:z.literal('debian'),release:z.literal('12'),architecture:z.literal('amd64'),manager:z.literal('apt'),adapterVersion:z.literal(1)}).strict();
export const targetSchema=z.union([localTargetSchema,containerTargetSchema]);
const uri = z.string().max(2048).refine(value => {
  try { const url = new URL(value); return ['http:','https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
});
const previewSchema = z.object({
  target: targetSchema,
  packages: z.array(z.object({ name, version, architecture: z.string().regex(/^[a-z0-9-]{1,32}$/), sha256: hex, downloadBytes: count, installedBytes: count, requested: z.boolean(), uris: z.array(uri).min(1).max(16), repositories: z.array(z.object({ origin: z.enum(['Ubuntu','Debian']), label: text, archive: text, component: text, site: text, trusted: z.literal(true) }).strict()).min(1).max(16) }).strict()).max(32),
  stateDigest: hex, repositoryDigest: hex,
  impact: z.object({ newPackages: count.max(32), downloadBytes: count.max(128*1024*1024), installedBytes: count.max(512*1024*1024), removals: z.literal(0), upgrades: z.literal(0), downgrades: z.literal(0), maintainerScripts: z.literal('trusted-package-root-execution'), triggers: z.literal('may-modify-existing-packages-and-services'), serviceChanges: z.literal('package-defined') }).strict(),
}).strict();
const containerReceiptSchema=z.object({targetId:hex,baseImageId:z.string().regex(/^sha256:[a-f0-9]{64}$/),imageId:z.string().regex(/^sha256:[a-f0-9]{64}$/),generation:z.string().uuid(),manifestDigest:hex}).strict();
const recordSchema = z.object({
  containerReceipt:containerReceiptSchema.optional(),
  requestId: z.string().uuid(), request: packageRequestSchema, preview: previewSchema, previewDigest: hex,
  state: z.enum(['prepared','noop','authorized','running','succeeded','failed','uncertain']),
  createdAt: count, updatedAt: count, expiresAt: count, code: z.string().regex(/^[A-Z_]{1,64}$/),
  decision: z.object({ requestId: z.string().uuid(), previewDigest: hex, decisionNonce: hex, expiresAt: count }).strict().optional(),
  reconciliation: z.object({ matches: z.boolean(), healthy: z.boolean(), packages: z.array(z.object({ name, expectedVersion: version, installedVersion: version.nullable() }).strict()).max(32) }).strict().optional(),
}).strict();
export function checkedRecord(value: unknown, install: InstallRecord): PackageHelperRecord {
  if (Buffer.byteLength(JSON.stringify(value)) > 160*1024) throw new Error('INVALID_HELPER_EVIDENCE');
  const record = recordSchema.parse(value);
  const preview = record.preview, packages = preview.packages;
  if(install.settings.target?.scope==='project-container'){
    if(record.state==='succeeded'&&(!record.containerReceipt||record.containerReceipt.targetId!==install.settings.target.id||record.containerReceipt.baseImageId!==install.settings.target.baseImageId))throw new Error('INVALID_CONTAINER_LINEAGE');
  }else if(record.containerReceipt)throw new Error('INVALID_CONTAINER_LINEAGE');
  if (record.requestId !== install.id || record.request.requestId !== install.id || record.request.targetId !== install.settings.target?.id || helperCanonical(record.request.packages) !== helperCanonical(install.recommendation.packages) || helperCanonical(preview.target) !== helperCanonical(install.settings.target) || record.previewDigest !== createHash('sha256').update(helperCanonical(preview)).digest('hex') || record.expiresAt - record.createdAt > 120000 || record.expiresAt <= record.createdAt || new Set(packages.map(p=>p.name)).size !== packages.length || preview.impact.newPackages !== packages.length || preview.impact.downloadBytes !== packages.reduce((sum,p)=>sum+p.downloadBytes,0) || preview.impact.installedBytes !== packages.reduce((sum,p)=>sum+p.installedBytes,0)) throw new Error('INVALID_HELPER_EVIDENCE');
  if (install.previewDigest && (install.previewDigest !== record.previewDigest || install.expiresAt !== record.expiresAt)) throw new Error('CHANGED_HELPER_PREVIEW');
  for (const item of packages) {
    const requested = install.recommendation.packages.find(p=>p.name === item.name);
    if (item.requested !== !!requested || requested?.version && requested.version !== item.version) throw new Error('INVALID_HELPER_EVIDENCE');
  }
  return record;
}
