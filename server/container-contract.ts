import path from 'node:path';

/** Trusted supervisor inputs only; never accepted as model/API mount arguments. */
export type HostStoragePath = string & {readonly __hostStoragePath:unique symbol};
export type ContainerPath = string & {readonly __containerPath:unique symbol};
export interface HostStorageSelection {version:1; platform:'linux'|'win32'; root:HostStoragePath; storageId:string; kind:'local-bind'}
export const containerPaths = {
  home:'/abyssus' as ContainerPath, config:'/abyssus/profile/config' as ContainerPath,
  workspace:'/workspace' as ContainerPath,
};
export function hostStoragePath(input:string,platform:'linux'|'win32'):HostStoragePath {
  const paths=platform==='win32'?path.win32:path.posix;
  if(input.length>4096 || /[\x00-\x1f\x7f]/.test(input) || !paths.isAbsolute(input) || paths.normalize(input)!==input ||
    input===paths.parse(input).root || platform==='win32' && !/^[A-Za-z]:\\/.test(input))throw new Error('Select a canonical local storage directory');
  return input as HostStoragePath;
}
export const containerExecutionUnavailable='Container project execution is unavailable until the M29 worker broker is installed. No host or Bubblewrap fallback.';
