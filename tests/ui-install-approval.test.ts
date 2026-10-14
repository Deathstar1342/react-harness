import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { ApprovalCard } from '../client/Panels.js';
import type { Approval, InstallState } from '../shared/types.js';
import { installFixture } from './install-fixture.js';

afterEach(()=>vi.restoreAllMocks());
const render=(approval:Approval)=>renderToStaticMarkup(createElement(ApprovalCard,{approval,refresh:async()=>{}}));

it.each([
  ['approved','pending'], // Real historical approval retains its pending preview snapshot.
  ['approved','approved'], // Pre-dispatch approval must await backend expiry/invalidation.
  ['approved','succeeded'],
  ['denied','pending'],
  ['denied','rejected'],
] as const)('preserves %s with %s install evidence across the preview deadline',async(status,state)=>{
  const t=installFixture();
  try {
    const item=t.create();await t.advance(item.id);const approval=t.store.getApproval(item.id);
    approval.status=status;approval.install!.state=state;
    const expiry=approval.install!.expiresAt!;
    const clock=vi.spyOn(Date,'now');
    for (const time of [expiry-1,expiry,expiry+120000]) {
      clock.mockReturnValue(time);
      const html=render(approval);
      expect(html).toContain(`Approval ${status}`);
      expect(html).toContain('Reviewed preview deadline:');
      expect(html).not.toContain('Approval expired');
      expect(html).not.toContain('Request a new preview');
      expect(html).not.toContain('Your approval is needed');
    }
  } finally {vi.restoreAllMocks();await t.service.close();t.store.close();}
});

it.each(['pending','stale'] as const)('offers fresh review only for unresolved %s cards',async status=>{
  const t=installFixture();
  try {
    const item=t.create();await t.advance(item.id);const approval=t.store.getApproval(item.id);approval.status=status;
    const expiry=approval.install!.expiresAt!,clock=vi.spyOn(Date,'now');
    clock.mockReturnValue(expiry-1);
    const fresh=render(approval);
    expect(fresh).toContain(status==='pending'?'Your approval is needed':'Approval stale');
    expect(fresh.includes('Request a new preview')).toBe(status==='stale');
    clock.mockReturnValue(expiry);
    const expired=render(approval);
    expect(expired).toContain('Approval expired');
    expect(expired).toContain('Request a new preview');
    expect(expired).not.toContain('Your approval is needed');
    expect(expired).not.toMatch(/>Approve<|>Deny</);
    // If current outcome evidence is provided, an old stale label cannot offer retry.
    for(const state of ['dispatching','succeeded','rejected','uncertain'] satisfies InstallState[]) {
      approval.install!.state=state;
      const terminal=render(approval);
      expect(terminal).not.toContain('Request a new preview');
      expect(terminal).not.toContain('Your approval is needed');
    }
  } finally {vi.restoreAllMocks();await t.service.close();t.store.close();}
});
