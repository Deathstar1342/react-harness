import {z} from 'zod';
export const browserProbeStage=z.enum(['positive','enforced','positiveAgain']);
export type BrowserProbeStage=z.infer<typeof browserProbeStage>;
export const browserProbeResult=z.strictObject({kind:z.literal('preview-capability'),probeId:z.uuid(),documentId:z.uuid(),stage:browserProbeStage,nonce:z.string().regex(/^[a-f0-9]{48}$/),settled:z.literal(true),peerOpened:z.boolean(),peerDelivered:z.boolean(),error:z.boolean()});
export type BrowserProbeResult=z.infer<typeof browserProbeResult>;
export const browserProbeStep=z.strictObject({id:z.uuid(),documentId:z.uuid(),stage:browserProbeStage,nonce:z.string().regex(/^[a-f0-9]{48}$/),url:z.string().max(256),expiresAt:z.number().int().positive()});
export type BrowserProbeStep=z.infer<typeof browserProbeStep>;
export const browserPreviewView=z.strictObject({id:z.uuid(),documentId:z.uuid(),url:z.string().max(256),expiresAt:z.number().int().positive()});
export type BrowserPreviewView=z.infer<typeof browserPreviewView>;
