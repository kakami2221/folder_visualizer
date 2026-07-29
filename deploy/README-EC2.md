# Folder Visualizer EC2 production deployment

This guide deploys the Flask shell to EC2. Folder selection, metadata analysis,
searching, comparisons, and exports remain inside each user's browser. There is
no upload API, and local filenames, paths, search terms, or IndexedDB results
must not be added to server logs.

## Recommended topology

```text
Browser -- HTTPS --> Nginx -- HTTP/loopback --> Gunicorn -- Flask
                 local browser: Worker + IndexedDB
```

The baseline below targets Ubuntu 24.04 LTS on a small `t3.micro` or
`t3.small`. Analysis runs in the browser, so two Gunicorn workers with four
threads are intentionally conservative.

## 1. AWS, DNS, and Security Group

1. Allocate an Elastic IP and associate it with the EC2 instance.
2. Add an `A` record for the public domain to that Elastic IP. Add `AAAA` only
   when the instance is configured for IPv6.
3. Configure the EC2 Security Group:
   - TCP 22 from a fixed administrator IP only.
   - TCP 80 from `0.0.0.0/0` and `::/0` for ACME and HTTP redirect.
   - TCP 443 from `0.0.0.0/0` and `::/0`.
   - Do **not** expose port 8000. Gunicorn binds to loopback.
4. Confirm DNS propagation:

   ```bash
   dig +short example.com
   ```

## 2. Non-Docker deployment (Gunicorn + systemd)

Copy or clone this repository onto the instance. Then run:

```bash
cd /path/to/folder-visualizer
chmod +x deploy/*.sh
sudo APP_DOMAIN=example.com \
  CERTBOT_EMAIL=admin@example.com \
  ./deploy/install.sh
```

The installer:

- installs Python, Nginx, Certbot, and rsync;
- creates the unprivileged `folderviz` account;
- places an immutable release in `/opt/folder-visualizer/releases/`;
- generates `/etc/folder-visualizer/folder-visualizer.env` with a random
  `SECRET_KEY`, and atomically aligns `APP_VERSION` with the target release;
- installs and starts the hardened systemd service;
- obtains a Let's Encrypt certificate when `CERTBOT_EMAIL` is supplied;
- changes Nginx from the HTTP bootstrap config to HTTPS; and
- verifies `GET /health`.

Review the generated environment file after installation:

```bash
sudoedit /etc/folder-visualizer/folder-visualizer.env
sudo systemctl restart folder-visualizer
```

Keep its owner/group as `root:folderviz` and mode as `0640`.
The deployment scripts preserve those attributes and every setting other than
`APP_VERSION` when switching releases.

`APP_VERSION` is also the namespace for versioned asset URLs. Whenever a
release changes CSS, JavaScript, a Worker, or Plotly.js, assign a new
`APP_VERSION`; never publish different bytes under an existing version. Use
at most 128 ASCII letters, digits, or `. _ + ~ -`; the app rejects an unsafe
identifier during startup.

## 3. HTTPS with Nginx and Certbot

The install command above is the normal path. For a manual certificate setup:

1. Replace `example.com` in `nginx/bootstrap.conf` and enable that file.
2. Verify Nginx and open port 80:

   ```bash
   sudo nginx -t
   sudo systemctl reload nginx
   ```

3. Request the certificate:

   ```bash
   sudo certbot certonly \
     --webroot \
     --webroot-path /var/www/certbot \
     --domain example.com \
     --email admin@example.com \
     --agree-tos \
     --no-eff-email
   ```

4. Replace `example.com` in `nginx/default.conf`, copy it to
   `/etc/nginx/conf.d/folder-visualizer.conf`, run `sudo nginx -t`, and reload
   Nginx. The final config redirects HTTP to HTTPS and enables HSTS.
5. Enable renewal and test it without changing the certificate:

   ```bash
   sudo systemctl enable --now certbot.timer
   sudo certbot renew --dry-run
   systemctl list-timers certbot.timer
   ```

The installer places a Certbot deploy hook that validates and reloads Nginx
after a successful renewal.

