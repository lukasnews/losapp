# 🎁 Live-Auslosung für Twitch

Web-App für Live-Verlosungen im Stream: Zuschauer schreiben ein Schlüsselwort (z.B. `!join`) in den Chat, die App prüft automatisch die Teilnahmebedingungen und zieht fair (gewichtet, kryptografisch zufällig) einen oder mehrere Gewinner. Ein OBS-Overlay zeigt alles live im Stream.

## Funktionen

**Steuerung (Dashboard, auch auf dem Handy)**
- Teilnahme öffnen / schließen, optional mit Countdown
- Gewinner ziehen, neu ziehen, manuell bestätigen
- Teilnehmerliste mit Suche, Gewicht und Gewinnchance; einzelne Teilnehmer entfernen
- Liste der Abgelehnten mit Begründung, Protokoll aller Aktionen, Verlauf vergangener Verlosungen

**Prüfbare Teilnahmebedingungen (alle einstellbar)**
| Bedingung | Quelle |
|---|---|
| Muss dem Kanal folgen, optional mind. X Tage | Twitch API (Follower) |
| Nur Abonnenten, Mindest-Abostufe | Twitch API (Subscriptions) |
| Twitch-Konto mind. X Tage alt (gegen Zweitkonten) | Twitch API (Users) |
| Streamer / Mods / VIPs ausschließen | Chat-Badges + Twitch API |
| Gewinner der letzten X Verlosungen ausschließen | eigener Verlauf |
| Sperrliste | Einstellungen |
| Max. Teilnehmerzahl | Einstellungen |
| Erneute Prüfung beim Ziehen (wer entfolgt, fliegt raus) | Twitch API |

Wenn Twitch bei einer Prüfung nicht antwortet, wird die Teilnahme **abgelehnt** statt ungeprüft zugelassen.

**Glückschance:** Multiplikatoren für Abo Stufe 1/2/3 und VIPs (z.B. Abo Stufe 3 = doppelte Chance).

**Gewinner-Bestätigung:** Der Gewinner muss sich innerhalb von X Sekunden im Chat melden, sonst wird automatisch neu gezogen.

**Chat:** Start, Ende, Gewinner, Bestätigung, Ablehnungsgrund: jede Nachricht ist an-/abschaltbar und frei formulierbar (Platzhalter wie `{user}`, `{prize}`, `{keyword}`).

**Prüfen & Testen**
- Beliebigen echten Twitch-Nutzer gegen die aktuellen Bedingungen prüfen (✔/✘ pro Bedingung)
- Testmodus: simulierte Zuschauer mit frei wählbaren Eigenschaften (folgt seit X Tagen, Abo-Stufe, VIP, Mod, Konto-Alter) eine Chat-Nachricht schreiben lassen
- Massentest: bis zu 500 zufällige Testzuschauer auf einmal
- Testnachricht in den echten Chat senden

**OBS-Overlay:** transparente Browserquelle mit Teilnahme-Aufruf, Live-Zähler, neuen Teilnehmern, Ziehungs-Animation und Konfetti. Farbe, helles/dunkles Design und Animationsdauer sind einstellbar. Der Link enthält einen geheimen Schlüssel, der sich jederzeit neu erzeugen lässt.

**Nachvollziehbare Ziehung:** Für jeden Gewinner werden Wurf, Gesamtgewicht, Poolgröße und Chance gespeichert.

## Einrichtung

Voraussetzung: Node.js 20 oder neuer.

```bash
npm install
cp .env.example .env
```

### 1. Twitch-App anlegen
1. Auf https://dev.twitch.tv/console/apps eine Anwendung registrieren
2. **OAuth Redirect URL:** `<BASE_URL>/auth/callback` (lokal: `http://localhost:3000/auth/callback`)
3. Kategorie: z.B. „Chat Bot“; Client-Typ: **Vertraulich**
4. Client-ID und Client-Secret in die `.env` eintragen

### 2. Starten
```bash
npm start
```
Dann `http://localhost:3000` öffnen und **mit dem Twitch-Konto des Kanals** anmelden. Die App fragt dabei die Berechtigungen für Chat, Follower, Abonnenten, VIPs und Moderatoren ab.

Der erste Login legt den Kanal fest; danach kann sich nur dieses Konto per Twitch anmelden. Alternativ lässt sich der Kanal mit `ALLOWED_LOGIN` fest vorgeben.

### Testmodus ohne Twitch
`ADMIN_PASSWORD` in der `.env` setzen und ohne Twitch-Daten starten. Dann über das Passwort anmelden und im Reiter **Prüfen & Testen** mit simulierten Zuschauern spielen. Das Passwort eignet sich auch, um einem Mod Zugriff aufs Dashboard zu geben.

### 3. Overlay in OBS
Im Dashboard unter **OBS-Overlay** den Link kopieren → in OBS *Quelle hinzufügen → Browser* → URL einfügen, Größe 1920×1080.

## Online betreiben (für „alles per Web“)

Die App läuft als normaler Node-Server, z.B. auf einem kleinen VPS, Render, Railway oder Fly.io:
- `BASE_URL` auf die öffentliche HTTPS-Adresse setzen (dann sind die Cookies automatisch `Secure`)
- Redirect-URL in der Twitch-Konsole entsprechend anpassen
- Den Ordner `data/` (bzw. `DATA_DIR`) dauerhaft speichern: dort liegen Einstellungen, Verlauf und das Twitch-Token

## Tests
```bash
npm test
```

## Aufbau
```
server.js           HTTP-Server, Login, REST-API, WebSocket
src/giveaway.js     Verlosungslogik: Prüfungen, Gewichtung, Ziehung, Bestätigung
src/twitch.js       Twitch OAuth + Helix API (mit Token-Refresh und Cache)
src/checker.js      Prüfdaten: echte Twitch-Abfragen oder simulierte Testnutzer
src/chat.js         Twitch-Chat (tmi.js)
src/store.js        JSON-Speicher in data/
public/             Login, Dashboard, Overlay
test/               Tests der Verlosungslogik
```
