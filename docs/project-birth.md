# How a project is born

A project created through the panel is born **slim, routed and registered** — the three
steps that used to be done by hand (and therefore were not done at all). This file is the
contract; the code is `src/lib/tenant-provisioning.ts`, `src/lib/slim-compose.ts` and the
`createProject` / `deployProject` / `deleteProject` paths in `src/lib/project.ts`.

## 1. A slot on the shared gateway

Every project owns one **listener** on the single shared envoy (`smbt-shared-gateway`):

```
slot N  ->  listener 8100+N (in the gateway)  ->  published 11130+N (on the host)  ->  Traefik target 10.0.2.1:11130+N
```

- Allocated **lowest-free** (`allocateTenantSlot`), so deleting and re-creating projects
  does not walk the range upwards until it runs out. Ceiling: `MAX_TENANTS = 20`.
- Persisted in the project's own env as `GATEWAY_SLOT`, because the gateway config is
  **derived from the database**: a project without a slot is *skipped and reported*, never
  defaulted. Two tenants on one listener would answer one project's host with another
  project's data, so "no slot" is a loud state, not a guess.

## 2. The env a project needs to be reachable

Written into `docker/.env` and stored in `project_env_vars`:

| key | meaning |
|---|---|
| `GATEWAY_SLOT` | the slot above; the gateway writer reads this |
| `GATEWAY_LISTENER_PORT` | `8100 + slot`, what the tenant's own services call as `http://<slug>-gw:<port>` |
| `GATEWAY_PUBLISHED_PORT` | `11130 + slot`, what Traefik targets |
| `GW_API_HOST` | `<slug-without-trailing-timestamp>.<platform domain>` |
| `GW_STUDIO_HOST` | `<slug>-studio.<platform domain>` — the host the dashboard links to |
| `API_EXTERNAL_URL`, `SUPABASE_PUBLIC_URL` | `https://<GW_API_HOST>` — what auth emails and Studio's snippets hand to clients |
| `SITE_URL`, `ADDITIONAL_REDIRECT_URLS` | the Studio host and both hosts, so auth redirects are allowed on them |

The public URLs matter as much as the slot: with the upstream `localhost` defaults a
project's confirmation emails and its Studio's API snippets point at a host only the server
can see.

## 3. The service set

`slimProjectCompose()` turns the eleven-service upstream template into what a project
actually needs:

- **kept:** `db`, `auth`, `rest` — plus `studio`, `meta`, `imgproxy`, which are named in
  `RETAINED_SHARED_SERVICES` because they belong on the shared plane but are not hoisted
  yet. Removing a name from that list is how a service gets hoisted; it is a deliberate
  edit, not a per-project difference.
- **removed:** `api-gw` (replaced by the shared gateway), `supavisor` (nothing refers to
  it), and the opt-in trio `realtime`, `storage`, `functions`.
- **repointed:** internal `http://api-gw:8000` calls become
  `http://<slug>-gw:<GATEWAY_LISTENER_PORT>`.

The generator refuses to emit a compose that strands a kept service (e.g. `storage` without
`imgproxy`), loses a kept service, or drops the `volumes:` trailer.

## 4. The router file

Written at creation into the directory the proxy reads
(`getTraefikDynamicPath()`), one file per project (`<slug>.yml`):

- `<GW_API_HOST>` → the tenant's listener (`http://10.0.2.1:<published port>`),
- `<GW_STUDIO_HOST>` → the panel with `X-Studio-Gateway: /gateway/studio/<slug>`, which
  the panel's middleware rewrites; a header rather than `addPrefix`, because the panel
  normalises the trailing slash and the browser would loop.

Projects cut over by hand have a router file under the old name (`<GW_API_HOST>.yaml`).
Writing the file the panel owns **removes that one**: two files describing the same `Host`
is a duplicate-router conflict, so the next deploy of an old project migrates it.

## 5. Registration (after the containers exist)

`deployProject()` finishes by calling `registerTenantOnGateway(slug)`, which

1. joins the gateway to the project's compose network (`docker network connect --alias
   <slug>-gw`), so the gateway can reach the tenant and the tenant can reach the gateway,
2. rewrites **all** clusters and listeners from the database (`writeGatewayConfig`),
3. reloads envoy (`docker restart smbt-shared-gateway`).

The order is load-bearing: the network the gateway joins is created by `compose up`, and a
gateway failure is a warning, not a failed deploy — the stack is up and re-deploying
retries the step.

`deleteProject()` reverses it: the router file is removed with the other Traefik cleanup,
and `unregisterTenantFromGateway()` runs **after** the project row is deleted, because the
rewrite is derived from the database and a still-present row would put the tenant straight
back into the config.

## 6. Repairing the plane

`POST /api/gateway/sync` (system administrators only; everyone else gets a 404) re-derives
everything: every tenant's router file, every network join, the envoy config, the reload.
It reports projects without a slot instead of inventing one. Use it after a machine
restart, after a manual docker change, or when a host stops answering.

## 7. Adopting projects that predate the shared plane

```bash
python3 scripts/backfill-gateway-slots.py            # dry run: print the plan
python3 scripts/backfill-gateway-slots.py --apply    # write the database rows and .env
```

Each project's slot is read back out of the router file that is serving it today
(`10.0.2.1:11130` → slot 0), so adoption follows live traffic rather than a guess. Projects
with no live router are listed and left alone. Until a project is adopted it is skipped by
every gateway rewrite — which is why this runs **before** the rewrite is relied on.

Both the database and the `.env` are written; the script is idempotent (it treats "database
agrees *and* `.env` agrees" as done). Reads and writes go through the panel container: the
files live under the panel's root-owned `/data` and the host user cannot open them.

## 8. Deployment setting: where the proxy reads routers

The panel and the proxy are separate containers, so the panel must write where the proxy
looks:

```
TRAEFIK_DYNAMIC_PATH=/data/coolify/proxy/dynamic
```

(that directory is the proxy's mounted `/traefik/dynamic`; both containers bind the same
`/data`). Without it the panel writes into its own container and every new project's host
silently 404s — which is exactly the symptom that started this work.
