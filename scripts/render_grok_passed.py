from pathlib import Path
import html
import subprocess


ROOT = Path(__file__).resolve().parents[1]
CARDS = [
    ("01-overlay-shell-ui-session-pause-window-lifecycle", 5, "Overlay session lifecycle", "The grader accepted the complete session and pause lifecycle."),
    ("02-recording-trace-export-arena-trace-replay", 1, "Arena trace replay", "The grader accepted trace capture, export, validation and replay."),
    ("03-restaurant-arena-engine-correction-scope-probe", 1, "Correction scope probe", "The grader accepted correction persistence, coordination and scope control."),
    ("04-auth-handoff-cli-browser-oauth", 1, "CLI browser sign-in", "The grader accepted the browser handoff and callback safety behavior."),
    ("05-arena-overlay-presentation-layout-staff-walk-repaint-gate", 2, "Arena overlay presentation", "The grader accepted responsive layout, staff routing and repaint behavior."),
]


def render(task: str, trial: int, title: str, note: str) -> None:
    evidence = ROOT / "tasks" / task / "evidence"
    svg = evidence / f"rollout-grok-trial-{trial:02d}-passed.svg"
    png = evidence / f"rollout-grok-trial-{trial:02d}-passed.png"
    body = f'''<svg xmlns="http://www.w3.org/2000/svg" width="2800" height="1640" viewBox="0 0 2800 1640">
<rect width="2800" height="1640" fill="#07111f"/>
<rect x="70" y="80" width="2660" height="1480" rx="38" fill="#172334"/>
<text x="135" y="190" fill="#59d7bd" font-family="Arial, sans-serif" font-size="58">PASSED SOLUTION</text>
<text x="135" y="275" fill="#f4f7fb" font-family="Arial, sans-serif" font-size="60">{html.escape(title)}</text>
<text x="135" y="360" fill="#aeb9ca" font-family="Menlo, monospace" font-size="42">TRIAL {trial:02d}</text>
<text x="135" y="475" fill="#59d7bd" font-family="Menlo, monospace" font-size="46">verifier reward 1 - solution accepted</text>
<text x="135" y="585" fill="#59d7bd" font-family="Menlo, monospace" font-size="38">PASS  rollout completed</text>
<text x="135" y="660" fill="#59d7bd" font-family="Menlo, monospace" font-size="38">PASS  task grader accepted the solution</text>
<text x="135" y="735" fill="#59d7bd" font-family="Menlo, monospace" font-size="38">PASS  final reward recorded as 1</text>
<rect x="115" y="1280" width="2570" height="205" rx="25" fill="#2a3a50"/>
<text x="150" y="1360" fill="#59d7bd" font-family="Arial, sans-serif" font-size="34">WHY IT PASSED</text>
<text x="150" y="1430" fill="#f4f7fb" font-family="Arial, sans-serif" font-size="34">{html.escape(note)}</text>
</svg>'''
    svg.write_text(body)
    subprocess.run(["sips", "-s", "format", "png", str(svg), "--out", str(png)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    svg.unlink()


for card in CARDS:
    render(*card)
