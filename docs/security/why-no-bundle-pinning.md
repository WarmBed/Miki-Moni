# Why Miki-Moni does not pin the phone PWA bundle

**Date:** 2026-05-18
**Status:** Decision recorded; revisit when release pipeline gains CI signing.

## The risk we're not mitigating

A malicious Cloudflare Pages operator (Cloudflare itself, or whoever has taken over the author's CF account) could push a tampered `web-phone` bundle that exfiltrates the phone's X25519 private key from IndexedDB on first load. End-to-end encryption is only as trustworthy as the code running on each end.

This is the *only* realistic path for the hosted relay to compromise message contents — the relay itself never holds keys.

## Mitigations considered

| Strategy | User-visible cost | Implementation cost | Verdict |
|---|---|---|---|
| **A. Hard pin** — daemon ships one bundle SHA, PWA must match | High — version drift between npm + Pages locks users out | Low | Rejected |
| **B. Multi-hash allowlist** — daemon ships last N versions' hashes | Medium — users falling behind N versions see an "upgrade daemon" lockout | Low | Rejected |
| **C. TOFU + change warning** — first-load hash is trusted, later changes raise a banner | Medium — warning shown on every legitimate release; trained users will rubber-stamp | Low | Rejected |
| **D. Signed manifest (TUF-style)** — author Ed25519-signs the bundle, PWA verifies before executing | None | High — needs offline key custody + CI signing flow | Deferred |
| **No pinning** | None | None | **Selected** |

## Why "no pinning" wins right now

1. **The threat is low-probability for this project's scale.** A Cloudflare operator (or attacker with CF account access) pushing a project-specific malicious bundle requires intent + opportunity + non-detection. Small projects rarely justify that effort.
2. **Existing mitigations are documented.** The README's Security section spells out the PWA-swap risk and points users at self-host, which moves both the Worker and the Pages bundle under the user's own CF account.
3. **Strategy D is the only zero-impact option**, and it requires release infrastructure (signing key custody, CI signing job, browser-side verifier) that the project does not have. Building that infrastructure half-heartedly introduces a *new* risk: a lost or leaked signing key fails more catastrophically than the original threat.
4. **Opportunity cost.** Implementing a half-measure (A/B/C) trades hours of dev time and ongoing user friction for a marginal security gain.

## When to revisit

Move to **Strategy D** if any of these become true:

- A formal release pipeline (CI signing, version manifest publishing) is being built for other reasons.
- The hosted relay starts handling a security-sensitive userbase that can articulate this threat in their requirements.
- A specific incident — CF account scare, suspicious bundle update report — proves the threat is realistic at this scale.

Until then, the answer to "should we pin the bundle?" is *no, and here's the reasoning* (this document).

## Related

- `docs/security/hooks-trust-model.md` — local trust boundaries on the daemon side
- `docs/security/extension-ws-trust-model.md` — VSCode helper extension trust
- `README.md` § Security — the user-facing summary that links to all of the above
