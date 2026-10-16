import {assertNativePath} from './native-storage.js';
import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, fstatSync, type Stats } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import { z } from 'zod';
import { readConfig, normalizeProviderEndpoint, type Config } from './config.js';
import type { ProviderSettings as PublicProviderSettings, ProviderSettingsPatch } from '../shared/types.js';
import type { Store } from './store.js';
import { applicationHome, profilePaths } from './locations.js';

const fields = { architect: 'ARCHITECT_MODEL', coder: 'CODER_MODEL', critic: 'CRITIC_MODEL', apiKey: 'STARK_API_KEY',baseUrl:'STARK_BASE_URL' } as const;
const value = z.string().max(1024).regex(/^[^\x00-\x1f\x7f\u2028\u2029]*$/, 'Use a single line without control characters');
const model = value.min(1).refine(s => s === s.trim(), 'Remove surrounding whitespace');
const patchSchema = z.object({ models: z.object({architect:model.optional(),coder:model.optional(),critic:model.optional()}).strict().optional(), apiKey:value.refine(s=>s==='' || !!s.trim(), 'Use a nonblank key or an empty string to clear it').optional(),baseUrl:z.string().max(2048).optional() }).strict();
const fail = (message: string) => Object.assign(new Error(message), {statusCode:409});
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

