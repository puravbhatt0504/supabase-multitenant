# Testing the platform end to end, by hand

The automated version of this is `scripts/e2e-platform.py` (21 assertions, ~60 seconds, driven by the
superadmin token). This guide is the same journey through the **browser**, so you can see with your
own eyes what the platform does, in the order a customer would do it.

Use it after a change, or when a screen misbehaves and you need to know whether it is the platform or
the page you are looking at.

## Before you start

- **Panel:** https://fmhych0pt0irtksig4kciewg.213.47.80.26.sslip.io/auth/login
- **Account:** the platform owner (`webboxes.com@gmail.com`) — the password is in the pinned
  "Supabase Multitenant — test logins" message. Alice's account works for everything except the
  system view and is the better test: she is an ordinary organization admin.
- **If a page misbehaves, reload it once before reporting.** Studio keeps the state from the moment
  the page was loaded, so a page opened before a server-side fix can still show a spinner that no
  longer corresponds to anything. (A table that was in fact created is the usual example.)

## Part 1 — the panel (organizations and projects)

1. **Sign in.** You land on the dashboard.
2. Open **Organizations** in the sidebar, press **Create a new organization**, name it
   `test-<today>`. *Expect:* it appears in the list and you are its owner.
3. Open **Dashboard → Create New Project**, name it `manual-<today>`, pick the organization you just
   made, create it. *Expect:* you land on the project page already provisioned — a new project is
   born slim (database, auth, API) with its own two hosts assigned immediately, not after a manual
   step.
4. Press **Deploy** on the project page. *Expect:* running within a minute, with the Studio link and
   the API URL shown. Copy the API URL for Part 2.
5. Open the **Backups** tab and create one. *Expect:* a row with a filename and a size. Create a
   second one; older ones are pruned by retention.
6. Open **Configure**. Every host you see here must be a real public URL — `localhost` or
   `http://0.0.0.0` anywhere in this page is a bug worth reporting.
7. Leave the project in place; you delete it in Part 4.

## Part 2 — the project's own interface (Studio)

Open the **Studio link** from the project page. The panel session is the entry point, so Studio must
**not** ask you for a second login. If it does, or you see `RBAC: access denied`, that is a bug.

1. **Table Editor** (`/project/default/editor`) — the table list loads. If it shows "password
   authentication failed", the platform's database credential has drifted; report it.
2. Press **New table**, name it `things`, keep the default `id`, add a column `label` of type
   `text`, press **Save**. *Expect:* the table appears at once.
   *If Save refuses:* Studio marks a column that has **no type chosen** — a row beyond the two it
   offers you has to have both a name and a type, or delete that row with the ✗ beside it. The message
   it shows in that case ("Ensure that all your columns are named") points at the name, but a column
   with a name and an empty type fails the same check.
3. **SQL Editor** (`/project/default/sql`) — run:
   ```sql
   insert into things (label) values ('hello'), ('world');
   select * from things;
   ```
   *Expect:* two rows. If Save said the table already existed, it is there from an earlier attempt —
   `select * from things;` will show it, and `drop table things;` starts you clean.
4. **Authentication → Users** (`/project/default/auth/users`) — press **Add user**, create
   `manual-<today>@example.com`. *Expect:* it appears in the list.
5. **Storage** (`/project/default/storage/buckets`) — create a bucket, upload a small file.
   *Expect:* both listed. Storage is an on-demand service, so the first request can take a few
   seconds while it starts.
6. **Integrations** and **Advisors** — the pages that used to fail wholesale. Real data, no error
   banner.
7. **API docs** (`/project/default/api`) — the URL shown must be the public one
   (`https://<project>.<domain>`), never `http://localhost:…`.

## Part 3 — the data plane (the API other apps use)

With the API URL from Part 1 step 4 and the `anon` key from **Configure**:

```bash
API=https://<your project>.<domain>
ANON=<anon key>

curl -s "$API/auth/v1/health" -H "apikey: $ANON"          # 200 = auth is up
curl -s "$API/rest/v1/things?select=*" -H "apikey: $ANON" -H "Authorization: Bearer $ANON"
```

If you enabled Row Level Security on the table and wrote no policies, that last call returns an
**empty array**. That is correct Supabase behaviour, not a fault: RLS protects the data until a policy
allows it. The row count in the SQL editor is the proof the data is really there.

Then as an end user, still with the `anon` key:

```bash
curl -s -X POST "$API/auth/v1/token?grant_type=password" -H "apikey: $ANON" \
  -H 'Content-Type: application/json' \
  -d '{"email":"manual-<today>@example.com","password":"<the password you set>"}'
```

*Expect:* an `access_token`. That is the whole Auth path: a user created in Studio signing in through
the API.

## Part 4 — teardown, and confirming it really went

1. Open the project in the panel and press **Delete Project**, confirm.
2. *Expect:* it leaves the dashboard, and its hosts stop answering (the API host returns 502/404, not
   your data).
3. Delete the organization from **Organizations** — it refuses while it still holds projects, which is
   deliberate: one click must not destroy several databases.
4. On the box, confirm nothing was left behind:
   ```bash
   docker ps -a --format '{{.Names}}' | grep '<project slug>'                     # no output
   docker exec coolify-proxy sh -c 'ls /traefik/dynamic/ | grep "<project slug>"' # no output
   ```
   A leftover container or router file is a bug: the teardown is incomplete.

## What a passing run looks like, in numbers

The automated run prints a per-step timing and a metrics block at the end. A recent clean run:

```
21/21 steps passed  ·  wall clock 59s  ·  slowest step "deploys the project" (33s)
metrics: {"containers_running": 6, "containers_memory_mib": "405",
          "backup_file": "…_database_…Z.dump", "backup_bytes": 1775, "public_tables_at_backup": "1"}
```

Read it as a comparison against the previous run: the pass count should be all of them, so the signal
that matters is a step that got slower, a container count that moved (a project should be **6**:
db, auth, rest, studio, meta, imgproxy), or memory that jumped. Deploy and delete are the seconds;
everything else should be under a second.

```
python3 scripts/e2e-platform.py            # --keep leaves the project behind for inspection
```

## Reporting a failure usefully

Quote the failing step's name from the automated run, or the screen and the exact error text for the
manual path. "Nothing works" cannot be acted on; `Advisors → password authentication failed` can — and
that is the difference between a fix in minutes and a day of guessing.
