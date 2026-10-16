/** Short lived asynchronous native-storage freshness scopes for trusted backend code.
 * A path/inode check alone never creates this permission context.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import type { NativeBindPolicy } from './native-bind-policy.js';
const gateSchema=z.object({storageId:z.uuid(),launchId:z.uuid(),gateId:z.string().regex(/^[a-f0-9]{64}$/),issuedAt:z.number().int().safe().positive(),expiresAt:z.number().int().safe().positive()}).strict();
export class NativeStorageGate {
 private readonly context=new AsyncLocalStorage<z.infer<typeof gateSchema>>();
 private failed=false;
 poison(){if(this.failed)return;this.failed=true;this.onPoison();}
 constructor(private readonly policy:NativeBindPolicy,private readonly check:()=>Promise<unknown>,private readonly clock:()=>number=Date.now,private readonly onPoison:()=>void=()=>{}){}
 async run<T>(operation:()=>Promise<T>|T):Promise<T>{
  if(this.failed)throw new Error('Native storage authority failed; explicit recovery required');
  let gate:z.infer<typeof gateSchema>;
  try{
   gate=gateSchema.parse(await this.check());const now=this.clock();
   if(gate.storageId!==this.policy.record.storageId||gate.launchId!==this.policy.record.launchId||gate.issuedAt>now||gate.expiresAt<now||gate.expiresAt<=gate.issuedAt||gate.expiresAt-gate.issuedAt>10000)throw new Error('Native storage freshness changed');
   this.policy.verifyRoots();
   if(this.failed)throw new Error('Native storage authority failed; explicit recovery required');
  }catch(error){this.poison();throw error;}
  return this.context.run(gate,operation);
 }
 permits(filename:string,privateClass=true){
  const gate=this.context.getStore();
  const now=this.clock();
  if(this.failed||!gate)return false;
  if(now<gate.issuedAt||now>gate.expiresAt){this.poison();return false;}
  try{this.policy.verifyRoots();return this.policy.permits(filename,privateClass);}
  catch{this.poison();return false;}
 }
}
