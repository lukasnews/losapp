# Übergabe: Multi-Plattform Live-Verlosung

## Ziel
Gewinnspiel über YouTube, Instagram, Snapchat und TikTok mit einstellbaren Bedingungen (Kommentar mit Stichwort, Follower/Abo). Es soll auch spontan live verlost werden können, meist auf TikTok LIVE oder Instagram Live. Die Bedingungen müssen beim Gewinner live geprüft werden.

## Entscheidung: Hybrid-Ansatz
1. Teilnahmen laufend einsammeln (Webhook oder Stream) und in einer gemeinsamen Datenbank speichern.
2. Bei der Ziehung mit kryptografischem Zufall (`crypto.getRandomValues`) aus gültigen Einträgen ziehen.
3. Nur den Gewinner live nachprüfen (Kommentar noch da? folgt/abonniert?). Bei Fehlschlag automatisch neu ziehen.
4. Alles mit Zeitstempel protokollieren. Anzeige im Stream als OBS-Browser-Quelle.

Das spart API-Kosten und Rate-Limits.

## Was jede Plattform hergibt
| Plattform | Kommentare live | Follower-/Abo-Status | Stabilität |
|---|---|---|---|
| Instagram | Offiziell: Webhook `live_comments` (nur während der Übertragung, Advanced Access, App im Live-Modus, Business-/Creator-Account) | Nur über DM: Messaging-API liefert `is_user_follow_business`. Teilnehmer müssen also per DM/Button reagieren | offiziell |
| TikTok LIVE | Keine offizielle API. Inoffiziell: `tiktok-live-connector` (Node) oder EulerStream (WebSocket) | Follow-Events im LIVE inoffiziell, sonst manuell | brüchig, bei Updates Ausfall möglich |
| YouTube | Live-Chat-API und Kommentare, offiziell | `subscriptions.list?mySubscribers=true`, nur eigene Liste, begrenzt, nur öffentliche Abos | stabil |
| Snapchat | Keine brauchbare API für Kommentare/Follower (Public-Profile-API nur Metadaten und Statistiken) | nicht abfragbar | Teilnahme-Formular-Link in der Story oder manuell eintragen |

Folgerung: Immer einen manuellen Bestätigungsschritt einplanen ("Profil im Stream zeigen, bestätigen"), wo die Prüfung nicht automatisch geht.

## Rechtliches (AT/EU)
Teilnahmebedingungen und DSGVO-Hinweis, Teilnahme kostenlos (sonst Glücksspiel-Risiko), Plattformregeln (z. B. Meta-Hinweis "nicht von Meta unterstützt"). Keine Scraper gegen die Nutzungsbedingungen einsetzen.

## Stand
Es gibt einen klickbaren Frontend-Prototyp: `live-verlosung.html` (eine Datei, Vanilla JS, keine Abhängigkeiten, simulierte Daten).
- Gezeigt: Eingangs-Feed, Walzen-Ziehung, Live-Prüfschritte (✓ / ✕ / ? manuell), Bedingungen, Plattform-Schalter, manuelle Einträge, Protokoll, OBS-Ansicht (grüner Hintergrund).
- Simuliert: alle Eingänge (`makeEntry`) und alle Prüfungen (`checksFor`). Das sind die Stellen, an die echte Daten gehören.

## Nächste Schritte (Vorschlag)
1. Kleiner Node/TypeScript-Server (z. B. Fastify) mit SQLite: Tabelle `entries` (platform, handle, text, ts, meta), `draws` (Protokoll), Konfiguration der Bedingungen.
2. Server-Sent Events oder WebSocket an das Dashboard, damit der Feed echt wird (`addEntry` im Frontend ersetzen).
3. Connectoren einzeln bauen, Reihenfolge: YouTube Live-Chat, dann TikTok (`tiktok-live-connector`), dann Instagram (Webhook, braucht öffentliche HTTPS-URL, z. B. Cloudflare Tunnel; Meta-App-Review), Snapchat als Formular-Endpunkt.
4. `checksFor` durch echte Live-Prüfungen im Server ersetzen (Endpunkt `POST /draw/:id/verify`).
5. Ziehung serverseitig (Zufall und Protokoll nicht im Browser), Dashboard zeigt nur an.
6. Tests: Ziehung nie doppelt, Gewinner-Ausschluss, Dubletten pro Account, Ausfall einer Plattform darf nichts blockieren.

## Startprompt für Claude Code
> Lies HANDOFF.md und live-verlosung.html. Baue den Server aus "Nächste Schritte" in einem neuen Ordner `giveaway/` und mache das Dashboard zum Frontend dafür. Starte mit YouTube als erstem echten Connector und lass die anderen als Mock. Frag mich nur, wenn du API-Keys brauchst.

## Stand aus dem anderen Agenten (Losfee, Stand 25.11.2026)

