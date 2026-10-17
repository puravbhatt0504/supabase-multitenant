#!/usr/bin/env python3
"""End-to-end integration test for the whole platform, driven only by a superadmin access token.

This is the answer to "does it still work after the last change": it creates an organization, a
project inside it, brings the project up, uses the database (tables, rows), the API keys, Auth (a
real end user signing in), takes a backup, then deletes the project and the organization — and
asserts each step, with the cleanup it can do itself if something fails halfway.

Run it after every deploy:

    python3 scripts/e2e-platform.py                  # full run, cleans up after itself
    python3 scripts/e2e-platform.py --keep           # leave the project behind for inspection
    python3 scripts/e2e-platform.py --panel https://… --token smbt_…

The token is read from --token, then $PLATFORM_API_TOKEN, then /home/z370n/.secure-upload/platform-api-token.txt.
"""
import argparse
import json
import os
import re
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request

DEFAULT_PANEL = 'https://fmhych0pt0irtksig4kciewg.213.47.80.26.sslip.io'
TOKEN_FILE = '/home/z370n/.secure-upload/platform-api-token.txt'

steps: list[tuple[str, bool, str, float]] = []
context: dict[str, str] = {}
metrics: dict[str, object] = {}
_last = [time.monotonic()]


def record(name: str, ok: bool, detail: str = '') -> bool:
    now = time.monotonic()
    elapsed = now - _last[0]
    steps.append((name, ok, detail, elapsed))
    _last[0] = now
    print(f'  [{"PASS" if ok else "FAIL"}] {name} ({elapsed:.1f}s)'
          + (f' — {detail}' if detail else ''))
    return ok


def call(panel, method, path, token, body=None, timeout=180):
    data = json.dumps(body).encode() if body is not None else None
    headers = {'Authorization': f'Bearer {token}'}
    if data:
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(panel + path, data=data, method=method, headers=headers)
    ctx = ssl._create_unverified_context()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw.strip().startswith(('{', '[')) else raw)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw
    except Exception as e:
        return 0, f'{type(e).__name__}: {e}'


