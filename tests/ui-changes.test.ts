import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { ChangeReview, ChangesPanel } from '../client/ChangesPanel';
import type { ChangePreview } from '../shared/types';

const preview: ChangePreview={change:{id:'write',projectId:'p',chatId:'chat',path:'file.txt',createdAt:'2026-09-28T00:00:00Z',status:'confirmed'},diff:'-old\n+<script>agent</script>',undoDiff:'-<script>agent</script>\n+old',expectedHash:'abc',previewToken:'token'};
it('labels current Git attribution separately from recorded writes and keeps undo behind selection',()=>{
  const html=renderToStaticMarkup(createElement(ChangesPanel,{projectId:'p',revision:0,onClose:()=>{}}));
  expect(html).toContain('Current project Git changes');expect(html).toContain('pre-existing work, manual edits and shell effects');
  expect(html).toContain('Recorded agent writes');expect(html).toContain('Older actions without snapshots have no undo');
  expect(html).not.toContain('Undo this write');
});
it('shows explicit forward and undo previews with escaped content and a human undo action',()=>{
  const html=renderToStaticMarkup(createElement(ChangeReview,{preview,busy:false,onUndo:()=>{}}));
  expect(html).toContain('Undo preview');expect(html).toContain('Recorded write');expect(html).toContain('Undo this write');
  expect(html).toContain('Pause all active project chats first');expect(html).toContain('Shell effects cannot be undone');
  expect(html).toContain('&lt;script&gt;agent&lt;/script&gt;');expect(html).not.toContain('<script>');
});
it('does not offer undo for stale or uncertain records and disables it during submission',()=>{
  const blocked=renderToStaticMarkup(createElement(ChangeReview,{preview:{...preview,previewToken:undefined,reason:'Later saved edits must be preserved.'},busy:false,onUndo:()=>{}}));
  expect(blocked).toContain('Later saved edits');expect(blocked).not.toContain('Undo this write');
  const busy=renderToStaticMarkup(createElement(ChangeReview,{preview,busy:true,onUndo:()=>{}}));
  expect(busy).toContain('disabled=""');expect(busy).toContain('Undoing');
});
it('keeps Changes closed by default and outside the mounted editor container',()=>{
  const source=readFileSync(new URL('../client/App.tsx',import.meta.url),'utf8');
  expect(source).toContain('const [changes, setChanges] = useState(false)');
  expect(source).toContain('onChanges={() => setChanges(true)}');
  expect(source).toContain('{changes && project && <ChangesPanel');
  expect(source).toMatch(/<FilePanel\s+key=\{project.id\}/);
});
