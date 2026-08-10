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

function requireCompanyId(companyId, fnName) {
  if (!companyId) throw new Error(`${fnName}: companyId is required`);
}

export async function initDb() {
  await client.connect();
  db = client.db(dbName);
  await ensureIndexes();
  await ensurePlatformBootstrap();
}

async function ensureIndexes() {
  await db.collection('companies').createIndex({ code: 1 }, { unique: true });
  await db.collection('dailyState').createIndex({ companyId: 1 }, { unique: true, sparse: true });
  await db.collection('remindersLog').createIndex({ companyId: 1 }, { unique: true, sparse: true });
  await db.collection('securitySettings').createIndex({ companyId: 1 }, { unique: true, sparse: true });
  await db.collection('roster').createIndex({ companyId: 1 });
  await db.collection('history').createIndex({ companyId: 1 });
  await db.collection('weeklyPlans').createIndex({ companyId: 1 });
  await db.collection('dishes').createIndex({ companyId: 1, normalizedName: 1 }, { unique: true });
  await db.collection('dishes').createIndex({ companyId: 1, active: 1 });
  await db.collection('dishImages').createIndex({ companyId: 1 });
  await db.collection('branches').createIndex({ companyId: 1 });
  await db.collection('companySettings').createIndex({ companyId: 1 }, { unique: true, sparse: true });
}

// Inserts the one Platform Admin account (companyId: null) from env vars,
// if no such account exists yet. Safe to call on every boot.
async function ensurePlatformBootstrap() {
  const existing = await db.collection('roster').findOne({ companyId: null, role: 'Platform Admin' });
  if (existing) return;

  const name = process.env.PLATFORM_ADMIN_NAME;
  const passcode = process.env.PLATFORM_ADMIN_PASSCODE;
  if (!name || !passcode) return;

  await db.collection('roster').insertOne({
    id: `usr-platform-${Date.now()}`,
    companyId: null,
    name,
    email: '',
    phone: '',
    role: 'Platform Admin',
    passcodeHash: await bcrypt.hash(passcode, 10),
    mustChangePasscode: true
  });
}

// Seeds the default dailyState/remindersLog/securitySettings docs for a
// brand-new company. Called once, right after createCompany().
export async function seedCompanyDefaults(companyId) {
  requireCompanyId(companyId, 'seedCompanyDefaults');

  const dailyState = await db.collection('dailyState').findOne({ companyId });
  if (!dailyState) {
    await db.collection('dailyState').insertOne({
      companyId,
      date: '',
      cutoffTime: '11:30',
      archiveTime: '14:00',
      operationalDays: [0, 1, 2, 3, 4, 5, 6],
      menu: [],
      menuPublished: false,
      orders: {}
    });
  }

  const remindersLog = await db.collection('remindersLog').findOne({ companyId });
  if (!remindersLog) {
    await db.collection('remindersLog').insertOne({ companyId, entries: [] });
  }

  const securitySettings = await db.collection('securitySettings').findOne({ companyId });
  if (!securitySettings) {
    await db.collection('securitySettings').insertOne({
      companyId,
      loginMaxFailedAttempts: Number(process.env.LOGIN_MAX_FAILED_ATTEMPTS) || 5,
      loginLockoutMinutes: Number(process.env.LOGIN_LOCKOUT_MINUTES) || 15,
      loginRateLimitMax: Number(process.env.LOGIN_RATE_LIMIT_MAX) || 5,
      loginRateLimitWindowMinutes: Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MINUTES) || 15
    });
  }

  const companySettings = await db.collection('companySettings').findOne({ companyId });
  if (!companySettings) {
    await db.collection('companySettings').insertOne({ companyId, defaultPricePerHead: null });
  }
}

// ---- companySettings ----
// Company-wide catering settings an Admin can edit themselves (unlike
// `companies`, which only a Platform Admin can touch). Currently just the
// per-head fallback cost Trends uses when an order's dish has no price of
// its own — most commonly orders archived before the Dish Catalog existed.

export async function getCompanySettings(companyId) {
  requireCompanyId(companyId, 'getCompanySettings');
  const doc = await db.collection('companySettings').findOne({ companyId });
  if (!doc) return { defaultPricePerHead: null };
  const { _id, ...rest } = doc;
  return rest;
}

export async function saveCompanySettings(companyId, settings) {
  requireCompanyId(companyId, 'saveCompanySettings');
  await db.collection('companySettings').replaceOne(
    { companyId },
    { ...settings, companyId },
    { upsert: true }
  );
}

// ---- companies ----

export async function getCompanies() {
  return db.collection('companies').find({}).toArray();
}

export async function getCompanyById(id) {
  if (!id) return null;
  return db.collection('companies').findOne({ _id: id });
}

