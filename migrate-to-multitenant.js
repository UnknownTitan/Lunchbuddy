import 'dotenv/config';
import { MongoClient } from 'mongodb';
import bcrypt from 'bcryptjs';

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'lunchbuddy';
const client = new MongoClient(uri);

const APPLY = process.argv.includes('--apply');
const ROLLBACK = process.argv.includes('--rollback');

const RFD_COMPANY = {
  _id: 'cmp-rfd',
  code: 'RFD',
  name: 'RFD (Resource for Development)',
  status: 'active'
};

const SCOPED_COLLECTIONS = ['roster', 'dailyState', 'history', 'remindersLog', 'securitySettings', 'weeklyPlans'];

await client.connect();
const db = client.db(dbName);

if (ROLLBACK) {
  console.log('--- ROLLBACK ---');
  for (const name of SCOPED_COLLECTIONS) {
    const result = await db.collection(name).updateMany({}, { $unset: { companyId: '' } });
    console.log(`${name}: unset companyId on ${result.modifiedCount} document(s)`);
  }
  const dropped = await db.collection('roster').deleteMany({ companyId: null, role: 'Platform Admin' });
  console.log(`roster: removed ${dropped.deletedCount} Platform Admin record(s)`);
  await db.collection('companies').deleteOne({ _id: RFD_COMPANY._id });
  console.log(`companies: removed ${RFD_COMPANY._id}`);
  await client.close();
  process.exit(0);
}

// --- Pre-flight ---
console.log('--- PRE-FLIGHT ---');
const preCounts = {};
for (const name of SCOPED_COLLECTIONS) {
  const total = await db.collection(name).countDocuments();
  const withoutCompanyId = await db.collection(name).countDocuments({ companyId: { $exists: false } });
  preCounts[name] = { total, withoutCompanyId };
  console.log(`${name}: ${total} total, ${withoutCompanyId} missing companyId`);
}

if (!APPLY) {
  console.log('\nDry run only — re-run with --apply to perform the migration.');
  await client.close();
  process.exit(0);
}

// --- 1. Upsert the RFD company doc (safe to re-run) ---
await db.collection('companies').updateOne(
  { _id: RFD_COMPANY._id },
  { $setOnInsert: { ...RFD_COMPANY, createdAt: Date.now(), createdBy: 'migration-script' } },
  { upsert: true }
);
console.log(`\nEnsured company ${RFD_COMPANY._id} (${RFD_COMPANY.code}) exists.`);

// --- 2. Backfill companyId on every scoped collection ---
for (const name of SCOPED_COLLECTIONS) {
  const result = await db.collection(name).updateMany(
    { companyId: { $exists: false } },
    { $set: { companyId: RFD_COMPANY._id } }
  );
  console.log(`${name}: backfilled ${result.modifiedCount} document(s)`);
}

// --- 3. Create the Platform Admin, only if one doesn't already exist ---
// Deliberately a NEW roster record from env vars — never repurpose the
// existing usr-admin record, which would strip RFD of its only Admin.
let createdPlatformAdmin = false;
const existingPlatformAdmin = await db.collection('roster').findOne({ companyId: null, role: 'Platform Admin' });
if (existingPlatformAdmin) {
  console.log('\nPlatform Admin already exists — skipping.');
} else {
  const name = process.env.PLATFORM_ADMIN_NAME;
  const passcode = process.env.PLATFORM_ADMIN_PASSCODE;
  if (!name || !passcode) {
    console.log('\nPLATFORM_ADMIN_NAME/PLATFORM_ADMIN_PASSCODE not set — skipping Platform Admin creation (server boot will create one once they are set).');
  } else {
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
    createdPlatformAdmin = true;
    console.log(`\nCreated Platform Admin "${name}".`);
  }
}

// --- 4. Indexes (after backfill — a unique index on a not-yet-populated field would block) ---
await db.collection('companies').createIndex({ code: 1 }, { unique: true });
await db.collection('dailyState').createIndex({ companyId: 1 }, { unique: true, sparse: true });
await db.collection('remindersLog').createIndex({ companyId: 1 }, { unique: true, sparse: true });
await db.collection('securitySettings').createIndex({ companyId: 1 }, { unique: true, sparse: true });
await db.collection('roster').createIndex({ companyId: 1 });
await db.collection('history').createIndex({ companyId: 1 });
await db.collection('weeklyPlans').createIndex({ companyId: 1 });
console.log('\nIndexes created.');

// --- 5. Post-flight verification ---
console.log('\n--- POST-FLIGHT ---');
let allOk = true;
for (const name of SCOPED_COLLECTIONS) {
  const total = await db.collection(name).countDocuments();
  const withoutCompanyId = await db.collection(name).countDocuments({ companyId: { $exists: false } });
  // roster deliberately grows by exactly 1 when this run created a new
  // Platform Admin record — every other collection must match exactly.
  const expectedTotal = (name === 'roster' && createdPlatformAdmin)
    ? preCounts[name].total + 1
    : preCounts[name].total;
  const totalOk = total === expectedTotal;
  const scopedOk = withoutCompanyId === 0;
  if (!totalOk || !scopedOk) allOk = false;
  console.log(`${name}: ${total} total (expected ${expectedTotal}, ${totalOk ? 'OK' : 'MISMATCH'}), ${withoutCompanyId} missing companyId (${scopedOk ? 'OK' : 'FAIL'})`);
}

await client.close();

if (!allOk) {
  console.error('\nVerification FAILED — see MISMATCH/FAIL rows above.');
  process.exit(1);
}
console.log('\nMigration complete.');
