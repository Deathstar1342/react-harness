import type { ApprovalMode, Chat, ConnectionReport, Preferences } from '../shared/types';
import { id, request } from './api';

export const getPreferences = () => request<Preferences>('/preferences');
export const savePreferences = (patch: Partial<Preferences>) => request<Preferences>('/preferences', { method: 'PATCH', body: JSON.stringify(patch) });
export const saveChatApproval = (chatId: string, approvalMode: ApprovalMode) => request<Chat>(`/chats/${id(chatId)}`, { method: 'PATCH', body: JSON.stringify({ approvalMode }) });
export const testConnection = (signal: AbortSignal) => request<ConnectionReport>('/connection-check', {
  method: 'POST', body: '{}', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
});
export const approvalNames: Record<ApprovalMode, string> = {
  balanced: 'Balanced', review: 'Review every change', autonomous: 'Full workspace autonomy',
};