export async function getCompanyByCode(code) {
  if (!code) return null;
  return db.collection('companies').findOne({ code: code.trim().toUpperCase() });
}

export async function createCompany({ id, code, name, createdBy }) {
  const doc = {
    _id: id,
    code: code.trim().toUpperCase(),
    name,
    status: 'active',
    createdAt: Date.now(),
    createdBy
  };
  await db.collection('companies').insertOne(doc);
  return doc;
}

export async function updateCompany(companyId, patch) {
  requireCompanyId(companyId, 'updateCompany');
  await db.collection('companies').updateOne({ _id: companyId }, { $set: patch });
}

// ---- roster ----

export async function getRoster(companyId) {
  requireCompanyId(companyId, 'getRoster');
  const docs = await db.collection('roster').find({ companyId }).toArray();
  return docs.map(({ _id, ...rest }) => rest);
}

export async function saveRoster(companyId, roster) {
  requireCompanyId(companyId, 'saveRoster');
  const collection = db.collection('roster');
  await collection.deleteMany({ companyId });
  if (roster.length > 0) {
    await collection.insertMany(roster.map((r) => ({ ...r, companyId })));
  }
}

// Unscoped by design: user ids are globally unique, and the caller doesn't
// yet know which company a request belongs to (pre-auth login lookup).
export async function getUserById(id) {
  if (!id) return null;
  const doc = await db.collection('roster').findOne({ id });
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return rest;
}

// Targeted single-field patch by id — used for auth bookkeeping
// (failedAttempts, lockedUntil, passcode changes, push subscriptions) that
// would otherwise force a companyId-scoped read-modify-write of the whole
// roster. Works for Platform Admin records too, which have no companyId.
export async function updateUserById(id, patch) {
  await db.collection('roster').updateOne({ id }, { $set: patch });
}

// Unscoped by design: Platform Admin records have companyId: null, so the
// normal company-scoped getRoster() can never find them.
export async function getPlatformAdminByName(name) {
  const doc = await db.collection('roster').findOne({ companyId: null, role: 'Platform Admin', name });
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return rest;
}

// ---- dailyState ----

export async function getDailyState(companyId) {
  requireCompanyId(companyId, 'getDailyState');
  const doc = await db.collection('dailyState').findOne({ companyId });
  if (!doc) return {};
  const { _id, ...rest } = doc;
  return rest;
}

export async function saveDailyState(companyId, state) {
  requireCompanyId(companyId, 'saveDailyState');
  await db.collection('dailyState').replaceOne(
    { companyId },
    { ...state, companyId },
    { upsert: true }
  );
}

// ---- history ----

export async function getHistory(companyId) {
  requireCompanyId(companyId, 'getHistory');
  const docs = await db.collection('history')
    .find({ companyId })
    .sort({ _seq: 1 })
    .toArray();
  return docs.map(({ _id, _seq, ...rest }) => rest);
}

export async function getHistoryForDates(companyId, dates) {
  requireCompanyId(companyId, 'getHistoryForDates');
  if (!dates || dates.length === 0) return [];
  const docs = await db.collection('history').find({ companyId, date: { $in: dates } }).toArray();
  return docs.map(({ _id, _seq, ...rest }) => rest);
}

export async function saveHistory(companyId, history) {
  requireCompanyId(companyId, 'saveHistory');
  const collection = db.collection('history');
  await collection.deleteMany({ companyId });
  if (history.length > 0) {
    await collection.insertMany(history.map((entry, i) => ({ ...entry, companyId, _seq: i })));
  }
}

// ---- remindersLog ----

export async function getRemindersLog(companyId) {
  requireCompanyId(companyId, 'getRemindersLog');
  const doc = await db.collection('remindersLog').findOne({ companyId });
  return doc?.entries ?? [];
}

export async function saveRemindersLog(companyId, logs) {
  requireCompanyId(companyId, 'saveRemindersLog');
  await db.collection('remindersLog').replaceOne(
    { companyId },
    { companyId, entries: logs },
    { upsert: true }
  );
}

// ---- securitySettings ----

export async function getSecuritySettings(companyId) {
  requireCompanyId(companyId, 'getSecuritySettings');
  const doc = await db.collection('securitySettings').findOne({ companyId });
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return rest;
}

export async function saveSecuritySettings(companyId, settings) {
  requireCompanyId(companyId, 'saveSecuritySettings');
  await db.collection('securitySettings').replaceOne(
    { companyId },
    { ...settings, companyId },
    { upsert: true }
  );
}

// ---- weeklyPlans ----
// _id stays userId (globally unique already); companyId is added as a
// cross-tenant guard on every read/write.

export async function getWeeklyPlan(companyId, userId) {
  requireCompanyId(companyId, 'getWeeklyPlan');
  const doc = await db.collection('weeklyPlans').findOne({ _id: userId, companyId });
  if (!doc) return { userId, entries: {} };
  const { _id, ...rest } = doc;
  return rest;
}

