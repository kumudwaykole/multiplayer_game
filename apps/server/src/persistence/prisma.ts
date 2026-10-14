import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client.js';

export { Prisma, PrismaClient };

export function createPrisma(databaseUrl: string, poolSize: number): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: databaseUrl,
    max: poolSize,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  return new PrismaClient({ adapter });
}

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
