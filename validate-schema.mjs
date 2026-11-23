import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
const dir = path.dirname(fileURLToPath(import.meta.url));
const ajv = new Ajv2020({ strict: false, allErrors: true });
const schema = JSON.parse(fs.readFileSync(path.join(dir,'schema','strpg-game-package.schema.json'),'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(dir,'examples','emberfall.game-package.json'),'utf8'));
const validate = ajv.compile(schema);
console.log('valid', validate(pkg));
if (!validate(pkg)) console.log(JSON.stringify(validate.errors.slice(0, 20), null, 2));

