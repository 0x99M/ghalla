#!/usr/bin/env node
// Provisions everything the portal needs from a database it does not own.
//
// Three steps, all idempotent, all safe to re-run:
//
//   1. CREATE DATABASE for the portal's own tables.
//   1b. Create a NON-SUPERUSER owner for it, so the portal's own connection
//      string carries no cluster-wide privilege.
//   2. Run sql/ghalla_ops_ro.sql against an integration database, creating the
//      read-only role the portal connects as.
//
// WHY THIS EXISTS. The SQL file documents `psql -f`, and psql is not installed
// everywhere this needs to run — not on a fresh laptop, and not in Railway's
// runtime image. The file also uses psql CLIENT meta-commands (\if, \set, the
// :'ops_password' variable) which no driver understands. This runner supplies
// exactly what psql would and nothing else, so the SQL file stays the single
// source of truth for what the role may see.
//
// Run it as the database OWNER or a superuser. The role it creates is the
// low-privilege one; creating it is not.
//
//   ADMIN_DATABASE_URL=postgresql://postgres:...@host:5432/railway \
//   OPS_RO_PASSWORD=$(openssl rand -hex 20) \
//   PORTAL_OWNER_PASSWORD=$(openssl rand -hex 20) \
//   node apps/ghalla-ops/scripts/provision.mjs
//
// It prints the two connection strings to set on the ops service. Neither of
// them is the superuser's.
//
// PORTAL_DATABASE_NAME defaults to ghalla_ops.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const adminUrl = process.env.ADMIN_DATABASE_URL;
const password = process.env.OPS_RO_PASSWORD;
const portalDbName = process.env.PORTAL_DATABASE_NAME ?? 'ghalla_ops';

if (!adminUrl) {
  console.error('ADMIN_DATABASE_URL is not set — it must point at the INTEGRATION database, as its owner');
  process.exit(1);
}
if (!password) {
  console.error('OPS_RO_PASSWORD is not set');
  process.exit(1);
}

// The one substitution this runner makes is a password into SQL text, and this
// is what makes that safe rather than merely careful: a URL-safe alphanumeric
// secret cannot carry a quote, so there is nothing to escape and no escaping
// bug to have. `openssl rand -base64` is deliberately NOT acceptable here — it
// emits `+`, `/` and `=`, and a `/` also breaks the connection string this
// password ends up inside.
if (!/^[A-Za-z0-9_-]{24,}$/.test(password)) {
  console.error(
    'OPS_RO_PASSWORD must be at least 24 URL-safe characters ([A-Za-z0-9_-]). ' +
      'Generate one with: openssl rand -hex 20',
  );
  process.exit(1);
}

