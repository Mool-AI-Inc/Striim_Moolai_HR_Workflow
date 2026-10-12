"""
Deploy and drive the two Instant Teams Striim applications.

The TQL on disk is a TEMPLATE with __PLACEHOLDERS__. Credentials are substituted in
memory at deploy time and never written to a file, because the rendered TQL contains
the database password in clear text.

The REST convention here is not what Striim's documentation describes. It is what the
Striim agent repo's FINDINGS.md section 1 records as actually working:
  POST /security/authenticate  form-encoded  -> {"token": ...}
  POST /api/v2/tungsten        text/plain body, header  Authorization: token <value>
A JSON body returns 415. A STRIIM-TOKEN header returns 401.

  python striim/deploy.py deploy [app]  render + create all three, or just one
  python striim/deploy.py start  <app>  START APPLICATION
  python striim/deploy.py stop   <app>  STOP APPLICATION
  python striim/deploy.py drop   <app>  UNDEPLOY + DROP ... CASCADE
  python striim/deploy.py status        state of both
  python striim/deploy.py sql "<stmt>"  one console statement
"""
import os
import sys
from pathlib import Path
from urllib.parse import urlparse

import requests

HERE = Path(__file__).resolve().parent
BASE = os.environ.get("STRIIM_URL", "https://developer.striim.com").rstrip("/")
NS = os.environ.get("STRIIM_MIGRATION_NS", "sarah_moolai")
# There is no deployment group called "default" on this cluster; DEPLOY without an
# explicit group fails with "cannot find such deployment group: default".
# `LIST DEPLOYMENTGROUPS;` is how you find the real name.
DG = os.environ.get("STRIIM_DEPLOYMENT_GROUP", "sarah_moolai_dg")
APPS = ("InstantTeamsCDC", "InstantTeamsInitialLoad", "BambooHRToPostgres", "ReverseDemoCDC")


def _required(name):
    value = os.environ.get(name)
    if not value:
        sys.exit(f"missing required environment variable {name}")
    return value


def token():
    r = requests.post(f"{BASE}/security/authenticate",
                      data={"username": _required("STRIIM_USER"),
                            "password": _required("STRIIM_PASS")},
                      timeout=30)
    r.raise_for_status()
    return r.json()["token"]


def console(statement, tok=None):
    tok = tok or token()
    r = requests.post(f"{BASE}/api/v2/tungsten",
                      headers={"Authorization": f"token {tok}",
                               "Content-Type": "text/plain"},
                      data=statement.encode("utf-8"), timeout=180)
    if r.status_code >= 400:
        # Striim puts the useful part in the body; the status code alone says
        # nothing about WHICH statement failed or why.
        raise RuntimeError(f"HTTP {r.status_code} from /api/v2/tungsten: {r.text[:2000]}")
    try:
        return r.json()
    except ValueError:
        return r.text


def _db():
    """Host, user, password and both database names for the TQL placeholders.

    MIGRATION_DB_HOST / _USER / _PASS used to be required outright, and they are in neither
    .env nor .env.example — so `deploy` only ever worked from a shell where someone had
    exported them by hand, and failed with "missing required environment variable
    MIGRATION_DB_HOST" for anyone who just sourced .env. They are the same host, user and
    password already present in LEDGER_DATABASE_URL, so derive them from it and keep the
    MIGRATION_* names as overrides for the case where the migration targets another cluster.
    """
    ledger = os.environ.get("LEDGER_DATABASE_URL", "")
    target = os.environ.get("TARGET_DATABASE_URL", "")
    lu, tu = urlparse(ledger), urlparse(target)

    host = os.environ.get("MIGRATION_DB_HOST") or (lu.hostname or "")
    user = os.environ.get("MIGRATION_DB_USER") or (lu.username or "")
    password = os.environ.get("MIGRATION_DB_PASS") or (lu.password or "")
    srcdb = os.environ.get("MIGRATION_SOURCE_DB") or (lu.path.lstrip("/") or "instant_ledger")
    tgtdb = (os.environ.get("MIGRATION_TARGET_DB") or (tu.path.lstrip("/") or "")
             or f"{srcdb}_target")

    missing = [n for n, v in (("host", host), ("user", user), ("password", password)) if not v]
    if missing:
        sys.exit("cannot determine the migration database " + ", ".join(missing)
                 + " — set LEDGER_DATABASE_URL (recommended) or MIGRATION_DB_HOST/_USER/_PASS")
    return host, user, password, srcdb, tgtdb


