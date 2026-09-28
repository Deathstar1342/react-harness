import { useEffect, useRef, useState } from 'react';
import type { ApprovalMode, ChatDetail, ConnectionReport, Preferences } from '../shared/types';
import { errorText, id, request } from './api';
import { approvalNames, getPreferences, saveChatApproval, savePreferences, testConnection } from './settings';

export function ConnectionResults({ report }: { report: ConnectionReport }) {
  return <div className="connection-results" role="status">
    <strong>{report.ok ? 'Connection checks passed' : 'Connection checks did not all pass'}</strong>
    <ul>{report.checks.map(check => <li key={check.target}>
      <strong>{check.target === 'catalog' ? 'Model catalog' : check.target} · {check.status === 'skipped' ? 'not checked' : check.status}</strong>
      <span>{check.message}</span>
    </li>)}</ul>
  </div>;
}

export function SettingsControls({ chatId, onPreferences }: { chatId?: string; onPreferences?: (value: Preferences) => void }) {
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [detail, setDetail] = useState<ChatDetail | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [report, setReport] = useState<ConnectionReport | null>(null);
  const check = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const saveLock = useRef(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; check.current?.abort(); };
  }, []);
  useEffect(() => {
    let active = true;
    setDetail(null);
    void Promise.all([getPreferences(), chatId ? request<ChatDetail>(`/chats/${id(chatId)}`) : Promise.resolve(null)])
      .then(([prefs, chat]) => { if (active) { setPreferences(prefs); setDetail(chat); } })
      .catch(e => { if (active) setError(errorText(e)); });
    return () => { active = false; };
  }, [chatId, revision]);
  const save = async (action: () => Promise<void>, message: string) => {
    if (saveLock.current) return;
    saveLock.current = true; setSaving(true); setError(''); setNotice('');
    try { await action(); if (mounted.current) setNotice(message); }
    catch (e) { if (mounted.current) { setError(errorText(e)); setRevision(old => old + 1); } }
    finally { saveLock.current = false; if (mounted.current) setSaving(false); }
  };
  const update = (patch: Partial<Preferences>, message: string) => void save(async () => {
    const next = await savePreferences(patch);
    if (mounted.current) setPreferences(next);
    onPreferences?.(next);
  }, message);
  const locked = !detail || ['running', 'awaiting_approval'].includes(detail.chat.status) || detail.approvals.some(item => item.status === 'pending');
  const options = Object.entries(approvalNames).map(([value, label]) => <option key={value} value={value}>{label}</option>);
  return <>
    <section className="settings-section">
      <h3>Connection</h3>
      <p className="field-help">Checks the model catalog and sends up to three small model requests using your normal connection. Uses account request and token budgets; may take up to 25 seconds.</p>
      <button type="button" className="button" disabled={checking} onClick={() => {
        if (check.current) return;
        const controller = new AbortController(); check.current = controller;
        setChecking(true); setReport(null); setError(''); setNotice('');
        void testConnection(controller.signal).then(value => { if (mounted.current && !controller.signal.aborted) setReport(value); })
          .catch(e => { if (mounted.current) setError(controller.signal.aborted ? 'Connection check cancelled.' : errorText(e)); })
          .finally(() => { if (check.current === controller) check.current = null; if (mounted.current) setChecking(false); });
      }}>{checking ? 'Testing connection…' : 'Test connection'}</button>
      {checking && <button type="button" className="text-button" onClick={() => check.current?.abort()}>Cancel check</button>}
      {report && <ConnectionResults report={report} />}
    </section>
    <section className="settings-section">
      <h3>Approvals</h3>
      <p className="field-help">Approval and Debug changes save immediately.</p>
      <label>Current chat{detail ? ` · ${detail.chat.title}` : ''}
        <select aria-label="Current chat approval mode" disabled={saving || locked} value={detail?.chat.approvalMode ?? ''} onChange={event => {
          if (!detail) return;
          const approvalMode = event.target.value as ApprovalMode;
          void save(async () => {
            const chat = await saveChatApproval(detail.chat.id, approvalMode);
            if (mounted.current) setDetail(current => current ? { ...current, chat } : current);
          }, 'Current chat approval mode saved.');
        }}><option value="" disabled>{chatId ? 'Loading chat…' : 'No chat selected'}</option>{options}</select>
      </label>
      <p className="field-help">Applies only to the selected chat. Pause active work and resolve pending proposals before changing it.</p>
      <label>Default for future chats
        <select aria-label="Default approval mode for future chats" disabled={saving || !preferences} value={preferences?.defaultApprovalMode ?? 'balanced'}
          onChange={event => update({ defaultApprovalMode: event.target.value as ApprovalMode }, 'Default saved for future chats. Existing chats are unchanged.')}>{options}</select>
      </label>
      <p className="field-help">Balanced asks before elevated actions. Review asks before every change. Full workspace autonomy allows changes without individual approval.</p>
    </section>
    <section className="settings-section">
      <h3>Debug mode</h3>
      <button type="button" className="button" role="switch" aria-checked={preferences?.debugMode ?? false} disabled={saving || !preferences}
        onClick={() => update({ debugMode: !preferences?.debugMode }, 'Debug preference saved.')}>Debug mode {preferences?.debugMode ? 'on' : 'off'}</button>
      <p className="field-help">Show internal coder, critic, and tool activity. Errors, approvals, diffs, and test results stay available with Debug off. Saved for this backend.</p>
    </section>
    {notice && <p className="field-help" role="status">{notice}</p>}
    {error && <p className="inline-error" role="alert">{error} <button type="button" className="text-button" onClick={() => { setError(''); setRevision(old => old + 1); }}>Reload settings</button></p>}
  </>;
}
