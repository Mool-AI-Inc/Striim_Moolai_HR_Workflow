# @lifespan THROWAWAY — verify credentials before the real run.
import asyncio
from conn import connect

async def main():
    conn = connect()
    try:
        async for p in conn.projects():          # any success (even empty) proves auth
            print("project:", p.id, p.name)
    finally:
        await conn.close()
    print("connected.")

if __name__ == "__main__":
    asyncio.run(main())
