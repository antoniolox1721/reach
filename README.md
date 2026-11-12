# reach

Run one command on each of your machines (PC, laptop, phone) and control any of them from any other: browse and edit files, upload and download, run commands, and start saved scripts with one tap. For example, start a heavy script on your desktop from your phone and watch its output.

- No VPN, no port forwarding, no account. Each machine dials out to a relay.
- End-to-end encrypted. The relay and the dashboard host only ever see ciphertext.
- The dashboard is a web page: <https://antoniolox1721.github.io/reach/>

## Quick start

You need [Node.js](https://nodejs.org) 18 or newer and git on each machine.

**1. On the first machine**

```
npx github:antoniolox1721/reach
```

It creates your secret key, goes online, and prints:

- a **dashboard link** (also as a QR code), and
- a **join command** for your other machines.

Leave it running.

**2. On every other machine**

Paste the join command the first machine printed:

```
npx github:antoniolox1721/reach join <your key>
```

After the first time, plain `npx github:antoniolox1721/reach` is enough: the key is saved in `~/.reach/config.json`.

**3. Open the dashboard**

Scan the QR code with your phone, or open the dashboard link in any browser. The first time on each device it asks you to choose a **password**. From then on that device asks for the password every time the page is opened.

## Using your phone as a machine (Android)

To reach the phone's files from your PC, run reach on the phone inside [Termux](https://termux.dev) (install it from F-Droid):

```
pkg install nodejs git
termux-setup-storage
npx github:antoniolox1721/reach join <your key>
```

`termux-setup-storage` makes your photos, downloads and so on available under `~/storage/shared`; the dashboard shows it as a shortcut. Run `termux-wake-lock` so Android does not put it to sleep. Controlling other machines *from* the phone needs nothing installed, only the browser.

iPhones can use the dashboard but cannot run the agent.

## The dashboard

- **My machines**: every machine running reach with your key. Tap one to open it.
- **Files**: browse folders, tap a file to open (text and images), edit and save, download, rename or delete. *Upload* sends files from the device you are holding. *Open terminal here* is in a folder's `⋯` menu.
- **Terminal**: type a command, see the output live. `cd` works. While a program runs you can type input for it or press *Stop*. Jobs keep running if you close the page or lose signal; tap a job under *Jobs* to pick its output back up.
- **Scripts**: save commands you run often (name, command, folder) and start them with one tap. They are stored on the machine they belong to.
- **Lock**: forgets the key from memory until the password is typed again.

## Commands

```
reach                 put this machine online (creates your key on first run)
reach join <key>      add this machine using the key (or dashboard link) from another one
reach link            show the dashboard link, QR code and join command again
reach ui [port]       serve the dashboard from this machine instead of the public page
reach name <name>     rename this machine
reach rekey           replace the key (every other machine must join again)

--name <name>         name for this machine (saved)
--broker <wss url>    use your own MQTT-over-WebSocket relay (saved)
--dashboard <url>     dashboard address to print in links (saved)
--no-qr               do not print the QR code
```

With `npx`, write `npx github:antoniolox1721/reach` wherever it says `reach`. Or install it once with `npm install -g github:antoniolox1721/reach` and use `reach` directly.

To keep a machine always reachable, start reach when the machine starts: Task Scheduler on Windows, a systemd user service or `@reboot` cron line on Linux, Termux:Boot on Android.

## Security

Anyone who controls reach can read your files and run commands, so this is the part to understand.

- **The dashboard page is public, but it is empty.** It is a static page with no server, no accounts and no list of machines. It can do nothing until it has your key.
- **The key is the access.** It is 256 random bits, created on your first machine and stored in `~/.reach/config.json`. Every message is encrypted and authenticated with AES-256-GCM using a key derived from it. A machine ignores anything that was not encrypted with your key. The relay channel name is also derived from the key.
- **The link carries the key after the `#`.** That part of an address is never sent to a web server. The page removes it from the address bar immediately.
- **The password protects the key on each device.** The browser stores the key only in encrypted form (PBKDF2-SHA256, 600,000 rounds, then AES-256-GCM). Without the password the stored data is useless. The password is per device and is never sent anywhere.
- **Recorded messages cannot be replayed.** Each dashboard session gets a random session id from the machine and numbers its requests; a machine drops any request it has already seen.

What you need to do:

- Treat the key, the dashboard link and the join command like a master password. Do not paste them into chats or screenshots. The join command stays in your shell history.
- If a device is lost or the key may have leaked, run `reach rekey` on one machine and `reach join <new key>` on the others. The old key stops working as soon as no machine uses it.
- The public dashboard is served from `antoniolox1721.github.io`. Whoever controls that GitHub repository controls the page's code. If you would rather not depend on that, run `reach ui` and use the dashboard from `http://127.0.0.1:7700`, or fork the repository and pass `--dashboard` with your own address.

What the relay can still do: see that some device is online and how much data it sends, and block or delay traffic. It cannot read or forge anything.

## Limits

- Commands run through the machine's shell (`cmd.exe` on Windows, `$SHELL` elsewhere), one process per command. Full-screen terminal programs such as `vim` or `htop` do not work.
- The default relay is the free public HiveMQ broker. It is fine for commands and ordinary files (a few hundred KB/s to a few MB/s), has no uptime guarantee, and connecting occasionally takes several seconds. For heavy use point every machine at your own relay with `--broker wss://...` (any MQTT broker with WebSocket support, for example Mosquitto).
- Downloads are assembled in the browser's memory, so very large files (many hundreds of MB) are better moved another way. Files up to 2 MB can be opened and edited in the page.
- The terminal keeps the last 1 MB of each job's output and remembers the last 30 jobs until reach is restarted.

## Development

```
git clone https://github.com/antoniolox1721/reach
cd reach
npm install
npm test        # starts a real agent and drives it through the real relay
node reach.js ui
```

Layout: `reach.js` is the agent and CLI. `docs/` is the dashboard (GitHub Pages serves it as is); `docs/core.js` holds the encryption and protocol and is shared by the agent and the page.

MIT license.
