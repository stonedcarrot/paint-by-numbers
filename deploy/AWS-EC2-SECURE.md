# Secure setup on AWS EC2 with Docker, your own domain and Let's Encrypt

This sets the game up at `https://paint.example.com` (use your own domain) on one EC2 server running only
Docker. Caddy gets and renews the Let's Encrypt certificate by itself. The setup is locked down so that:

- **The admin page can't be reached from the internet at all.** You open it through an SSH tunnel from your own
  computer, and it still needs the admin password.
- **Only you can log in to the server:** SSH is limited to your IP address and to your key, and passwords are off.
- **The containers can't change themselves:** they run with read-only files, no extra Linux permissions, and (for
  the game) as a normal user. Only the saved-games volume is writable.
- **Only ports 80 and 443 are open to the world**, and plain HTTP just redirects to HTTPS.

Replace `paint.example.com`, `YOUR_ELASTIC_IP` and `paint-key.pem` with your own values throughout.

## 1. Secure the AWS account (once)

1. Turn on **MFA for the root user** (account menu → Security credentials → Assign MFA).
2. Don't use the root user day to day: create an admin user in **IAM Identity Center** (or an IAM user with MFA)
   and sign in with that.
3. Create a **budget alert**: Billing → Budgets → Create budget → "Zero spend budget" (or a monthly limit).

## 2. Create the server

EC2 → **Launch instance**:

- **Name:** `paint-together`.
- **AMI:** Ubuntu Server 24.04 LTS (64-bit x86; or Arm with a `t4g` instance).
- **Instance type:** `t3.small` is comfortable; `t3.micro` works with swap (step 5).
- **Key pair:** Create new key pair → type **ED25519**, format `.pem` → download it and keep it private
  (`chmod 400 paint-key.pem` on Mac/Linux).
- **Network settings → Edit → Create security group** named `paint-together-sg` with exactly these inbound rules:

  | Type | Port | Source | Why |
  | --- | --- | --- | --- |
  | SSH | 22 | **My IP** | only you can log in |
  | HTTP | 80 | Anywhere (0.0.0.0/0 and ::/0) | Let's Encrypt checks and redirect to HTTPS |
  | HTTPS | 443 (TCP) | Anywhere (0.0.0.0/0 and ::/0) | the game |
  | Custom UDP | 443 | Anywhere (0.0.0.0/0 and ::/0) | optional: faster HTTP/3 |

  Nothing else. In particular don't open port 3000.
- **Storage:** 20 GiB gp3, and under Advanced tick **Encrypted**.
- **Advanced details:**
  - **Metadata version:** *V2 only (token required)*. This blocks a classic way of stealing cloud credentials.
  - **IAM instance profile:** none. The server doesn't need any AWS permissions.

Click **Launch instance**.

If your home IP changes later, update the SSH rule (EC2 → Security Groups → `paint-together-sg` → Edit inbound
rules → SSH → My IP).

## 3. Give it a fixed IP address

EC2 → **Elastic IPs** → **Allocate Elastic IP address** → **Allocate**, then **Actions → Associate Elastic IP
address** → choose the instance → **Associate**. Note the address (`YOUR_ELASTIC_IP`).

## 4. Point your domain at it

At your domain's DNS provider (Route 53 → Hosted zones, or your registrar):

- Add an **A record**: name `paint` (or `@` for the bare domain), value `YOUR_ELASTIC_IP`.
- Optional but recommended: a **CAA record** on the domain with value `0 issue "letsencrypt.org"`, so only Let's
  Encrypt may issue certificates for it.

Wait until `nslookup paint.example.com` shows your Elastic IP before step 8. Let's Encrypt checks it.

## 5. Log in and harden the server

```bash
ssh -i paint-key.pem ubuntu@YOUR_ELASTIC_IP
```

Then, on the server:

```bash
# all updates now; security updates install themselves from now on
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y unattended-upgrades && sudo dpkg-reconfigure -f noninteractive unattended-upgrades

# SSH: keys only, no root login, no passwords
sudo tee /etc/ssh/sshd_config.d/99-hardening.conf >/dev/null <<'CONF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
X11Forwarding no
CONF
sudo sshd -t && sudo systemctl reload ssh

# swap (needed on t3.micro, harmless elsewhere)
sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

sudo reboot   # picks up a new kernel if one was installed
```

Keep your current SSH window open until you've checked you can still log in from a new one.

## 6. Install Docker

Log back in, then:

```bash
curl -fsSL https://get.docker.com | sudo sh
```

Use `sudo docker …` rather than adding your user to the `docker` group: membership in that group is equivalent to
full root access.

