# @lifespan THROWAWAY — the one proven Rockfish connection form (spec §E/§H).
import os
import rockfish as rf
from dotenv import load_dotenv

def connect():
    load_dotenv()
    key = os.environ.get("ROCKFISH_API_KEY")
    org = os.environ.get("ROCKFISH_ORG_ID")
    if not key or not org:
        raise SystemExit("Set ROCKFISH_API_KEY and ROCKFISH_ORG_ID in .env (see .env.example)")
    kwargs = {"organization": org}
    if os.environ.get("ROCKFISH_API_URL"):
        kwargs["api_url"] = os.environ["ROCKFISH_API_URL"]
    # Do NOT pass project= here — the generation/upload connection 403s if you do (spec §H).
    return rf.Connection.remote(key, **kwargs)
