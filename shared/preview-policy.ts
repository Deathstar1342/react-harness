import {z} from 'zod';
export const previewPath=z.string().min(1).max(2048).refine(value=>{
  if(!value.startsWith('/')||/[^\x21-\x7e]|[\\#]/.test(value)||/%(?![0-9A-F]{2})/.test(value))return false;
  const split=value.indexOf('?'),pathname=split===-1?value:value.slice(0,split),query=split===-1?'':value.slice(split+1);
  if(pathname.includes('//'))return false;
  try{const decoded=decodeURIComponent(pathname);return encodeURI(decoded)===pathname&&!/[\\%?#\x00-\x1f\x7f]/.test(decoded)&&!decoded.split('/').some(part=>part==='.'||part==='..'||/^(?:\.env|\.git|\.ssh|\.aws|\.config)/i.test(part)||part==='@fs'||part==='@id')&&!/%(?:0[0-9A-F]|1[0-9A-F]|7F|25|5C)/.test(query);}catch{return false;}
},'Canonical bounded preview request target required');