Note: Docker opens the ports it publishes past Ubuntu's `ufw` firewall, so the **AWS security group is the
firewall that counts** here. The setup publishes only 80 and 443 to the world, and the game's own port 3000 only to
the server itself (`127.0.0.1`).

## 7. Get the game and set its secrets

```bash
git clone https://github.com/stonedcarrot/paint-by-numbers.git paint-together
cd paint-together
```

(Or copy the zip up from your computer with `scp -i paint-key.pem paint-together.zip ubuntu@YOUR_ELASTIC_IP:` and
`unzip` it.)

Create the settings file, readable only by you:

```bash
umask 077
echo "DOMAIN=paint.example.com" > deploy/.env
echo "ADMIN_TOKEN=$(openssl rand -hex 32)" >> deploy/.env
echo "UPLOAD_QUOTA_MB=100" >> deploy/.env
cat deploy/.env        # copy the ADMIN_TOKEN into your password manager
```

## 8. Start it

```bash
sudo docker compose -f deploy/docker-compose.https.yml --env-file deploy/.env up -d --build
sudo docker compose -f deploy/docker-compose.https.yml --env-file deploy/.env logs -f caddy
```

Within a minute the Caddy log shows `certificate obtained successfully` for your domain (press Ctrl+C to stop
watching). Open `https://paint.example.com`: you should see the game with a padlock, and `http://` should send
you to `https://`. Both containers restart by themselves after crashes and reboots.

If the certificate fails, check that DNS points at the Elastic IP and that ports 80 and 443 are open in the
security group. Don't keep deleting the `caddy-data` volume to retry: Let's Encrypt limits how many certificates
one domain can get per week.

## 9. Using the admin page

The admin page (featured pictures, storage requests, removing players' pictures) answers **404** on your public domain. To use it, open an SSH tunnel
from your own computer:

```bash
ssh -i paint-key.pem -N -L 8765:127.0.0.1:3000 ubuntu@YOUR_ELASTIC_IP
```

Leave that running, open <http://localhost:8765/admin> in your browser, and sign in with the `ADMIN_TOKEN`.
(`8765` is the port on your computer and can be any free one. On Windows, ports such as 3000 are often reserved by
Hyper-V, WSL or Docker Desktop and give `bind ... Permission denied`; just pick another number.) The
traffic travels inside the encrypted SSH connection. Close the tunnel with Ctrl+C when you're done.

To change the admin password, edit `deploy/.env` and run the start command from step 8 again.

## 10. Check it's locked down

From your own computer:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://paint.example.com/admin            # 404
curl -s -o /dev/null -w "%{http_code}\n" https://paint.example.com/api/admin/users  # 404
curl -s -o /dev/null -w "%{http_code}\n" --max-time 5 http://YOUR_ELASTIC_IP:3000/ # 000 (not reachable)
curl -sI https://paint.example.com | grep -i strict-transport                         # HSTS header present
```

You can also run your domain through <https://www.ssllabs.com/ssltest/> to check the HTTPS setup.

## Keeping it healthy

- **Updates to the game:** `git pull`, then the start command from step 8. Saved games are kept.
- **Updates to Caddy and the base image** (every month or so):
  ```bash
  sudo docker compose -f deploy/docker-compose.https.yml --env-file deploy/.env pull caddy
  sudo docker compose -f deploy/docker-compose.https.yml --env-file deploy/.env build --pull
  ```
  then the start command from step 8.
- **OS updates:** security patches install automatically. Run `sudo apt update && sudo apt full-upgrade -y` and
  reboot now and then for the rest.
- **Backups:** EC2 → Lifecycle Manager → create a policy that takes a daily **EBS snapshot** of the server's volume
  and keeps the last 7. Or back up just the game data with the command in [DEPLOY.md](../DEPLOY.md#backups).
- **Logs** are capped at 30 MB per container, so they can't fill the disk.

## What protects what

| Risk | Protection |
| --- | --- |
| Someone opens the admin page | Blocked by Caddy on the public domain; only reachable through your SSH tunnel; still needs the 64-character admin password; failed sign-ins are slowed down |
| Someone logs in to the server | SSH only from your IP, keys only, no root, no passwords |
| A bug in the game is used to change the server | Game runs as a normal user in a read-only container with no Linux capabilities and `no-new-privileges`; only its data volume is writable; no Docker socket is mounted |
| Stolen AWS credentials from the server | No IAM role on the instance and IMDSv2 required |
| Traffic snooped or tampered with | HTTPS everywhere with HSTS; HTTP redirects to HTTPS |
| Malicious scripts in the page | Strict Content-Security-Policy: only the game's own scripts run, and the page can't be framed |
| Disk or memory exhaustion | Memory and process limits per container, capped logs, per-player storage limits |
| Surprise bills | Budget alert; Elastic IP stays attached (an unattached one is billed) |
