# Programmatic access: API tokens

A person uses the panel in a browser. An agent or a script has no browser, so it needs a credential
of its own — that is what an API token is. A token acts **as the platform**, with the rights of the
account that minted it, without carrying a password or a cookie.

## Creating one

Sign in to the panel (or send an existing `admin` token) and:

```bash
curl -sS -X POST https://<panel-host>/api/tokens \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer <your-token>" \
  -d '{"name":"coding-agent","scope":"admin"}'
```

The response contains `token` **once**. It is not stored in readable form anywhere — a lost token is
replaced, not recovered. Then use it on every call:

```bash
curl -sS https://<panel-host>/api/tokens -H "Authorization: Bearer smbt_..."
```

## Scopes

`read` < `write` < `admin`. `admin` is required for anything that reaches into a project's data
(SQL, user creation, credentials). A weaker token is refused with 403, not silently downgraded.

A token is **not** a frozen permission: the minting account's `users.role` is re-read on every
request, so demoting an account immediately disables the tokens it minted.

## Endpoints

| Purpose | Call |
| --- | --- |
| List your tokens (no secrets) | `GET /api/tokens` |
| Create a token | `POST /api/tokens` `{"name":"…","scope":"admin","expiresInDays":30}` |
| Revoke a token | `DELETE /api/tokens/<id>` |
| Everything a client needs for a project | `GET /api/projects/<slug>/credentials` |
| Run SQL as the platform | `POST /api/projects/<slug>/sql` `{"sql":"select 1","format":"unaligned"}` |
| Create an end user in a project's Auth | `POST /api/projects/<slug>/auth/users` `{"email":"…","password":"…"}` |
| Organizations (create, list, delete) | `POST`/`GET /api/platform/organizations`, `DELETE /api/platform/organizations/<id>` |
| Projects (create, list, get, delete) | `POST`/`GET /api/platform/projects`, `GET`/`DELETE /api/platform/projects/<id>` |
| Deploy a project | `POST /api/platform/projects/<id>/deploy` |
| Backups (create, list) | `POST`/`GET /api/platform/projects/<id>/backups` `{"kind":"database"}` |

`<slug>` and `<id>` are interchangeable everywhere: the path segment is looked up as a slug first,
then as an id. `format: "unaligned"` returns one value per line (`psql -tA`) — use it in scripts, so
you never have to parse a human-readable table (and never mistake its header row for the value).

## Verifying the platform after a change

```bash
python3 scripts/e2e-platform.py            # add --keep to leave the project for inspection
```

That is the whole lifecycle with nothing but a superadmin token: create an organization, create a
project inside it, deploy, create a table and write rows through SQL, read and write through the
REST API with the anon and service_role keys, create an end user and sign that user in for a real
access token, take a database backup, then delete the project and the organization — asserting every
step (21 of them), and cleaning up after itself if one fails. Run it after every deploy; it is the
difference between "the tests pass" and "the platform works".

`GET /credentials` returns the API URL with `anon`/`service_role` keys, the Studio URL, and the
database connection facts, so nothing has to be copied out of a container by hand. The database
address is the **in-network** one (`db:<port>`); the port is not published on the host, and the SQL
endpoint means most work does not need it:

```bash
docker run --rm --network <slug>_default postgres:16-alpine psql "postgresql://postgres:…@db:13120/supabase_multitenant"
```

Every SQL statement and user creation is written to the audit log with the token, the project and
the account behind it. An unreviewable path to arbitrary SQL is not a feature.

## Known gap

There is no panel page for tokens yet: mint the first one with a browser session against
`POST /api/tokens`, then use that token for everything else. A page under Settings is the next step.
