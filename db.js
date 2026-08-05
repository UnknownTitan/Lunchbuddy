import 'dotenv/config';
import { MongoClient } from 'mongodb';
import bcrypt from 'bcryptjs';

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'lunchbuddy';

if (!uri) {
  throw new Error('MONGODB_URI is not set. Add it to your .env file.');
}

const client = new MongoClient(uri);
let db;

// Singleton doc IDs for the settings-style collections
const DAILY_STATE_ID = 'current';
const REMINDERS_LOG_ID = 'log';
const SECURITY_SETTINGS_ID = 'current';

export async function initDb() {
  await client.connect();
  db = client.db(dbName);

  const rosterCount = await db.collection('roster').countDocuments();
  if (rosterCount === 0) {
    await db.collection('roster').insertOne({
      id: 'usr-admin',
      name: 'System Admin',
      email: 'admin@company.com',
      phone: '',
      role: 'Admin',
      passcodeHash: await bcrypt.hash('admin123', 10)
    });
  }

  const dailyState = await db.collection('dailyState').findOne({ _id: DAILY_STATE_ID });
  if (!dailyState) {
    await db.collection('dailyState').insertOne({
      _id: DAILY_STATE_ID,
      date: '',
      cutoffTime: '11:30',
      archiveTime: '14:00',
      menu: [],
      menuPublished: false,
      orders: {}
    });
  }

  const remindersLog = await db.collection('remindersLog').findOne({ _id: REMINDERS_LOG_ID });
  if (!remindersLog) {
    await db.collection('remindersLog').insertOne({ _id: REMINDERS_LOG_ID, entries: [] });
  }

  const securitySettings = await db.collection('securitySettings').findOne({ _id: SECURITY_SETTINGS_ID });
  if (!securitySettings) {
    // Seed from whatever env vars were previously set (if any), so
    // existing deployments keep their configured values; from here on,
    // these live in the DB and are editable from the admin UI.
    await db.collection('securitySettings').insertOne({
      _id: SECURITY_SETTINGS_ID,
      loginMaxFailedAttempts: Number(process.env.LOGIN_MAX_FAILED_ATTEMPTS) || 5,
      loginLockoutMinutes: Number(process.env.LOGIN_LOCKOUT_MINUTES) || 15,
      loginRateLimitMax: Number(process.env.LOGIN_RATE_LIMIT_MAX) || 5,
      loginRateLimitWindowMinutes: Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MINUTES) || 15
    });
  }
}

export async function getRoster() {
  const docs = await db.collection('roster').find({}).toArray();
  return docs.map(({ _id, ...rest }) => rest);
}

export async function saveRoster(roster) {
  const collection = db.collection('roster');
  await collection.deleteMany({});
  if (roster.length > 0) {
    await collection.insertMany(roster.map((r) => ({ ...r })));
  }
}

export async function getDailyState() {
  const doc = await db.collection('dailyState').findOne({ _id: DAILY_STATE_ID });
  if (!doc) return {};
  const { _id, ...rest } = doc;
  return rest;
}

export async function saveDailyState(state) {
  await db.collection('dailyState').replaceOne(
    { _id: DAILY_STATE_ID },
    { _id: DAILY_STATE_ID, ...state },
    { upsert: true }
  );
}

export async function getHistory() {
  const docs = await db.collection('history')
    .find({})
    .sort({ _seq: 1 })
    .toArray();
  return docs.map(({ _id, _seq, ...rest }) => rest);
}

export async function saveHistory(history) {
  const collection = db.collection('history');
  await collection.deleteMany({});
  if (history.length > 0) {
    await collection.insertMany(history.map((entry, i) => ({ ...entry, _seq: i })));
  }
}

export async function getRemindersLog() {
  const doc = await db.collection('remindersLog').findOne({ _id: REMINDERS_LOG_ID });
  return doc?.entries ?? [];
}

export async function saveRemindersLog(logs) {
  await db.collection('remindersLog').replaceOne(
    { _id: REMINDERS_LOG_ID },
    { _id: REMINDERS_LOG_ID, entries: logs },
    { upsert: true }
  );
}

export async function getSecuritySettings() {
  const doc = await db.collection('securitySettings').findOne({ _id: SECURITY_SETTINGS_ID });
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return rest;
}

export async function saveSecuritySettings(settings) {
  await db.collection('securitySettings').replaceOne(
    { _id: SECURITY_SETTINGS_ID },
    { _id: SECURITY_SETTINGS_ID, ...settings },
    { upsert: true }
  );
}
