import type { DesktopStatus } from './contracts.js';
/** Main-owned document epochs and edit revisions; no renderer-supplied identity. */
export class DocumentGuard {
  private epoch=0;
  private edits=0;
  dirty=false;
  private operation?:object;
  sessionId?:string;
  selection?:DesktopStatus['selection'];
  documentChanged(){this.epoch++;}
  edited(value:boolean){this.dirty=value;if(value)this.edits++;}
  begin(allowDirty=false){
    if(this.operation)throw new Error('A desktop transition is already in progress.');
    if(this.dirty&&!allowDirty)throw new Error('Save or discard the editor buffer before changing desktop setup.');
    const ticket={epoch:this.epoch,edits:this.edits,allowDirty};this.operation=ticket;return ticket;
  }
  check(ticket:ReturnType<DocumentGuard['begin']>){
    if(this.operation!==ticket||ticket.epoch!==this.epoch||ticket.edits!==this.edits||(!ticket.allowDirty&&this.dirty))throw new Error('The document or editor changed during setup. Buffers are preserved; review them before retrying.');
  }
  end(ticket:object){if(this.operation===ticket)this.operation=undefined;}
  get busy(){return !!this.operation;}
  publish(status:DesktopStatus){this.sessionId=status.sessionId;this.selection=status.selection;}
  status(state:DesktopStatus):DesktopStatus{
    const quarantined=state.sessionId!==this.sessionId;
    return {...state,sessionId:this.sessionId,selection:this.selection??state.selection,
      ...(quarantined&&state.phase==='ready'?{phase:'starting',message:'Prepared backend is isolated until the current document can safely change.'}:{}),transitioning:this.busy};
  }
}
