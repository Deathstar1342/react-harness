/** Fixed trusted controller environment; undefined must be omitted, not stringified. */
export function installFixedEnvironment(env:NodeJS.ProcessEnv){
 for(const key of Object.keys(process.env))delete process.env[key];
 for(const [key,value] of Object.entries(env))if(value!==undefined)process.env[key]=value;
}
