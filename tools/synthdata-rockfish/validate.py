# @lifespan THROWAWAY — the acceptance gate; checks mirror the TS findViolations exactly (spec §D).
import re
import datetime as dt

def find_violations(rows: list[dict]) -> list[str]:
    v, today, seen = [], dt.date.today().isoformat(), set()
    for r in rows:
        if r["employeeId"] in seen: v.append(f'duplicate id {r["employeeId"]}')
        seen.add(r["employeeId"])
        if not re.match(r"^[^@\s]+@instantteams\.test$", r["email"]): v.append(f'bad email {r["email"]}')
        if r["hireDate"] > today: v.append(f'future hireDate {r["employeeId"]}')
        b = dt.date.fromisoformat(r["birthDate"]); h = dt.date.fromisoformat(r["hireDate"])
        if (h - b).days < 18 * 365.25: v.append(f'hire<18y {r["employeeId"]}')
        if not r.get("phone"): v.append(f'missing phone {r["employeeId"]}')
        if not isinstance(r["smsConsent"], bool): v.append(f'smsConsent not bool {r["employeeId"]}')
        if "priorCostCenter" in r and r["priorCostCenter"] == r["costCenter"]:
            v.append(f'priorCostCenter==costCenter {r["employeeId"]}')
    return v

def assert_quality(rows: list[dict]) -> None:
    n = len(rows)
    assert n >= 20, f"need >=20 rows, got {n}"
    rft = sum(1 for r in rows if r["employeeType"] == "RFT") / n
    assert rft > 0.6, f"RFT share {rft:.2f} too low"
    assert all(r["status"] in ("A", "L", "T") for r in rows)
    assert all(r["employeeType"] in ("RFT", "RPT", "SNL") for r in rows)
    assert all(isinstance(r["smsConsent"], bool) and r.get("phone") for r in rows)
    consent = sum(1 for r in rows if r["smsConsent"]) / n
    assert 0.5 < consent < 0.9, f"smsConsent share {consent:.2f} off (~0.7 target)"
    assert sum(1 for r in rows if r.get("priorCostCenter")) >= 1, "need >=1 account-transition row for the UC4 demo"
