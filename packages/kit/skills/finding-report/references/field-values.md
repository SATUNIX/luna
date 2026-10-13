# Finding Report — Field Values (reference)

Values for the finding data block. Match the client's house scale where they mandate one; otherwise
use these.

## Likelihood (qualitative)

`Rare` · `Unlikely` · `Possible` · `Likely` · `Almost Certain`

Judge from exposure and the realistic barrier to exploitation (position, privilege, timing), not
from how bad the outcome is — that is Impact.

## Impact (qualitative)

`Insignificant` · `Minor` · `Moderate` · `Major` · `Severe`

The demonstrated business/security consequence. Rate what the evidence shows, not the worst
theoretical case.

## Access Required

- `None` — reachable unauthenticated, typically from the network / internet.
- `Limited` — needs a standard user account, or an adjacent/internal network position.
- `Privileged` — needs administrative rights, local access, or physical access.

## CVSS 4.0 Vector

Prefix every vector with `CVSS:4.0/`. All eleven **Base** metrics are mandatory and come in this
order:

| Metric | Meaning | Values |
|---|---|---|
| `AV` | Attack Vector | `N` Network · `A` Adjacent · `L` Local · `P` Physical |
| `AC` | Attack Complexity | `L` Low · `H` High |
| `AT` | Attack Requirements | `N` None · `P` Present |
| `PR` | Privileges Required | `N` None · `L` Low · `H` High |
| `UI` | User Interaction | `N` None · `P` Passive · `A` Active |
| `VC` | Confidentiality (vulnerable system) | `H` · `L` · `N` |
| `VI` | Integrity (vulnerable system) | `H` · `L` · `N` |
| `VA` | Availability (vulnerable system) | `H` · `L` · `N` |
| `SC` | Confidentiality (subsequent system) | `H` · `L` · `N` |
| `SI` | Integrity (subsequent system) | `H` · `L` · `N` |
| `SA` | Availability (subsequent system) | `H` · `L` · `N` |

Example: `CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:N/SC:N/SI:N/SA:N`.

Optional metric groups, appended after the base metrics only when they change the assessment:
- **Threat**: `E` Exploit Maturity (`X`/`A` Attacked/`P` PoC/`U` Unreported).
- **Environmental**: `CR`/`IR`/`AR` requirements, and the Modified Base metrics `MAV…MSA`.
- **Supplemental**: `S` Safety, `AU` Automatable, `R` Recovery, `V` Value Density,
  `RE` Response Effort, `U` Provider Urgency.

**Do not hand-compute the numeric score.** Record the vector string, then obtain the score from the
official FIRST CVSS 4.0 calculator, and in the finding justify any metric that is not the obvious
default (one short clause each). A vector without that justification is not defensible.

## MITRE ATT&CK

Cite the **technique** that matches the behaviour you demonstrated, not an aspirational one:
`Txxxx` (or sub-technique `Txxxx.xxx`) with its name, and the parent **tactic** (`TAxxxx`) in
parentheses — e.g. `T1557 Adversary-in-the-Middle (Tactic: TA0006 Credential Access)`. Use the
Enterprise matrix by default; use ICS or Mobile when the affected asset belongs to that domain. If
a finding maps to more than one technique, list the primary one in the data block and note the
others in the Overview.
