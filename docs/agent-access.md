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
| Run SQL as the platform | `POST /api/projects/<slug>/sql` `{"sql":"select 1"}` |
| Create an end user in a project's Auth | `POST /api/projects/<slug>/auth/users` `{"email":"…","password":"…"}` |

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
