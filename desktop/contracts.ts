/** Public desktop DTOs contain no launch capability, helper credential or executable. */
export type Environment = { kind:'linux' } | { kind:'wsl'; distribution:string };
export interface DesktopSelection { environment:Environment; home:string }
export interface DesktopStatus {
  platform:string;
  phase:'setup'|'starting'|'ready'|'stopping'|'failed';
  distributions:string[];
  selection?:DesktopSelection;
  message:string;
  checks?:{ name:string; ok:boolean; message:string }[];
  helper?:{available:boolean; target?:string};
}
export interface DesktopBridge {
  status():Promise<DesktopStatus>;
  start(input:{environment:Environment;home:string;mode:'existing'|'initialize'|'migrate';legacyRoot?:string}):Promise<DesktopStatus>;
  pickDirectory():Promise<string|null>;
  helper(action:'setup'|'repair'|'uninstall'):Promise<DesktopStatus>;
  dirty(value:boolean):Promise<void>;
}
declare global { interface Window { abyssusDesktop?:DesktopBridge } }
