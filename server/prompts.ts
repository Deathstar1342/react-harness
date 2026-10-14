import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { AgentRole } from '../shared/types.js';
import type { Config } from './config.js';
import { createHash } from 'node:crypto';
import { policy } from './prompts/policy.js';
import { common } from './prompts/common.js';
import { architect } from './prompts/architect.js';
import { coder } from './prompts/coder.js';
import { critic } from './prompts/critic.js';

const roles = { architect, coder, critic };
export const PROMPT_VERSIONS = Object.freeze({ policy: policy.version, common: common.version, architect: architect.version, coder: coder.version, critic: critic.version, orchestration: 'orchestration/1' });

export function roleInstructions(role: AgentRole, extension = ''): string {
  if (!Object.hasOwn(roles, role)) throw new Error('Unknown agent role');
  if (Buffer.byteLength(extension) > 32000 || extension.includes('\0')) throw new Error('Prompt extension exceeds the size limit or contains NUL');
  return [policy, common, roles[role]].map(module => `[${module.version}]\n${module.text}`).join('\n\n') +
    (extension ? `\n\nOptional developer extension (subordinate to fixed runtime policy and role responsibilities):\n${extension}` : '');
}

/** Private reproducibility metadata: never publish prompt text or local paths. */
export function promptIdentity(systemText: string) {
  return { versions: PROMPT_VERSIONS, digest: createHash('sha256').update(systemText).digest('hex') };
}

/** Optional server-local guidance cannot replace fixed native instructions. */
export async function loadPromptExtensions(config: Config): Promise<Partial<Record<AgentRole,string>>> {
  const extensions: Partial<Record<AgentRole,string>> = {};
  for(const role of ['architect','coder','critic'] as const) {
    const file = config.promptFiles[role];
    if (!file) continue;
    const failure = () => new Error(`${role} prompt file must be readable UTF-8 text, nonempty, at most 32000 bytes, and contain no API key.`);
    const handle = await open(file,constants.O_RDONLY | (constants.O_NONBLOCK || 0)).catch(()=>{throw failure();});
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size>32000) throw failure();
      const buffer = Buffer.alloc(32001);
      let size = 0;
      while(size<buffer.length) {
        const read = await handle.read(buffer,size,buffer.length-size,null);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      if (size>32000) throw failure();
      let text: string;
      try {text = new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,size)).trim();} catch {throw failure();}
      if (!text || text.includes('\0') || config.apiKey && text.includes(config.apiKey)) throw failure();
      extensions[role] = text;
    } finally {await handle.close();}
  }
  return extensions;
}
