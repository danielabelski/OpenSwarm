import { afterEach, describe, expect, it } from 'vitest';
import { SqliteIssueStore } from '../issues/sqliteStore.js';
import { SqliteTaskSource, issueToTask } from './taskSource.js';

function freshStore(): SqliteIssueStore {
  return new SqliteIssueStore(':memory:');
}

describe('issueToTask mapping', () => {
  it('maps priority + status to the runner vocabulary', () => {
    const store = freshStore();
    const issue = store.createIssue({ projectId: 'p', title: 'T', priority: 'high', status: 'in_progress' });
    const task = issueToTask(issue);
    expect(task.source).toBe('local');
    expect(task.priority).toBe(2); // high → 2
    expect(task.linearState).toBe('In Progress');
    expect(task.issueId).toBe(issue.id);
    store.close();
  });
});

describe('SqliteTaskSource', () => {
  let store: SqliteIssueStore;
  afterEach(() => store?.close());

  it('fetchTasks returns only todo/in_progress issues', async () => {
    store = freshStore();
    store.createIssue({ projectId: 'p', title: 'todo-one', status: 'todo' });
    store.createIssue({ projectId: 'p', title: 'running', status: 'in_progress' });
    store.createIssue({ projectId: 'p', title: 'backlogged', status: 'backlog' });
    store.createIssue({ projectId: 'p', title: 'finished', status: 'done' });

    const src = new SqliteTaskSource(store);
    const tasks = await src.fetchTasks();
    const titles = tasks.map((t) => t.title).sort();
    expect(titles).toEqual(['running', 'todo-one']);
    expect(tasks.every((t) => t.source === 'local')).toBe(true);
  });

  it('updateState transitions the issue status', async () => {
    store = freshStore();
    const issue = store.createIssue({ projectId: 'p', title: 'x', status: 'todo' });
    const src = new SqliteTaskSource(store);
    await src.updateState(issue.id, 'Done');
    expect(store.getIssue(issue.id)?.status).toBe('done');
  });

  it('addComment records a commented event', async () => {
    store = freshStore();
    const issue = store.createIssue({ projectId: 'p', title: 'x' });
    const src = new SqliteTaskSource(store);
    await src.addComment(issue.id, 'hello');
    const events = store.getEvents(issue.id);
    expect(events.some((e) => e.type === 'commented')).toBe(true);
  });

  it('createSubIssue creates a child under the parent project', async () => {
    store = freshStore();
    const parent = store.createIssue({ projectId: 'proj-x', title: 'parent' });
    const src = new SqliteTaskSource(store);
    const result = await src.createSubIssue(parent.id, 'child', 'desc', { priority: 1, estimatedMinutes: 20 });
    expect('id' in result).toBe(true);
    if ('id' in result) {
      const child = store.getIssue(result.id);
      expect(child?.parentId).toBe(parent.id);
      expect(child?.projectId).toBe('proj-x');
      expect(child?.priority).toBe('urgent'); // 1 → urgent
    }
  });

  it('createTask creates a top-level todo issue', async () => {
    store = freshStore();
    const src = new SqliteTaskSource(store, 'proj-default');
    const result = await src.createTask('a goal', 'details');
    expect('id' in result).toBe(true);
    if ('id' in result) {
      const issue = store.getIssue(result.id);
      expect(issue?.title).toBe('a goal');
      expect(issue?.status).toBe('todo');
      expect(issue?.parentId).toBeUndefined();
    }
  });

  it('markAsDecomposed comments + moves the parent to Backlog', async () => {
    store = freshStore();
    const issue = store.createIssue({ projectId: 'p', title: 'big', status: 'todo' });
    const src = new SqliteTaskSource(store);
    await src.markAsDecomposed(issue.id, 3, 90);
    expect(store.getIssue(issue.id)?.status).toBe('backlog');
    expect(store.getEvents(issue.id).some((e) => e.type === 'commented')).toBe(true);
  });
});