export async function saveWeeklyPlan(companyId, userId, plan) {
  requireCompanyId(companyId, 'saveWeeklyPlan');
  await db.collection('weeklyPlans').replaceOne(
    { _id: userId, companyId },
    { _id: userId, ...plan, companyId },
    { upsert: true }
  );
}

export async function getAllWeeklyPlans(companyId) {
  requireCompanyId(companyId, 'getAllWeeklyPlans');
  const docs = await db.collection('weeklyPlans').find({ companyId }).toArray();
  return docs.map(({ _id, ...rest }) => rest);
}

export async function deleteWeeklyPlan(companyId, userId) {
  requireCompanyId(companyId, 'deleteWeeklyPlan');
  await db.collection('weeklyPlans').deleteOne({ _id: userId, companyId });
}

// ---- dishes (catalog) ----
// Per-document CRUD (not roster's whole-array-replace pattern) — matches
// how `companies` already works, and avoids read-modify-write races between
// concurrent admin edits.

export async function getDishes(companyId, { includeInactive = false } = {}) {
  requireCompanyId(companyId, 'getDishes');
  const query = includeInactive ? { companyId } : { companyId, active: true };
  return db.collection('dishes').find(query).sort({ name: 1 }).toArray();
}

export async function getDishById(companyId, dishId) {
  requireCompanyId(companyId, 'getDishById');
  return db.collection('dishes').findOne({ id: dishId, companyId });
}

export async function createDish(companyId, dish) {
  requireCompanyId(companyId, 'createDish');
  const doc = { ...dish, companyId };
  await db.collection('dishes').insertOne(doc);
  return doc;
}

export async function updateDish(companyId, dishId, patch) {
  requireCompanyId(companyId, 'updateDish');
  await db.collection('dishes').updateOne({ id: dishId, companyId }, { $set: patch });
}

export async function setDishActive(companyId, dishId, active) {
  requireCompanyId(companyId, 'setDishActive');
  await db.collection('dishes').updateOne({ id: dishId, companyId }, { $set: { active, updatedAt: Date.now() } });
}

// ---- dishImages ----
// Kept as its own collection so listing the catalog (getDishes) never has
// to transfer image bytes.

export async function saveDishImage(companyId, image) {
  requireCompanyId(companyId, 'saveDishImage');
  const doc = { _id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, companyId, ...image, createdAt: Date.now() };
  await db.collection('dishImages').insertOne(doc);
  return doc;
}

export async function getDishImage(companyId, imageId) {
  requireCompanyId(companyId, 'getDishImage');
  return db.collection('dishImages').findOne({ _id: imageId, companyId });
}

// Unscoped by design: <img src> requests can't carry the x-auth-token
// header, so this endpoint can't require auth — served by opaque,
// unguessable id only (same trade-off as the existing static dish assets,
// which were always publicly reachable files under public/assets/).
export async function getDishImageById(imageId) {
  if (!imageId) return null;
  return db.collection('dishImages').findOne({ _id: imageId });
}

export async function deleteDishImage(companyId, imageId) {
  requireCompanyId(companyId, 'deleteDishImage');
  if (!imageId) return;
  await db.collection('dishImages').deleteOne({ _id: imageId, companyId });
}

// ---- branches ----

export async function getBranches(companyId) {
  requireCompanyId(companyId, 'getBranches');
  const docs = await db.collection('branches').find({ companyId }).sort({ name: 1 }).toArray();
  return docs.map(({ _id, ...rest }) => rest);
}

export async function createBranch(companyId, branch) {
  requireCompanyId(companyId, 'createBranch');
  const doc = { _id: branch.id, ...branch, companyId };
  await db.collection('branches').insertOne(doc);
  const { _id, ...rest } = doc;
  return rest;
}

export async function updateBranch(companyId, branchId, patch) {
  requireCompanyId(companyId, 'updateBranch');
  await db.collection('branches').updateOne({ _id: branchId, companyId }, { $set: patch });
}

export async function deleteBranch(companyId, branchId) {
  requireCompanyId(companyId, 'deleteBranch');
  await db.collection('branches').deleteOne({ _id: branchId, companyId });
}

// ---- history (range query for Trends) ----

export async function getHistoryInRange(companyId, startDate, endDate) {
  requireCompanyId(companyId, 'getHistoryInRange');
  const query = { companyId };
  if (startDate || endDate) {
    query.date = {};
    if (startDate) query.date.$gte = startDate;
    if (endDate) query.date.$lte = endDate;
  }
  const docs = await db.collection('history').find(query).sort({ date: 1 }).toArray();
  return docs.map(({ _id, _seq, ...rest }) => rest);
}
