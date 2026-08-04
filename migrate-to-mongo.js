import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(path.join(DATA_DIR, file), 'utf8'));
  } catch {
    return fallback;
  }
}

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'lunchbuddy';
const client = new MongoClient(uri);

await client.connect();
const db = client.db(dbName);

const roster = await readJson('roster.json', []);
if (roster.length > 0) {
  await db.collection('roster').deleteMany({});
  await db.collection('roster').insertMany(roster.map((r) => ({ ...r })));
  console.log(`Migrated ${roster.length} roster entries`);
}

const dailyState = await readJson('daily_state.json', null);
if (dailyState) {
  await db.collection('dailyState').replaceOne(
    { _id: 'current' },
    { _id: 'current', ...dailyState },
    { upsert: true }
  );
  console.log('Migrated daily state');
}

const history = await readJson('history.json', []);
if (history.length > 0) {
  await db.collection('history').deleteMany({});
  await db.collection('history').insertMany(history.map((entry, i) => ({ ...entry, _seq: i })));
  console.log(`Migrated ${history.length} history entries`);
}

const remindersLog = await readJson('reminders_log.json', []);
if (remindersLog.length > 0) {
  await db.collection('remindersLog').replaceOne(
    { _id: 'log' },
    { _id: 'log', entries: remindersLog },
    { upsert: true }
  );
  console.log(`Migrated ${remindersLog.length} reminder log entries`);
}

await client.close();
console.log('Done.');