**Entscheidung des Nutzers: kein eigener Server, keine Kosten, nur GitHub.** Deshalb wurde der Vorschlag oben (Node/Fastify + SQLite, Cloudflare Tunnel) nicht umgesetzt. Stattdessen läuft alles als eine Seite auf GitHub Pages:

- **Seite:** https://lukasnews.github.io/losapp/ (`index.html` auf `main`, Vanilla JS, keine Build-Schritte)
- **Speicher und Login:** Firebase (Projekt `losfee-fd3ce`, E-Mail/Passwort, Firestore). Sicherheitsregeln in `firestore.rules`, getestet mit dem Firebase-Emulator (37 Prüfungen).
- **Ziehung:** im Browser mit `crypto.getRandomValues` (Rejection Sampling, gewichtet nach Losen). Jede Ziehung wird mit Zeit, „Los X von Y“ und Poolgröße gespeichert.

### Was gebaut ist
| Bereich | Umsetzung | Datei |
|---|---|---|
| TikTok LIVE | Euler-Stream-WebSocket direkt im Browser; **jeder Chat-Kommentar enthält `user.followInfo.followStatus`** (0/1/2), dazu Folge-Ereignisse | `index.html` (TikTok-Teil) |
| Instagram | DM mit Stichwort → Cloudflare Worker → `is_user_follow_business` → Firestore-Posteingang (nur Anlegen mit Geheimschlüssel erlaubt) → Losfee live. Live-Kommentare über `live_comments`, falls Meta freigibt. Automatische DM-Antwort optional | `worker/instagram-worker.js` |
| YouTube | Live-Chat (`liveChat/messages`, API-Schlüssel, alle 6 s), Video-Kommentare (`commentThreads`), „Kommentar steht noch?“ (`comments?id=`), Abonnenten über Google-Login (`mySubscribers`, nur öffentliche Abos) | `index.html` (YouTube-Teil) |
| Snapchat & alle anderen | Teilnahme-Link: öffentliche Seite, Zuschauer tragen Namen ein; Regeln erlauben einen Eintrag pro Name und Plattform, nur solange offen | `mitmachen.html` |
| Follower-Listen | Offizieller Daten-Export von Instagram/TikTok (ZIP/JSON/HTML/Text) einlesen und alle Teilnehmer abgleichen | `index.html` |
| Bühne/OBS | Walzen-Ziehung, danach animierte Prüfschritte ✓/✕/? mit „Profil öffnen“, „Bestätigt“/„Nicht erfüllt“/„Neu ziehen“, grüner Hintergrund für OBS, Wartebild mit Zählern | `index.html` |
| Eingang | Gemeinsame Live-Liste aller Quellen mit „zählt / zählt nicht“ | `index.html` |
| Regeln | Bedingungen je Plattform, Pflichtwort, markierte Freunde, Mehrfach-Teilnahme, Bonus-Lose (+X/×X), Preise mit Bestand und Kombis, Sperrliste, frühere Gewinner | `index.html` |
| Rechtliches (DE) | `teilnahmebedingungen.html`, `datenschutz.html`, `impressum.html` (Vorlagen, gelbe Platzhalter ausfüllen), Hinweistext-Knopf „keine Verbindung zu Instagram & Co.“ | |

### Was noch offen ist
1. **Platzhalter** in Teilnahmebedingungen, Datenschutz und Impressum ausfüllen (Name, Anschrift, E-Mail, Alter, Fristen).
2. **Firebase-Regeln veröffentlichen:** Inhalt von `firestore.rules` in die Firebase-Konsole kopieren (Firestore → Regeln). Ohne das funktionieren Teilnahme-Link und Instagram-Posteingang nicht.
3. **Instagram-Einrichtung beim Streamer** (Meta-App, Cloudflare Worker, Webhook). Möglicherweise App-Prüfung durch Meta nötig. Noch nicht mit echtem Instagram getestet.
4. **TikTok und YouTube mit echtem Stream testen.** Getestet wurde nur mit nachgebauten Schnittstellen.
5. Der alte Twitch-Prototyp mit Node-Server (`server.js`, `src/`, `public/`, `test/`) ist nicht mehr in Gebrauch.

### Tests (lokal ausgeführt)
- Firestore-Regeln: 37/37 im Emulator (Worker-Posteingang und Teilnahme-Link)
- Ende-zu-Ende im Emulator: Login → Teilnahme-Link → Zuschauer trägt sich ein → Doppelanmeldung abgelehnt → Schließen → Instagram-DM über den echten Worker-Code → Ziehung mit Prüfschritten
- Worker: 14/14 mit nachgebauter Instagram-Schnittstelle
- Browser-Tests für Bühne, YouTube (nachgebaut), TikTok (nachgebaut), Preise/Kombis, Bonus-Lose, Follower-Listen
