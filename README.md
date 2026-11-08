# Requester

A local-first desktop API client for testing REST and GraphQL APIs. No account or login needed — everything is stored on your machine.

## Features

- **REST & GraphQL** — all common HTTP methods; GraphQL query + variables editor
- **Request bodies** — JSON (with validation & beautify), GraphQL, form URL-encoded, multipart (text + file uploads), plain text, XML, binary file
- **Auth** — Bearer token, Basic auth, API key (header or query), inherited from folder/collection
- **Headers & params** — key/value editors with enable/disable toggles; query params stay in sync with the URL
- **Collections & folders** — group requests, nest folders, drag & drop to reorder, duplicate, rename
- **Environments & variables** — `{{baseUrl}}`, `{{token}}` etc.; collection variables; built-ins `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$uuid}}`, `{{$randomInt}}`
- **Response viewer** — pretty/raw JSON with highlighting, HTML & image preview, headers, timing, size, redirects, sent headers; save to file
- **Import / export** — Requester JSON, Postman Collection v2/v2.1, Postman environments, cURL (paste a cURL command straight into the URL bar); copy any request as cURL
- **Settings** — dark/light/system theme, side-by-side or stacked layout, timeout, redirects, SSL verification

## Install on Ubuntu

```bash
npm install
npm run dist            # builds dist/requester_1.0.0_amd64.deb and dist/Requester-1.0.0.AppImage
sudo apt install ./dist/requester_1.0.0_amd64.deb
```

Then launch **Requester** from the app menu, or run `requester` in a terminal.
To uninstall: `sudo apt remove requester`.

Alternatively run the AppImage directly: `chmod +x dist/Requester-*.AppImage && ./dist/Requester-*.AppImage`.

## Development

```bash
npm install
npm start
```

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| Ctrl+Enter | Send / cancel request |
| Ctrl+N | New request |
| Ctrl+Shift+N | New collection |
| Ctrl+O | Import |
| Ctrl+L | Focus URL bar |
| Ctrl+W | Close tab |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous tab |

## Data

Data is saved automatically to `~/.config/Requester/requester-data.json`.
