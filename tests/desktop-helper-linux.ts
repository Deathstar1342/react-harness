/** Actual OS policy / pkexec boundary; disposable GitHub VM only. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync,existsSync } from 'node:fs';
import { helperOperation } from '../desktop/helper-entry.js';
assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.platform,'linux');assert.notEqual(process.getuid!(),0);
const rule='/etc/polkit-1/rules.d/00-abyssus-ci.rules';
const fixture=process.cwd()+'/build/polkit-ci.rules';
const uid=process.getuid!();
function policy(result:'YES'|'NO') {
  writeFileSync(fixture,`polkit.addRule(function(action, subject) { if (action.id === "org.freedesktop.policykit.exec" && action.lookup("program") === "/usr/lib/abyssus-helper/launcher" && subject.user === "${process.env.USER}") return polkit.Result.${result}; });\n`);
  execFileSync('sudo',['install','-o','root','-g','root','-m','0644',fixture,rule]);
  execFileSync('sudo',['systemctl','restart','polkit']);
}
try {
  policy('NO');await assert.rejects(helperOperation('setup'));assert(!existsSync('/etc/abyssus-helper/client.json'));
  console.log('PASS actual OS-policy denial leaves helper authority absent');
  policy('YES');const setup=await helperOperation('setup');assert.equal(setup.available,true);assert(setup.target);
  execFileSync('sudo',['rm','/etc/abyssus-helper/client.json']);
  const repair=await helperOperation('repair');assert.equal(repair.target,setup.target);
  console.log('PASS actual pkexec fixed setup, signed hello and damaged-descriptor repair identity preservation');
  execFileSync('sudo',['rm','/etc/abyssus-helper/client.json']);
  assert.equal((await helperOperation('uninstall')).available,false);
  assert(!existsSync('/usr/lib/abyssus-helper/launcher'));assert(!existsSync('/etc/abyssus-helper/client.json'));
  // The audit directory deliberately denies non-root traversal. Do not mistake
  // existsSync's permission failure for absence or weaken its permissions.
  execFileSync('sudo',['/usr/bin/test','-s','/var/lib/abyssus-helper/audit.sqlite']);
  console.log('PASS actual pkexec removal verifies absent authority and retained audit');
}finally{execFileSync('sudo',['rm','-f',rule]);execFileSync('sudo',['systemctl','restart','polkit']);}
