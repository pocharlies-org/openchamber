import { describe, expect, test } from 'vitest';
import { parseWorkflowConfig, roleForIssue, findReadyToAdvance, approversFor } from './workflow.js';

// The real SC project: Epic(1) > Story/Task/Bug(0) > Subtask(-1),
// statuses Backlog, In Progress, Review, QA, Sign-off, Done.
const config = {
  issueTypes: [
    { type: 'Subtask', role: 'developer', onDone: { status: 'Review', validatedBy: 'qa' } },
    { type: 'Story', role: 'pm', onDone: { status: 'QA', validatedBy: 'qa' } },
    { type: 'Epic', role: 'cto', onDone: { status: 'Sign-off', validatedBy: 'pm' } },
  ],
};

const roleIds = new Set(['developer', 'pm', 'cto', 'qa']);
const issue = (key, type, status, parentKey = null) => ({ key, type, status, parentKey });

describe('who owns which issue type', () => {
  test('maps each type to its role, case-insensitively', () => {
    const workflow = parseWorkflowConfig(config, { roleIds });
    expect(roleForIssue(workflow, issue('SC-1', 'Story', 'Backlog'))).toBe('pm');
    expect(roleForIssue(workflow, issue('SC-2', 'subtask', 'Backlog'))).toBe('developer');
    expect(roleForIssue(workflow, issue('SC-3', 'Bug', 'Backlog'))).toBeNull();
  });

  test('rejects a role the installation never configured', () => {
    expect(() => parseWorkflowConfig({
      issueTypes: [{ type: 'Story', role: 'ghost' }],
    }, { roleIds })).toThrow(/"ghost" is not a configured role/);

    expect(() => parseWorkflowConfig({
      issueTypes: [{ type: 'Story', role: 'pm', onDone: { status: 'QA', validatedBy: 'ghost' } }],
    }, { roleIds })).toThrow(/validatedBy "ghost" is not a configured role/);
  });

  test('rejects duplicates, empties and oversized tables', () => {
    expect(() => parseWorkflowConfig({ issueTypes: [] })).toThrow(/non-empty array/);
    expect(() => parseWorkflowConfig({
      issueTypes: [{ type: 'Story', role: 'pm' }, { type: 'story', role: 'cto' }],
    })).toThrow(/duplicate issue type/);
    expect(() => parseWorkflowConfig({
      issueTypes: Array.from({ length: 21 }, (_, i) => ({ type: `T${i}`, role: 'pm' })),
    })).toThrow(/exceeds 20 issue types/);
  });

  test('names the offending entry so an operator can find it', () => {
    expect(() => parseWorkflowConfig({ issueTypes: [{ type: 'Story', role: 'pm' }, { type: '', role: 'pm' }] }))
      .toThrow(/issueTypes\[1\]\.type/);
  });
});

