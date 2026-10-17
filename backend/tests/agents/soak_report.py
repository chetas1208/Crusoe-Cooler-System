import asyncio, sys
from live_harness import Stack
async def main(seed, horizon):
    st = await Stack.create(seed=seed, random_faults=True, overrides={"first_fault_s": [90, 150]})
    await st.advance(horizon, 4.0)
    for i in st.incidents():
        print(i["id"], i["status"], i["cause"], i["attempts"], i["severity"], "|", i["title"], "|", i["summary"][:170])
    for v in st.eng.track.verifications.values():
        if v["status"] == "rejected":
            print("REJ", v["id"], v.get("failed_reason"))
    for t in st.eng.track.tasks.values():
        for c in t["tool_calls"]:
            if c["status"] in ("rejected", "error") and not c["name"].startswith("model."):
                print("TOOL", t["incident_id"], t["kind"], c["name"], str(c.get("output"))[:160])
    print("sim", st.eng.sim_time, "errors", st.rt.errors)
    await st.stop()
asyncio.run(main(int(sys.argv[1]), float(sys.argv[2])))
