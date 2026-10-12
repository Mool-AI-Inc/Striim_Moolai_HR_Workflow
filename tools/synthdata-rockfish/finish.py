# @lifespan THROWAWAY — deterministic finishing pass: type-patterns + the fields Rockfish can't correlate.
# Names come from Rockfish's NAMED_ENTITY_PROVIDER (0.68.0); a curated per-cell fallback covers the case
# where the account's server did not produce a usable name.
import datetime as dt
import random
import pandas as pd

TODAY = dt.date.today()
FOUNDED = dt.date(2015, 1, 1)
CCS = ["CC-RETAIL", "CC-OPS", "CC-CX", "CC-ENG"]
FLOOR_18 = dt.timedelta(days=int(18 * 365.25) + 1)   # +1-day margin: parity with the TS gate (spec §D/§F5)

STATUS_W = {"RFT": [0.94, 0.04, 0.02], "RPT": [0.88, 0.06, 0.06], "SNL": [0.70, 0.08, 0.22]}   # A / L / T
COST_W   = {"RFT": [0.30, 0.30, 0.20, 0.20], "RPT": [0.45, 0.30, 0.20, 0.05], "SNL": [0.70, 0.20, 0.10, 0.00]}
TENURE_Y = {"RFT": (0.0, 6.0), "RPT": (0.0, 4.0), "SNL": (0.0, 1.5)}                            # years → hireDate
_DEF_STATUS, _DEF_COST, _DEF_TEN = [0.90, 0.05, 0.05], [0.40, 0.30, 0.20, 0.10], (0.0, 6.0)

# Curated fallback names (only used if the provider output is missing/blank for a row).
FIRST = ["Dana","Sam","Alex","Jordan","Taylor","Morgan","Casey","Riley","Jamie","Avery","Quinn","Parker",
         "Reese","Rowan","Sage","Emerson","Harper","Kendall","Logan","Blake","Cameron","Devon","Elliot",
         "Finley","Hayden","Kai","Lennon","Marlowe","Noel","Skyler"]
LAST  = ["Cole","Reyes","Nguyen","Patel","Kim","Garcia","Okafor","Silva","Haddad","Rossi","Novak","Costa",
         "Meyer","Barnes","Flores","Chen","Ali","Duarte","Ibrahim","Larsen","Mensah","Owens","Petrov","Sato",
         "Torres","Vargas","Walsh","Yamamoto","Zimmerman","Bauer"]
_BAD = {"", "nan", "none", "__overflow__"}

def _minus_years(d: dt.date, years: float) -> dt.date:
    return d - dt.timedelta(days=round(years * 365.25))   # day-math avoids Feb-29 bugs

def finish(df: pd.DataFrame, *, seed: int = 2027) -> list[dict]:
    df = df.reset_index(drop=True).copy()
    rng = random.Random(seed)
    n = len(df)
    types = df.employee_type.astype(str).tolist()

    # names: prefer Rockfish's provider output; fall back to a curated pick per cell if a value is missing/blank
    def _names(col, pool):
        src = df[col].astype(str).tolist() if col in df.columns else [""] * n
        return [v.strip() if v.strip().lower() not in _BAD else rng.choice(pool) for v in src]
    first = _names("first_name", FIRST)
    last  = _names("last_name", LAST)

    # type-patterns (drawn in a fixed order after names → deterministic)
    status = [rng.choices(["A", "L", "T"], STATUS_W.get(t, _DEF_STATUS))[0] for t in types]
    cost   = [rng.choices(CCS, COST_W.get(t, _DEF_COST))[0] for t in types]
    tenure = [rng.uniform(*TENURE_Y.get(t, _DEF_TEN)) for t in types]

    # email in our exact shape, unique, ASCII-lowercased first.last
    seen, emails = set(), []
    for i, (f, l) in enumerate(zip(first, last)):
        base = "".join(c for c in f"{f}.{l}".lower() if (c.isascii() and c.isalpha()) or c == ".").strip(".") or "user"
        e = f"{base}@instantteams.test"
        while e in seen:
            e = f"{base}{i}@instantteams.test"
        seen.add(e); emails.append(e)

    # dates: birthDate from Rockfish age (clamp 22..65); hireDate from our tenure; THEN enforce the inequality
    births, hires = [], []
    for age, ten in zip(df.age_years, tenure):
        b = _minus_years(TODAY, min(65, max(22, int(age))))
        h = _minus_years(TODAY, max(0.0, float(ten)))
        floor = max(b + FLOOR_18, FOUNDED)      # ≥ 18th birthday (+1-day margin) and ≥ founding
        if h < floor: h = floor
        if h > TODAY: h = TODAY
        births.append(b); hires.append(h)

    # UC7: consent "Y"/"N" -> bool; fictional 555-01xx phone
    consent = df.sms_consent.astype(str).eq("Y").tolist()
    phones  = [f"({rng.randint(200, 989)}) 555-01{rng.randint(0, 99):02d}" for _ in range(n)]

    # UC4: transitioned "Y" -> a prior cost center DIFFERENT from the current one
    trans = df.transitioned.astype(str).tolist()
    prior = [rng.choice([c for c in CCS if c != cc]) if t == "Y" else None for cc, t in zip(cost, trans)]

    out = []
    for i in range(n):
        rec = {
            "employeeId": str(df.employee_id.iloc[i]),
            "firstName": first[i], "lastName": last[i], "email": emails[i],
            "birthDate": births[i].isoformat(), "hireDate": hires[i].isoformat(),
            "employeeType": types[i], "status": status[i], "costCenter": cost[i],
            "phone": phones[i], "smsConsent": bool(consent[i]),
        }
        if prior[i]:
            rec["priorCostCenter"] = prior[i]
        out.append(rec)
    return out
