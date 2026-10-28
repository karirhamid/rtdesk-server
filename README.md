# RTDesk Server

The server side of **RTDesk**, the RIRAKTECH remote-support system: the ID server (`hbbs`), the relay
(`hbbr`) and the device console, in one Docker image. It works with the RTDesk client and the RTDesk
management console.

## Run

```
docker run -d --name rtdesk-server   -p 21115-21117:21115-21117 -p 21116:21116/udp -p 8080:8080   -e APP_URL=https://rtdesk.example.com   -v rtdesk-data:/data   ghcr.io/karirhamid/rtdesk-server:latest
```

- `APP_URL` is the public address: the ID server tells clients the relay is at its host, port 21117.
- `/data` holds the server key pair, the device database and the console database. Back it up.
- Put the console (port 8080) behind a TLS reverse proxy; clients use `/api` and `/ws` on it.

## Build

```
docker build -t rtdesk-server .
```

The image workflow (`.github/workflows/docker-release.yml`) builds and publishes
`ghcr.io/karirhamid/rtdesk-server` when a release is published, or by hand from the Actions tab.

The in-browser client is TypeScript under `webclient/`; its built output in `public/rdclient/` is
committed. After changing it: `cd webclient && npm ci && node esbuild.mjs`.

## License

Copyright (C) 2026 RIRAKTECH SARL. Licensed under the **GNU AGPL v3.0 only** (see `LICENSE`).

RTDesk Server is based on [CortenDesk](https://github.com/marcpope/cortendesk) 1.15.0 by Marc Pope and
contributors, also AGPL-3.0. `NOTICE` lists what was changed and the third-party files with their own
licenses.
