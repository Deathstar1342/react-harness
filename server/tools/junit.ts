import { randomUUID } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { TestCase, TestReport } from '../../shared/types.js';
import type { CommandResult } from './shell.js';
import { ToolError } from './paths.js';
const array = (value: unknown): any[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const text = (value: any): string => typeof value === 'string' || typeof value === 'number' ? String(value) : value && typeof value === 'object' ? [value['@_message'], value['#text']].filter(v => v !== undefined).join('\n') : '';
export function parseJUnit(xml: string, command: string, result: CommandResult, maxBytes = 2_000_000): TestReport {
  if (Buffer.byteLength(xml) > maxBytes || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new ToolError('JUnit report is oversized or contains a prohibited XML declaration.');
  if (XMLValidator.validate(xml) !== true) throw new ToolError('Malformed JUnit XML report.');
  const doc = new XMLParser({ ignoreAttributes: false, parseTagValue: false, processEntities: true }).parse(xml);
  if (!Object.hasOwn(doc, 'testsuites') && !Object.hasOwn(doc, 'testsuite')) throw new ToolError('Expected JUnit testsuite or testsuites root.');
  const tests: TestCase[] = []; let suiteErrors = false;
  function visit(suite: any): void {
    if (!suite || typeof suite !== 'object') return;
    if (Number(suite['@_errors']) > 0 || Number(suite['@_failures']) > 0) suiteErrors = true;
    for (const test of array(suite.testcase)) {
      if (tests.length >= 10_000) throw new ToolError('JUnit report has too many test cases.');
      if (!test || typeof test !== 'object' || typeof test['@_name'] !== 'string') throw new ToolError('JUnit testcase is missing a name.');
      const duration = Number(test['@_time']);
      const status: TestCase['status'] = test.error !== undefined ? 'error' : test.failure !== undefined ? 'failed' : test.skipped !== undefined ? 'skipped' : 'passed';
      tests.push({ name: test['@_name'], ...(test['@_classname'] ? { classname: String(test['@_classname']) } : {}), status,
        ...(Number.isFinite(duration) && duration >= 0 ? { duration } : {}),
        ...(['error', 'failed'].includes(status) ? { error: array(test.error ?? test.failure).map(text).join('\n') } : {}),
        output: [text(test['system-out']), text(test['system-err'])].filter(Boolean).join('\n') });
    }
    for (const nested of [...array(suite.testsuite), ...array(suite.testsuites)]) visit(nested);
  }
  for (const suite of [...array(doc.testsuite), ...array(doc.testsuites)]) visit(suite);
  const status: TestReport['status'] = result.cancelled ? 'cancelled' : result.timedOut || result.error || !tests.length || tests.some(t => t.status === 'error') ? 'error' : tests.some(t => t.status === 'failed') ? 'failed' : suiteErrors || result.exitCode !== 0 ? 'error' : 'passed';
  return { id: randomUUID(), runner: 'junit', command, createdAt: new Date().toISOString(), status, tests, output: result.output, ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}) };
}
export function unavailableReport(command: string, result: CommandResult, error: string): TestReport {
  return { id: randomUUID(), runner: 'junit', command, createdAt: new Date().toISOString(), status: result.cancelled ? 'cancelled' : 'error', tests: [], output: [result.output, error].filter(Boolean).join('\n'), ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}) };
}
