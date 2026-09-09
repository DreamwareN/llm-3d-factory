import { describe, expect, it } from 'vitest';
import { createDatabase } from './client.js';
import { migrate } from './migrate.js';
import { createRepositories } from './repositories.js';

function setup() {
  const database = createDatabase(':memory:');
  migrate(database);
  const repos = createRepositories(database.db);
  const project = repos.projects.create({ name: 'Prune Test' });
  const other = repos.projects.create({ name: 'Other Project' });
  return { repos, project, other };
}

function createOperation(
  repos: ReturnType<typeof createRepositories>,
  projectId: string,
  tool: string,
): string {
  const operation = repos.sceneOperations.create({
    projectId,
    conversationId: null,
    tool,
    input: { object_id: 'ghost_2' },
    result: { success: true },
  });
  return operation.id;
}

describe('sceneOperations.removeMany', () => {
  it('removes only the requested operations of the given project', () => {
    const { repos, project, other } = setup();
    const keep = createOperation(repos, project.id, 'create_primitive');
    const removeA = createOperation(repos, project.id, 'transform_object');
    const removeB = createOperation(repos, project.id, 'transform_object');
    const foreign = createOperation(repos, other.id, 'transform_object');

    const removed = repos.sceneOperations.removeMany(project.id, [removeA, removeB, foreign]);

    expect(removed).toBe(2);
    const remaining = repos.sceneOperations.list(project.id).map((operation) => operation.id);
    expect(remaining).toEqual([keep]);
    expect(repos.sceneOperations.list(other.id).map((operation) => operation.id)).toEqual([foreign]);
  });

  it('is a no-op for an empty id list', () => {
    const { repos, project } = setup();
    createOperation(repos, project.id, 'create_primitive');
    expect(repos.sceneOperations.removeMany(project.id, [])).toBe(0);
    expect(repos.sceneOperations.list(project.id)).toHaveLength(1);
  });
});
