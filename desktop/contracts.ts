/** Public desktop DTOs contain no launch capability, helper credential or executable. */
export type Environment = { kind:'linux' } | { kind:'wsl'; distribution:string };
export interface DesktopSelection { environment:Environment; home:string }
export interface DesktopStatus {
  runtime?:'container';
  container?:{engine?:string;engineDataRoot?:string;storage?:{displayPath:string;id:string};available:boolean};
  platform:string;
  phase:'setup'|'starting'|'ready'|'stopping'|'failed';
  distributions:string[];
  selection?:DesktopSelection;
  message:string;
  sessionId?:string;
  transitioning?:boolean;
  checks?:{ name:string; ok:boolean; message:string }[];
  helper?:{available:boolean; target?:string};
  helperReadiness?:import('./helper-preflight.js').HelperReadiness;
}
export interface DesktopBridge {
  status():Promise<DesktopStatus>;
  checkContainer():Promise<DesktopStatus>;
  pickStorage():Promise<{id:string;displayPath:string;mode:'existing'|'initialize'}|null>;
  startContainer(input:{selectionId?:string}):Promise<DesktopStatus>;
  restartContainer():Promise<DesktopStatus>;
  authorizeTransfer(input:{kind:'import'}|{kind:'export';projectId:string}):Promise<{code:string}|null>;
  start(input:{environment:Environment;home:string;mode:'existing'|'initialize'|'migrate';legacyRoot?:string}):Promise<DesktopStatus>;
  pickDirectory():Promise<string|null>;
  helper(action:'setup'|'repair'|'uninstall'):Promise<DesktopStatus>;
  dirty(value:boolean):Promise<void>;
}
declare global { interface Window { abyssusDesktop?:DesktopBridge } }