/** One canonical backend directory, one backend process. No request accepts a file path. */
export class ProviderSettingsFile {
  readonly filename: string;
  private readonly parent: string;
  private readonly parentIdentity: Stats;
  private snapshot: {text:string; stat?:Stats};
  private requiresRestart = false;
  readonly overrides: NodeJS.ProcessEnv;
  constructor(filename: string, overrides: NodeJS.ProcessEnv = process.env) {
    this.overrides = {...overrides};
    this.parent = realpathSync(path.dirname(path.resolve(filename)));
    this.parentIdentity = lstatSync(this.parent);
    this.filename = path.join(this.parent, path.basename(filename));
    this.snapshot = this.read();
  }
  private read(): {text:string; stat?:Stats} {
    assertNativePath(this.filename,true,true);
    const parent = lstatSync(this.parent);
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.dev !== this.parentIdentity.dev || parent.ino !== this.parentIdentity.ino || realpathSync(this.parent) !== this.parent) throw fail('Backend configuration directory changed; restart after checking it');
    let stat: Stats;
    try { stat = lstatSync(this.filename); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {text:''}; throw fail('Cannot read backend .env'); }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024*1024) throw fail('Backend .env must be a regular, unlinked file under 1 MiB');
    let fd: number | undefined;
    try {
      fd = openSync(this.filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      if (!same(stat, fstatSync(fd))) throw fail('Backend .env changed while reading');
      const bytes = readFileSync(fd);
      if (bytes.length > 1024*1024) throw fail('Backend .env exceeds 1 MiB');
      const text = new TextDecoder('utf-8', {fatal:true,ignoreBOM:true}).decode(bytes);
      if (text.includes('\0') || !same(stat, lstatSync(this.filename))) throw fail('Backend .env is invalid or changed while reading');
      return {text, stat};
    } catch { throw fail('Cannot safely read backend .env'); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  config(): Config { return readConfig({...parse(this.snapshot.text), ...this.overrides},this.parent); }
  lockedFields(): string[] { return Object.entries(fields).filter(([,key]) => this.overrides[key] !== undefined).map(([key]) => key); }
  write(patch: ProviderSettingsPatch) {
    assertNativePath(this.filename,true,true);
    if (this.requiresRestart) throw fail('Backend .env changed after saving; restart to load it before saving again');
    const updates: Record<string,string> = {};
    for (const [role,id] of Object.entries(patch.models ?? {})) updates[fields[role as keyof typeof fields]] = id;
    if (patch.apiKey !== undefined) updates.STARK_API_KEY = patch.apiKey;
    if (patch.baseUrl !== undefined) updates.STARK_BASE_URL = patch.baseUrl;
    for (const key of Object.keys(updates)) if (this.overrides[key] !== undefined) throw fail(`${key} is set by the process environment; remove that override and restart before saving this field`);
    const current = this.read();
    if (current.text !== this.snapshot.text || Boolean(current.stat) !== Boolean(this.snapshot.stat) || current.stat && this.snapshot.stat && !same(current.stat,this.snapshot.stat)) throw fail('Backend .env changed outside Settings; restart to load it before saving');
    if (!Object.keys(updates).length) return;
    // Match dotenv declarations, including export, colon syntax and multiline quotes.
    // Preserve all other source bytes; then independently validate the parsed result.
    const declaration = /^[\t \uFEFF]*(?:export[\t ]+)?([\w.-]+)(?:[\t ]*=[\t ]*|:[\t ]+)(?:'(?:\\'|[^'])*'|"(?:\\"|[^"])*"|`(?:\\`|[^`])*`|[^\r\n#]*)(?:[\t ]*#[^\r\n]*)?[\t ]*(?=\r?$)/gm;
    let text = current.text.replace(declaration, (whole,key:string) => Object.hasOwn(updates,key) ? (whole.startsWith('\uFEFF') ? '\uFEFF' : '') : whole);
    const remaining = parse(text);
    if (Object.keys(updates).some(key=>Object.hasOwn(remaining,key))) throw fail('Unsupported .env syntax; normalize its quoting before saving');
    const newline = current.text.includes('\r\n') ? '\r\n' : '\n';
    if (text && !text.endsWith('\n')) text += newline;
    for (const [key,entry] of Object.entries(updates)) {
      const quote = ["'", '"', '`'].find(q => !entry.includes(q) && !(q === '"' && /\\[nr]/.test(entry)));
      if (!quote) throw fail('Value cannot be represented safely in dotenv; avoid combining all three quote styles');
      text += `${key}=${quote}${entry}${quote}${newline}`;
    }
    const expected = {...parse(current.text), ...updates};
    const actual = parse(text);
    if (Object.keys(expected).length !== Object.keys(actual).length || Object.entries(expected).some(([key,v]) => actual[key] !== v)) throw fail('Unsupported .env syntax; normalize its quoting before saving');
    if (Buffer.byteLength(text) > 1024*1024) throw fail('Backend .env exceeds 1 MiB');
    const temporary = path.join(this.parent, `.env.${randomUUID()}.tmp`);
    let created = false;
    try {
      const fd = openSync(temporary, 'wx', 0o600); created = true;
      let temporaryIdentity: Stats;
      try { writeFileSync(fd,text); fsyncSync(fd); temporaryIdentity=fstatSync(fd); } finally { closeSync(fd); }
      const latest = this.read();
      if (latest.text !== current.text || Boolean(latest.stat) !== Boolean(current.stat) || latest.stat && current.stat && !same(latest.stat,current.stat)) throw fail('Backend .env changed before saving');
      assertNativePath(temporary);
      const candidate=lstatSync(temporary);
      if (!candidate.isFile() || candidate.isSymbolicLink() || candidate.nlink!==1 || !same(candidate,temporaryIdentity)) throw fail('Temporary configuration file changed before saving');
      assertNativePath(this.filename,true,true);
      renameSync(temporary,this.filename); created = false;
      // No awaited/fallible operation between disk commit and active publication.
      this.snapshot = {text,stat:temporaryIdentity};
    } catch (e) { if (e instanceof Error && 'statusCode' in e) throw e; throw fail('Cannot save backend .env; active settings were not changed'); }
    finally { if (created) { try { unlinkSync(temporary); } catch { /* Only our exclusive temporary file. */ } } }
    // The next preflight still checks bytes; capture identity after publication via refreshIdentity.
  }
  refreshIdentity() {
    try {
      const refreshed=this.read();
      // Rename may change ctime. Require our exact bytes and committed inode,
      // then capture its post-rename timestamps only after those checks pass.
      if (refreshed.text!==this.snapshot.text || Boolean(refreshed.stat)!==Boolean(this.snapshot.stat) ||
          refreshed.stat && this.snapshot.stat && (refreshed.stat.dev!==this.snapshot.stat.dev || refreshed.stat.ino!==this.snapshot.stat.ino)) {
        throw fail('Backend .env changed after saving');
      }
      this.snapshot=refreshed;
    } catch (error) { this.requiresRestart=true;throw error; }
  }
}

export class ProviderSettings {
  constructor(private config: Config, private store: Store, private file?: ProviderSettingsFile) {}
  get(): PublicProviderSettings {
    return {models:{...this.config.models},baseUrl:this.config.baseUrl,apiKeyConfigured:!!this.config.apiKey,lockedFields:this.file?.lockedFields() ?? ['architect','coder','critic','apiKey','baseUrl']};
  }
  update(input: unknown): PublicProviderSettings {
    const patch = patchSchema.parse(input);
    if (!this.file) throw fail('Provider settings persistence is unavailable in this backend');
    if(patch.baseUrl!==undefined) {
      patch.baseUrl=normalizeProviderEndpoint(patch.baseUrl);
      const equivalent=(v:string)=>v?new URL(v).href.replace(/\/+$/,''):'';
      if(equivalent(patch.baseUrl)===equivalent(this.config.baseUrl))patch.baseUrl=this.config.baseUrl;
      else if(this.config.apiKey&&patch.apiKey===undefined)throw fail('Changing the endpoint requires an explicit replacement API key or Clear saved API key. An existing key is never forwarded to a new endpoint.');
    }
    const models = {...this.config.models,...patch.models};
    this.store.initializeModels(this.config.models);
    this.file.write(patch);
    this.config.models = models;
    if (patch.apiKey !== undefined) this.config.apiKey = patch.apiKey;
    if (patch.baseUrl !== undefined) this.config.baseUrl = patch.baseUrl;
    this.store.setModelDefaults(models);
    try { this.file.refreshIdentity(); }
    catch { throw fail('Settings saved and active, but the file changed immediately afterward; restart after checking backend .env'); }
    return this.get();
  }
}

export function loadBackendConfig(env: NodeJS.ProcessEnv = process.env, filename = profilePaths(applicationHome(env)).configFile) {
  if (Object.keys(env).some(key => /^DOTENV_(?:CONFIG_)?(?:PATH|ENCODING|OVERRIDE|FAST)$/.test(key) && env[key] !== undefined)) throw new Error('Custom dotenv path, encoding, override and parser options are unsupported; use the selected profile config/.env');
  const file = new ProviderSettingsFile(filename,env);
  return {file, config:file.config()};
}