def public_call(method, url, body=None, headers=None, timeout=60, follow=True):
    data = json.dumps(body).encode() if body is not None else None
    hdrs = dict(headers or {})
    if data:
        hdrs['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
    ctx = ssl._create_unverified_context()
    opener = urllib.request.build_opener(
        urllib.request.HTTPSHandler(context=ctx),
        *([] if follow else [NoRedirect()]),
    )
    try:
        with opener.open(req, timeout=timeout) as r:
            raw = r.read().decode()
            try:
                return r.status, json.loads(raw)
            except Exception:
                return r.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw
    except Exception as e:
        return 0, f'{type(e).__name__}: {e}'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def sh(cmd, timeout=120):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
    return (r.stdout + r.stderr).strip()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--panel', default=DEFAULT_PANEL)
    ap.add_argument('--token', default=None)
    ap.add_argument('--keep', action='store_true', help='leave the project behind for inspection')
    ap.add_argument('--name', default=None, help='project name (default: e2e-<timestamp>)')
    args = ap.parse_args()

    token = args.token or os.environ.get('PLATFORM_API_TOKEN')
    if not token:
        try:
            with open(TOKEN_FILE) as fh:
                token = [l.split(': ', 1)[1].strip() for l in fh if l.startswith('# token:')][0]
        except Exception:
            print(f'No token: pass --token, set $PLATFORM_API_TOKEN, or write {TOKEN_FILE}')
            return 2

    stamp = time.strftime('%y%m%d%H%M%S')
    project_name = args.name or f'e2e-{stamp}'
    org_name = f'e2e-org-{stamp}'
    print(f'=== end-to-end run: project "{project_name}", organization "{org_name}" ===\n')

    project_id = project_slug = org_id = None

    try:
        # 1. the token itself
        status, body = call(args.panel, 'GET', '/api/platform/organizations', token)
        record('token is accepted by the platform API', status == 200, f'HTTP {status}')
        if status != 200:
            return finish(1)

        # 2. organization
        status, body = call(args.panel, 'POST', '/api/platform/organizations', token,
                            {'name': org_name, 'type': 'Team', 'plan': 'Pro'})
        ok = status == 201 and isinstance(body, dict) and body.get('organization', {}).get('id')
        record('creates an organization', bool(ok), f'HTTP {status}')
        if not ok:
            return finish(1)
        org_id = body['organization']['id']
        context['organization'] = body['organization']['slug']

        # 3. project inside it
        status, body = call(args.panel, 'POST', '/api/platform/projects', token,
                            {'name': project_name, 'organizationId': org_id})
        ok = status == 201 and isinstance(body, dict) and body.get('project', {}).get('id')
        record('creates a project inside that organization', bool(ok), f'HTTP {status}')
        if not ok:
            return finish(1)
        project_id = body['project']['id']
        project_slug = body['project']['slug']
        context['project'] = project_slug

        # 4. deploy, then wait for the project's own API to answer
        status, body = call(args.panel, 'POST', f'/api/platform/projects/{project_id}/deploy', token,
                            timeout=600)
        record('deploys the project', status == 200, f'HTTP {status}')
        if status != 200:
            return finish(1)

        status, creds = call(args.panel, 'GET', f'/api/projects/{project_id}/credentials', token)
        ok = status == 200 and isinstance(creds, dict)
        record('reads its credentials (API url, keys, database)', bool(ok), f'HTTP {status}')
        if not ok:
            return finish(1)

        # Metrics: what this run actually materialised.
        containers = sh(f"docker ps --format '{{{{.Names}}}}' | grep -c '^{project_slug}-' || true")
        rss = sh(f"docker stats --no-stream --format '{{{{.MemUsage}}}}' "
                 f"$(docker ps --format '{{{{.Names}}}}' | grep '^{project_slug}-' | tr '\n' ' ') 2>/dev/null "
                 f"| awk -F'/' '{{gsub(/[^0-9.]/,\"\",$1); s+=$1}} END {{printf \"%.0f\", s}}'")
        metrics['containers_running'] = int(containers) if containers.isdigit() else containers
        metrics['containers_memory_mib'] = rss

        api_url = creds['api']['url']
        anon = creds['api']['anonKey']
        service = creds['api']['serviceRoleKey']
        context['api'] = api_url

        health = 0
        for _ in range(40):
            health, _b = public_call('GET', f'{api_url}/auth/v1/health',
                                     headers={'apikey': anon, 'Authorization': f'Bearer {anon}'})
            if health in (200, 401):
                break
            time.sleep(6)
        record('the project answers on its own host', health in (200, 401), f'HTTP {health}')

        # 5. database: schema and rows, through the platform SQL endpoint
        create_sql = (
            'create table if not exists e2e_items '
            '(id bigint generated by default as identity primary key, label text not null);'
            "insert into e2e_items (label) values ('first');"
            "notify pgrst, 'reload schema';"
        )
        status, body = call(args.panel, 'POST', f'/api/projects/{project_id}/sql',
                            token, {'sql': create_sql}, timeout=180)
        record('creates a table and writes a row (CREATE TABLE, INSERT)',
               status == 200 and isinstance(body, dict) and body.get('ok'), f'HTTP {status}')

        def count_rows(label: str) -> int | None:
            status, body = call(args.panel, 'POST', f'/api/projects/{project_id}/sql', token,
                                {'sql': 'select count(*) from e2e_items', 'format': 'unaligned'})
            if status != 200 or not isinstance(body, dict):
                return None
            text = (body.get('stdout') or '').strip()
            match = re.match(r'^(\d+)$', text)
            return int(match.group(1)) if match else None

        rows = count_rows('select')
        record('reads the row back (SELECT)', rows == 1, f'rows={rows}')

        # 6. API keys on the data plane: anon for reading, service_role for privileged work
        status, body = public_call('GET', f'{api_url}/rest/v1/e2e_items?select=id,label',
                                   headers={'apikey': anon, 'Authorization': f'Bearer {anon}'})
        record('the anon API key reads through the REST API',
               status == 200 and isinstance(body, list) and len(body) == 1, f'HTTP {status}')

        status, body = public_call('POST', f'{api_url}/rest/v1/e2e_items',
                                   {'label': 'written by the service role'},
                                   headers={'apikey': service, 'Authorization': f'Bearer {service}',
                                            'Prefer': 'return=representation'})
        record('the service_role API key writes through the REST API',
               status in (200, 201) and isinstance(body, list) and len(body) == 1, f'HTTP {status}')

        count = count_rows('after write')
        record('the write is visible in the database', count == 2, f'rows={count}')

        # 7. Auth: a real end user, created by the platform and signing in on its own
        email = f'e2e-user-{stamp}@example.com'
        password = 'E2E-Test-Password-2026x'
        status, body = call(args.panel, 'POST', f'/api/projects/{project_id}/auth/users', token,
                            {'email': email, 'password': password, 'emailConfirm': True})
        record('creates an end user in the project Auth', status == 201, f'HTTP {status}')

        status, body = public_call('POST', f'{api_url}/auth/v1/token?grant_type=password',
                                   {'email': email, 'password': password},
                                   headers={'apikey': anon})
        access_token = body.get('access_token') if isinstance(body, dict) else None
        record('the end user signs in and gets a token', status == 200 and bool(access_token),
               f'HTTP {status}')

        if access_token:
            status, who = public_call('GET', f'{api_url}/auth/v1/user',
                                      headers={'apikey': anon,
                                               'Authorization': f'Bearer {access_token}'})
            record('the end user token identifies that user',
                   status == 200 and isinstance(who, dict) and who.get('email') == email,
                   f'HTTP {status}')

        # 8. backup
        status, body = call(args.panel, 'POST', f'/api/platform/projects/{project_id}/backups',
                            token, {'kind': 'database'}, timeout=600)
        ok = status == 201 and isinstance(body, dict) and body.get('backup')
        record('takes a database backup', bool(ok), f'HTTP {status}')
        backup_name = body.get('backup', {}).get('fileName') if isinstance(body, dict) else None
        if isinstance(body, dict) and isinstance(body.get('backup'), dict):
            metrics['backup_file'] = body['backup'].get('fileName') or body['backup'].get('id')
            metrics['backup_bytes'] = body['backup'].get('sizeBytes') or body['backup'].get('size')
        db_tables = sh(f"docker exec {project_slug}-db psql -U supabase_admin -d supabase_multitenant "
                       f"-tAc \"select count(*) from pg_tables where schemaname='public'\"")
        metrics['public_tables_at_backup'] = db_tables
        # A dump can be valid, non-empty and still contain nothing: the backup once read the wrong
        # database and reported success. Open the artifact and require the table we wrote.
        if ok and backup_name:
            contents = sh(f"docker exec -i {project_slug}-db pg_restore -l < /data/backups/{project_slug}/{backup_name}")
            record('the backup contains the table the test wrote',
                   'TABLE public e2e_items' in contents, f'{len(contents.splitlines())} toc lines')
        if ok:
            status, listing = call(args.panel, 'GET', f'/api/platform/projects/{project_id}/backups', token)
            record('the backup is listed for the project',
                   status == 200 and len(listing.get('backups', [])) >= 1, f'HTTP {status}')

        # 9. teardown: the project, then the organization
        if args.keep:
            print(f'\n  --keep: leaving {project_slug} and {context.get("organization")} in place')
            record('teardown skipped (--keep)', True)
        else:
            status, body = call(args.panel, 'DELETE', f'/api/platform/projects/{project_id}', token,
                                timeout=600)
            record('deletes the project', status == 200 and body.get('deleted'), f'HTTP {status}')

            gone_containers = sh(f"docker ps -a --format '{{{{.Names}}}}' | grep -c '^{project_slug}-' || true")
            record('its containers are gone', gone_containers.strip() in ('0', ''), f'found {gone_containers}')

            router = sh("docker exec coolify-proxy sh -c "
                        f"'ls /traefik/dynamic/ 2>/dev/null | grep -c {project_slug} || true'")
            record('its router file is gone', router.strip() in ('0', ''), f'found {router}')

            status, _body = call(args.panel, 'GET', f'/api/platform/projects/{project_id}', token)
            record('the project no longer exists', status == 404, f'HTTP {status}')

            status, body = call(args.panel, 'DELETE', f'/api/platform/organizations/{org_id}', token)
            record('deletes the organization', status == 200 and body.get('deleted'), f'HTTP {status}')

    except Exception as error:  # noqa: BLE001 - the point is to report, not to hide
        record('run completed without an unexpected exception', False, f'{type(error).__name__}: {error}')
    finally:
        if not args.keep and project_id:
            # Best effort: never leave a running tenant behind because a check failed earlier.
            if not any('deletes the project' in n and ok for n, ok, _detail, _secs in steps):
                call(args.panel, 'DELETE', f'/api/platform/projects/{project_id}', token, timeout=600)
                print('\n  (cleanup) removed the project after the failure')

    return finish(0 if all(ok for _n, ok, _d, _s in steps) else 1)


def finish(code: int) -> int:
    print('\n=== summary ===')
    for name, ok, detail, secs in steps:
        print(f'  {"PASS" if ok else "FAIL"}  {name:<58} {secs:6.1f}s'
              + (f'  [{detail}]' if detail and not ok else ''))
    passed = sum(1 for _n, ok, _d, _s in steps if ok)
    total = sum(secs for *_r, secs in steps)
    slowest = max(steps, key=lambda s: s[3]) if steps else ('', True, '', 0.0)
    print(f'\n  {passed}/{len(steps)} steps passed  ·  wall clock {total:.0f}s'
          f'  ·  slowest step "{slowest[0]}" ({slowest[3]:.0f}s)')
    if metrics:
        print('  metrics: ' + json.dumps(metrics))
    if context:
        print('  artifacts: ' + json.dumps(context))
    return code


if __name__ == '__main__':
    sys.exit(main())
