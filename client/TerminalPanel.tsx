import { X } from 'lucide-react';
import type { ChatDetail } from '../shared/types';
import { commandLabel, consoleText, terminalHistory } from './terminal';

export function TerminalPanel({detail,connected,onClose}: {detail:ChatDetail; connected:boolean; onClose:()=>void}) {
  const history = terminalHistory(detail.events,detail.chat.id);
  return <section id="command-terminal" className="command-terminal" aria-label="Command output">
    <header><strong>Terminal</strong><span className="muted">Read-only command evidence</span><button className="icon-button" onClick={onClose} aria-label="Close terminal"><X size={15}/></button></header>
    <div className="command-scroll">
      {!connected && <p role="status">Reconnecting. These are last recorded outcomes; command activity may have changed.</p>}
      {detail.eventsTruncated && <p role="status">Earlier history is omitted. Starts, output, or outcomes may be missing from this view.</p>}
      {!history.commands.length && !history.unassociated.length && <p className="muted">No command evidence in the available history. Commands appear here when an agent executes them.</p>}
      {history.commands.map(entry=>{
        const item = entry.lifecycle;
        const command = item?.action.name === 'execute_python' ? String(item.action.args.code ?? '') : String(item?.action.args.command ?? 'Command text unavailable');
        return <article className="command-entry" key={entry.commandId}>
          <div className="command-heading"><strong>{commandLabel(entry)}</strong>{item?.exitCode !== undefined && <span>Exit {item.exitCode}</span>}{item?.timedOut && <span>Timed out</span>}{item?.cancelled && <span>Cancelled</span>}</div>
          <div className="terminal-meta">{item?.role ?? 'Agent'} · Agent {entry.agentId} · Session {entry.sessionId} · Command {entry.commandId}</div>
          {item?.action.name === 'execute_python' && <div className="muted">Python source</div>}
          <pre className="command-source">{consoleText(command)}</pre>
          {!entry.hasStart && <p className="muted">Start event unavailable. Only retained evidence is shown.</p>}
          {!item && <p className="muted">No lifecycle outcome available; output alone does not establish success.</p>}
          {item?.status === 'running' && <p className="muted">No completion recorded.{['paused','interrupted'].includes(detail.chat.status) ? ' Stop was requested; awaiting command outcome.' : ''}</p>}
          {item?.message && <p>{consoleText(item.message)}</p>}
          {item?.shellReset && <p className="muted">Shell state was lost or recreated. Completed side effects were not rolled back.</p>}
          {entry.outputTruncated && <p role="status">Output truncated; only part of the command output is available.</p>}
          {entry.output ? <pre>{consoleText(entry.output)}</pre> : <p className="muted">{entry.hasSnapshot ? 'No output was captured.' : 'No output is available in this history.'}</p>}
        </article>;
      })}
      {!!history.unassociated.length && <details className="unassociated-output"><summary>Unassociated / legacy evidence ({history.unassociated.length})</summary><p>These events lack reliable command correlation. They are not assigned to a command or treated as completion evidence. Each entry shows at most its last 16,000 characters.</p>{history.unassociated.map(event=><pre key={event.id}>{consoleText(JSON.stringify(event.data,null,2).slice(-16000))}</pre>)}</details>}
    </div>
  </section>;
}