Do not enable HSTS for a domain until HTTPS works on every required subdomain.

## 4. HTTPS with ALB and ACM

An Application Load Balancer can terminate TLS instead:

1. Request or import the certificate in AWS Certificate Manager in the ALB
   region and complete DNS validation.
2. Create an HTTPS/443 listener with that certificate.
3. Redirect the ALB HTTP/80 listener to HTTPS/443.
4. Use an HTTP target group that checks `/health` and forwards to Nginx on port
   80 in the instance's private Security Group.
5. Allow instance port 80 only from the ALB Security Group; do not expose
   Gunicorn port 8000.
6. Configure the public DNS alias to the ALB.
7. Preserve `X-Forwarded-Proto` and leave `TRUST_PROXY_HEADERS=true`.

When the ALB is the only TLS endpoint, use an Nginx variant without local
certificate directives and redirect according to the trusted
`X-Forwarded-Proto` header. Never trust that header from the public internet
without the ALB/instance Security Group boundary.

## 5. Docker deployment

Docker runs Gunicorn in a read-only, unprivileged container and publishes it
only on host loopback. Host Nginx still handles HTTPS:

```bash
cp .env.example .env
python3 -c 'import secrets; print(secrets.token_urlsafe(64))'
```

Paste the generated secret into `.env`, set `APP_BASE_URL`, and keep
`APP_VERSION` equal to the code in that image. Bump it whenever that release
changes an asset, then:

```bash
docker compose build --pull
docker compose up -d
docker compose ps
curl --fail http://127.0.0.1:8000/health
```

Configure host Nginx and Certbot as in section 3. The supplied Nginx
configuration proxies `/assets/<version>/<path>` to Flask; Flask serves bytes
only when the URL version exactly matches the running `APP_VERSION`. Do not
rewrite versioned URLs to a single unversioned static directory. In production,
successful versioned assets are cached for one year as `public, immutable`.
Development and testing responses are `no-cache`, as are the compatibility
URLs `/static/...` and `/plotly.js`.

The compose file deliberately does not publish port 8000 beyond `127.0.0.1`.
Relative ES module imports and module Worker URLs resolve from their entry
script, so the complete dependency graph retains the same
`/assets/<APP_VERSION>/` prefix.

## 6. Gunicorn settings

The following environment variables are validated and bounded by
`gunicorn.conf.py`:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `GUNICORN_BIND` | `127.0.0.1:8000` | Listening address |
| `GUNICORN_WORKERS` | `2` | Worker processes |
| `GUNICORN_THREADS` | `4` | Threads per worker |
| `GUNICORN_TIMEOUT` | `30` | Hard timeout in seconds |
| `GUNICORN_GRACEFUL_TIMEOUT` | `30` | Graceful restart timeout |
| `GUNICORN_ACCESS_LOG` | app log directory | Access log |
| `GUNICORN_ERROR_LOG` | app log directory | Error log |
| `GUNICORN_MAX_REQUESTS` | `1000` | Recycle threshold |
| `GUNICORN_MAX_REQUESTS_JITTER` | `100` | Randomized recycle offset |
| `GUNICORN_PRELOAD` | `false` | Preload the Flask app |

Gunicorn's privacy-minimized access format omits the complete request target,
including both URL path and query string.

## 7. Update

Transfer or check out the new source on the server, run its tests, then:

```bash
cd /path/to/new/folder-visualizer
sudo SOURCE_DIR="$PWD" ./deploy/update.sh
```

Set the target version in the new source's `.env.example` before running the
command. A release that changes any asset must use a new value. The update
script validates that URL-safe value and verifies that the starting release
matches the active environment. It then atomically replaces only the
environment file's `APP_VERSION`, preserving `SECRET_KEY`, all other values,
owner/group, and mode, before switching the release symlink.

The update script first creates a backup, installs into a timestamped release,
switches the `current` symlink, restarts Gunicorn, and requires `/health` to
return the target version. If link switching, restart, or the versioned health
check fails, it atomically restores the previous `APP_VERSION`, restores the
prior symlink, restarts the previous release, and verifies its version. Version
values and environment contents are not printed.

