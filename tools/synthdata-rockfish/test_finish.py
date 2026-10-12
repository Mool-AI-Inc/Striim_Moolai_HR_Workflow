# @lifespan THROWAWAY — offline unit test for the deterministic finishing pass (names, patterns, derived fields).
import re
import datetime as dt
import pandas as pd
from finish import finish, FIRST, LAST

EMAIL_RE = re.compile(r"^[^@\s]+@instantteams\.test$")
PHONE_RE = re.compile(r"^\(\d{3}\) 555-01\d{2}$")
YR_DAYS = 18 * 365.25
REQUIRED = {"employeeId", "firstName", "lastName", "email", "birthDate", "hireDate",
            "employeeType", "status", "costCenter", "phone", "smsConsent"}

def _rockfish_df_with_names() -> pd.DataFrame:
    return pd.DataFrame([
        dict(employee_id="EMP_1", first_name="Dana", last_name="Cole", employee_type="RFT", sms_consent="Y", transitioned="N", age_years=35),
        dict(employee_id="EMP_2", first_name="Sam",  last_name="Reyes", employee_type="RPT", sms_consent="N", transitioned="Y", age_years=29),
        dict(employee_id="EMP_3", first_name="Lee",  last_name="Ng",    employee_type="SNL", sms_consent="Y", transitioned="N", age_years=41),
        dict(employee_id="EMP_4", first_name="Val",  last_name="Ito",   employee_type="RFT", sms_consent="N", transitioned="N", age_years=18),
    ])

def _rockfish_df_no_names() -> pd.DataFrame:
    return _rockfish_df_with_names().drop(columns=["first_name", "last_name"])

def test_finish_produces_the_contract_shape():
    recs = finish(_rockfish_df_with_names())
    assert len(recs) == 4
    for r in recs:
        assert REQUIRED <= set(r), f"missing keys: {REQUIRED - set(r)}"
        assert r["employeeType"] in ("RFT", "RPT", "SNL")
        assert r["status"] in ("A", "L", "T")
        assert r["costCenter"] in ("CC-RETAIL", "CC-OPS", "CC-CX", "CC-ENG")

def test_uses_rockfish_names_when_present():
    recs = finish(_rockfish_df_with_names())
    by = {r["employeeId"]: r for r in recs}
    assert by["EMP_1"]["firstName"] == "Dana" and by["EMP_1"]["lastName"] == "Cole"
    assert by["EMP_1"]["email"].startswith("dana.cole@")

def test_falls_back_to_curated_names_when_absent():
    recs = finish(_rockfish_df_no_names())
    for r in recs:
        assert r["firstName"] in FIRST and r["lastName"] in LAST
        assert EMAIL_RE.match(r["email"])

def test_email_shape_lowercase_and_unique():
    recs = finish(_rockfish_df_with_names())
    emails = [r["email"] for r in recs]
    assert all(EMAIL_RE.match(e) for e in emails)
    assert all(e == e.lower() for e in emails)
    assert len(set(emails)) == len(emails)

def test_blank_provider_value_falls_back_per_cell():
    df = _rockfish_df_with_names()
    df.loc[0, "first_name"] = ""            # a blank/overflow cell must not yield an empty name
    df.loc[1, "last_name"] = "__OVERFLOW__"
    recs = finish(df)
    assert recs[0]["firstName"] in FIRST
    assert recs[1]["lastName"] in LAST
    assert all(EMAIL_RE.match(r["email"]) for r in recs)

def test_phone_and_consent_types():
    recs = finish(_rockfish_df_with_names())
    by_id = {r["employeeId"]: r for r in recs}
    assert all(PHONE_RE.match(r["phone"]) for r in recs)
    assert all(isinstance(r["smsConsent"], bool) for r in recs)
    assert by_id["EMP_1"]["smsConsent"] is True and by_id["EMP_2"]["smsConsent"] is False

def test_dates_and_the_18y_inequality():
    recs = finish(_rockfish_df_with_names())
    today = dt.date.today()
    for r in recs:
        b = dt.date.fromisoformat(r["birthDate"]); h = dt.date.fromisoformat(r["hireDate"])
        assert h <= today
        assert h >= dt.date(2015, 1, 1)
        assert (h - b).days >= YR_DAYS

def test_prior_cost_center_only_on_transition_and_differs():
    recs = finish(_rockfish_df_with_names())
    by_id = {r["employeeId"]: r for r in recs}
    assert "priorCostCenter" not in by_id["EMP_1"]
    assert by_id["EMP_2"]["priorCostCenter"] != by_id["EMP_2"]["costCenter"]

def test_patterns_depend_on_employee_type():
    df = pd.DataFrame(
        [dict(employee_id=f"R{i}", first_name="A", last_name="B", employee_type="RFT", sms_consent="Y", transitioned="N", age_years=40) for i in range(200)]
        + [dict(employee_id=f"S{i}", first_name="A", last_name="B", employee_type="SNL", sms_consent="Y", transitioned="N", age_years=40) for i in range(200)]
    )
    recs = finish(df)
    rft_t = sum(1 for r in recs if r["employeeType"] == "RFT" and r["status"] == "T")
    snl_t = sum(1 for r in recs if r["employeeType"] == "SNL" and r["status"] == "T")
    assert snl_t > rft_t, f"expected SNL more Terminated than RFT, got SNL={snl_t} RFT={rft_t}"