describe('a parent advances only when every child is done', () => {
  const workflow = parseWorkflowConfig(config, { roleIds });

  test('a story whose subtasks are all done goes to QA', () => {
    const { ready } = findReadyToAdvance(workflow, [
      issue('SC-10', 'Story', 'In Progress'),
      issue('SC-11', 'Subtask', 'Done', 'SC-10'),
      issue('SC-12', 'Subtask', 'Done', 'SC-10'),
    ]);
    expect(ready).toEqual([{
      key: 'SC-10', from: 'In Progress', to: 'QA', validatedBy: 'qa', children: ['SC-11', 'SC-12'],
    }]);
  });

  test('one unfinished subtask blocks the story and says which', () => {
    const { ready, blocked } = findReadyToAdvance(workflow, [
      issue('SC-10', 'Story', 'In Progress'),
      issue('SC-11', 'Subtask', 'Done', 'SC-10'),
      issue('SC-12', 'Subtask', 'In Progress', 'SC-10'),
    ]);
    expect(ready).toEqual([]);
    expect(blocked).toEqual([{ key: 'SC-10', pending: ['SC-12'] }]);
  });

  test('a story with no subtasks is never pushed to validation', () => {
    const { ready, blocked } = findReadyToAdvance(workflow, [issue('SC-10', 'Story', 'In Progress')]);
    expect(ready).toEqual([]);
    expect(blocked).toEqual([]);
  });

  test('an epic advances to Sign-off once its stories are done, validated by the PM', () => {
    const { ready } = findReadyToAdvance(workflow, [
      issue('SC-1', 'Epic', 'In Progress'),
      issue('SC-10', 'Story', 'Done', 'SC-1'),
      issue('SC-20', 'Story', 'Done', 'SC-1'),
    ]);
    expect(ready).toEqual([{
      key: 'SC-1', from: 'In Progress', to: 'Sign-off', validatedBy: 'pm', children: ['SC-10', 'SC-20'],
    }]);
  });

  test('three levels resolve in one pass without confusing grandchildren for children', () => {
    const { ready, blocked } = findReadyToAdvance(workflow, [
      issue('SC-1', 'Epic', 'In Progress'),
      issue('SC-10', 'Story', 'In Progress', 'SC-1'),
      issue('SC-11', 'Subtask', 'Done', 'SC-10'),
    ]);
    // the story may advance; the epic may not, because its story is not done
    expect(ready.map((r) => r.key)).toEqual(['SC-10']);
    expect(blocked).toEqual([{ key: 'SC-1', pending: ['SC-10'] }]);
  });

  test('does not churn a ticket that is already where it belongs', () => {
    const { ready } = findReadyToAdvance(workflow, [
      issue('SC-10', 'Story', 'QA'),
      issue('SC-11', 'Subtask', 'Done', 'SC-10'),
    ]);
    expect(ready).toEqual([]);
  });

  test('never re-opens something already finished', () => {
    const { ready } = findReadyToAdvance(workflow, [
      issue('SC-10', 'Story', 'Done'),
      issue('SC-11', 'Subtask', 'Done', 'SC-10'),
    ]);
    expect(ready).toEqual([]);
  });

  test('honours an installation that calls "done" something else', () => {
    const workflowB = parseWorkflowConfig({ ...config, doneStatuses: ['Done', 'Sign-off'] }, { roleIds });
    const { ready } = findReadyToAdvance(workflowB, [
      issue('SC-10', 'Story', 'In Progress'),
      issue('SC-11', 'Subtask', 'Sign-off', 'SC-10'),
    ]);
    expect(ready.map((r) => r.key)).toEqual(['SC-10']);
  });
});

describe('nobody ships without a pull request and its approvers', () => {
  const gated = {
    issueTypes: [
      { type: 'Epic', role: 'cto', approvals: ['pm'], onDone: { status: 'Sign-off', validatedBy: 'pm' } },
      { type: 'Story', role: 'pm', approvals: ['po'], onDone: { status: 'QA', validatedBy: 'qa' } },
      { type: 'Subtask', role: 'developer', approvals: ['qa'], onDone: { status: 'Review', validatedBy: 'qa' } },
      { type: 'Task', role: 'devops' },
    ],
  };
  const ids = new Set(['cto', 'pm', 'po', 'qa', 'developer', 'devops']);
  const wf = parseWorkflowConfig(gated, { roleIds: ids });

  test('the CTO approves every level, plus the role that owns it', () => {
    expect(approversFor(wf, { type: 'Epic' })).toEqual(['cto', 'pm']);
    expect(approversFor(wf, { type: 'Story' })).toEqual(['cto', 'po']);
    expect(approversFor(wf, { type: 'Subtask' })).toEqual(['cto', 'qa']);
  });

  test('an issue type with no approvals still needs the CTO, never zero', () => {
    expect(approversFor(wf, { type: 'Task' })).toEqual(['cto']);
    expect(approversFor(wf, { type: 'Unknown' })).toEqual(['cto']);
  });

  test('never lists the same approver twice', () => {
    const wfB = parseWorkflowConfig({
      issueTypes: [{ type: 'Epic', role: 'cto', approvals: ['cto', 'pm'] }],
    }, { roleIds: ids });
    expect(approversFor(wfB, { type: 'Epic' })).toEqual(['cto', 'pm']);
  });

  test('rejects an approver the installation never configured', () => {
    expect(() => parseWorkflowConfig({
      issueTypes: [{ type: 'Epic', role: 'cto', approvals: ['ghost'] }],
    }, { roleIds: ids })).toThrow(/approvals\[0\] "ghost" is not a configured role/);
  });

  test('rejects a duplicated or malformed approvals list', () => {
    expect(() => parseWorkflowConfig({
      issueTypes: [{ type: 'Epic', role: 'cto', approvals: ['pm', 'pm'] }],
    }, { roleIds: ids })).toThrow(/duplicate approver/);
    expect(() => parseWorkflowConfig({
      issueTypes: [{ type: 'Epic', role: 'cto', approvals: 'pm' }],
    }, { roleIds: ids })).toThrow(/issueTypes\[0\]\.approvals/);
  });
});
