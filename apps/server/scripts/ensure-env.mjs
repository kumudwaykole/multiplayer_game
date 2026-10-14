// Creates apps/server/.env from .env.example on first run so `pnpm dev` works from a fresh checkout.
import { copyFileSync, existsSync } from 'node:fs';

if (!existsSync('.env')) {
  copyFileSync('.env.example', '.env');
  console.log('[server] created .env from .env.example');
}
