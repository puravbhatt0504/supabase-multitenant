#!/usr/bin/env python3
"""Repair the public URLs of projects that predate the shared gateway.

`SUPABASE_PUBLIC_URL` and `API_EXTERNAL_URL` were written as `http://localhost:<port>` when a project
was created, which is unreachable for anyone outside its own network — the value reaches Studio, the
edge functions and the links in Auth emails. Every project now gets `https://<GW_API_HOST>`.

Dry-run by default; `--apply` writes database and `.env` (through the panel container, because the
files under /data are root-owned).
"""
import argparse
import json
import re
import subprocess

PANEL_IMAGE = 'panel-fmhych'

KEYS = ('SUPABASE_PUBLIC_URL', 'API_EXTERNAL_URL')


def sh(cmd, timeout=120):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
    return (r.stdout + r.stderr).strip()


def panel_container():
    return sh("docker ps --format '{{.Names}}' | grep '^panel-fmhych' | head -1")


def projects():
    db = sh("docker ps --format '{{.Names}}' | grep -E '^db-fmhych' | head -1")
    panel = panel_container()
    user = sh(f"docker exec {panel} sh -c 'echo $DATABASE_URL'").split('://')[1].split(':')[0]
    rows = sh(
        f"docker exec {db} psql -U {user} -d supabase_multitenant -tAc "
        f"\"select slug from projects order by slug\""
    )
    return [r.strip() for r in rows.splitlines() if r.strip()], db, user


def env_of(slug, panel):
    out = sh(f"docker exec {panel} cat /data/projects/{slug}/docker/.env")
    env = {}
    for line in out.splitlines():
        if '=' in line and not line.strip().startswith('#'):
            k, v = line.split('=', 1)
            env.setdefault(k, v)
    return env


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true')
    args = ap.parse_args()

    panel = panel_container()
    slugs, db, user = projects()
    changed = 0

    for slug in slugs:
        env = env_of(slug, panel)
        api_host = env.get('GW_API_HOST')
        if not api_host:
            print(f'  {slug:<46} no GW_API_HOST (predates the shared plane) — skipped')
            continue

        wanted = f'https://{api_host}'
        stale = [k for k in KEYS if env.get(k) and env[k] != wanted and
                 re.search(r'localhost|127\.0\.0\.1|0\.0\.0\.0', env[k])]
        if not stale:
            print(f'  {slug:<46} already correct')
            continue

        print(f'  {slug:<46} {", ".join(stale)} -> {wanted}')
        if not args.apply:
            continue

        for key in stale:
            sh(f"docker exec {db} psql -U {user} -d supabase_multitenant -c "
               f"\"update project_env_vars set value = '{wanted}', \\\"updatedAt\\\" = now() "
               f"where key = '{key}' and \\\"projectId\\\" = (select id from projects where slug = '{slug}')\"")
            # The .env is what the running stack reads; rewrite the line in place.
            sh(f"docker exec {panel} sh -c \"cd /data/projects/{slug}/docker && "
               f"sed -i 's|^{key}=.*|{key}={wanted}|' .env\"")
        changed += 1

    print()
    if args.apply:
        print(f'  {changed} project(s) updated. Restart their stacks (or open Studio) to pick it up.')
    else:
        print('  dry run — nothing written. Re-run with --apply.')


if __name__ == '__main__':
    main()
