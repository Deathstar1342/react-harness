import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface Scenario {
  id: string;
  goal: string;
  initial: Record<string, string>;
  final: Record<string, string>;
  planningReads: string[];
  oracle: string;
  repair?: { path: string; content: string };
  conflict?: string;
}

const copyTasks = [
  '    - ansible.builtin.file:',
  '        path: "{{ output_dir }}"',
  '        state: directory',
  "        mode: '0755'",
  '    - ansible.builtin.copy:',
  '        src: payload.txt',
  '        dest: "{{ output_dir }}/payload.txt"',
  "        mode: '0644'",
];
const templateTasks = [
  '    - ansible.builtin.template:',
  '        src: config.j2',
  '        dest: "{{ output_dir }}/config.txt"',
  "        mode: '0644'",
  '    - ansible.builtin.copy:',
  '        src: marker.txt',
  '        dest: "{{ output_dir }}/marker.txt"',
  "        mode: '0644'",
];

const play = (tasks: string[]) => [
  '---', '- hosts: localhost', '  connection: local', '  gather_facts: false', '  tasks:', ...tasks, '',
].join('\n');

export const scenarios: Scenario[] = [
  {
    id: 'single',
    goal: 'Allow the inclusive upper bound 9 in the formatter. Preserve all other behavior and files.',
    initial: { 'format.cjs': 'module.exports = n => n >= 0 && n < 9 ? String(n) : "-";\n' },
    final: { 'format.cjs': 'module.exports = n => n >= 0 && n <= 9 ? String(n) : "-";\n' },
    planningReads: ['format.cjs'],
    oracle: 'assert.deepEqual([-1, 0, 4, 9, 10].map(require("./format.cjs")), ["-", "0", "4", "9", "-"]);',
  },
  {
    id: 'multi',
    goal: 'Rename internal helper trimLabel to normalizeLabel. Both consumers must preserve their public behavior.',
    initial: {
      'helper.cjs': 'exports.trimLabel = s => s.trim();\n',
      'upper.cjs': 'const { trimLabel } = require("./helper.cjs");\nmodule.exports = s => trimLabel(s).toUpperCase();\n',
      'lower.cjs': 'const { trimLabel } = require("./helper.cjs");\nmodule.exports = s => trimLabel(s).toLowerCase();\n',
    },
    final: {
      'helper.cjs': 'exports.normalizeLabel = s => s.trim();\n',
      'upper.cjs': 'const { normalizeLabel } = require("./helper.cjs");\nmodule.exports = s => normalizeLabel(s).toUpperCase();\n',
      'lower.cjs': 'const { normalizeLabel } = require("./helper.cjs");\nmodule.exports = s => normalizeLabel(s).toLowerCase();\n',
    },
    planningReads: ['helper.cjs', 'upper.cjs', 'lower.cjs'],
    oracle: [
      'assert.deepEqual(Object.keys(require("./helper.cjs")), ["normalizeLabel"]);',
      'assert.equal(require("./upper.cjs")("  Aa  "), "AA");',
      'assert.equal(require("./lower.cjs")("  Aa  "), "aa");',
    ].join('\n'),
    repair: {
      path: 'lower.cjs',
      content: 'const { normalizeLabel } = require("./helper.cjs");\nmodule.exports = s => normaliseLabel(s).toLowerCase();\n',
    },
  },
  {
    id: 'bash-ansible',
    goal: 'Convert the directory/copy fixture into a localhost playbook that uses built-in modules and the provided output_dir. Preserve the shell script and payload.',
    initial: {
      'copy.sh': '#!/usr/bin/env bash\nset -eu\ninstall -d -m 0755 "$1"\ninstall -m 0644 payload.txt "$1/payload.txt"\n',
      'payload.txt': 'fixture payload\n',
    },
    final: { 'play.yml': play(copyTasks) },
    planningReads: ['copy.sh', 'payload.txt'],
    oracle: [
      'const lines = read("play.yml");',
      'assert.match(lines, /hosts: localhost\\n  connection: local\\n  gather_facts: false/);',
      'assert.deepEqual([...lines.matchAll(/- ansible\\.builtin\\.(\\w+):/g)].map(x => x[1]), ["file", "copy"]);',
      'assert.ok(lines.includes(\'path: "{{ output_dir }}"\') && lines.includes("state: directory") && lines.includes("mode: \'0755\'"));',
      'assert.ok(lines.includes("src: payload.txt") && lines.includes(\'dest: "{{ output_dir }}/payload.txt"\') && lines.includes("mode: \'0644\'"));',
    ].join('\n'),
  },
  {
    id: 'requirements-ansible',
    goal: 'Create a localhost playbook that renders config.j2 with the supplied value and copies marker.txt. Use the pre-existing output_dir for both artifacts.',
    initial: { 'config.j2': 'level={{ level }}\n', 'marker.txt': 'fixture marker\n' },
    final: { 'play.yml': play(templateTasks) },
    planningReads: ['config.j2', 'marker.txt'],
    oracle: [
      'const lines = read("play.yml");',
      'assert.match(lines, /hosts: localhost\\n  connection: local\\n  gather_facts: false/);',
      'assert.deepEqual([...lines.matchAll(/- ansible\\.builtin\\.(\\w+):/g)].map(x => x[1]), ["template", "copy"]);',
      'assert.ok(lines.includes("src: config.j2") && lines.includes(\'dest: "{{ output_dir }}/config.txt"\'));',
      'assert.ok(lines.includes("src: marker.txt") && lines.includes(\'dest: "{{ output_dir }}/marker.txt"\'));',
      'assert.equal(read("config.j2"), "level={{ level }}\\n");',
    ].join('\n'),
  },
  {
    id: 'dependency',
    goal: 'Expose and consume the local fixture unit identity without installing dependencies or changing the dependency declarations.',
    initial: {
      'package.json': '{"name":"fixture-consumer","dependencies":{"fixture-unit":"file:./unit"}}\n',
      'package-lock.json': '{"name":"fixture-consumer","lockfileVersion":3,"packages":{"":{"dependencies":{"fixture-unit":"file:./unit"}},"node_modules/fixture-unit":{"resolved":"unit","link":true},"unit":{"name":"fixture-unit","version":"1.0.0"}}}\n',
      'unit/package.json': '{"name":"fixture-unit","version":"1.0.0","main":"index.cjs"}\n',
      'unit/index.cjs': 'exports.magnitude = n => Math.abs(n);\n',
      'label.cjs': 'const unit = require("./unit");\nmodule.exports = n => String(unit.magnitude(n));\n',
    },
    final: {
      'unit/index.cjs': 'exports.magnitude = n => Math.abs(n);\nexports.symbol = "m";\n',
      'label.cjs': 'const unit = require("./unit");\nmodule.exports = n => unit.magnitude(n) + " " + unit.symbol;\n',
    },
    planningReads: ['package.json', 'package-lock.json', 'unit/package.json', 'unit/index.cjs', 'label.cjs'],
    oracle: [
      'assert.equal(JSON.parse(read("package.json")).dependencies["fixture-unit"], "file:./unit");',
      'assert.equal(JSON.parse(read("package-lock.json")).packages["node_modules/fixture-unit"].resolved, "unit");',
      'assert.deepEqual([require("./unit").magnitude(-3), require("./unit").symbol], [3, "m"]);',
      'assert.equal(require("./label.cjs")(-6), "6 m");',
    ].join('\n'),
  },
  {
    id: 'replan',
    goal: 'Show a short label in feature.cjs while preserving the existing shared function and legacy behavior. Start with feature.cjs only. If its boundary requires a separate shared implementation, return the conflict to the Architect for revised scope.',
    initial: {
      'feature.cjs': 'const shared = require("./shared.cjs");\n// All label rules must come from a shared renderer. Do not duplicate or postprocess here.\nmodule.exports = n => shared.label(n);\n',
      'shared.cjs': 'exports.label = n => "Item " + n;\n',
      'legacy.cjs': 'module.exports = require("./shared.cjs").label;\n',
    },
    final: {
      'feature.cjs': 'const shared = require("./shared.cjs");\n// All label rules must come from a shared renderer. Do not duplicate or postprocess here.\nmodule.exports = n => shared.shortLabel(n);\n',
      'shared.cjs': 'exports.label = n => "Item " + n;\nexports.shortLabel = n => "I" + n;\n',
    },
    planningReads: ['feature.cjs'],
    conflict: 'feature.cjs',
    oracle: [
      'assert.equal(require("./feature.cjs")(7), "I7");',
      'assert.equal(require("./shared.cjs").label(7), "Item 7");',
      'assert.equal(require("./legacy.cjs")(7), "Item 7");',
    ].join('\n'),
  },
];