def render(template_path):
    """Substitute credentials into a TQL template. In memory only."""
    host, user, password, srcdb, tgtdb = _db()
    text = Path(template_path).read_text(encoding="utf-8")
    # Demanded only when the template actually has the placeholder, so the two Postgres
    # applications still deploy on a machine with no BambooHR credentials. Demanded at all
    # because an empty APIKey does not fail loudly: the reader accepts it, the app starts, and
    # then halts with a connection error that reads like a misconfigured Domain.
    if "__BAMBOO_KEY__" in text:
        _required("BAMBOOHR_API_KEY")
    if "__BAMBOO_DOMAIN__" in text:
        _required("BAMBOOHR_DOMAIN")
    return (text
            .replace("__NS__", NS)
            .replace("__HOST__", host)
            .replace("__SRCDB__", srcdb)
            .replace("__TGTDB__", tgtdb)
            .replace("__USER__", user)
            .replace("__PASS__", password)
            .replace("__SLOT__", os.environ.get("MIGRATION_SLOT", "instant_teams_slot"))
            # The reverse pipeline has its OWN slot. Sharing one would mean two readers
            # competing for the same replication stream, and whichever connected second
            # would fail — logical slots allow exactly one consumer.
            .replace("__REVSLOT__", os.environ.get("REVDEMO_SLOT", "revdemo_slot"))
            .replace("__DB__", srcdb)
            .replace("__BAMBOO_KEY__", os.environ.get("BAMBOOHR_API_KEY", ""))
            .replace("__BAMBOO_DOMAIN__", os.environ.get("BAMBOOHR_DOMAIN", "")))


def _report(label, result):
    """Print one console result, and say plainly whether it failed.

    Striim returns HTTP 200 with executionStatus Failure inside the body, so a
    raise_for_status is not enough on its own to know whether anything happened.
    """
    failed = False
    if isinstance(result, list):
        for item in result:
            if isinstance(item, dict) and item.get("executionStatus") == "Failure":
                failed = True
                print(f"  FAIL {label}: {item.get('failureMessage', '').strip()}")
    if not failed:
        print(f"  ok   {label}")
    return not failed


def app_state(app, tok):
    """Current state, or CREATED if the cluster does not say."""
    result = console(f"STATUS {NS}.{app};", tok)
    if isinstance(result, list) and result and isinstance(result[0], dict):
        output = result[0].get("output") or {}
        return output.get("status", "UNKNOWN")
    return "UNKNOWN"


def _bring_up(app, tok):
    """CREATED/HALT/STOPPED -> RUNNING, from wherever it actually is.

    Three things the plan's runbook does not mention, each of which stops a start dead:
      - DEPLOY is a separate step; START on a CREATED application says "not deployed".
      - A failed start leaves the application in HALT, and DEPLOY on a HALT application
        is refused. It has to be stopped first.
      - The replication slot is NOT created by the reader. See ensure_slot in
        migration/slot handling; Striim only reports the slot missing once it starts.
    """
    state = app_state(app, tok)
    print(f"{NS}.{app} is {state}")

    if state == "RUNNING":
        print("  already running")
        return True

    if state == "HALT":
        # A HALT application refuses both STOP and START. Striim's own error names the
        # way out: RESUME. If the cause has not cleared, RESUME fails too and the only
        # remaining route is UNDEPLOY -> DEPLOY, which rebuilds it from CREATED.
        if _report("resume", console(f"RESUME APPLICATION {NS}.{app};", tok)):
            print(f"  -> {app_state(app, tok)}")
            return True
        _report("undeploy", console(f"UNDEPLOY APPLICATION {NS}.{app};", tok))
        state = app_state(app, tok)

    if state == "QUIESCED":
        _report("stop", console(f"STOP APPLICATION {NS}.{app};", tok))
        state = app_state(app, tok)

    if state in ("CREATED", "STOPPED", "TERMINATED", "COMPLETED", "UNKNOWN"):
        _report("deploy", console(f"DEPLOY APPLICATION {NS}.{app} IN {DG};", tok))

    ok = _report("start", console(f"START APPLICATION {NS}.{app};", tok))
    print(f"  -> {app_state(app, tok)}")
    return ok


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    tok = token()

    if cmd == "deploy":
        # An optional app name deploys just that one. Without it all three are attempted, and
        # CREATE on an application that already exists reports a Failure — which buries the one
        # line you care about under noise when you are recreating a single leg.
        only = sys.argv[2] if len(sys.argv) > 2 else None
        for name, template in (("InstantTeamsCDC", "InstantTeamsCDC.tql.template"),
                               ("InstantTeamsInitialLoad", "InstantTeamsInitialLoad.tql.template"),
                               ("BambooHRToPostgres", "BambooHRToPostgres.tql.template"),
                               ("ReverseDemoCDC", "ReverseDemoCDC.tql.template")):
            if only and name != only:
                continue
            print(f"{name}:")
            _report("create", console(render(HERE / template), tok))
        return

    if cmd == "start":
        app = sys.argv[2]
        _bring_up(app, tok)
        return

    if cmd == "stop":
        app = sys.argv[2]
        print(f"STOP {NS}.{app}")
        _report("stop", console(f"STOP APPLICATION {NS}.{app};", tok))
        return

    if cmd == "drop":
        app = sys.argv[2]
        console(f"STOP APPLICATION {NS}.{app};", tok)
        console(f"UNDEPLOY APPLICATION {NS}.{app};", tok)
        _report("drop", console(f"DROP APPLICATION {NS}.{app} CASCADE;", tok))
        return

    if cmd == "sql":
        print(console(sys.argv[2], tok))
        return

    for app in APPS:
        print(f"{NS}.{app}:", console(f"STATUS {NS}.{app};", tok))


if __name__ == "__main__":
    main()
