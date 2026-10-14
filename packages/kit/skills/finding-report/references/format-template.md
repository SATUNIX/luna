# Finding Report — Template & Worked Example (reference)

Copy the template, fill it, delete the guidance in `< >`. Field values and the CVSS 4.0 vector are
in `field-values.md`. The order of sections is fixed.

## Template

```
### <Title: specific and neutral — what + where>

```yaml
Likelihood:      <Rare | Unlikely | Possible | Likely | Almost Certain>
Impact:          <Insignificant | Minor | Moderate | Major | Severe>
Access Required: <None | Limited | Privileged>
CVSS 4.0 Vector: <CVSS:4.0/AV:_/AC:_/AT:_/PR:_/UI:_/VC:_/VI:_/VA:_/SC:_/SI:_/SA:_>
MITRE ATT&CK:    <Txxxx[.xxx] Technique Name (Tactic: TAxxxx Tactic Name)>
Affected Asset:  <exact in-scope host / endpoint / object>
```

**Risk Statement**
Due to <the weakness, stated plainly>, there is a risk that a threat actor <with the stated access>
could <the action the evidence supports>, resulting in <the concrete business consequence>.

**Background**
<High-level, general explanation of the technologies involved — what they are and how they are
meant to work — so the reader has the context to understand the finding. General knowledge only;
no reference to this environment, no figures, no evidence IDs.>

**Overview**
<The specific issue in this environment: what was found, on which asset, and why it is a problem
here. Environment specifics and evidence-backed detail live here. Reference Evidence IDs inline.>

**Remediation**
1. <Single imperative sentence, single level, specific to the real fix.>
2. <...>

**Evidence**
- <EV-ID> — <what it shows>
- Screenshot captions:
  1. <Caption naming exactly what the reader is looking at.>
  2. <...>
```

## Worked example (certificate finding)

```
### Self-signed TLS certificate on the customer portal

```yaml
Likelihood:      Possible
Impact:          Major
Access Required: None
CVSS 4.0 Vector: CVSS:4.0/AV:A/AC:H/AT:P/PR:N/UI:N/VC:H/VI:H/VA:N/SC:N/SI:N/SA:N
MITRE ATT&CK:    T1557 Adversary-in-the-Middle (Tactic: TA0006 Credential Access)
Affected Asset:  portal.example.com:443
```

**Risk Statement**
Due to the customer portal presenting a self-signed TLS certificate that clients cannot validate
against a trusted certificate authority, there is a risk that a threat actor positioned on the
network path could intercept or modify traffic between users and the application without detection,
resulting in the disclosure of session credentials and unauthorised access to customer accounts.

**Background**
Transport Layer Security (TLS) protects data in transit between a client and a server. Trust rests
on a digital certificate issued by a Certificate Authority (CA) that both parties recognise: the
client checks the certificate chains to a trusted CA, has not expired, and matches the hostname it
is connecting to. When those checks pass, the client has assurance it is talking to the genuine
server over an encrypted channel. A self-signed certificate is not issued by a recognised CA, so a
client has no independent way to confirm the server's identity and cannot distinguish the real
server from an impostor.

**Overview**
The portal at portal.example.com presents a self-signed certificate [EV-114] rather than one issued
by a trusted CA. Because the certificate cannot be validated, users are conditioned to click
through the browser warning, and an intercepting proxy on the same network segment was able to
present its own certificate and read the submitted login form in cleartext [EV-115]. The same
certificate is served on all 14 portal endpoints tested [EV-116].

**Remediation**
1. Replace the self-signed certificate on portal.example.com with one issued by a trusted public CA.
2. Redirect all plaintext HTTP requests to HTTPS at the load balancer.
3. Enable HTTP Strict Transport Security with a max-age of at least one year.

**Evidence**
- EV-114 — openssl output showing the self-signed issuer equal to subject.
- EV-115 — intercepted login request captured through the proxy.
- EV-116 — endpoint sweep showing the same certificate on 14 hosts.
- Screenshot captions:
  1. Browser certificate warning shown to a user visiting the portal.
  2. Proxy interface displaying the captured credentials in cleartext.
```

Notes:
- Background stays general (what TLS/CAs are). The Overview carries every environment-specific
  claim, each with an Evidence ID.
- The CVSS vector, the qualitative Likelihood/Impact, and the Risk Statement tell one consistent
  story. If they disagree, the finding is not ready.
