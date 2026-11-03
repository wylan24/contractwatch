// Writes schema/contractwatch.schema.json from the rule list. `npm test` checks it is up to date.
import { mkdirSync, writeFileSync } from 'node:fs';
import { configSchema } from '../src/config-schema.ts';

mkdirSync(new URL('../schema/', import.meta.url), { recursive: true });
writeFileSync(new URL('../schema/contractwatch.schema.json', import.meta.url), JSON.stringify(configSchema(), null, 2) + '\n');
