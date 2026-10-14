import type { DesktopStatus } from '../desktop/contracts';
export function OptionalSystemInstalls({status,busy,run,continueToChats}:{status:DesktopStatus;busy:boolean;run:(action:'setup'|'repair'|'uninstall')=>void;continueToChats:()=>void}) {
  const messages=[...new Set(Object.values(status.helperReadiness??{}).map(check=>check.message))];
  return <><h2>Optional system installs</h2>
    <p>This helper lets approved tools install Linux system packages. It is separate from the model provider endpoint and API key in Settings. You can continue to chats without enabling it.</p>
    {messages.length?messages.map(message=><p key={message}>{message}</p>):<p>Helper prerequisites have not been verified. An administrator-staged helper, systemd and OS authentication tools are required.</p>}
    <div className="dialog-actions">{(['setup','repair','uninstall'] as const).map(action=><button key={action} className="button" disabled={busy||!status.helperReadiness?.[action].canStart} onClick={()=>run(action)}>{action==='setup'?'Enable helper':action==='repair'?'Repair helper':'Remove helper'}</button>)}</div>
    {status.helper?.target&&<p>Verified target: {status.helper.target}</p>}
    <button className="button primary" disabled={busy} onClick={continueToChats}>Continue to chats</button>
  </>;
}
