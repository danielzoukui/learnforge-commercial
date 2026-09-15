# Deploy on Oracle Cloud Always Free (maximum $0 headroom)

**Why here:** the largest permanent free allocation among the shortlisted options —
an ARM Ampere A1 VM, 200 GB block storage and 10 TB/month egress, with no request
caps, no cold starts and no non-commercial clause. You own the OS, TLS, backups and
upgrades, so this path has real operational work.

**Sizing check first:** Oracle halved the Arm allocation in June 2026 for **new
non-PAYG tenancies** (2 OCPU / 12 GB, down from 4 / 24). Existing instances and
PAYG tenancies reportedly still see 4 / 24 within the free allowance. Confirm the
figure shown in your tenancy's console before you size anything, and note that
instance capacity for Ampere shapes is often unavailable in popular regions.

---

## 1. Provision

1. Create a tenancy, choose a **home region** with Ampere capacity.
2. **Compute → Instances → Create.** Shape **VM.Standard.A1.Flex**, and set
   OCPU/RAM to what your console's Always Free banner allows (2/12 for new
   free-tier tenancies). Image: **Ubuntu 24.04** (or Oracle Linux 9). Add your SSH key.
3. **Networking:** attach a public IPv4, and add ingress rules for TCP **80** and
   **443** in the VCN security list (keep 22 restricted to your IP).

## 2. Open the ports on the host too

Oracle images ship with iptables rules that block 80/443 even when the VCN allows them.

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

On Ubuntu images also run `sudo ufw allow 80/tcp && sudo ufw allow 443/tcp` if ufw is active.

## 3. Install Docker

```bash
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git
sudo usermod -aG docker "$USER" && newgrp docker
```

## 4. Clone and configure

```bash
git clone https://github.com/danielzoukui/learnforge-commercial.git
cd learnforge-commercial
cp deploy/.env.example .env       # then edit: domain, database password, keys
```

Set **at minimum** in `.env`: `DOMAIN`, `POSTGRES_PASSWORD`, `PUBLIC_SITE_URL`,
`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_FAMILY`, `STRIPE_PRICE_TEACHER`.

## 5. Bring up the stack

```bash
docker compose -f deploy/docker-compose.yml --env-file .env up -d --build
docker compose -f deploy/docker-compose.yml logs -f app
```

What comes up:

| Container | Role |
| --- | --- |
| `db` | PostgreSQL 16 with a persistent volume (only reachable on the internal network) |
| `app` | This repository's `Dockerfile` — static pages + the 15 `/commercial-api` handlers on port 8080 |
| `caddy` | Automatic Let's Encrypt TLS and reverse proxy for your domain |
| `migrate` | One-shot job that applies the three commercial migrations, then exits |

DNS: point an `A` record for your domain at the instance's public IP **before**
starting Caddy, or certificate issuance will fail. `deploy/Caddyfile` reads the
domain from the `DOMAIN` environment variable.

Confirm migrations ran:

```bash
docker compose -f deploy/docker-compose.yml logs migrate
curl -sS https://$DOMAIN/commercial-api/health    # {"ok":true,...,"database":"ready"}
```

## 6. Keep it running and safe

```bash
# Auto-start after reboot (compose already survives; enable the service)
sudo systemctl enable docker

# Nightly logical backup at 03:20, kept 14 days, off-box copy recommended
crontab -e
20 3 * * * cd /home/ubuntu/learnforge-commercial && docker compose -f deploy/docker-compose.yml exec -T db pg_dump -U learnforge learnforge | gzip > /home/ubuntu/backups/learnforge-$(date +\%F).sql.gz && find /home/ubuntu/backups -name 'learnforge-*.sql.gz' -mtime +14 -delete
```

Also: `sudo apt-get install -y unattended-upgrades`, restrict SSH to key-only, and
confirm the `db` container has **no** public port mapping (the compose file below
does not publish it).

## 7. Updates

```bash
cd ~/learnforge-commercial
git pull
docker compose -f deploy/docker-compose.yml up -d --build app
docker compose -f deploy/docker-compose.yml run --rm migrate
```

## 8. Stripe, Supabase and DNS

Same as every other host: register
`https://<your-domain>/commercial-api/stripe-webhook` in Stripe (the six
subscription/invoice events listed in [`NORTHFLANK.md`](NORTHFLANK.md#6-point-stripe-at-the-new-origin)),
copy the signing secret, and add `https://<your-domain>/auth.html?verified=1` to
Supabase's allowed redirect URLs. Then run one full test-mode purchase.

## 9. Trade-offs to accept

- **You are the SRE.** Patching, TLS renewal (Caddy automates it), backup/restore
  tests and incident response are yours.
- **Ampere capacity is not always available** in a region; if instance creation
  fails, try another availability domain or region.
- **Idle reclamation:** Oracle has historically reclaimed Always Free compute that
  is genuinely idle for long periods. Real customer traffic is fine; keep the
  instance doing something useful (this app does).
- **Single box, single point of failure.** For paying customers, either script
  tested backups plus a documented restore path, or move to a managed platform
  (Northflank pay-as-you-go, Render, Fly) before you depend on it for revenue.
