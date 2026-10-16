import {expect,it} from 'vitest';
import {installFixedEnvironment} from '../containers/environment.js';
import {NativeBindPolicy} from '../server/native-bind-policy.js';
import {nativeStorageActive} from '../server/native-storage.js';
it('ordinary controller launch omits absent native flags instead of installing the string undefined',()=>{
 const saved={...process.env};try{
  installFixedEnvironment({PATH:saved.PATH,HARNESS_EXECUTION_MODE:'container',HARNESS_NATIVE_BIND_DIGEST:undefined,HARNESS_LAUNCH_ID:undefined});
  expect(Object.hasOwn(process.env,'HARNESS_NATIVE_BIND_DIGEST')).toBe(false);expect(NativeBindPolicy.load(process.env)).toBeUndefined();expect(nativeStorageActive()).toBe(false);
 }finally{installFixedEnvironment(saved);}
});
