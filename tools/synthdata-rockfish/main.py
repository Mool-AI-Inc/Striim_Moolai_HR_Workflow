# @lifespan THROWAWAY — run once to mint fixtures/employees.json. No git; deliver by copying the file.
import asyncio, json
from generate import generate
from finish import finish
from validate import find_violations, assert_quality

N = 200   # >= 20; cardinality must stay <= 1_000_000

async def main():
    df = await generate(N)
    records = finish(df)
    problems = find_violations(records)
    if problems:
        raise SystemExit(f"{len(problems)} violations — not writing: {problems[:5]}")
    assert_quality(records)
    with open("employees.json", "w") as fh:
        json.dump(records, fh, indent=2)
    print(f"wrote {len(records)} employees -> employees.json")

if __name__ == "__main__":
    asyncio.run(main())
