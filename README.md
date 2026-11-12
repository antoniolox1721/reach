# reach

Run one command on each of your machines (PC, laptop, phone) and control any of them from any other: browse and edit files, upload and download, run commands, and start saved scripts with one tap. For example, start a heavy script on your desktop from your phone and watch its output.

- No VPN, no port forwarding, no account. Each machine dials out to a relay.
- End-to-end encrypted. The relay and the dashboard host only ever see ciphertext.
- The dashboard is a web page: <https://antoniolox1721.github.io/reach/>

## Quick start

**1. Get the program** on each machine. No installation, nothing else needed:

| Machine | Download |
| --- | --- |
| Windows | [reach-windows-x64.exe](https://github.com/antoniolox1721/reach/releases/latest/download/reach-windows-x64.exe) |
| Linux | [reach-linux-x64](https://github.com/antoniolox1721/reach/releases/latest/download/reach-linux-x64) or [reach-linux-arm64](https://github.com/antoniolox1721/reach/releases/latest/download/reach-linux-arm64) |
| Mac (Apple silicon) | [reach-macos-arm64](https://github.com/antoniolox1721/reach/releases/latest/download/reach-macos-arm64) |
| Android phone | see [below](#using-your-phone-as-a-machine-android) |

On Linux and Mac make it runnable first: `chmod +x reach-*`. The programs are not code-signed, so Windows SmartScreen shows "Windows protected your PC" the first time: choose *More info*, then *Run anyway*. On a Mac, right-click the file and choose *Open*.

If you have Node.js 18+ and git you can skip the download and use `npx github:antoniolox1721/reach` wherever these instructions say to start reach.

**2. First machine.** Start the program (double-click it on Windows). It says the machine is not on a dashboard yet. Press **Enter** to create your dashboard. It prints a **dashboard link** and a QR code. Open the link, or scan the QR code with your phone, and choose a **password** for that device. Your machine is in the list.

**3. Every other machine.** Start the program. It shows a **code** like `ABCD-EFGH-JKLM`. In your dashboard choose **Add a machine**, type the code and confirm (or scan the QR code the new machine shows with the phone that already has your dashboard). The machine appears in the list a few seconds later. It does not matter which network each machine is on.

Leave the program running on a machine for as long as you want to reach it. It remembers its key in `~/.reach/config.json`, so next time you just start it.

**Adding machines without the dashboard at hand.** Run `reach keyfile` on a machine that is already set up. It writes a `reach.key` file. Put that file in the same folder as the program on the new machine (for example carry both on a USB stick) and start it: it finds the file, asks you to confirm with `y`, and joins. `reach join <path to reach.key>` does the same without asking, for scripts. Treat that file like a master password.

## Using your phone as a machine (Android)

Opening the dashboard on a phone needs nothing but the browser. To also reach the phone's own files from your other machines, run reach on the phone inside [Termux](https://termux.dev) (install it from F-Droid):

```
pkg install nodejs git
termux-setup-storage
npx github:antoniolox1721/reach
```

It shows a pairing code like any other machine. `termux-setup-storage` makes your photos, downloads and so on available under `~/storage/shared`; the dashboard shows it as a shortcut. Run `termux-wake-lock` so Android does not put it to sleep.

iPhones can use the dashboard but cannot run the program.

## The dashboard

- **My machines**: every machine running reach with your key. Tap one to open it. *Add a machine* takes the code a new machine shows.
- **Files**: browse folders, tap a file to open (text and images), edit and save, download, rename or delete. *Upload* sends files from the device you are holding. *Open terminal here* is in a folder's `⋯` menu.
- **Terminal**: type a command, see the output live. `cd` works. While a program runs you can type input for it or press *Stop*. Jobs keep running if you close the page or lose signal; tap a job under *Jobs* to pick its output back up.
- **Scripts**: save commands you run often (name, command, folder) and start them with one tap. They are stored on the machine they belong to.
- **Lock**: forgets the key from memory until the password is typed again.

## Commands

```
reach                 put this machine online (first run: shows a pairing code for your dashboard)
reach new             first machine: create a new key and dashboard
reach join <key>      add this machine using the key (or dashboard link) from another one
reach keyfile         write reach.key here; reach started next to that file offers to join with it
reach link            show the dashboard link, QR code and join command again
reach ui [port]       serve the dashboard from this machine instead of the public page
reach name <name>     rename this machine
reach rekey           replace the key (every other machine must join again)

--name <name>         name for this machine (saved)
--broker <wss url>    use your own MQTT-over-WebSocket relay (saved)
--dashboard <url>     dashboard address to print in links (saved)
--no-qr               do not print the QR code
```

`reach` here means the downloaded program (for example `reach-windows-x64.exe link`), or `npx github:antoniolox1721/reach`, or plain `reach` after `npm install -g github:antoniolox1721/reach`.

To keep a machine always reachable, start reach when the machine starts: Task Scheduler on Windows, a systemd user service or `@reboot` cron line on Linux, Termux:Boot on Android.

## Security

Anyone who controls reach can read your files and run commands, so this is the part to understand.

- **The dashboard page is public, but it is empty.** It is a static page with no server, no accounts and no list of machines. It can do nothing until it has your key.
- **The key is the access.** It is 256 random bits, created on your first machine and stored in `~/.reach/config.json`. Every message is encrypted and authenticated with AES-256-GCM using a key derived from it. A machine ignores anything that was not encrypted with your key. The relay channel name is also derived from the key.
- **The link carries the key after the `#`.** That part of an address is never sent to a web server. The page removes it from the address bar immediately.
- **The password protects the key on each device.** The browser stores the key only in encrypted form (PBKDF2-SHA256, 600,000 rounds, then AES-256-GCM). Without the password the stored data is useless. The password is per device and is never sent anywhere.
- **Pairing codes are one-time and short-lived.** A new machine shows a random code (60 bits) that exists only while it waits. Your dashboard uses the code to encrypt your key for that one machine (the code is stretched with PBKDF2 first, so a recorded pairing cannot be cracked later). The dashboard asks you to confirm before it sends anything.
- **Recorded messages cannot be replayed.** Each dashboard session gets a random session id from the machine and numbers its requests; a machine drops any request it has already seen.

What you need to do:

- Treat the key, the dashboard link, the join command and any `reach.key` file like a master password. Do not paste them into chats or screenshots.
- Only approve a pairing code that you can see on a machine you started yourself. Never approve a code or open a pairing link that someone sends you: approving gives that machine your key.
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
npm test        # starts real agents and drives them through the real relay
node reach.js ui
node build.mjs  # standalone executable for this OS in dist/ (REACH_BIN=dist/... npm test checks it)
```

Pushing a tag such as `v0.1.0` makes GitHub Actions build the executables for Windows, Linux and Mac and attach them to a release.

Layout: `reach.js` is the agent and CLI. `docs/` is the dashboard (GitHub Pages serves it as is); `docs/core.js` holds the encryption and protocol and is shared by the agent and the page.

MIT license.
