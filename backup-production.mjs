// One-off safety-net backup before the multi-tenancy migration touches
// production. Dumps every collection in the real `lunchbuddy` database to
// timestamped local JSON files — independent of whatever Atlas backup tier
// this cluster is on. Read-only against production; writes only to disk.
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);
await client.connect();
const db = client.db('lunchbuddy'); // always the real production DB, regardless of .env's MONGODB_DB

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join('backups', stamp);
fs.mkdirSync(outDir, { recursive: true });

const collections = (await db.listCollections().toArray()).map(c => c.name);
console.log(`Backing up ${collections.length} collection(s) from production ("lunchbuddy") to ${outDir}/`);

for (const name of collections) {
  const docs = await db.collection(name).find({}).toArray();
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(docs, null, 2));
  console.log(`  ${name}: ${docs.length} document(s)`);
}

await client.close();
console.log(`\nBackup complete: ${outDir}/`);
