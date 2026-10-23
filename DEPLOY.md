# Hosting Paint Together publicly for free

This guide puts the game on the internet at an `https://` address so anyone can open it and paint. Free-tier rules
change often. The details below were checked in October 2026, so confirm them on the provider's pricing page before
you sign up.

## What the game needs

- **A server that stays on.** Players stay connected over WebSockets, so serverless or "functions" hosting
  (Lambda, Vercel, Netlify) won't work.
- **A disk that keeps its files**, for pictures, players, friends and painting progress (the `/data` volume).
- **Small resources.** About 150 to 250 MB of RAM is plenty for one server with a few rooms.

## Which free option to pick

| Option | Free for how long | Keeps saved games | Good for |
| --- | --- | --- | --- |
| **[A] Oracle Cloud Always Free** (recommended) | No time limit | Yes | A real public server at no cost |
| **[B] Google Cloud e2-micro** | No time limit | Yes | A small always-free server in the US |
| **[C] AWS Free plan** | About 6 months, or until the credits run out | Yes | Trying AWS; then about $8 to $10 a month |
| **[D] Render free web service** | No time limit | **No**: resets when it sleeps | A quick demo link in 5 minutes |
| **[E] Your own computer + Cloudflare Tunnel** | No time limit | Yes | Free hosting while your computer is on |

Notes on each:

- **Oracle:** Always Free includes Arm (Ampere A1) servers. Since mid-2026 the allowance is 2 CPUs and 12 GB of RAM
  in total (it used to be 4 and 24), which is still far more than this game needs. Free Arm capacity is sometimes
  "out of capacity" in busy regions, so try again later or pick another home region. Oracle may reclaim Always Free
  servers that sit nearly idle for a week. Upgrading the account to Pay As You Go keeps the free resources free
  and stops that, but set a budget alert if you do.
- **Google:** you get one e2-micro VM (2 shared vCPUs, 1 GB RAM) with a 30 GB standard disk, and only in
  us-west1, us-central1 or us-east1. Outbound traffic is free only up to 1 GB a month. That covers casual play
  (joining a picture downloads roughly 50 to 200 KB), but busy use will cost a few cents per GB.
- **AWS:** accounts created since July 2025 get the Free plan. It lasts 6 months and comes with up to $200 in
  credits (about $100 at sign-up and up to $100 more for trying services), and t3.micro or t2.micro servers are
  included. After that you must upgrade to a paid plan to keep the server. AWS also charges for public IPv4
  addresses (about $3.60 a month), which the credits cover while they last.
- **Render:** free web services sleep after 15 minutes without visitors (waking takes about a minute) and have no
  persistent disk. Featured pictures always work, but uploaded pictures, friends and progress are lost whenever
  the service sleeps, restarts or redeploys.
- **Cloudflare Tunnel:** free, and you don't need to open ports on your router. The game is only online while your
  computer is on.

