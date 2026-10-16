import { expect,it } from 'vitest';
import { nativeBindPolicySchema,privateBrokerHost,NativeBindPolicy } from '../server/native-bind-policy.js';
import { randomUUID } from 'node:crypto';
const uuid=randomUUID(),record={version:1,revision:1,platform:'win32',storageClass:'native-ntfs',phase:'controller',storageId:uuid,launchId:uuid,proofId:uuid,probeRevision:1,engineId:'engine',context:'desktop-linux',controllerImage:'sha256:'+'a'.repeat(64),probeImage:'sha256:'+'a'.repeat(64),issuedAt:1,expiresAt:2,slots:{state:{dev:'1',ino:'1'},config:{dev:'1',ino:'2'},workspace:{dev:'1',ino:'3'},control:{dev:'1',ino:'4'}},broker:{sessionId:uuid,host:'host.docker.internal',port:12345}};
it('native bind records reject type coercion, extra paths and unsupported storage classes',()=>{
 expect(nativeBindPolicySchema.parse(record)).toEqual(record);
 for(const value of [{...record,revision:true},{...record,storageClass:'volume'},{...record,root:'/host'},{...record,slots:{...record.slots,extra:{dev:'1',ino:'5'}}},{...record,broker:{...record.broker,port:'1234'}}])expect(()=>nativeBindPolicySchema.parse(value)).toThrow();
});
it('a normal Linux launch has no native permission exception',()=>{expect(NativeBindPolicy.load({HARNESS_EXECUTION_MODE:'container'})).toBeUndefined();});
it.each(['0.0.0.0','8.8.8.8','localhost','127.0.0.1','192.168.1.999','172.15.1.1','10.01.1.2','::1','example.com'])('refuses arbitrary controller broker target %s',host=>expect(privateBrokerHost(host)).toBe(false));
it.each(['host.docker.internal','10.1.2.3','172.16.0.1','172.31.255.1','192.168.1.2'])('permits only scoped route candidate syntax %s pending host proof',host=>expect(privateBrokerHost(host)).toBe(true));
