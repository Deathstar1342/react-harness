import type {DatabaseSync} from 'node:sqlite';
import {nativeStorageActive,nativePrivateUnit,nativePrivateCommit,nativePrivatePath} from './native-storage.js';
/** Only fixed trusted Store SQL is used. Cleanup rollback/close never need authority. */
export function nativeStateDatabase(database:DatabaseSync,filename:string):DatabaseSync{
 if(!nativeStorageActive())return database;
 const unit=<T>(fn:()=>T)=>nativePrivateUnit(()=>{nativePrivatePath(filename);return fn();});
 return new Proxy(database,{get(target,property){
  if(property==='close')return target.close.bind(target);
  if(property==='exec')return (sql:string)=>{
   if(sql.trim().toUpperCase()==='ROLLBACK')return target.exec(sql);
   return unit(()=>{if(sql.trim().toUpperCase()==='COMMIT')nativePrivateCommit();return target.exec(sql);});
  };
  if(property==='prepare')return (sql:string)=>unit(()=>{
   const statement=target.prepare(sql);
   return new Proxy(statement,{get(stmt,key){const value=Reflect.get(stmt,key,stmt);if(typeof value!=='function')return value;
    if(key==='iterate')throw new Error('Native private-state iterators must be materialized in one unit');
    return (...args:unknown[])=>unit(()=>Reflect.apply(value,stmt,args));}});
  });
  const value=Reflect.get(target,property,target);
  if(typeof value==='function')return (...args:unknown[])=>unit(()=>Reflect.apply(value,target,args));return value;
 }});
}
export function nativeStateStore<T extends object>(store:T):T{
 if(!nativeStorageActive())return store;
 return new Proxy(store,{get(target,property,receiver){const value=Reflect.get(target,property,receiver);if(typeof value!=='function'||property==='close'||property==='constructor')return value;
  return (...args:unknown[])=>nativePrivateUnit(()=>Reflect.apply(value,receiver,args));
 }});
}