Sources: [Oracle Always Free change (InfoQ)](https://infoq.com/news/2026/07/oracle-cloud-free-tier-limits/),
[AWS Free Tier summary (freetier.co)](https://freetier.co/aws-free-tier),
[Google Cloud free tier (WikiDocs)](https://wikidocs.net/blog/@insightbridge/18254/),
[Render free plan docs](https://render.com/docs/free). Always check the official pricing pages too.

## Before you start: a free web address

A domain lets Caddy (included) get a free HTTPS certificate automatically, so the game loads as `https://...` and
the Copy link button works everywhere.

- **Free:** create a subdomain at [DuckDNS](https://www.duckdns.org) (sign in, pick a name such as
  `mypaint`, and set its IP to your server's public IP once you have the server). Your address is then
  `mypaint.duckdns.org`.
- **Own domain:** add an `A` record pointing at your server's public IP.

---

## [A] Oracle Cloud Always Free (recommended)

1. **Sign up** at <https://www.oracle.com/cloud/free/>. A card is needed for identity checks; Always Free
   resources are not charged. Choose your home region carefully, because it can't be changed later.
2. **Create the server:** Menu → Compute → Instances → **Create instance**.
   - Image: **Canonical Ubuntu 24.04**.
   - Shape: **Ampere → VM.Standard.A1.Flex**, 1 OCPU and 6 GB RAM (stays inside the free allowance).
     If Ampere is out of capacity, the AMD **VM.Standard.E2.1.Micro** (also Always Free) works too.
   - Networking: keep "Assign a public IPv4 address" on.
   - SSH keys: download the generated private key (or paste your own public key).
   - Click **Create**, wait until it shows Running, then copy the **Public IP address**.
3. **Open the web ports in Oracle's firewall:** on the instance page open the **Subnet** → its **Security List** →
   **Add Ingress Rules**: Source CIDR `0.0.0.0/0`, IP protocol TCP, destination ports `80,443`.
4. **Point your DuckDNS name at the Public IP** (see above).
5. **Connect:** `ssh -i path/to/key ubuntu@YOUR_PUBLIC_IP`
6. **Open the ports on the server too.** Oracle's Ubuntu images block them with iptables:
   ```bash
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
   sudo netfilter-persistent save
   ```
7. Continue with **[Install and start the game](#install-and-start-the-game-on-any-server)** below.

## [B] Google Cloud e2-micro

1. **Sign up** at <https://cloud.google.com/free> and create a project.
2. **Create the VM:** Compute Engine → VM instances → **Create instance**.
   - Region: **us-west1**, **us-central1** or **us-east1** (other regions are not free).
   - Machine type: **e2-micro**.
   - Boot disk: **Ubuntu 24.04 LTS**, **Standard persistent disk**, 30 GB at most.
   - Firewall: tick **Allow HTTP traffic** and **Allow HTTPS traffic**.
   - Click **Create** and copy the **External IP**.
3. **Point your DuckDNS name at the External IP.**
4. **Connect:** click **SSH** next to the VM in the console.
5. **Add swap.** 1 GB of RAM is tight while building the Docker image:
   ```bash
   sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
   echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
   ```
6. **Set a budget alert:** Billing → Budgets & alerts → create a $1 budget so you hear about any charge.
7. Continue with **[Install and start the game](#install-and-start-the-game-on-any-server)**.

## [C] AWS (free for about 6 months)

1. **Sign up** at <https://aws.amazon.com/free/> and choose the **Free plan**.
2. **Create the server:** EC2 → **Launch instance**.
   - AMI: **Ubuntu Server 24.04 LTS**. Instance type: **t3.micro** (or t2.micro if that is what's marked
     "Free tier eligible" in your region).
   - Key pair: create one and download it.
   - Network settings: allow **SSH**, **HTTP** and **HTTPS** traffic from the internet.
   - Storage: 20 GB gp3 is plenty.
3. **Give it a fixed address:** EC2 → Elastic IPs → **Allocate** → **Associate** it with the instance.
   Otherwise the IP changes when the instance stops.
4. **Point your DuckDNS name at the Elastic IP.**
5. **Connect:** `ssh -i your-key.pem ubuntu@YOUR_ELASTIC_IP`, then add swap as in step 5 of [B].
6. **Set a budget alert:** Billing → Budgets → **Create budget** → "Zero spend budget".
7. Continue with **[Install and start the game](#install-and-start-the-game-on-any-server)**. Before the free
   plan ends, either upgrade to a paid plan (about $8 to $10 a month for this setup) or move to Oracle or Google
   and copy your data across (see [Backups](#backups)).

## Install and start the game on any server

These steps are the same for Oracle, Google and AWS (Ubuntu). Run them over SSH.

1. **Install Docker:**
   ```bash
   curl -fsSL https://get.docker.com | sudo sh
   sudo usermod -aG docker $USER && newgrp docker
   ```
2. **Get the code:**
   ```bash
   git clone https://github.com/stonedcarrot/paint-by-numbers.git paint-together
   cd paint-together
   ```
   (Or upload the zip with `scp paint-together.zip ubuntu@YOUR_IP:` and `unzip` it.)
3. **Set your address:**
   ```bash
   echo "DOMAIN=mypaint.duckdns.org" > deploy/.env
   ```
4. **Start it:**
   ```bash
   docker compose -f deploy/docker-compose.https.yml --env-file deploy/.env up -d --build
   ```
   The first build takes a few minutes. Caddy then fetches the HTTPS certificate on its own.
5. **Open `https://mypaint.duckdns.org`.** That's the link to share.

Both containers restart automatically after a reboot or crash.

## [D] Render (quick demo, progress isn't kept)

1. Put the code in a GitHub repository (this repo includes `render.yaml`).
2. Sign in at <https://render.com> with GitHub → **New** → **Blueprint** → pick the repository → **Apply**.
3. When the deploy finishes, Render gives you an `https://paint-together-xxxx.onrender.com` address.

It sleeps after 15 idle minutes and starts fresh each time it wakes, so treat it as a demo.

## [E] Your own computer with Cloudflare Tunnel

1. Run the game on your computer: `docker compose up -d --build` (see README).
2. **Quick, temporary link:** install
   [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) and run
   `cloudflared tunnel --url http://localhost:3000`. It prints a random `https://….trycloudflare.com` address that
   works until you stop it.
3. **Permanent address:** add a domain to a free Cloudflare account, then Zero Trust → Networks → Tunnels →
   **Create a tunnel**, and add a public hostname pointing to `http://localhost:3000`. Run the `cloudflared`
   command it shows you. WebSockets work through the tunnel without extra settings.

---

## Updating to a new version

```bash
cd paint-together
git pull
docker compose -f deploy/docker-compose.https.yml --env-file deploy/.env up -d --build
```

Saved games live in the `paint-data` volume and are kept across updates.

## Featured pictures and artists

Edit `featured/featured.json` and add images under `featured/` (see README). To change them without rebuilding,
uncomment the `../featured:/app/featured:ro` line in `deploy/docker-compose.https.yml` and run the start command
again; after that, edits to the folder show up on their own. Only feature artwork you have permission to use.

## Backups

All game data is in the `paint-data` volume. To back it up to a file:

```bash
docker run --rm -v deploy_paint-data:/data -v "$PWD":/backup alpine tar czf /backup/paint-backup.tgz -C /data .
```

To restore on a new server, start the game once, stop it with `docker compose ... down`, then:

```bash
docker run --rm -v deploy_paint-data:/data -v "$PWD":/backup alpine sh -c "rm -rf /data/* && tar xzf /backup/paint-backup.tgz -C /data"
```

## Keeping it safe and free

- Only ports 22, 80 and 443 need to be open.
- Run `sudo apt update && sudo apt upgrade -y` now and then. Ubuntu installs security fixes automatically by default.
- Set a budget or billing alert on any cloud account, even on a free tier.
- Stay inside the free shapes and regions listed above. Resources outside them are billed from the first minute.

## Troubleshooting

- **The site doesn't load:** check the DNS name points at the right IP (`ping mypaint.duckdns.org`) and that ports
  80 and 443 are open in both the cloud firewall and (on Oracle) iptables.
- **The certificate doesn't work:** run `docker compose -f deploy/docker-compose.https.yml logs caddy`. Caddy needs
  port 80 reachable from the internet to get the certificate.
- **The game loads but painting doesn't sync:** check `logs paint-together`. If you put the game behind another proxy
  or CDN, make sure it allows WebSockets on `/ws`.
- **The build stops on a small server:** add swap (see [B] step 5) and run the start command again.