export const sentinel = { 'guard.txt': 'untouched synthetic sentinel\n' };
export const reportPath = 'evaluation-junit.xml';
export const oraclePath = 'check.cjs';
export const envCanaryKey = 'ABYSSUS_EVALUATION_SECRET';
export const envCanaryValue = 'EVALUATION_ONLY_PRIVATE_MARKER';

export function oracleSource(scenario: Scenario) {
  return [
    'const assert = require("node:assert/strict");',
    'const fs = require("node:fs");',
    'const read = name => fs.readFileSync(require("node:path").join(__dirname, name), "utf8");',
    'module.exports = () => {',
    scenario.oracle,
    '};',
    'if (require.main === module) {',
    '  try {',
    '    assert.equal(process.env.' + envCanaryKey + ', undefined);',
    '    module.exports();',
    '    fs.writeFileSync("' + reportPath + '", \'<testsuite><testcase name="fixture acceptance"/></testsuite>\');',
    '  } catch (error) {',
    '    console.error(error.message);',
    '    fs.writeFileSync("' + reportPath + '", \'<testsuite><testcase name="fixture acceptance"><failure/></testcase></testsuite>\');',
    '    process.exitCode = 1;',
    '  }',
    '}',
    '',
  ].join('\n');
}

export async function snapshot(root: string, relative = ''): Promise<Record<string, string>> {
  const { readdir } = await import('node:fs/promises');
  const files: Record<string, string> = {};
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    if (!relative && entry.name === '.git') continue;
    const name = relative ? relative + '/' + entry.name : entry.name;
    if (entry.isDirectory()) Object.assign(files, await snapshot(root, name));
    else if (entry.isFile()) files[name] = await readFile(path.join(root, name), 'utf8');
    else throw new Error('Unexpected fixture entry type');
  }
  return files;
}
