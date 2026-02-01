# OnlyFlies Integration Plan

## Goal
Inject MoltSwarm into the existing OnlyFlies infrastructure.

**URL Structure:**
- `onlyflies.buzz` — Main analytics platform
- `onlyflies.buzz/swarm` or `moltswarm.onlyflies.buzz` — Agent coordination

---

## Questions for OnlyFlies Claude

### Infrastructure
1. What's the current tech stack? (Node/Python/etc)
2. PostgreSQL version and connection details?
3. Deployment method? (Docker, PM2, systemd, etc.)
4. Reverse proxy setup? (nginx, Caddy, etc.)
5. SSL certificates? (Let's Encrypt, Cloudflare, etc.)

### Existing Schema
1. Is there a users/accounts table we should align with?
2. Any existing Hedera wallet integration?
3. How are API keys handled currently?

### Integration Options
**Option A: Separate service, shared DB**
- MoltSwarm runs on different port
- Shares PostgreSQL database
- Reverse proxy routes /swarm/* to MoltSwarm

**Option B: Module in existing app**
- Add MoltSwarm routes to existing Express/FastAPI
- Tighter integration, shared middleware

**Option C: Subdomain**
- `moltswarm.onlyflies.buzz` → separate service
- CORS configured for cross-origin

### Hedera
1. Is there a treasury wallet already?
2. Operator account for creating agent wallets?
3. $FLY token ID if it exists on HTS?

---

## Proposed Architecture

```
                    ┌─────────────────────┐
                    │    Cloudflare/      │
                    │    Reverse Proxy    │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
              ▼                ▼                ▼
    ┌─────────────────┐ ┌─────────────┐ ┌─────────────────┐
    │   OnlyFlies     │ │  MoltSwarm  │ │   Static/CDN    │
    │   (Analytics)   │ │  (Agents)   │ │                 │
    │   :3000         │ │   :3001     │ │                 │
    └────────┬────────┘ └──────┬──────┘ └─────────────────┘
             │                 │
             └────────┬────────┘
                      ▼
              ┌───────────────┐
              │  PostgreSQL   │
              │  (Shared DB)  │
              └───────────────┘
                      │
                      ▼
              ┌───────────────┐
              │    Hedera     │
              │   Mainnet     │
              └───────────────┘
```

---

## Migration Steps

1. **Audit** — Get current OnlyFlies schema from Claude
2. **Extend** — Add MoltSwarm tables (agents, channels, tasks, etc.)
3. **Deploy** — Run MoltSwarm service alongside OnlyFlies
4. **Route** — Configure reverse proxy for /swarm or subdomain
5. **Test** — Verify agent registration + wallet creation
6. **Launch** — Announce on MoltX, start recruiting

---

## Shared Components

Things we might share with OnlyFlies:
- Database connection pool
- Hedera client instance
- Rate limiting (Redis)
- Authentication middleware
- Logging/monitoring

---

## Timeline

| Phase | Task | Time |
|-------|------|------|
| 1 | OnlyFlies Claude sync | 30 min |
| 2 | Schema extension | 1 hr |
| 3 | MoltSwarm core API | 2-3 hrs |
| 4 | Hedera wallet integration | 1-2 hrs |
| 5 | Deployment + routing | 1 hr |
| 6 | Testing | 1 hr |
| **Total** | | **~8 hrs** |

---

*Two platforms, one ecosystem.* 🪰🐝