// A database name is an identifier, not a value, so it cannot be parameterised
// and is interpolated instead. Constrained to what an unquoted identifier may
// hold so the interpolation cannot become an injection.
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(portalDbName)) {
  console.error(`PORTAL_DATABASE_NAME ${JSON.stringify(portalDbName)} is not a plain lowercase identifier`);
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const sqlPath = path.resolve(here, '../sql/ghalla_ops_ro.sql');

const base = new URL(adminUrl);
const integrationDb = base.pathname.replace(/^\//, '');

/** Managed Postgres terminates TLS with a certificate nobody here pins. */
const ssl = /localhost|127\.0\.0\.1/.test(base.hostname) ? false : { rejectUnauthorized: false };

function clientFor(database) {
  const url = new URL(base.toString());
  url.pathname = `/${database}`;
  return new pg.Client({ connectionString: url.toString(), ssl });
}

async function withClient(database, fn) {
  const client = clientFor(database);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// ── 1. the portal's own database ───────────────────────────────────────────
//
// A separate DATABASE, and that is not a preference. Both migrators use
// Drizzle's default `drizzle.__drizzle_migrations` bookkeeping table, and the
// portal's journal timestamps are NEWER than the integration's. Point both at
// one database and the integration migrator concludes it is up to date, skips
// every one of its migrations, and reports success — a green deploy against a
// schema that was never created.
await withClient('postgres', async (client) => {
  const existing = await client.query('select 1 from pg_database where datname = $1', [portalDbName]);
  if (existing.rowCount > 0) {
    console.log(`database ${portalDbName} already exists — leaving it alone`);
    return;
  }
  // CREATE DATABASE cannot run inside a transaction block, which is why this
  // step is its own connection rather than part of the file below.
  await client.query(`CREATE DATABASE ${portalDbName}`);
  console.log(`created database ${portalDbName}`);
});

// -- 1b. an owner for the portal database that is NOT the superuser ---------
//
// Without this the portal runs holding the cluster SUPERUSER's credential,
// because a managed Postgres hands you exactly one role and every connection
// string is built from it. The read-only role then bounds what the portal READS
// WITH, while the process itself holds a credential that reaches the
// integration database by changing one field of a URL - the dbname. That makes
// "the portal cannot write to an integration database" false at the process
// level, which is the opposite of what this design claims.
//
// So the portal database gets its own login role, owns its own schema, and the
// superuser credential never enters the ops service's environment at all.
const ownerPassword = process.env.PORTAL_OWNER_PASSWORD;
if (!ownerPassword) {
  console.error('PORTAL_OWNER_PASSWORD is not set - the portal must not run as the cluster superuser');
  process.exit(1);
}
if (!/^[A-Za-z0-9_-]{24,}$/.test(ownerPassword)) {
  console.error('PORTAL_OWNER_PASSWORD must be at least 24 URL-safe characters ([A-Za-z0-9_-])');
  process.exit(1);
}

const OWNER_ROLE = 'ghalla_ops_app';

await withClient('postgres', async (client) => {
  const exists = await client.query('select 1 from pg_roles where rolname = $1', [OWNER_ROLE]);
  if (exists.rowCount === 0) await client.query(`CREATE ROLE ${OWNER_ROLE} LOGIN`);
  // Inlined rather than parameterised because ALTER ROLE ... PASSWORD takes no
  // parameter. Safe for the same reason as the read-only password: asserted
  // URL-safe above, so there is nothing to escape.
  await client.query(`ALTER ROLE ${OWNER_ROLE} WITH LOGIN PASSWORD '${ownerPassword}' CONNECTION LIMIT 10`);
  await client.query(`ALTER DATABASE ${portalDbName} OWNER TO ${OWNER_ROLE}`);
  // PUBLIC holds CONNECT and TEMP on a freshly created database. TEMP is a
  // WRITE capability and it survives default_transaction_read_only, so it is
  // the one write every role on this cluster could otherwise perform against
  // the portal's database. Nothing legitimate needs it.
  await client.query(`REVOKE TEMP, CONNECT ON DATABASE ${portalDbName} FROM PUBLIC`);
  await client.query(`GRANT ALL ON DATABASE ${portalDbName} TO ${OWNER_ROLE}`);
  console.log(`role ${OWNER_ROLE} owns database ${portalDbName}; PUBLIC revoked`);
});

// Objects created before the owner role existed still belong to whoever ran the
// migration. Reassigned explicitly, table by table, rather than with REASSIGN
// OWNED - which acts on everything the old owner holds in the database and is a
// blunt instrument to reach for while connected as a superuser.
await withClient(portalDbName, async (client) => {
  await client.query(`ALTER SCHEMA public OWNER TO ${OWNER_ROLE}`);
  const tables = await client.query(
    "select tablename from pg_tables where schemaname = 'public' and tableowner <> $1",
    [OWNER_ROLE],
  );
  for (const { tablename } of tables.rows) {
    await client.query(`ALTER TABLE public."${tablename}" OWNER TO ${OWNER_ROLE}`);
  }
  const drizzleSchema = await client.query("select 1 from pg_namespace where nspname = 'drizzle'");
  if (drizzleSchema.rowCount > 0) {
    await client.query(`ALTER SCHEMA drizzle OWNER TO ${OWNER_ROLE}`);
    const journal = await client.query(
      "select tablename from pg_tables where schemaname = 'drizzle' and tableowner <> $1",
      [OWNER_ROLE],
    );
    for (const { tablename } of journal.rows) {
      await client.query(`ALTER TABLE drizzle."${tablename}" OWNER TO ${OWNER_ROLE}`);
    }
  }
  console.log(`reassigned ${String(tables.rowCount)} public table(s) to ${OWNER_ROLE}`);
});


// ── 2. the read-only role, in the integration database ─────────────────────
const raw = fs.readFileSync(sqlPath, 'utf8');

const stripped = [];
const sql = raw
  .split('\n')
  .filter((line) => {
    // psql client meta-commands. Their behaviour is preserved, not discarded:
    // the \if guard that refuses to run without a password is the assertion
    // above, and \set ON_ERROR_STOP is the file's own BEGIN/COMMIT — an error
    // aborts the transaction, so the COMMIT rolls back.
    if (/^\s*\\(if|else|endif|echo|quit|set)\b/.test(line)) {
      stripped.push(line.trim());
      return false;
    }
    return true;
  })
  .join('\n')
  .replaceAll(":'ops_password'", `'${password}'`);

const unsubstituted = sql.match(/:'[a-z_]+'/g);
if (unsubstituted) {
  console.error(`unsubstituted psql variables remain: ${unsubstituted.join(', ')}`);
  process.exit(1);
}

console.log(`\napplying ${path.relative(process.cwd(), sqlPath)} to ${integrationDb}`);
console.log(`  (psql meta-commands handled by this runner: ${stripped.length})`);

const grants = await withClient(integrationDb, async (client) => {
  const result = await client.query(sql);
  const last = Array.isArray(result) ? result[result.length - 1] : result;
  return last.rows ?? [];
});

console.log('\ncolumn grants the role ended up with:');
for (const row of grants) console.log(`  ${row.table_name}: ${row.columns}`);

// ── 3. prove it from the OUTSIDE ───────────────────────────────────────────
//
// The SQL file asserts its own outcome, but it does so as the superuser that
// ran it. This connects AS ghalla_ops_ro, which is the only way to find out
// whether the credential actually works and whether the boundary holds for the
// role that will really be used.
const roleUrl = new URL(base.toString());
roleUrl.username = 'ghalla_ops_ro';
roleUrl.password = password;
roleUrl.pathname = `/${integrationDb}`;

const asRole = new pg.Client({ connectionString: roleUrl.toString(), ssl });
await asRole.connect();
try {
  const probe = await asRole.query(`
    select
      current_setting('default_transaction_read_only') as read_only,
      has_table_privilege(current_user, 'orders', 'INSERT') as can_insert_orders,
      has_table_privilege(current_user, 'platform_credentials', 'SELECT') as can_read_credentials
  `);
  console.log('\nprobe, connected as ghalla_ops_ro:');
  console.log(' ', JSON.stringify(probe.rows[0]));

  // The check the grant style does not obviously survive. `count(*)` names no
  // column, so Postgres requires a privilege on the TABLE — and this file
  // grants columns. Every aggregate the portal runs is a count, so if this
  // fails the console renders zeroes everywhere with no error to explain them.
  for (const table of ['stores', 'orders', 'webhook_events', 'daily_store_rollup']) {
    const counted = await asRole.query(`select count(*)::int as n from ${table}`);
    console.log(`  count(*) on ${table}: ${counted.rows[0].n}`);
  }

  const writable = await asRole
    .query('insert into stores (id) values (\'provision-probe\')')
    .then(() => true)
    .catch(() => false);
  if (writable) {
    console.error('\nFATAL: ghalla_ops_ro could INSERT into stores. The read-only boundary is not in place.');
    process.exitCode = 1;
  } else {
    console.log('  write refused, as it must be');
  }
} finally {
  await asRole.end();
}

const portalUrl = new URL(base.toString());
portalUrl.username = OWNER_ROLE;
portalUrl.password = ownerPassword;
portalUrl.pathname = `/${portalDbName}`;

console.log('\nprovisioning complete. Set these on the ops service:');
console.log(`  PORTAL_DATABASE_URL = ${portalUrl.toString()}`);
console.log(`  DATABASE_URL_<PLATFORM> = ${roleUrl.toString()}`);
console.log('\nNeither is the cluster superuser. Replace the host with the private');
console.log('domain if the service runs inside the same network.');
