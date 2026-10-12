# @lifespan THROWAWAY — offline unit test for find_violations / assert_quality (parity with the TS gate).
import datetime as dt
import pytest
from validate import find_violations, assert_quality

TODAY = dt.date.today()

def _good_row(i: int, *, etype="RFT", consent=True, prior=None) -> dict:
    r = dict(employeeId=f"EMP_{i}", firstName="Ada", lastName="Lovelace",
             email=f"ada.lovelace{i}@instantteams.test",
             birthDate="1990-01-01", hireDate="2022-01-01",
             employeeType=etype, status="A", costCenter="CC-OPS",
             phone="(316) 555-0143", smsConsent=consent)
    if prior:
        r["priorCostCenter"] = prior
    return r

def _good_population(n=20) -> list[dict]:
    rows = [_good_row(i, etype=("RFT" if i < 16 else "RPT"), consent=(i < 14)) for i in range(n)]  # RFT .8, consent .7
    rows[0]["priorCostCenter"] = "CC-CX"   # differs from CC-OPS → valid transition
    return rows

def test_clean_population_has_no_violations():
    assert find_violations([]) == []
    assert find_violations(_good_population()) == []

def test_each_violation_class_is_caught():
    dup = _good_population(2); dup[1]["employeeId"] = dup[0]["employeeId"]
    assert any("duplicate id" in m for m in find_violations(dup))

    bad_email = [_good_row(1)]; bad_email[0]["email"] = "ada@example.com"
    assert any("bad email" in m for m in find_violations(bad_email))

    future = [_good_row(1)]; future[0]["hireDate"] = (TODAY + dt.timedelta(days=30)).isoformat()
    assert any("future hireDate" in m for m in find_violations(future))

    young = [_good_row(1)]; young[0]["birthDate"] = "2010-01-01"; young[0]["hireDate"] = "2020-01-01"
    assert any("hire<18y" in m for m in find_violations(young))

    nophone = [_good_row(1)]; nophone[0]["phone"] = ""
    assert any("missing phone" in m for m in find_violations(nophone))

    badconsent = [_good_row(1)]; badconsent[0]["smsConsent"] = "yes"
    assert any("smsConsent" in m for m in find_violations(badconsent))

    same = [_good_row(1, prior="CC-OPS")]   # priorCostCenter == costCenter
    assert any("priorCostCenter" in m for m in find_violations(same))

def test_assert_quality_passes_on_a_good_population():
    assert_quality(_good_population())        # must not raise

def test_assert_quality_rejects_bad_populations():
    with pytest.raises(AssertionError):
        assert_quality(_good_population(10))                                  # < 20 rows
    with pytest.raises(AssertionError):
        assert_quality([_good_row(i, etype="RPT") for i in range(20)])        # RFT share 0 < 0.6
    with pytest.raises(AssertionError):
        assert_quality([_good_row(i, consent=True) for i in range(20)])       # consent 1.0 outside 0.5–0.9
    with pytest.raises(AssertionError):
        assert_quality([_good_row(i, consent=(i < 14)) for i in range(20)])   # consent in-band, zero transitions
