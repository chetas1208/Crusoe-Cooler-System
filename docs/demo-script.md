# Three-minute demo

Run `pnpm dev` (or `pnpm dev:standalone`) and open http://localhost:5173. The world is already running — don't press anything for ~15 s.

1. **The plant is alive** (0:00) — glass pipes carry cyan (TCS supply) and amber (return) flow; racks glow with their thermal margin; OUTRIG waits on its dock. Top bar: *Simulated facility · LIVE · MOCK*.
2. **SENTINEL notices** (≈0:15) — a callout appears on P-17 and the incident card opens: *ΔP rising*. Point out the ranked hypotheses (fouling 64 %, valve 17 %, meter drift 10 %). Nothing was scripted: the monitor compares measurements with a healthy twin.
3. **Ride the crawler** — press **2**. You're inside a 15 cm pipe lit only by the crawler's lamp. Dust glints in the beam, weld seams slide past. Toggle **Section** for a cut-away profile. The tagged observation shows the real blockage.
4. **Human in the loop** — back to Facility (`Esc`). The incident card shows *"CRAWLER C-01 brush-clears P-17 — auto-approves in 18 s"*. Click **Hold**: nothing moves and the thermal margin starts to fall. **Approve** when ready.
5. **Honest verification** — the brush only removes part of the deposit; the **independent verifier rejects** it (flow ✗, ΔP ✗). SENTINEL replans: cordon racks → isolate V-ZB → OUTRIG replaces the section.
6. **See the agents think** — press **3**. The mission board lays SENTINEL / INPIPE / OUTRIG out by causal depth; click any node for the question, thought summary, evidence, and the tool-call input/output.
7. **Rewind** — click **LIVE → REPLAY**, drag the scrubber to before the incident, then **Return to live**.
8. **Same world on the phone** — open the iOS app against the same mock API.

Tips: `⌘K` jumps to anything · `F` follows a robot · `X` x-ray · engineering test controls (top-left menu) can force a specific fault.
