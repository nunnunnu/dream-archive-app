/** 프로젝트 루트 .env 를 불러온다 (OPENAI_API_KEY, YOUTUBE_API_KEY 등). .env 는 Git에 올라가지 않는다. */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');
if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);
