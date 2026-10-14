import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // `prisma generate` runs at image build time without a database, so the
    // URL is only required by commands that connect (migrate, studio).
    url: process.env.DATABASE_URL ?? '',
  },
});
