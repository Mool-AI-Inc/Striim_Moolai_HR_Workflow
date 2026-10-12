# @lifespan THROWAWAY — run the schema-only workflow and return the employees DataFrame.
import asyncio
import rockfish as rf
import rockfish.actions as ra
from conn import connect
from schema import create_employee_schema

async def generate(n: int):
    conn = connect()
    frames = {}
    try:
        schema = create_employee_schema(n)
        config = ra.GenerateFromDataSchema.Config(schema=schema, upload_datasets=True)
        builder = rf.WorkflowBuilder()
        builder.add(ra.GenerateFromDataSchema(config))
        workflow = await builder.start(conn)
        await workflow.wait(raise_on_failure=True)
        async for ds in workflow.datasets():                 # async-iterate; .collect() is not used
            frames[ds.name()] = (await ds.to_local(conn)).to_pandas()
    finally:
        await conn.close()
    if not frames:                                           # a workflow can finalize with NO output (spec §H)
        raise RuntimeError("Rockfish produced no dataset — the workflow finalized empty; check the schema/logs")
    return frames.get("employees", next(iter(frames.values())))

if __name__ == "__main__":
    df = asyncio.run(generate(200))
    print(df.head())
    print(df["employee_type"].value_counts(normalize=True))               # ~0.72 / 0.20 / 0.08
    print("sms Y:", (df["sms_consent"] == "Y").mean(), " trans Y:", (df["transitioned"] == "Y").mean())
    have_names = {"first_name", "last_name"} <= set(df.columns) and df["first_name"].astype(str).str.strip().ne("").all()
    print("NAME-SMOKE — provider returned names:", have_names)
    print(df[["first_name", "last_name"]].head().to_dict("records") if have_names else "NO NAMES → finish() uses the curated fallback")