If Nginx or systemd configuration changed, compare and install those files
explicitly, run `nginx -t`/`systemd-analyze verify`, then reload the service.

## 8. Backup

```bash
sudo /opt/folder-visualizer/current/deploy/backup.sh
```

Backups are mode `0600` archives under `/var/backups/folder-visualizer`.
They contain the active release reference, server environment, Nginx config,
and systemd unit. Browser IndexedDB belongs to the browser and is never copied
to EC2.

Copy encrypted backups to a separate account or storage location and define an
independent retention policy.

## 9. Rollback

List retained releases:

```bash
ls -1 /opt/folder-visualizer/releases
```

Rollback to the most recent release other than the current one:

```bash
sudo /opt/folder-visualizer/current/deploy/rollback.sh
```

Or choose an exact timestamped release:

```bash
sudo /opt/folder-visualizer/current/deploy/rollback.sh 20260728093000
```

The rollback reads and validates `APP_VERSION` from the target release's
`.env.example`, atomically applies it before switching the symlink, and checks
that `/health` returns that version. Manual environment editing is unnecessary.
If the selected release fails, the script restores both the starting version
and symlink before restarting and verifying the starting release. Other
environment values and file ownership/mode remain unchanged.

## 10. Operations and logs

```bash
sudo systemctl status folder-visualizer nginx
sudo journalctl -u folder-visualizer --since today
sudo tail -f /var/log/folder-visualizer/application.log
sudo tail -f /var/log/folder-visualizer/gunicorn-error.log
sudo tail -f /var/log/nginx/folder-visualizer_error.log
curl --fail https://example.com/health
```

Logs are separated into:

- Nginx access and error logs;
- Gunicorn access and error logs; and
- Flask application logs.

`deploy/folder-visualizer.logrotate` retains compressed rotations. The supplied
formats exclude the request target (URL path and query string), referrers,
user-agent strings, local filenames, local folder names, IndexedDB results,
search terms, and exported report contents.

## 11. Security checks

After deployment:

```bash
curl -I https://example.com/
curl https://example.com/health
sudo nginx -t
sudo systemd-analyze verify /etc/systemd/system/folder-visualizer.service
sudo ss -lntp
```

Confirm CSP, `nosniff`, Referrer Policy, Permissions Policy, and HSTS headers.
Only ports 22 (restricted), 80, and 443 should be public. Keep
`FLASK_ENV=production`, never enable Flask debug, protect the secret environment
file, patch the OS regularly, and rebuild/redeploy when fixed dependencies are
updated.

Also confirm that `/assets/<APP_VERSION>/css/style.css` returns a one-year
`public, immutable` policy in production, while `/static/css/style.css` and
`/plotly.js` return `no-cache`. A different version in the `/assets/` URL must
return 404. Nginx proxies `/assets/` to Flask so this exact-version validation
cannot be bypassed.

There are no POST, PUT, PATCH, DELETE, upload, file-management, payment, or
license routes. Normal analysis never reads file content. Explicit duplicate
hashing or project-file inspection reads only in the browser and sends none of
that content to Flask or EC2.

## 12. Troubleshooting

- **502 Bad Gateway:** check `systemctl status folder-visualizer`, Gunicorn
  error logs, and that it listens on `127.0.0.1:8000`.
- **Certificate request fails:** verify DNS, port 80, the ACME webroot, and that
  the temporary bootstrap config is active.
- **Versioned asset 404:** compare the URL version with `/health` and
  `/etc/folder-visualizer/folder-visualizer.env`, then verify the requested path
  exists in the active release's `static/` directory. Nginx must proxy
  `/assets/` to Flask without removing the version segment.
- **Service cannot write logs:** restore ownership
  `folderviz:folderviz` and mode `0750` on `/var/log/folder-visualizer`.
- **Health check returns the wrong version:** do not retry by manually
  inventing a version. Verify the active release's `.env.example` is valid,
  inspect the update/rollback error, and restore from the mode-`0600` backup if
  the script reports that automatic restoration was incomplete.
