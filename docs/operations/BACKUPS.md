# Backups and recovery

The business data lives in one PostgreSQL database (Supabase). This guide says how it is copied, how a copy is proved good,
and how to recover. Read it before real data goes in.

## What protects you, in layers
1. **Supabase's own backups** (Pro plan: daily backups, optional point-in-time recovery). The free plan has none you can
   rely on. Upgrade before real data. These also cover the sign-in accounts (staff and shoppers), which Mudatex's own copy
   below does not.
2. **Mudatex's nightly copy** (this guide): an encrypted dump of all Mudatex data, kept 30 days in GitHub, restored every
   night into an empty database and checked. It works on any plan and does not depend on Supabase being reachable when you
   need it. Worst case you lose up to a day of work (RPO about 24 hours); with Supabase point-in-time recovery it is minutes.
3. **Your own periodic copy**: once a month download the newest backup from GitHub and keep it somewhere that is not GitHub
   or Supabase (an office computer, a cloud drive). Keep the passphrase separately, also off GitHub.

## Turning the nightly copy on (once)
In the GitHub repository: *Settings → Secrets and variables → Actions → New repository secret*:
- `BACKUP_DATABASE_URL`: the database's **direct** connection string from Supabase (*Connect → Direct connection*, or the
  *session pooler* on port 5432). Not the transaction pooler (port 6543): it cannot take a dump. Use a dedicated
  read-only database user if you can; the dump needs only to read.
- `BACKUP_PASSPHRASE`: a long random passphrase (for example 6 random words). **Write it down somewhere safe outside
  GitHub.** Without it no backup can ever be opened.

Then *Actions → Nightly backup → Run workflow* once to see it work. It runs at about 02:17 UTC every night after that.
Keep the repository **private**: the backups are encrypted, but there is no reason to show them to anyone.

## How a copy is proved good
Each night, right after the dump, the workflow restores it into an empty scratch database and runs the checker
(`apps/api/src/backup-verify.ts`). It fails, and GitHub emails the repository owner, if:
- the file will not open or its checksum is wrong;
- the structure differs from what the code expects;
- a posted journal entry does not balance;
- any stock balance is negative or over-reserved;
- what an online order has paid disagrees with its recorded payments.

On every code change the same backup-and-restore runs against the test database, so the scripts themselves cannot rot.

## Recovering
Decide first what happened:
- **A mistake in the data** (wrong bulk change, deleted by accident): prefer Supabase point-in-time recovery to a moment
  just before. If you must use the nightly copy, restore it into a *new* scratch database and copy back only what is needed.
- **The database is gone or corrupted:**
  1. Create a new Supabase project (or empty PostgreSQL 15 or newer) and note its direct connection string.
  2. Download the newest `mudatex-backup` from the last green *Nightly backup* run (*Actions → the run → Artifacts*) and
     unzip it.
  3. On a computer with PostgreSQL client tools and this repository: from `apps/api`, run `npm ci && npm run build`, then
     `SCRATCH_DATABASE_URL=<new database> BACKUP_PASSPHRASE=<passphrase> scripts/restore-check.sh mudatex-….dump.gpg`.
     This restores and checks it. (It wipes the target's `public` schema first, which is what you want for a new, empty database.)
  4. Point the API's `DATABASE_URL` at the new database and redeploy. Run the migrations (they apply on release) so the
     schema is current.
  5. Staff and shopper **sign-in accounts live in Supabase Auth, not in the dump.** In a new project they must be re-created
     or re-invited, and each person's `external_subject` in Mudatex re-linked. This is a reason to prefer restoring the
     *same* Supabase project (layer 1) whenever it still exists.
  6. Run the pilot checks in `GO_LIVE.md` (sign in, place an order, ring up a sale).

## Practise it
Once a quarter, do the recovery steps above into a throwaway project, with someone other than the person who set it up. Write down how
long it took (that is your real recovery time) and what was unclear, and fix the guide.

## What this does not cover
- Product photos and other files in storage (if they are added later, they need their own copy).
- Supabase Auth accounts (layer 1 covers them).
- Point-in-time recovery: only Supabase's Pro plan offers it.
