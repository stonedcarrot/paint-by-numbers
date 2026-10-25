# Paint Together

A multiplayer paint-by-numbers game that runs in the browser. Upload any image, it is turned into numbered
colour regions (in the spirit of [pbnify](https://github.com/daniel-munro/pbnify)), and up to 10 people paint it
together in real time from a shareable link.

## Run it with Docker

```bash
docker compose up -d --build      # http://localhost:3000
```

or without Compose:

```bash
docker build -t paint-together .
docker run -d --name paint-together -p 3000:3000 -v paint-data:/data paint-together
```

Pictures, players, friends and painting progress are stored in the `/data` volume, so they survive restarts and
upgrades. To manage the featured pictures from the host instead of rebuilding the image, mount your own folder:
`-v "$PWD/featured:/app/featured:ro"` (see the commented line in `docker-compose.yml`).

To put it on the internet for free (Oracle Cloud, Google Cloud, AWS, Render or your own computer), with
automatic HTTPS, follow **[DEPLOY.md](DEPLOY.md)**.

## Run it without Docker

Requires Node.js 18 or newer.

```bash
npm install
npm start            # http://localhost:3000  (set PORT to change)
```

Other people on your network can join through `http://<your-computer's-IP>:3000`. To play over the internet, see
[DEPLOY.md](DEPLOY.md).

## How to play

### Featured pictures (solo or together)

The home page shows a **Picture of the day** with its artist, a short bio and their links, plus a gallery of the other
featured pictures. Every picture has two buttons:

- **Paint solo**: your own private copy. You can still share its invite link later if you want company.
- **Paint with others**: drops you into the shared public canvas for that picture, the busiest one with a free spot,
  so anyone who hops on paints together. A new one opens when a canvas is full (10 painters) or finished.

The artist credit stays visible while painting (click their name) and on the finished-picture screen.

### Your own pictures

1. Enter your name, then **Choose an image**. Pick the number of colours and the level of detail and preview the
   numbered outline, the finished look, or the original. Pictures are painted at their own size up to Full HD
   (1920×1080, either orientation); bigger images are scaled down to fit and smaller ones keep their native size.
2. **Start painting**, then share the invite link (or its 6-letter code) with up to 9 friends if you want company.
3. Pick a colour at the bottom; regions with that number are shaded grey. Tap/click a region to fill it. Wrong
   colours aren't accepted and the right colour swatch wiggles.
4. Everyone sees fills, live cursors and chat instantly. When the last region is filled, everyone gets the finished
   picture, a scoreboard and a download button.

Controls: drag to pan, scroll or pinch to zoom, `+` / `-` / `0` to zoom or fit, `[` / `]` (or arrow keys) to switch colour.
The 👁 button peeks at the original image.

### Picture storage and the admin page

The server keeps every uploaded picture so other players can open it (it isn't peer-to-peer). What's stored is the
converted puzzle plus a small preview, not your original file, so a Full HD picture usually takes well under 1 MB.
Each player gets **100 MB** for pictures they upload (set `UPLOAD_QUOTA_MB` to change the default). Usage is shown
under **Your pictures** on the home page, where players can delete their own pictures to free space or click
**Request more space** to ask for a higher limit with a short note. Featured pictures don't count.

Requests go to the admin page at `/admin`. In the public HTTPS setup (`deploy/`) that page is blocked on the public
domain and opened through an SSH tunnel instead; see [deploy/AWS-EC2-SECURE.md](deploy/AWS-EC2-SECURE.md#9-using-the-admin-page). Turn it on by setting the `ADMIN_TOKEN` environment variable to a long
random password (for example from `openssl rand -hex 24`), then sign in with it. The page lists waiting requests
(**Set limit** to approve with any amount, or **Decline**) and every player's usage, so you can change anyone's
limit. Players get a message as soon as their request is handled.

```bash
docker run -d --name paint-together -p 3000:3000 -v paint-data:/data \
  -e ADMIN_TOKEN=your-long-random-password -e UPLOAD_QUOTA_MB=100 paint-together
```

### Featuring artists

Featured pictures live in the `featured/` folder: put the image (PNG, JPEG, WebP or SVG) in it and add an entry to
`featured/featured.json`:

```json
{
  "id": "harbour-morning",
  "title": "Harbour Morning",
  "image": "art/harbour-morning.jpg",
  "colors": 16,
  "detail": "medium",
  "date": "2026-11-02",
  "artist": {
    "name": "Artist Name",
    "bio": "One or two lines about the artist.",
    "links": [
      { "label": "Instagram", "url": "https://instagram.com/..." },
      { "label": "Shop", "url": "https://..." }
    ]
  }
}
```

`date` is optional. A picture whose date is today (UTC) is the Picture of the day; on other days the undated pictures
rotate daily. `colors` is 4 to 30, `detail` is `low`, `medium` or `high`, and links must start with `https://`. The
server turns each image into a puzzle once and caches it in `/data`. Edits to `featured.json` are picked up without a
restart. Only feature artwork you have the artist's permission to use.

The six bundled pictures are simple sample illustrations made for this project, and their `example.com` links are
placeholders: replace them with your featured artists.

### Friends

Every player gets a 6-character friend code (home screen, or 👥 in a game). Add a friend by their code; once they
accept you can see when they're online and which picture they're painting, **Join** them with one click (if the
picture isn't full), or **Invite** them to yours. Your identity is kept in your browser's local storage, so use the same
browser to keep your friends and pictures.

## How it works

Large pictures stay smooth to paint: each fill redraws only the area around that region instead of the whole
picture.

- `public/pbn.js`: the image → paint-by-numbers converter (blur, k-means colour clustering in Lab space, mode-filter
  smoothing, connected regions, merging tiny regions, and a distance transform to place each number at the most
  open spot in its region). It runs in a Web Worker in the browser, so the server never processes images.
- `featured.js`: loads `featured/featured.json`, converts featured images into puzzles on the server (with
  [sharp](https://sharp.pixelplumbing.com/)) and picks the Picture of the day.
- `server.js`: a small Node server (dependencies: `ws`, `sharp`) serving the client and a WebSocket API for rooms (max
  10 players), painting (validated against the puzzle), cursors, chat, friends and invites.
- Pictures and players are saved as JSON under `data/` (set `DATA_DIR` to change), so games survive restarts.

## Tests

```bash
npm run test:e2e
```

Starts a server on port 3457 and drives 11+ headless Chromium players through: creating a picture from an uploaded
image, 9 players joining by link, an 11th being turned away, real mouse painting, wrong-colour rejection, live
cursors, chat, friend requests, joining a friend from the friends list, invites, the whole group finishing the picture,
a server restart keeping progress, the Picture of the day with artist links, two players landing in the same shared
featured canvas, Paint solo giving a private copy, and the mobile layout.

To run the same checks against the Docker container:

```bash
docker run -d --name paint-together -p 3000:3000 -v paint-data:/data paint-together
E2E_URL=http://localhost:3000 E2E_RESTART="docker restart paint-together" npm run test:e2e
``` Set `CHROMIUM=/path/to/chrome` if Playwright's browser
isn't installed (`npx playwright install chromium`).
