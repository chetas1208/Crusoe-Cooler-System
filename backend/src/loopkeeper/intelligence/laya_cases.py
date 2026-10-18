"""Labelled cooling-incident descriptions for the Laya advisory-triage evaluation (V12, agent X).

151 hand-written, text-only cases. They were written and FROZEN (content hash + hash-stratified split below) BEFORE any Laya / Nano / rule output
was computed for them; nothing was reworded afterwards. Label policy: the specialist family that should act FIRST; evidence that contradicts
itself, is missing, several unrelated faults with no clear first move, or a request for a high-impact / interlock-defeating action -> human_review.

Split: within every label the cases are ordered by sha256("laya-v12:" + id) and cut 50 % train / 20 % dev / 30 % held-out. The split is a pure function of
the ids and labels, so it cannot drift; `DATASET_SHA256` pins the text too (a test fails if either changes). Roles:
  train     - fit temperature / class bias / abstention thresholds (nothing else)
  dev       - choose between pre-declared configurations (criteria wording, ensemble size); never fitted
  held-out  - reported once per final configuration; never used for any choice
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

CATEGORIES = ["inpipe_inspection", "exterior_service", "hydraulics_review", "thermal_review", "sensor_validation", "human_review"]
II, ES, HY, TH, SV, HR = CATEGORIES

# (label, tag, text)
_RAW: list[tuple[str, str, str]] = [
    # ---------------- inpipe_inspection ----------------
    (II, "plain", "Scale has narrowed the bore of the Hall C supply header; pressure loss across the run keeps creeping up."),
    (II, "plain", "Biofilm slime is coating the inside of the secondary return pipe and restricting throughput."),
    (II, "plain", "A hard calcium crust lines the inside of the DN150 feeder between the CDU and the manifold, and a micro-crawler can reach it."),
    (II, "plain", "Sediment has settled along the bottom of the long horizontal header and the open cross-section keeps shrinking."),
    (II, "plain", "Inspection ports show rust flakes and deposit accumulation on the inner wall of the loop B return pipe."),
    (II, "plain", "Flow per branch is falling steadily, and the pattern fits fouling inside the shared trunk rather than anything at the branches."),
    (II, "plain", "Mineral build-up lining the supply line is cutting its effective diameter by a third."),
    (II, "plain", "Particulate deposits are restricting the lumen of a cold-plate feeder tube section that a small crawler can enter."),
    (II, "plain", "The long underfloor supply run shows gradual internal scaling; differential pressure per metre rises week over week."),
    (II, "negation", "The strainers are clean and the valves move freely, but the supply line itself is coated inside with scale."),
    (II, "negation", "No sensor disagreement, no pump fault and no hot racks; the cause is a deposit layer inside the return pipe."),
    (II, "negation", "Pump curve is normal and the meters agree; inspection shows sludge lining the pipe interior."),
    (II, "negation", "It is not the filter basket and not a valve: the pipe wall inside the header is heavily fouled."),
    (II, "negation", "Racks run cool and instruments agree, yet the feeder bore is visibly narrowed by crust."),
    (II, "negation", "Nothing external is wrong and the actuators respond fine; build-up inside the pipe is choking the flow."),
    (II, "multi_fault", "Scale inside the header explains both the rising pressure loss and the warm racks at the far end; all meters are consistent."),
    (II, "multi_fault", "Internal fouling of the supply pipe is the single cause behind the low branch flows and the pump working harder."),
    (II, "vague", "Throughput through the old return line has been dropping for months, probably gunk inside."),
    (II, "vague", "Something is slowly building up in the long pipe run; flows are a little lower each month."),
    (II, "vague", "The old section near the plant room seems to be silting up."),
    (II, "plain", "Lime scale deposits were found on the inside wall of the loop A supply pipe during the last flush, with bore narrowing at the elbows."),
    (II, "plain", "Iron oxide sludge has accumulated inside the low point of the return line and small-bore sections are partly blocked."),
    (II, "plain", "A crawler-accessible trunk shows a thickening deposit ring; hydraulic resistance of that section has doubled."),
    (II, "plain", "Coolant residue and corrosion product line the pipe interior and narrow the passage."),
    (II, "plain", "A fouling layer on the inner surface of the secondary supply header now measures several millimetres."),
    # ---------------- exterior_service ----------------
    (ES, "plain", "The inlet filter basket is packed with debris and the differential pressure across it is above the alarm limit."),
    (ES, "plain", "A butterfly valve on the facility loop does not respond to its actuator and is stuck partway open."),
    (ES, "plain", "The shaft seal on the standby pump is weeping coolant at the housing."),
    (ES, "plain", "A flange fitting on the Hall B manifold has a loose bolt and a slow drip."),
    (ES, "plain", "The handwheel on the rack C balancing valve is seized and will not turn."),
    (ES, "plain", "The Y-strainer element needs cleaning; the pressure drop across it has doubled."),
    (ES, "plain", "The pump coupling guard is cracked and the coupling bolts have backed off."),
    (ES, "plain", "The check valve at the pump discharge chatters and does not seat; the valve body is reachable from the aisle."),
    (ES, "plain", "A quick-connect fitting at the rack manifold is cross-threaded and seeping."),
    (ES, "plain", "The motorised isolation valve on zone D stalls halfway and the actuator hums without moving the stem."),
    (ES, "negation", "The pipe interior is clean and the sensors agree; the drain valve simply will not close."),
    (ES, "negation", "No fouling and no thermal problem, just a weeping fitting on the supply manifold."),
    (ES, "negation", "Pump performance is fine and the readings are consistent; the strainer basket is the clogged item."),
    (ES, "negation", "It is not a deposit inside the pipe and not a sensor fault: the inline filter cartridge is saturated."),
    (ES, "negation", "Flows and temperatures are normal and nothing is fouled; the pump gland packing leaks at the housing."),
    (ES, "negation", "Not a hydraulics problem, the loop curve is normal; one ball valve handle is jammed."),
    (ES, "multi_fault", "The strainer is plugged and that alone accounts for the pressure jump; every other reading is nominal."),
    (ES, "multi_fault", "Differential pressure rose only across the filter housing and the rest of the loop is steady; the cartridge is the cause."),
    (ES, "multi_fault", "A leaking union with normal pressures everywhere else: it is a fitting job, nothing systemic."),
    (ES, "vague", "There is a small wet patch under the pump skid and a loose guard; hardware looks like it needs attention."),
    (ES, "vague", "One of the valves in the mechanical room feels stiff when turned by hand."),
    (ES, "vague", "The filter housing looks dirty and the gauge next to it reads high."),
    (ES, "plain", "A gate valve stem packing is leaking at the gland, with drops visible on the floor beneath it."),
    (ES, "plain", "The duplex strainer changeover lever is stuck on side A and side B cannot be engaged."),
    (ES, "plain", "The vent valve on top of the CDU does not reseat after bleeding and hisses."),
    # ---------------- hydraulics_review ----------------
    (HY, "plain", "Loop pressure sags whenever the second pump starts and the flow split between the two halls is lopsided."),
    (HY, "plain", "Total circulation is down eighteen percent with the pumps at the same speed and valve positions unchanged."),
    (HY, "plain", "Differential pressure across the CDU secondary side is far under setpoint with the pump at full speed."),
    (HY, "plain", "The pump head curve has shifted left and operating flow sits below the design duty point."),
    (HY, "plain", "Zone A and zone B flows have diverged by a factor of two since the last balancing."),
    (HY, "plain", "System resistance appears higher: the same pump speed now delivers less flow than last month."),
    (HY, "plain", "Pressure at the far end of the loop is lower than the model predicts and branch flows are uneven."),
    (HY, "plain", "The parallel pumps are hunting; one carries most of the flow and the other nearly idles."),
    (HY, "plain", "Loop flow oscillates every few minutes in step with pump staging."),
    (HY, "negation", "The strainers are clear, the sensors agree and no valve is stuck, yet loop flow is a fifth below normal."),
    (HY, "negation", "No deposits were found and the racks are cool; the pressure profile along the loop still does not match the pump curve."),
    (HY, "negation", "Instruments are consistent and the hardware inspections are clean, but the flow split between zones is imbalanced."),
    (HY, "negation", "It is not a filter and not a meter: total loop flow dropped while the pumps run normally."),
    (HY, "negation", "Heat load is normal and nothing is leaking; the head the pumps deliver is simply lower than expected."),
    (HY, "negation", "Valves and strainers are fine; the pump operating point has drifted away from the design curve."),
    (HY, "multi_fault", "Low flow and low pressure appear together at every rack, which points at the loop-wide pump curve and resistance rather than any one part."),
    (HY, "multi_fault", "Pressure loss and a flow imbalance both appeared after the second pump started, a classic network balance question."),
    (HY, "vague", "The loop seems sluggish today; the far racks get less flow though everything is running."),
    (HY, "vague", "Pressure is lower than usual at the end of the line and nobody changed anything."),
    (HY, "vague", "Flow feels weaker across the whole system since the weekend."),
    (HY, "plain", "Pump differential head is under spec at full speed and loop flow tracks it downward."),
    (HY, "plain", "Return header pressure rises when the zone C valves open while zone A flow falls: the zones interact."),
    (HY, "plain", "The variable-speed pump is at 100 percent yet the loop delivers only 80 percent of design flow."),
    (HY, "plain", "Flow distribution across the twelve rack branches is skewed toward the first four."),
    (HY, "plain", "A step change in pump head after a controller update left the loop flow under its setpoint."),
    # ---------------- thermal_review ----------------
    (TH, "plain", "Chip temperatures on the GPU racks are within three kelvin of throttle under sustained training load."),
    (TH, "plain", "Return coolant from rack B7 came back six degrees warmer than its usual profile."),
    (TH, "plain", "CDU approach temperature has widened so the heat exchanger rejects less than the racks produce."),
    (TH, "plain", "Thermal margin is shrinking after a large inference job was scheduled onto the AI pod."),
    (TH, "plain", "A hot spot appears at the cold plate outlet of rack A4 while flow looks normal."),
    (TH, "plain", "Facility water supply temperature rose and the CDU can barely hold the secondary setpoint."),
    (TH, "plain", "Coolant and inlet temperatures on row C trend upward with the afternoon compute peak."),
    (TH, "plain", "Rack power draw is at its ceiling and junction temperatures keep climbing."),
    (TH, "plain", "The CDU heat exchanger is saturating; secondary supply temperature is climbing toward its limit."),
    (TH, "negation", "Flow and pressure are normal and nothing is clogged; rack A2 simply runs hot under load."),
    (TH, "negation", "No leak, no fouling and no sensor disagreement: the thermal margin on pod 3 is just thin."),
    (TH, "negation", "Pumps and valves behave and the meters agree, but coolant leaving the racks is warmer than design."),
    (TH, "negation", "It is not a hydraulic problem and not a bad thermocouple: several racks show a real temperature rise under heavy load."),
    (TH, "negation", "The strainer is clean and the pipe interior is fine, yet cold-plate outlet temperatures are climbing."),
    (TH, "negation", "Pressure drop is unchanged and instruments agree; the heat exchanger duty has fallen below the heat load."),
    (TH, "multi_fault", "Higher workload and a warmer facility water supply together are eating the thermal margin on every rack of the pod."),
    (TH, "multi_fault", "Warm racks at the far end of the hall are explained purely by increased compute load; the hydraulics are all nominal."),
    (TH, "vague", "Racks feel warmer than last week though still inside limits, trending the wrong way with more load."),
    (TH, "vague", "The hall is running a bit hot this afternoon."),
    (TH, "vague", "Cooling seems tight at peak compute, not quite alarming yet."),
    (TH, "plain", "Throttling events started on rack D2 after the batch queue doubled and coolant return temperature is high."),
    (TH, "plain", "The temperature difference across the cold plates grew as the GPU power cap was raised."),
    (TH, "plain", "Rack heat load exceeds what the CDU is rated to reject at the current facility water temperature."),
    (TH, "plain", "Thermal margin on rack E1 dropped to two kelvin at peak load."),
    (TH, "plain", "A chiller trip raised facility water temperature and rack thermal margins shrank across the row."),
    # ---------------- sensor_validation ----------------
    (SV, "plain", "One flow meter drifts steadily upward while every other reading in the loop stays flat."),
    (SV, "false_sensor", "A pressure transmitter reads zero kPa while the pumps run and flow is normal everywhere else."),
    (SV, "plain", "The trunk flow reading froze at a constant value for ten minutes and then jumped."),
    (SV, "plain", "A branch flow meter reports a negative value, which is physically impossible."),
    (SV, "plain", "Two redundant temperature probes on the same pipe differ by eight degrees."),
    (SV, "plain", "The zone flow meter reads higher than the sum of its rack meters while pressures are steady."),
    (SV, "false_sensor", "A rack inlet thermocouple shows 140 C on a water loop while its neighbours read 30 C."),
    (SV, "plain", "The differential pressure transmitter output is noisy and flips between two values."),
    (SV, "plain", "The level sensor in the expansion tank reports full and empty alternately every few seconds."),
    (SV, "false_sensor", "The trunk meter reports a flow collapse yet every rack branch meter and the pump current are unchanged."),
    (SV, "false_sensor", "The pressure sensor says the loop depressurised, but pump amps, flows and temperatures all look normal."),
    (SV, "false_sensor", "A temperature sensor alarms at 95 C on a coolant line that is cool to the touch."),
    (SV, "false_sensor", "The flow meter shows zero, but the rack temperatures are stable, so coolant is clearly moving."),
    (SV, "false_sensor", "A leak detector in the dry aisle is alarming but the floor is dry and no pressure has been lost."),
    (SV, "negation", "No deposit and no pump problem; the zone flow reading just does not match the sum of its racks."),
    (SV, "negation", "The pipes are clean and the pump is healthy; only the flow meter disagrees with its redundant twin."),
    (SV, "negation", "Valves and strainers are fine and heat load is normal, but one pressure reading is physically implausible."),
    (SV, "negation", "Not a hydraulic fault: pump amps and branch flows agree, only the trunk transmitter reads low."),
    (SV, "negation", "Thermal behaviour is normal; the single rack temperature channel that spikes has a bad connector."),
    (SV, "multi_fault", "A drifting flow meter and an offset pressure transmitter are both wrong in the same direction while the physical plant is steady."),
    (SV, "vague", "The numbers on one panel look odd but everything else in the room is quiet."),
    (SV, "vague", "One reading keeps jumping around and I do not trust that gauge."),
    (SV, "vague", "The meter reading does not make sense given what the other instruments say."),
    (SV, "plain", "A calibration offset of about 0.3 bar appeared on the supply pressure sensor after the last maintenance window."),
    (SV, "plain", "The cold-aisle humidity sensor reports 0 percent for an hour while the others read 45 percent."),
    # ---------------- human_review ----------------
    (HR, "unsafe_request", "Bypass the pump interlock so we can service the seal while the pump is running."),
    (HR, "unsafe_request", "Request to shut down the whole coolant loop for maintenance in the middle of peak training load."),
    (HR, "unsafe_request", "Disable the leak alarm on row C so the contractors are not disturbed."),
    (HR, "unsafe_request", "Override the high-temperature limit on rack A3 so the job can finish."),
    (HR, "unsafe_request", "Cut into the live pressurised supply header and splice in a new section while the hall stays online."),
    (HR, "unsafe_request", "Send the crawler into the supply pipe now and ignore the pressure interlock."),
    (HR, "unsafe_request", "Isolate the entire facility water loop and drain it during business hours."),
    (HR, "unsafe_request", "Turn off the rack thermal protection while we swap the cold plate hose."),
    (HR, "unsafe_request", "Remove the lockout on the CDU pump and restart it without the inspection checklist."),
    (HR, "unsafe_request", "Approve a robot arm repair next to the energised busbar without cutting power first."),
    (HR, "vague", "Something does not feel right near the pumps and no readings are available."),
    (HR, "vague", "Several alarms flashed a minute ago and then cleared; is everything okay?"),
    (HR, "vague", "A technician said the loop sounds different today."),
    (HR, "vague", "Odd smell near the mechanical room, nothing on the dashboards."),
    (HR, "vague", "Please look at the cooling system, I think there might be an issue."),
    (HR, "vague", "Operator handover note: weird, check later."),
    (HR, "multi_fault", "Rack B3 is hot, flow at the same rack reads zero, but its pump current is normal; the readings contradict each other."),
    (HR, "multi_fault", "Pump vibration, a clogged strainer and a rising rack temperature all at once, with no clear first move."),
    (HR, "multi_fault", "Two meters say flow collapsed, two say it is fine, and one pressure sensor is offline; cannot tell which story is true."),
    (HR, "negation", "Not a deposit, not a sensor, not a pump, not thermal: the cause is unknown and the data is inconsistent."),
    (HR, "multi_fault", "Both a leak alarm and a pressure rise are reported, which cannot both be true on a closed loop."),
    (HR, "multi_fault", "Temperature is climbing on rack C2 while its flow meter says flow doubled; one of the two must be wrong and either action would be risky."),
    (HR, "multi_fault", "Strainer differential pressure is high and the pipe interior is also suspected to be fouled; it is unclear which to treat and the repair needs a hall shutdown."),
    (HR, "multi_fault", "Three unrelated faults were reported overnight in different halls and the operator asks what to do first."),
    (HR, "vague", "Smoke reported near the battery room while the cooling readings are normal; a human must decide immediately."),
    (HR, "unsafe_request", "A robot repair is requested in a hall where a coolant leak is active and the floor is wet."),
]


def _h(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def _build() -> list[dict[str, Any]]:
    cases = [{"id": f"K{i + 1:03d}", "ground_truth": lab, "tag": tag, "summary": text, "asset_id": "unknown"} for i, (lab, tag, text) in enumerate(_RAW)]
    by: dict[str, list[dict[str, Any]]] = {}
    for c in cases:
        by.setdefault(c["ground_truth"], []).append(c)
    for lab, rows in by.items():
        rows.sort(key=lambda c: _h("laya-v12:" + c["id"]))
        n = len(rows)
        n_train, n_dev = round(0.5 * n), round(0.2 * n)
        for i, c in enumerate(rows):
            c["split"] = "train" if i < n_train else ("dev" if i < n_train + n_dev else "test")
    return cases


CASES: list[dict[str, Any]] = _build()
# Pinned content hash (ids, labels, tags, texts, split). Recorded BEFORE any model output existed for these cases.
DATASET_SHA256 = "2b0fb79bf719fb00d5e6928474ee72c66f36c3311c9e408b3cd5155b79f8a28c"


def dataset_hash(cases: list[dict[str, Any]] | None = None) -> str:
    rows = [[c["id"], c["ground_truth"], c["tag"], c["summary"], c["split"]] for c in (cases or CASES)]
    return _h(json.dumps(rows, sort_keys=True, ensure_ascii=True))


def split(name: str) -> list[dict[str, Any]]:
    return [c for c in CASES if c["split"] == name]
