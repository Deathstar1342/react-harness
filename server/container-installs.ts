import type {PackageHelperDecision,PackageHelperRequest,PackageHelperRecord,PackageHelperTarget} from '../shared/types.js';
import type {InstallHelper} from './installs.js';
import {WorkerClient,type WorkerTransport} from './worker-client.js';
import {helperProtocol} from './package-helper.js';

/** Only the trusted Store-resolved project path reaches this adapter. */
export class ContainerInstallClient implements InstallHelper {
  private project:string;
  constructor(private client:WorkerTransport,root:string,private originalTarget?:PackageHelperTarget){
    if(!/^\/workspace\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(root))throw new Error('Invalid managed install target');
    this.project=root.slice('/workspace/'.length);
  }
  static async connect(root:string,originalTarget?:PackageHelperTarget){return new ContainerInstallClient(await WorkerClient.connect(),root,originalTarget);}
  private request(op:string,body:Record<string,unknown>){return this.client.request(op,{project:this.project,...body});}
  async hello(){return await this.request('install_hello',this.originalTarget?{originalTarget:this.originalTarget}:{}) as {protocol:typeof helperProtocol;target:PackageHelperTarget};}
  async prepare(request:PackageHelperRequest){return await this.request('install_prepare',{request}) as PackageHelperRecord;}
  async authorize(decision:PackageHelperDecision){return await this.request('install_authorize',{decision}) as PackageHelperRecord;}
  async execute(decision:PackageHelperDecision){
    const receipt=await this.request('install_execute',{decision}) as {requestId:string;accepted:boolean};
    if(receipt.requestId!==decision.requestId||receipt.accepted!==true)throw new Error('Invalid install acceptance');
    const deadline=Date.now()+360000;
    for(;;){
      const record=await this.status(decision.requestId);
      if(['succeeded','failed','uncertain'].includes(record.state))return record;
      if(Date.now()>deadline)throw new Error('Container install outcome is uncertain');
      await new Promise(resolve=>setTimeout(resolve,250));
    }
  }
  async status(requestId:string){return await this.request('install_status',{requestId}) as PackageHelperRecord;}
  async reconcile(requestId:string){return await this.request('install_reconcile',{requestId}) as PackageHelperRecord;}
}
