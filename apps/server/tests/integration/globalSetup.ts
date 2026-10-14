import { execSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/** One real PostgreSQL for the integration suite, migrated with the committed migrations. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const container = await new PostgreSqlContainer('postgres:17.11-alpine')
    .withDatabase('drawing_game_test')
    .withUsername('game')
    .withPassword('test-only')
    .start();
  const databaseUrl = container.getConnectionUri();
  execSync('pnpm exec prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
  project.provide('databaseUrl', databaseUrl);
  return async () => {
    await container.stop();
  };
}
