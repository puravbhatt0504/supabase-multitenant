#!/usr/bin/env python3
"""Put existing projects onto the shared gateway: give them a slot and their hosts.

Why this exists
---------------
The gateway's config is *derived*: every tenant is rebuilt from the projects' stored
env, and a project without `GATEWAY_SLOT` is skipped on purpose (guessing a slot would
put two tenants on one listener, which answers one project's host with another
project's data). Projects created before the shared plane therefore have to be adopted
deliberately — otherwise the first gateway rewrite silently drops them and their hosts
start refusing connections.

Where the numbers come from
---------------------------
Not from this script's imagination: each project's slot is read back out of the router
file that is serving it today (`http://10.0.2.1:11130` -> slot 0), so the adoption
follows live traffic and cannot disagree with it.

Usage
-----
    scripts/backfill-gateway-slots.py                     # dry run, changes nothing
    scripts/backfill-gateway-slots.py --apply             # write env (database + .env)

Idempotent: a project that already has a slot is reported and left alone.
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys

PROXY_CONTAINER = 'coolify-proxy'
PROXY_DYNAMIC_DIR = '/traefik/dynamic'
DB_PREFIX = 'db-'
PANEL_PREFIX = 'panel-'
DATABASE = 'supabase_multitenant'

LISTENER_PORT_BASE = 8100
PUBLISHED_PORT_BASE = 11130
MAX_SLOTS = 20

RULE_RE = re.compile(r'rule:\s*Host\(`([^`]+)`\)')
TARGET_RE = re.compile(r'10\.0\.2\.1:(\d+)')
SLUG_TIMESTAMP_RE = re.compile(r'-\d+$')


def run(cmd: str) -> str:
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if result.returncode != 0:
        print(f'  ! {cmd}\n    {result.stderr.strip()}', file=sys.stderr)
    return result.stdout


def container_matching(prefix: str) -> str | None:
    for name in run("docker ps --format '{{.Names}}'").split():
        if name.startswith(prefix):
            return name
    return None


def api_host_for(slug: str, base_domain: str) -> str:
    return f'{SLUG_TIMESTAMP_RE.sub("", slug)}.{base_domain}'


def studio_host_for(slug: str, base_domain: str) -> str:
    return f'{slug}-studio.{base_domain}'


def live_tenants() -> dict[str, dict]:
    """api host -> {published_port, studio_host} from the router files in front of us."""
    script = (
        'for f in %s/*.yaml %s/*.yml; do [ -f "$f" ] || continue; echo "== $f"; cat "$f"; done'
        % (PROXY_DYNAMIC_DIR, PROXY_DYNAMIC_DIR)
    )
    output = run(f'docker exec {PROXY_CONTAINER} sh -c {_quote(script)}')

    tenants: dict[str, dict] = {}
    for block in output.split('== ')[1:]:
        lines = block.splitlines()
        header, body = lines[0], '\n'.join(lines[1:])
        targets = TARGET_RE.findall(body)
        if not targets:
            continue  # e.g. the host-IP route: not a tenant

        hosts = RULE_RE.findall(body)
        studio = [h for h in hosts if h.endswith('-studio.') or '-studio.' in h]
        api = [h for h in hosts if h not in studio]
        if not api:
            continue

        api_host = api[0]
        # Two router files can describe the same tenant (a hand cut-over left a pair);
        # the port must agree, and a disagreement is worth stopping for.
        if api_host in tenants and tenants[api_host]['published_port'] != int(targets[0]):
            raise SystemExit(
                f'Conflicting published ports for {api_host}: '
                f'{tenants[api_host]["published_port"]} vs {targets[0]}'
            )
        tenants[api_host] = {
            'published_port': int(targets[0]),
            'router_files': [header],
            'studio_host': studio[0] if studio else None,
        }
    return tenants


def _quote(value: str) -> str:
    return "'" + value.replace("'", "'\\''") + "'"


def psql(sql: str) -> list[list[str]]:
    db = container_matching(DB_PREFIX)
    panel = container_matching(PANEL_PREFIX)
    if not db or not panel:
        raise SystemExit('Could not find the panel/database container')
    user = run(f"docker exec {panel} sh -c 'echo $DATABASE_URL'").strip()
    match = re.match(r'postgres(?:ql)?://([^:]+):', user)
    if not match:
        raise SystemExit('Could not read the database user from the panel environment')
    user = match.group(1)

    output = run(
        f'docker exec {db} psql -U {user} -d {DATABASE} -t -A -F"|" -c {_quote(sql)}'
    )
    return [line.split('|') for line in output.strip().splitlines() if line.strip()]


def base_domain_of(hostname: str) -> str:
    return hostname.split('.', 1)[1]


def read_env_file(path: str) -> dict[str, str]:
    """Read a project's .env through the panel container.

    The files are owned by root inside the panel's `/data`; on the host this script runs
    as an ordinary user and cannot open them, so every read and write goes through the
    container that owns them.
    """
    panel = container_matching(PANEL_PREFIX)
    if not panel:
        raise SystemExit('Could not find the panel container')
    output = run(f'docker exec {panel} cat {path}')
    values: dict[str, str] = {}
    for line in output.splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            values[key.strip()] = value
    return values


def write_env_file(path: str, lines: list[str]) -> None:
    panel = container_matching(PANEL_PREFIX)
    if not panel:
        raise SystemExit('Could not find the panel container')
    content = '\n'.join(lines) + '\n'
    result = subprocess.run(
        ['docker', 'exec', '-i', panel, 'sh', '-c', f'cat > {path}'],
        input=content,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise SystemExit(f'Could not write {path}: {result.stderr.strip()}')


def merge_env_lines(lines: list[str], additions: dict[str, str]) -> tuple[list[str], list[str]]:
    """Replace the keys that exist, append the ones that do not. Returns lines + changed keys."""
    changed: list[str] = []
    seen: set[str] = set()
    for index, line in enumerate(lines):
        if '=' not in line or line.lstrip().startswith('#'):
            continue
        key = line.split('=', 1)[0].strip()
        if key in additions:
            seen.add(key)
            new_line = f'{key}={additions[key]}'
            if new_line != line:
                lines[index] = new_line
                changed.append(key)

    for key, value in additions.items():
        if key not in seen:
            lines.append(f'{key}={value}')
            changed.append(key)
    return lines, changed


def env_file_text(path: str) -> list[str]:
    panel = container_matching(PANEL_PREFIX)
    if not panel:
        raise SystemExit('Could not find the panel container')
    return run(f'docker exec {panel} cat {path}').splitlines()


def upsert_env(project_id: str, key: str, value: str, dry_run: bool) -> None:
    sql = (
        'insert into project_env_vars (id, "projectId", key, value, "createdAt", "updatedAt") '
        f"select gen_random_uuid()::text, '{project_id}', '{key}', '{value}', now(), now() "
        f"where not exists (select 1 from project_env_vars where \"projectId\" = '{project_id}' "
        f"and key = '{key}')"
    )
    if dry_run:
        return
    psql(sql)
    psql(
        'update project_env_vars set value = %s, "updatedAt" = now() '
        'where "projectId" = %s and key = %s'
        % (_quote(value), _quote(project_id), _quote(key))
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='write the changes (default: dry run)')
    parser.add_argument(
        '--projects-dir',
        default='/data/projects',
        help='host directory holding one folder per project',
    )
    args = parser.parse_args()
    dry_run = not args.apply

    tenants = live_tenants()
    if not tenants:
        raise SystemExit('No tenant routers found — is the proxy reachable?')

    base_domain = base_domain_of(next(iter(tenants)))
    projects = psql('select id, slug from projects order by "createdAt"')
    by_host = {api_host_for(slug, base_domain): (project_id, slug) for project_id, slug in projects}

    print(f'Platform domain: {base_domain}')
    print(f'Live tenants ({len(tenants)}):')
    for host, info in sorted(tenants.items()):
        print(f'  {host:<52} -> 10.0.2.1:{info["published_port"]}')

    adopted, already, unmatched = [], [], []
    plan: list[tuple[str, str, int, dict[str, str]]] = []

    for host, info in sorted(tenants.items()):
        entry = by_host.get(host)
        if not entry:
            unmatched.append(host)
            continue
        project_id, slug = entry
        slot = info['published_port'] - PUBLISHED_PORT_BASE
        if not 0 <= slot < MAX_SLOTS:
            unmatched.append(f'{host} (port {info["published_port"]} is not a tenant slot)')
            continue

        current = psql(
            'select coalesce((select value from project_env_vars where "projectId" = %s '
            "and key = 'GATEWAY_SLOT'), '')" % _quote(project_id)
        )
        additions = {
            'GATEWAY_SLOT': str(slot),
            'GATEWAY_LISTENER_PORT': str(LISTENER_PORT_BASE + slot),
            'GATEWAY_PUBLISHED_PORT': str(info['published_port']),
            'GW_API_HOST': host,
            'GW_STUDIO_HOST': info['studio_host'] or studio_host_for(slug, base_domain),
        }

        # Idempotent means "database *and* .env agree", not "the database was written":
        # a run interrupted between the two would otherwise leave the .env stale forever.
        env_path = f'{args.projects_dir}/{slug}/docker/.env'
        env_values = read_env_file(env_path)
        env_complete = all(env_values.get(key) == value for key, value in additions.items())
        db_agrees = bool(current and current[0] and current[0][0] == str(slot))

        if db_agrees and env_complete:
            already.append(slug)
            continue

        plan.append((project_id, slug, slot, additions))
        adopted.append((slug, slot, additions['GW_STUDIO_HOST']))

    print('\nPlan:')
    for slug, slot, studio in adopted:
        print(f'  adopt {slug}  -> slot {slot}  (studio: {studio})')
    for slug in already:
        print(f'  skip  {slug}  -> already has its slot')
    for host in unmatched:
        print(f'  ?     {host}  -> no project row matches (left alone)')
    for project_id, slug in projects:
        if api_host_for(slug, base_domain) not in tenants:
            print(f'  -     {slug}  -> no live router (cannot be adopted, left alone)')

    if dry_run:
        print('\nDry run: nothing written. Re-run with --apply.')
        return 0

    print('\nApplying:')
    for project_id, slug, slot, additions in plan:
        for key, value in additions.items():
            upsert_env(project_id, key, value, dry_run=False)
        env_path = f'{args.projects_dir}/{slug}/docker/.env'
        lines, changed = merge_env_lines(env_file_text(env_path), additions)
        write_env_file(env_path, lines)
        print(
            f'  {slug}: slot {slot}; database keys written; '
            f'.env updated ({", ".join(changed) or "no change"})'
        )

    print('\nDone. The gateway rewrite (`POST /api/gateway/sync`) will now include these projects.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
