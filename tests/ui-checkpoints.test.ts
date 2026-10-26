import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import {CheckpointReview} from '../client/CheckpointsPanel';
import type {CheckpointPreview} from '../shared/types';
it('renders the full restore diff and requires a fresh deliberate human checkbox',()=>{
 const preview:CheckpointPreview={checkpoint:{id:'cp',projectId:'project',chatId:'chat',label:'Task boundary',createdAt:new Date().toISOString(),digest:'a'.repeat(64),files:2,bytes:8,excludedCount:1,excluded:[{path:'.env',reason:'credential path'}]},previewToken:'opaque',revision:'a'.repeat(64),expiresAt:Date.now()+300000,currentExcludedCount:1,changes:[{path:'source.ts',kind:'modify',diff:'-current\n+checkpoint'},{path:'extra.ts',kind:'remove',diff:'-remove'}]};
 const html=renderToStaticMarkup(createElement(CheckpointReview,{preview,busy:false,confirmed:false,onConfirm:()=>{throw new Error('Rendering must never decide');},onRestore:()=>{throw new Error('Rendering must never restore');}}));
 expect(html).toContain('source.ts');expect(html).toContain('extra.ts');expect(html).toContain('+checkpoint');expect(html).toContain('not rolled back');expect(html).toContain('Restore this reviewed file set');expect(html).toMatch(/disabled=""[^>]*>Restore reviewed files/);
 expect(html).not.toContain('PRIVATE');
});
