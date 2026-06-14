# Silent Cinema Web-App

Zeitsynchrone Web-App für einen Filmabend mit Beamer: Das Video läuft stumm auf dem Leiter-Laptop, die Tonspur liegt lokal auf jedem Handy und wird per Web Audio API synchron gestartet. Über das Netz laufen nur Uhr-Sync und Steuerbefehle, kein Audio-Streaming.

## Struktur

```text
public/
  index.html
  app.js
  styles.css
  sw.js
  Bohemian_Rhapsody.m4a
server/
  server.js
  package.json
README.md
```

## 1. Strato-Upload

1. Lege `Bohemian_Rhapsody.m4a` in `public/`. Empfohlen ist AAC in einem `.m4a`-Container, damit iOS Safari `decodeAudioData` zuverlässig unterstützt.
2. Trage nach dem Render-Deploy in `public/app.js` oben die echte WebSocket-URL ein:

```js
const SYNC_SERVER_URL = "wss://DEINE-RENDER-APP.onrender.com";
```

3. Lade den Inhalt von `public/` per FTP nach Strato hoch, so dass `index.html`, `app.js`, `styles.css`, `sw.js` und `Bohemian_Rhapsody.m4a` direkt unter `https://audio.maxpfannkuch.de/` liegen.
4. Öffne die Seite einmal über HTTPS und prüfe, ob der Service Worker registriert wird. Beim ersten Besuch wird `Bohemian_Rhapsody.m4a` gecacht.

## 2. Render-Deploy

1. Lege ein neues Render Web Service Projekt an.
2. Nutze `server/` als Root Directory.
3. Build Command:

```bash
npm install
```

4. Start Command:

```bash
npm start
```

5. Render setzt `PORT` automatisch. Der Server antwortet auf `GET /` mit einem einfachen Healthcheck und nimmt WebSocket-Verbindungen auf derselben URL an.

## 3. Event-Ablauf

1. Verschicke den Link `https://audio.maxpfannkuch.de/` vorab an alle Gäste. Sie sollen die Seite einmal öffnen, damit die Tonspur lokal gecacht wird.
2. Bitte alle, Kabelkopfhörer zu verwenden. Bluetooth-Latenz schwankt und ist für Lippensynchronität ungeeignet.
3. Bitte iPhone- und Android-Nutzer, die Auto-Sperre möglichst auszuschalten und die Seite während des Films sichtbar zu lassen.
4. Wecke den Render-Server kurz vor Beginn einmal auf, indem du seine URL im Browser öffnest.
5. Öffne auf dem Leiter-Laptop `https://audio.maxpfannkuch.de/?role=leader`.
6. Wähle im Leiter-Modus die lokale Videodatei aus. Sie bleibt auf dem Laptop und wird nicht hochgeladen.
7. Alle Gäste tippen auf `Beitreten und Ton laden`, bis `Tonspur bereit` und eine Synchronitätsanzeige erscheint.
8. Messe die Lippensynchronität mit dem Offset-Slider ein. Positive Werte starten den Handy-Ton später, negative früher.
9. Klicke im Leiter-Bedienfeld auf `Start`. Der Server verteilt eine geplante Startzeit an alle Geräte.

## Hinweise zur Technik

- Der Client misst die Serveruhr im NTP-Stil per WebSocket-Pings und behält die Messung mit der kleinsten Roundtrip-Zeit.
- Starts werden gegen `AudioContext.getOutputTimestamp()` geplant, damit die Web-Audio-Zeit sauber auf die gemeinsame Uhr abgebildet wird.
- Kleine Abweichungen werden über `playbackRate` unauffällig korrigiert. Größere Abweichungen führen zu einem harten Neuansetzen an der Sollposition.
- Der Server hält den Zustand nur im Speicher: `{ playing, startServerTime, position }`. Nach einem Render-Restart ist der Zustand zurückgesetzt.
- Nur der erste verbundene Client mit `?role=leader` darf Steuerbefehle senden.
